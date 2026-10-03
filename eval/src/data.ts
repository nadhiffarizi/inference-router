export type EvalCase = {
  question: string;
  answer: string;
  intent: string;
  category: string;
};

export type CaseResult = {
  question: string;
  expectedIntent: string;
  detectedIntent: string | null;
  intentCorrect: boolean;
  refused: boolean;
  error: string | null;
  answer: string;
  retrievalConfidence: number | null;
  retrievedIntents: string[];
  backend: string | null;
  model: string | null;
  fallbackTriggered: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  // filled by the judge (when a real key is configured):
  groundednessScore?: number; // 1..5
  judgeComment?: string;
};

export type RunSummary = {
  config: string;
  backendPin: string;
  startedAt: string;
  cases: CaseResult[];
  metrics: {
    intentAccuracy: number;
    refusalRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalCostUsd: number;
    avgGroundedness: number | null;
    errorRate: number;
  };
};