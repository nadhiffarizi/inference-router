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
import { detectIntent, retrieve } from "../rag/kb.js";
import { config } from "../config.js";

/**
 * The support-assistant capability (the brief's "one capability on top of it").
 * Same gateway path as /v1/chat — same auth, quota, routing, metering — plus:
 *   1. retrieval over the KB slice  → confidence signal
 *   2. refusal rule: confidence below floor → refuse, NO model call at all
 *   3. answer + detected intent + retrieved entries + confidence in `final`
 */

const BodySchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 4000 },
    backendPin: { type: "string" },
  },
  additionalProperties: false,
} as const;

export function registerAssistantRoute(app: FastifyInstance, byId: Map<string, ModelAdapter>): void {
  app.post<{ Body: { message: string; backendPin?: string } }>(
    "/v1/support-assistant",
    { schema: { body: BodySchema }, onRequest: authenticate },
    async (req, reply) => {
      const tenant = req.tenant!;
      const requestId = randomUUID();
      const started = Date.now();

      // 1) Retrieve. Confidence is normalized top-hit strength (rag/kb.ts).
      const { entries, confidence } = retrieve(req.body.message);
      const intentResult = detectIntent(entries);

      // 2) Refusal rule — before routing. No model call when the KB gives us
      //    nothing to stand on: refuse rather than guess (brief, Support
      //    assistant). Still metered + recorded as a decided outcome.
      if (confidence < config.assistant.refuseBelowConfidence) {
        openSse(reply, requestId);
        writeEvent(reply, {
          type: "meta",
          data: { requestId, refusal: true, reason: "low_retrieval_confidence", retrieval: { entries, confidence } },
        });
        writeEvent(reply, {
          type: "final",
          data: {
            refused: true,
            message:
              "I don't have reliable information on that in the support knowledge base, so I won't guess. Could you rephrase, or contact support directly?",
            reasoning: `retrieval confidence ${confidence.toFixed(2)} < floor ${config.assistant.refuseBelowConfidence}`,
            retrieval: { entries, confidence },
            intent: intentResult,
            metering: { model: "none", tokens: { prompt: 0, completion: 0 }, latencyMs: Date.now() - started, estimatedCostUsd: 0, costSource: "n/a" },
          },
        });
        await recordRoutingDecision({
          requestId, tenantId: tenant.id, capability: "support-assistant",
          plan: [{ backendId: "none", action: "blocked_policy", reason: `retrieval confidence ${confidence.toFixed(2)} below refusal floor` }],
          fallbackTriggered: false,
        });
        await recordRequest({
          tenantId: tenant.id, capability: "support-assistant", ...reqKey(req), backendId: "none", modelId: "none",
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started,
          estimatedCostUsd: 0, outcome: "refused",
          retrievedCount: entries.length, intent: intentResult.intent ?? undefined, confidence,
        }, requestId);
        // A refusal is still a served request — it consumes a request slot,
        // zero tokens (no model was called).
        await bumpQuota(tenant.id, 0).catch(() => undefined);
        closeSse(reply);
        return;
      }

      // 3) Route with the confidence as a routing input (DECISIONS.md D5).
      const routeCtx: RouteContext = {
        capability: "support-assistant",
        question: req.body.message,
        retrievalConfidence: confidence,
        pinBackendId: req.body.backendPin,
      };
      const plan = buildRoutePlan(routeCtx, byId);

      const system = assistantPrompt(entries, intentResult.intent);
      const streamReq: StreamRequest = {
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.body.message },
        ],
        maxTokens: 500,
        temperature: 0.2, // grounded answering; low temperature over retrieval
      };

      openSse(reply, requestId);
      const outcome = await openWithFallback(plan, streamReq);
      await recordRoutingDecision({
        requestId, tenantId: tenant.id, capability: "support-assistant",
        plan: outcome.steps,
        chosenBackendId: outcome.ok ? outcome.chosen.meta.id : undefined,
        fallbackTriggered: outcome.ok ? outcome.fallbackTriggered : false,
      });

      if (!outcome.ok) {
        writeEvent(reply, { type: "error", data: errorBody("backend_unavailable", `no backend served the request: ${outcome.lastError}`, { plan: outcome.steps }) });
        await recordRequest({
          tenantId: tenant.id, capability: "support-assistant", ...reqKey(req), backendId: "none", modelId: "none",
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started,
          estimatedCostUsd: 0, outcome: "failed", error: outcome.lastError,
          retrievedCount: entries.length, intent: intentResult.intent ?? undefined, confidence,
        }, requestId);
        closeSse(reply);
        return;
      }

      writeEvent(reply, {
        type: "meta",
        data: {
          requestId,
          backend: { id: outcome.chosen.meta.id, label: outcome.chosen.meta.label, model: outcome.chosen.meta.modelId },
          fallbackTriggered: outcome.fallbackTriggered,
          routingPlan: outcome.steps,
          retrieval: { entries, confidence },
          intent: intentResult,
        },
      });

      let usage = { promptTokens: 0, completionTokens: 0, costUsd: undefined as number | undefined };
      let answer = "";
      let streamError: string | undefined;
      try {
        for await (const ev of outcome.stream) {
          if (ev.type === "delta") {
            writeEvent(reply, { type: "delta", data: { text: ev.text } });
            answer += ev.text;
          } else {
            usage = { promptTokens: ev.usage.promptTokens, completionTokens: ev.usage.completionTokens, costUsd: ev.usage.costUsd };
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
        writeEvent(reply, { type: "error", data: errorBody("backend_unavailable", `stream failed mid-answer: ${streamError}`, { backend: outcome.chosen.meta.id }) });
      }

      // 4) Unusable-output guard: empty or trivially short answers are a
      //    refusal, not an answer (brief: "handles the case where the model
      //    returns something unusable").
      const unusable = !streamError && answer.trim().length < 15;
      const latencyMs = Date.now() - started;
      const costUsd = usage.costUsd ?? estimateCost(outcome.chosen.meta.pricePerMTokens, usage);

      if (unusable) {
        writeEvent(reply, {
          type: "final",
          data: {
            refused: true,
            message: "The model returned an unusable response, so I'm not answering it. Please try again.",
            reasoning: `model output length ${answer.trim().length} < 15 chars`,
            retrieval: { entries, confidence },
            intent: intentResult,
            metering: { model: outcome.chosen.meta.modelId, tokens: usage, latencyMs, estimatedCostUsd: costUsd, costSource: usage.costUsd !== undefined ? "provider" : "estimate" },
          },
        });
      } else {
        const quotaNow = await readUsage(tenant.id);
        writeEvent(reply, {
          type: "final",
          data: {
            refused: false,
            answer,
            metering: {
              model: outcome.chosen.meta.modelId,
              tokens: { prompt: usage.promptTokens, completion: usage.completionTokens },
              latencyMs,
              estimatedCostUsd: costUsd,
              costSource: usage.costUsd !== undefined ? "provider" : "estimate",
            },
            quota: { used: quotaNow, limits: { requestsPerDay: tenant.requestsPerDay, tokensPerDay: tenant.tokensPerDay, budgetUsdPerDay: tenant.budgetUsdPerDay } },
            retrieval: { entries, confidence },
            intent: intentResult,
            ok: !streamError,
          },
        });
      }

      await recordRequest({
        tenantId: tenant.id, capability: "support-assistant", ...reqKey(req), backendId: outcome.chosen.meta.id,
        modelId: outcome.chosen.meta.modelId, promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens, latencyMs, estimatedCostUsd: costUsd,
        outcome: unusable ? "refused" : streamError ? "failed" : "ok",
        error: streamError, retrievedCount: entries.length, intent: intentResult.intent ?? undefined, confidence,
      }, requestId);
      if (!unusable) {
        await bumpQuota(tenant.id, usage.promptTokens + usage.completionTokens).catch((err) =>
          console.error({ msg: "quota bump failed", requestId, err: String(err) }));
      }
      closeSse(reply);
    },
  );
}

/** The grounded prompt: answer ONLY from retrieved entries, name uncertainty. */
function assistantPrompt(entries: RetrievedEntryLite[], intent: string | null): string {
  const context = entries
    .map((e, i) => `[${i + 1}] (intent: ${e.intent}) Q: ${e.question}\nA: ${e.answer}`)
    .join("\n\n");
  return [
    "You are a customer support assistant. Answer the customer's question using ONLY the knowledge base entries below.",
    "Rules:",
    "- Ground every claim in the entries. If the entries do not answer the question, say you don't have that information instead of guessing.",
    "- Keep the answer short (2-5 sentences), plain, and helpful.",
    "- The detected intent is provided for context; do not mention it in the answer text.",
    "",
    "Knowledge base entries:",
    context,
    intent ? `\nDetected intent: ${intent}` : "",
  ].join("\n");
}

type RetrievedEntryLite = { question: string; answer: string; intent: string };

/** The issued key that authenticated this request (for per-key usage). */
function reqKey(req: { apiKey?: { id: number; label: string } }): { apiKeyId?: number; keyLabel?: string } {
  return req.apiKey ? { apiKeyId: req.apiKey.id, keyLabel: req.apiKey.label } : {};
}
