import { randomBytes } from 'node:crypto';

export const COOPERATIVE_METHOD = 'DC-0.2';
export const COOPERATIVE_GROUPS = ['context', 'handoff', 'memory'];
export const CONTEXT_RATIOS = [.25, .5, .75];
export const OUTPUT_CAP = 256;
export const TEST_SYSTEM = '你正在完成隔离的合成任务。只根据所给材料回答，不调用工具，不读取外部信息。只输出指定 JSON，不加说明或代码围栏。';

export function makeHandoffScenario(position = 'middle') {
  const marker = randomBytes(10).toString('hex');
  const expected = { goal: `deliver_${marker}`, constraint: `offline_${marker}`, pending: `verify_${marker}`, latest: `new_${marker}` };
  const facts = `虚构任务档案：${JSON.stringify(expected)}。latest 的旧值 old_${marker} 已作废。后续任务以此档案为准。`;
  const filler = Array.from({ length: 16 }, (_, i) => `合成进度 ${i}：检查无关样例 ${marker.slice(0, 4)}-${i}，没有新增任务约束。`);
  const at = position === 'begin' ? 0 : position === 'end' ? filler.length : 8;
  filler.splice(at, 0, facts);
  return { id: `handoff-${position}`, position, expected,
    messages: filler.map((content) => ({ role: 'user', content })),
    question: '根据任务档案，输出 goal、constraint、pending、latest 四个字段的 JSON，值必须准确。' };
}

export function exactJson(text, expected) {
  if (typeof text !== 'string' || text.length > 8192) return false;
  try {
    const result = JSON.parse(text);
    return result !== null && !Array.isArray(result) && typeof result === 'object'
      && Object.keys(result).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => result[key] === value);
  } catch { return false; }
}

export function fieldEvidence(text, expected) {
  let parsed = null;
  try { if (typeof text === 'string' && text.length <= 8192) parsed = JSON.parse(text); } catch {}
  const object = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return { validObject: object, fields: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, object && parsed[key] === value])),
    exactSchema: object && Object.keys(parsed).length === Object.keys(expected).length };
}

/** All nine location checks share three requests; they are not independent samples. */
export async function makeContextCase(ratio, effectiveInput, countMessages) {
  const target = Math.floor(effectiveInput * ratio);
  if (!Number.isSafeInteger(target) || target < 2048) throw new Error('context-budget-unavailable');
  const marker = randomBytes(10).toString('hex');
  const expected = { begin: `b_${marker}`, middle: `m_${marker}`, end: `e_${marker}` };
  const block = Array.from({ length: 128 }, (_, i) => `日程记录 ${i}: sample=${marker.slice(0, 8)}; value=${(i * 7919) % 997}; 本条不修改有效档案。`).join('\n') + '\n';
  const messagesFor = (chars) => {
    const noise = block.repeat(Math.ceil(chars / block.length)).slice(0, chars);
    const half = Math.floor(noise.length / 2);
    return [{ role: 'system', content: TEST_SYSTEM }, { role: 'user', content:
      `请从三份有效档案读取 begin、middle、end，输出三个字段的 JSON。其他日程记录只作干扰。\n有效档案 begin=${expected.begin}\n`
      + noise.slice(0, half) + `\n有效档案 middle=${expected.middle}\n` + noise.slice(half) + `\n有效档案 end=${expected.end}` }];
  };
  let low = 0, high = Math.min(target * 12, 6_000_000), best = null;
  for (let i = 0; i < 24 && low <= high; i++) {
    const middle = Math.floor((low + high) / 2);
    const messages = messagesFor(middle);
    const counted = await countMessages(messages);
    if (!Number.isSafeInteger(counted) || counted < 1) throw new Error('token-count-unavailable');
    if (counted <= target) { best = { messages, inputTokens: counted }; low = middle + 1; }
    else high = middle - 1;
    if (best && target - best.inputTokens <= Math.max(8, target * .001)) break;
  }
  if (!best || best.inputTokens < target * .97) throw new Error('context-target-not-reached');
  return { id: `context-${ratio}`, group: 'context', ratio, targetInputTokens: target, expected, ...best };
}
