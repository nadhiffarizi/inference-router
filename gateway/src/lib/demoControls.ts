import { config } from "../config.js";
import type { ModelAdapter, StreamEvent, StreamRequest } from "../backends/types.js";
import { errors } from "./errors.js";

/**
 * Runtime demo controls (flag: DEMO_CONTROLS=1). The Demo Lab page turns these
 * mid-run so an assessor can trigger failure shapes — fallback, mid-stream
 * faults, dead backends — without a redeploy and without touching env.
 *
 * Scope guard: everything here mutates in-process state only (adapters consult
 * it live at call time; single process per container). Without the env flag the
 * module is inert — no endpoint accepts writes, the fault wrapper passes
 * through, and routing stays pure policy (DEPLOY.md: demo levers off in prod).
 */

export type MockFailureMode = "none" | "fail" | "hang" | "midstream" | "short";
export type BackendFault = "healthy" | "dead" | "midstream";

export type DemoSettings = {
  /** Same semantics as ROUTING_CHAIN — reorders the plan for demos. */
  routingChain: string;
  mock: {
    failureMode: MockFailureMode;
    failureRate: number;
    firstByteDelayMs: number;
    chunkDelayMs: number;
  };
  /** backendId → injected fault. Real tiers die before first byte ("dead") or
   *  after a couple of deltas ("midstream"); mock has its own richer modes. */
  faults: Record<string, BackendFault>;
};

const FAIL_MODES: readonly MockFailureMode[] = ["none", "fail", "hang", "midstream", "short"];
const FAULTS: readonly BackendFault[] = ["healthy", "dead", "midstream"];

function defaults(): DemoSettings {
  return {
    routingChain: config.routingChainOverride,
    mock: {
      failureMode: config.backends.mock.failureMode as MockFailureMode,
      failureRate: config.backends.mock.failureRate,
      firstByteDelayMs: config.backends.mock.firstByteDelayMs,
      chunkDelayMs: config.backends.mock.chunkDelayMs,
    },
    faults: {},
  };
}

const state: { settings: DemoSettings } = { settings: defaults() };

export type DemoSettingsPatch = {
  routingChain?: string;
  mock?: Partial<DemoSettings["mock"]>;
  faults?: Record<string, BackendFault>;
};

export const demoControls = {
  get enabled(): boolean {
    return config.demoControls;
  },
  settings(): DemoSettings {
    return state.settings;
  },
  routingChain(): string {
    return state.settings.routingChain;
  },
  mock(): DemoSettings["mock"] {
    return state.settings.mock;
  },
  faultFor(backendId: string): BackendFault {
    return state.settings.faults[backendId] ?? "healthy";
  },
  /**
   * Partial, validated update. Throws GatewayError 400 on anything malformed —
   * the Demo Lab surfaces it, the gateway never half-applies.
   */
  update(patch: DemoSettingsPatch, backendIds: readonly string[]): DemoSettings {
    const next = { ...state.settings };

    if (patch.routingChain !== undefined) {
      const ids = patch.routingChain.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = ids.filter((id) => !backendIds.includes(id));
      if (unknown.length) throw errors.invalidInput(`ROUTING_CHAIN names unknown backends: ${unknown.join(", ")}`, { allowed: backendIds });
      next.routingChain = patch.routingChain.trim();
    }

    if (patch.mock?.failureMode !== undefined) {
      requireMode(patch.mock.failureMode, FAIL_MODES);
      next.mock = { ...next.mock, failureMode: patch.mock.failureMode };
    }
    if (patch.mock?.failureRate !== undefined) {
      if (patch.mock.failureRate < 0 || patch.mock.failureRate > 1) throw errors.invalidInput("mock failureRate must be 0..1");
      next.mock = { ...next.mock, failureRate: patch.mock.failureRate };
    }
    for (const field of ["firstByteDelayMs", "chunkDelayMs"] as const) {
      const v = patch.mock?.[field];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 0 || v > 5000) throw errors.invalidInput(`mock ${field} must be an integer 0..5000`);
        next.mock = { ...next.mock, [field]: v };
      }
    }

    if (patch.faults !== undefined) {
      const unknown = Object.keys(patch.faults).filter((id) => !backendIds.includes(id));
      if (unknown.length) throw errors.invalidInput(`faults name unknown backends: ${unknown.join(", ")}`, { allowed: backendIds });
      for (const [id, fault] of Object.entries(patch.faults)) {
        if (!FAULTS.includes(fault)) throw errors.invalidInput(`fault "${fault}" for ${id} is not healthy|dead|midstream`);
      }
      // Merge, so a scene can clear one backend's fault without re-listing all.
      next.faults = {
        ...next.faults,
        ...patch.faults,
      };
    }

    state.settings = next;
    return next;
  },
  /** Boot defaults (env-derived) — the Demo Lab's "reset levers". */
  reset(): DemoSettings {
    state.settings = defaults();
    return state.settings;
  },
};

function requireMode(mode: string, allowed: readonly string[]): void {
  if (!allowed.includes(mode)) throw errors.invalidInput(`failure mode "${mode}" is not one of ${allowed.join("|")}`);
}

/**
 * Wrap every adapter in the fault-injection proxy. Consulted live at stream
 * time, so a toggle mid-run affects the very next call — no restart. "healthy"
 * is a pure pass-through, and with DEMO_CONTROLS unset the map is empty too.
 */
export function withDemoFaults(adapter: ModelAdapter): ModelAdapter {
  const meta = adapter.meta;
  return {
    meta, // same identity — dispatch's timeouts and reason strings read it
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown> {
      const fault = demoControls.faultFor(meta.id);
      if (fault === "dead") {
        throw new Error(`${meta.id} demo fault: dead backend (injected by demo controls)`);
      }
      if (fault === "midstream") {
        // Answer honestly, then die — the exact shape the "no mid-stream
        // re-routing" boundary exists for (no splice, an explicit error event).
        yield { type: "delta", text: "This is the beginning of a real answer that will" };
        await sleep(80);
        throw new Error(`${meta.id} demo fault: died mid-stream (injected by demo controls)`);
      }
      yield* adapter.stream(req);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}