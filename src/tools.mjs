/**
 * 三个工具的 schema 与处理逻辑。
 * 工具是「她自己参与体检」的唯一入口——不借宿主认知接口，也不需要额外 key。
 *
 *   self_checkup_quiz          read   取一批题（不含计分信息）
 *   self_checkup_quiz_submit   write  交一批答案，回执给本批摘要
 *   self_checkup_report        read   读报告（硬件 / 人格 / 两份都要）
 */

import { loadQuiz, takeBatch, creativeBatch, scoreQuiz, scoreCreative } from './quiz.mjs';
import { buildReport, reportToText } from './report.mjs';

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
  const lang = () => (typeof language === 'function' ? language() : language ?? 'zh');
  const state = typeof quizState === 'function' ? quizState() : quizState;

  function currentResult() {
    const s = typeof quizState === 'function' ? quizState() : quizState;
    if (s?.result) return s.result;
    // 两批都齐了就地合起来算一次（不落盘，调用方决定何时存）。
    const answers = [...(s?.batch1?.answers ?? []), ...(s?.batch2?.answers ?? [])];
    if (answers.length === 0) return null;
    const quiz = loadQuiz(lang());
    return scoreQuiz(quiz, answers, { now: typeof now === 'function' ? now() : now ?? new Date() });
  }

  function currentReport() {
    const currentState = typeof quizState === 'function' ? quizState() : quizState;
    return buildReport(typeof snapshot === 'function' ? snapshot() : snapshot, {
      contextWindow: typeof contextWindow === 'function' ? contextWindow() : contextWindow ?? null,
      quizResult: currentResult(),
      language: lang(),
      creativeResult: currentState?.creative ?? null,
       quizTakenAt: currentState?.takenAt ?? null,
      now: typeof now === 'function' ? now() : now ?? new Date(),
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
        : takeBatch(quiz, batch, { now: typeof now === 'function' ? now() : now ?? new Date() });
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
      if (batch === 3) {
        const quiz = loadQuiz(lang());
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
      const s = typeof quizState === 'function' ? quizState() : quizState;
      const next = {
        ...(s ?? {}),
        [`batch${batch}`]: { answers: cleaned, at: Date.now() },
        takenAt: Date.now(),
      };
      if (typeof saveQuizState === 'function') saveQuizState(next);
      const quiz = loadQuiz(lang());
      const partial = scoreQuiz(quiz, cleaned, { now: typeof now === 'function' ? now() : now ?? new Date() });
      // 交上来的条数不一定都能对上题（id 打错、option 越界），如实分开报。
      const resolved = partial.answered;
      const unmatched = cleaned.length - resolved;
      return {
        ok: true,
        batch,
        received: cleaned.length,
        accepted: resolved,
        rejected: [
          ...rejected,
          ...(unmatched > 0 ? [{ why: `${unmatched} answer(s) did not match any item or option` }] : []),
        ],
        thisBatch: {
          axes: partial.axes,
          letters: partial.letters,
          anchors: partial.anchors,
        },
        next:
          batch === 1
            ? `Now call ${QUIZ_TOOL} with batch=2 to finish, then report back.`
            : 'Both batches are in. The report now shows the four-letter type and the comparison against behaviour.',
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
