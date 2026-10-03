process.env.MOCK_FAILURE_MODE = "hang";
const { bootstrapDatabase } = await import("../db/index.js");
bootstrapDatabase();
await import("../db/index.js");
const { makeMockAdapter } = await import("../backends/mock.js");
const { makeOpenRouterAdapter } = await import("../backends/openrouter.js");
const { openWithFallback } = await import("../routing/dispatch.js");
const { buildRoutePlan } = await import("../routing/rules.js");
const { adapterRegistry } = await import("../routing/dispatch.js");
const { readFileSync } = await import("node:fs");

const { config } = await import("../config.js");
const reg = adapterRegistry([
  makeMockAdapter({ id: "mock", label: "mock", modelId: "mock/instant", tier: "mock", timeoutMs: 1500, pricePerMTokens: { input: 0, output: 0 } }),
  makeOpenRouterAdapter({ id: "openrouter-tier-a", label: "A", modelId: config.backends.tierA.model, tier: "a", timeoutMs: 4000, pricePerMTokens: { input: 0, output: 0 } }),
]);
const plan = buildRoutePlan({ capability: "chat", question: "hello world" }, reg);
console.log("plan:", plan.map((c) => c.adapter.meta.id).join(" → "));
const t0 = Date.now();
const out = await openWithFallback(plan, { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
console.log("elapsed", Date.now() - t0, "ms | ok:", out.ok);
for (const s of out.steps) console.log(" ", s.backendId, s.action, "|", s.reason.slice(0, 90));
if (out.ok) for await (const ev of out.stream) console.log(" ev:", ev.type);
process.exit(0);
void readFileSync;