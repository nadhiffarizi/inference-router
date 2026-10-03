import type { FastifyReply } from "fastify";

/**
 * SSE event protocol shared by /v1/chat and /v1/support-assistant. Four event
 * types keep the console dumb (it renders whatever arrives):
 *   meta  — routing + retrieval context (model, plan, fallback, retrieval, intent, confidence)
 *   delta — streamed answer text
 *   final — metering summary (tokens, latency, cost, quota remaining)
 *   error — structured failure after streaming started (mid-stream faults)
 */

export type SseEvent =
  | { type: "meta"; data: Record<string, unknown> }
  | { type: "delta"; data: { text: string } }
  | { type: "final"; data: Record<string, unknown> }
  | { type: "error"; data: Record<string, unknown> };

export function openSse(reply: FastifyReply, requestId: string): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    "x-accel-buffering": "no", // NGINX: don't buffer the stream
  });
  reply.raw.write(": stream opened\n\n"); // flush header through some proxies
}

export function writeEvent(reply: FastifyReply, event: SseEvent): void {
  const { type, data } = event;
  reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function closeSse(reply: FastifyReply): void {
  reply.raw.write("event: stream_end\ndata: {}\n\n");
  reply.raw.end();
}