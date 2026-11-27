/** Explicit integration seam. Ordinary WorldHost.cognition is NOT compatible. */
export interface DeepExecutor {
  /** Local inspection only: no model requests, secrets, user history or writes. */
  inspect(): {
    model: string;
    /** Must cover provider, model, effective prompts, pricing and adapter configuration. */
    fingerprint: string;
    contextWindow: number;
    capabilities: {
      isolated: true;
      noTools: true;
      noMemoryWrites: true;
      singleAttempt: true;
      hardLimits: true;
      usage: true;
      abort: true;
    };
    /** Complete, user-readable description including any adapter-added system prompts. */
    dataScope: string;
  };
  /** No network/model calls. Include all provider overhead; reject cases that cannot fit. */
  reserve(testCase: unknown): {
    inputTokens: number;
    outputTokens: number;
    maxCostCny: number;
    /** Optional latency estimate from matching real samples, never a fabricated default. */
    durationMs?: [number, number];
  };
  /** One billable attempt only. Honor caps, isolation and cancellation, including SDK retries. */
  execute(input: {
    runId: string;
    testCase: unknown;
    reservation: { inputTokens: number; outputTokens: number; maxCostCny: number };
    signal: AbortSignal;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
    /** Include failed attempts in accounting. False means transport/provider failure, not a wrong answer. */
    ok: boolean;
  }>;
}
