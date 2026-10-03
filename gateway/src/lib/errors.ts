/**
 * Machine-readable failure shapes. The brief grades "failure behaviour":
 * every error path returns a JSON body with { error: { code, message } } and
 * the right status — never a hang, never a bare string.
 */

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "quota_exceeded"
  | "quota_uncertain"
  | "backend_unavailable"
  | "model_output_unusable"
  | "low_confidence_refusal"
  | "internal";

export const errors = {
  invalidInput: (message: string, details?: Record<string, unknown>) =>
    new GatewayError(400, "invalid_input", message, details),
  unauthorized: (message: string) => new GatewayError(401, "unauthorized", message),
  quotaExceeded: (message: string, details?: Record<string, unknown>) =>
    new GatewayError(429, "quota_exceeded", message, details),
  quotaUncertain: (message: string) => new GatewayError(503, "quota_uncertain", message),
  backendUnavailable: (message: string, details?: Record<string, unknown>) =>
    new GatewayError(502, "backend_unavailable", message, details),
  modelOutputUnusable: (message: string) => new GatewayError(502, "model_output_unusable", message),
  lowConfidenceRefusal: (message: string, details?: Record<string, unknown>) =>
    new GatewayError(200, "low_confidence_refusal", message, details), // refusal is a 200 with outcome, by design
  internal: (message: string) => new GatewayError(500, "internal", message),
};

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...{ details } } };
}