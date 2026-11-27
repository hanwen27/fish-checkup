/** COO assembly protocol. A temporary session or a cognition callback alone does not satisfy it. */
export interface CooperativeHost {
  inspect(): {
    ready: boolean;
    modelReady: boolean;
    fingerprint: string;
    dataScope: string;
    source: { id: string; name: string; fingerprint: string; files: Array<{ name: string; sha256: string }> };
    runtime: {
      origin: 'live-host' | 'example-policy';
      stageTokens: number;
      softRatio: number;
      keepRatio: number;
      softTokens: number;
      noteBudgetTokens: number;
      modelInputLimit: number | null;
      maxOutputTokens: number | null;
    };
    memoryTargets: Array<{ id: string; name: string; version: string; testLevel: string; scope: string }>;
  };
  /** Fixed metadata projection only. An installed package is not evidence of active memory use. */
  readInventory(): Promise<{ status: string; rows: unknown[]; detail: string }>;
  /** Exact count for the complete request, with protocol overhead. No paid calls. */
  countMessages(messages: Array<{ role: string; content: string }>): Promise<number>;
  /** Native handoff preflight in an owned directory, without sending model requests. */
  measureHandoff(scenario: unknown): Promise<{
    beforeMessages: Array<{ role: string; content: string }>;
    afterMessages: Array<{ role: string; content: string }>;
    evidence: unknown;
  }>;
  open(runId: string): Promise<{
    handoff(scenario: unknown, options: { signal: AbortSignal }): Promise<unknown>;
    memoryLifecycle(target: string, options: { signal: AbortSignal }): Promise<unknown>;
    cleanup(): Promise<{ status: string; scope: string }>;
  }>;
  /** One request, no hidden retries/tools/implicit prompts. Settles usage on failure and cancellation. */
  complete(input: {
    messages: Array<{ role: string; content: string }>;
    maxOutputTokens: number;
    inputTokenCap: number;
    requestId: string;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; text: string; inputTokens: number; outputTokens: number; attempts: 1 }>;
}
