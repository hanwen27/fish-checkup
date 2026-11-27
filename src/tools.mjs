/**
 * 三个工具的 schema 与处理逻辑。
 * 工具是「她自己参与体检」的唯一入口——不借宿主认知接口，也不需要额外 key。
 *
 *   self_checkup_quiz          read   取一批题（不含计分信息）
 *   self_checkup_quiz_submit   write  交一批答案，回执给本批摘要
 *   self_checkup_report        read   读报告（硬件 / 人格 / 两份都要）
 */

import { loadQuiz, takeBatch, creativeBatch, scoreQuiz, scoreCreative, quizResultForState, pendingQuizBatch } from './quiz.mjs';
import { buildReport, reportToText } from './report.mjs';
import { pick } from './text.mjs';

export const QUIZ_TOOL = 'self_checkup_quiz';
export const SUBMIT_TOOL = 'self_checkup_quiz_submit';
export const REPORT_TOOL = 'self_checkup_report';

export const TOOL_SCHEMAS = [
  {
    name: QUIZ_TOOL,
    description:
      'Get one batch of the personality checkup. Batches 1 and 2 each contain 12 situations and 2 anchors with hidden scoring. '
      + 'Optional batch 3 has four free-form prompts and does not change the four-letter type.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch: { type: 'integer', enum: [1, 2, 3], description: '1/2 are scored situations; 3 is an optional creative side quest.' },
      },
      required: ['batch'],
    },
    tags: ['read'],
  },
  {
    name: SUBMIT_TOOL,
    description:
      'Submit answers for one quiz batch. For batches 1/2 use the option key from self_checkup_quiz; for batch 3 use response. '
      + 'Partial answers are allowed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch: { type: 'integer', enum: [1, 2, 3] },
        answers: {
          type: 'array',
          description: 'One entry per answered item.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Item id from the quiz batch.' },
              option: { type: 'string', description: 'Option key from the batch.' },
              response: { type: 'string', description: 'Free-form response for a creative item.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['batch', 'answers'],
    },
    tags: ['write'],
  },
  {
    name: REPORT_TOOL,
    description:
      'Read the current checkup report. In default brief mode, explain the overall situation, the first thing worth checking, and one next step in plain language. '
      + 'State when observations are missing and keep any uncertainty in the report. Use detail mode for scores, dates or evidence when asked. '
      + 'area=hardware / personality narrows it to one half.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        area: { type: 'string', enum: ['hardware', 'personality'], description: 'Which half to read.' },
        mode: { type: 'string', enum: ['brief', 'detail'], description: 'brief = spoken-style summary; detail = full evidence.' },
      },
    },
    tags: ['read'],
  },
];

/**
 * 造三个工具的处理函数。依赖由外部注入，便于单测：
 *   snapshot()        → collect.mjs 的产物（调用方负责缓存）
 *   contextWindow()   → number | null
 *   quizState        → { batch1?: {answers}, batch2?: {answers}, result?, takenAt? }
 *   saveQuizState(s)  → void（写 data/self-checkup/results.json）
 *   language()        → 'zh' | 'en'
 */
