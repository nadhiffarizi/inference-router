import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { errorBody } from "../lib/errors.js";
import { bumpQuota, readUsage } from "../lib/quota.js";
import { recordRequest, recordRoutingDecision } from "../lib/metering.js";
import { openSse, writeEvent, closeSse } from "../lib/sse.js";
import { buildRoutePlan, type RouteContext } from "../routing/rules.js";
import { openWithFallback } from "../routing/dispatch.js";
import type { ModelAdapter, StreamRequest } from "../backends/types.js";
import { estimateCost } from "../backends/types.js";
import { authenticate } from "../plugins/auth.js";

/** The plain-chat capability: tenant-supplied message, streamed answer. */

const BodySchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8000 },
    maxTokens: { type: "integer", minimum: 16, maximum: 2000, default: 700 },
  },
  additionalProperties: false,
} as const;

declare module "fastify" {
  interface FastifySchema {
    Body?: typeof BodySchema;
  }
}

export function registerChatRoute(
  app: FastifyInstance,
  byId: Map<string, ModelAdapter>,
  systemPrompt: string,
): void {
  app.post<{
    Body: { message: string; maxTokens?: number };
  }>(
    "/v1/chat",
    {
      schema: { body: BodySchema },
      onRequest: authenticate,
    },
    async (req, reply) => {
      const tenant = req.tenant!;
      const requestId = randomUUID();
      const started = Date.now();

      const routeCtx: RouteContext = { capability: "chat", question: req.body.message };
      const plan = buildRoutePlan(routeCtx, byId);

      const streamReq: StreamRequest = {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: req.body.message },
        ],
        maxTokens: req.body.maxTokens ?? 700,
      };

      openSse(reply, requestId);
      const outcome = await openWithFallback(plan, streamReq);
      await recordRoutingDecision({
        requestId, tenantId: tenant.id, capability: "chat",
        plan: outcome.steps, chosenBackendId: outcome.ok ? outcome.chosen.meta.id : undefined,
        fallbackTriggered: outcome.ok ? outcome.fallbackTriggered : false,
      });

      if (!outcome.ok) {
        // No candidate produced output — nothing streamed yet, so fail as JSON-shaped SSE then end.
        writeEvent(reply, { type: "error", data: errorBody("backend_unavailable", `no backend served the request: ${outcome.lastError}`, { plan: outcome.steps }) });
        await recordRequest({
          tenantId: tenant.id, capability: "chat", backendId: "none", modelId: "none",
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started,
          estimatedCostUsd: 0, outcome: "failed", error: outcome.lastError,
        }, requestId);
        return closeSse(reply);
      }

      const meta = {
        requestId,
        backend: { id: outcome.chosen.meta.id, label: outcome.chosen.meta.label, model: outcome.chosen.meta.modelId },
        fallbackTriggered: outcome.fallbackTriggered,
        routingPlan: outcome.steps,
      };
      writeEvent(reply, { type: "meta", data: meta });

      let usage = { promptTokens: 0, completionTokens: 0, costUsd: undefined as number | undefined };
      let streamError: string | undefined;
      try {
        for await (const ev of outcome.stream) {
          if (ev.type === "delta") writeEvent(reply, { type: "delta", data: { text: ev.text } });
          else usage = { promptTokens: ev.usage.promptTokens, completionTokens: ev.usage.completionTokens, costUsd: ev.usage.costUsd };
        }
      } catch (err) {
        // Mid-stream fault after first byte: surfaced, not retried (DECISIONS.md notes in dispatch.ts).
        streamError = err instanceof Error ? err.message : String(err);
        writeEvent(reply, { type: "error", data: errorBody("backend_unavailable", `stream failed mid-answer: ${streamError}`, { backend: outcome.chosen.meta.id }) });
      }

      const latencyMs = Date.now() - started;
      const costUsd = usage.costUsd ?? estimateCost(outcome.chosen.meta.pricePerMTokens, usage);
      const priceExact = usage.costUsd !== undefined;
      await recordRequest({
        tenantId: tenant.id, capability: "chat", backendId: outcome.chosen.meta.id,
        modelId: outcome.chosen.meta.modelId, promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens, latencyMs, estimatedCostUsd: costUsd,
        outcome: streamError ? "failed" : "ok", error: streamError,
      }, requestId);
      await bumpQuota(tenant.id, usage.promptTokens + usage.completionTokens).catch((err) =>
        console.error({ msg: "quota bump failed", requestId, err: String(err) }));

      const quotaNow = await readUsage(tenant.id);
      const tenantLimits = { requestsPerDay: tenant.requestsPerDay, tokensPerDay: tenant.tokensPerDay };
      writeEvent(reply, {
        type: "final",
        data: {
          metering: {
            model: outcome.chosen.meta.modelId,
            tokens: { prompt: usage.promptTokens, completion: usage.completionTokens },
            latencyMs,
            estimatedCostUsd: costUsd,
            costSource: priceExact ? "provider" : "estimate",
          },
          quota: { used: quotaNow, limits: { ...tenantLimits, budgetUsdPerDay: tenant.budgetUsdPerDay } },
          ok: !streamError,
        },
      });
      closeSse(reply);
    },
  );
}