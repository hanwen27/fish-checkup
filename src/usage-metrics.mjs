const MODEL_OUTCOMES = new Set(['completed', 'failed', 'aborted']);
const NON_MODEL_PURPOSES = new Set(['diagnostic', 'probe']);

export function modelCallRecords(usage) {
  return (usage?.records ?? []).filter((record) =>
    (!record.role || record.role === 'main')
    && !NON_MODEL_PURPOSES.has(String(record.purpose).toLowerCase())
    && MODEL_OUTCOMES.has(record.outcome));
}