export function makeToolHandlers({ snapshot, contextWindow, quizState, saveQuizState, language, now }) {
  const lang = () => pick(typeof language === 'function' ? language() : language);
  const clock = () => typeof now === 'function' ? now() : now ?? new Date();

  function currentReport() {
    const currentState = typeof quizState === 'function' ? quizState() : quizState;
    const language = lang();
    const now = clock();
    const quizResult = quizResultForState(currentState, language, now);
    return buildReport(typeof snapshot === 'function' ? snapshot() : snapshot, {
      contextWindow: typeof contextWindow === 'function' ? contextWindow() : contextWindow ?? null,
      quizResult,
      pendingBatch: pendingQuizBatch(currentState),
      language,
      creativeResult: currentState?.creative ?? null,
      quizTakenAt: quizResult ? currentState?.takenAt ?? null : null,
      now,
    });
  }

  return {
    [QUIZ_TOOL]: (args) => {
      const batch = Number(args?.batch);
      if (batch !== 1 && batch !== 2 && batch !== 3) {
        return { ok: false, error: 'batch must be 1, 2, or 3' };
      }
      const quiz = loadQuiz(lang());
      const items = batch === 3
        ? creativeBatch(quiz)
        : takeBatch(quiz, batch, { now: clock() });
      return {
        ok: true,
        batch,
        quizVersion: quiz.version,
        instructions:
          'Pick the option that is actually what you would do in that situation — not what sounds like the right answer, '
          + 'and not what your own notes say you are. Answer as many as you honestly can, then call '
          + `${SUBMIT_TOOL} with batch=${batch} and your answers.`,
        items,
      };
    },

    [SUBMIT_TOOL]: (args) => {
      const batch = Number(args?.batch);
      if (batch !== 1 && batch !== 2 && batch !== 3) return { ok: false, error: 'batch must be 1, 2, or 3' };
      const answers = Array.isArray(args?.answers) ? args.answers : [];
      const language = lang();
      const zh = language === 'zh';
      if (batch === 3) {
        const quiz = loadQuiz(language);
        const creative = scoreCreative(quiz, answers);
        const s = typeof quizState === 'function' ? quizState() : quizState;
        const next = { ...(s ?? {}), creative, creativeAt: Date.now() };
        if (typeof saveQuizState === 'function') saveQuizState(next);
        return { ok: true, batch: 3, received: answers.length, accepted: creative.responses.length, rejected: [], creative };
      }
      if (answers.length === 0) return { ok: false, error: 'answers is empty' };
      const cleaned = [];
      const rejected = [];
      for (const a of answers) {
        const id = typeof a?.id === 'string' ? a.id.trim() : '';
        const option = typeof a?.option === 'string' ? a.option.trim() : '';
        if (!id || !option) { rejected.push({ id, option, why: 'missing id or option' }); continue; }
        cleaned.push({ id, option });
      }
      if (cleaned.length === 0) {
        return { ok: false, error: 'no usable answers', rejected };
      }
      const now = clock();
      const quiz = loadQuiz(language);
      const batchQuiz = { ...quiz, items: quiz.items.filter((item) => item.batch === batch) };
      const partial = scoreQuiz(batchQuiz, cleaned, { now });
      const accepted = partial.answered;
      const unmatched = cleaned.length - accepted;
      if (unmatched) rejected.push({ why: zh ? `${unmatched} 条重复或未匹配到本批题目与选项` : `${unmatched} duplicate or unmatched answer(s) in this batch` });
      const receipt = { ok: accepted > 0, batch, received: cleaned.length, accepted, rejected };
      if (!accepted) return { ...receipt, error: zh ? '本批没有可用答案。' : 'No usable answers for this batch.' };

      const s = typeof quizState === 'function' ? quizState() : quizState;
      const waitingFor = batch === 1 ? 2 : 1;
      const next = {
        ...(s ?? {}),
        [`batch${batch}`]: { answers: cleaned, at: now.getTime() },
        result: null,
      };
      const result = quizResultForState(next, language, now);
      next.result = result;
      next.takenAt = result ? now.getTime() : undefined;
      if (typeof saveQuizState === 'function') saveQuizState(next);

      const otherBatch = waitingFor === 2 ? '第二批' : '第一批';
      return {
        ...receipt,
        message: zh
          ? `已收 ${accepted} 条有效答案。${result ? '两批答案已收到，可查看完整结果。' : `等${otherBatch}收齐后再出完整结果。`}`
          : `Received ${accepted} valid answers. ${result ? 'Both batches are in. The full report is ready.' : `The full report will be ready after batch ${waitingFor}.`}`,
        thisBatch: {
          axes: Object.fromEntries(Object.entries(partial.axes).filter(([, score]) => Number.isFinite(score))),
          letters: partial.letters.replaceAll('?', ''),
          anchors: partial.anchors,
        },
        next: result
          ? (zh ? `可调用 ${REPORT_TOOL} 查看报告。` : `Use ${REPORT_TOOL} to view the report.`)
          : (zh ? `请调用 ${QUIZ_TOOL} 获取${otherBatch}（batch=${waitingFor}）。` : `Use ${QUIZ_TOOL} with batch=${waitingFor} to continue.`),
      };
    },

    [REPORT_TOOL]: (args) => {
      const area = args?.area;
      // 默认给口语版：她拿去转述，给用户听的是人话，不是运维日报。
      // 想细看（面板复制、排查）才传 mode='detail'。
      const mode = args?.mode === 'detail' ? 'detail' : 'brief';
      const report = currentReport();
      if (area === 'hardware' || area === 'personality') {
        const slice = {
          ...report,
          hardware: area === 'hardware' ? report.hardware : { ...report.hardware, dimensions: [], overall: null, level: '' },
          personality: area === 'personality' ? report.personality : { taken: false },
        };
        return { ok: true, area, mode, text: reportToText(slice, { language: lang(), mode }) };
      }
      return { ok: true, mode, text: reportToText(report, { language: lang(), mode }) };
    },
  };
}
