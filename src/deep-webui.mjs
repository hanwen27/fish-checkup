/** Inlined into dist/webui.js by tools/sync-deep-webui.mjs. No external dependencies. */
export function makeDeepCheckupPanel() {
  return {
    async mount(ctx) {
      const make = (tag, className = '', text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
      };
      const groupNames = { context: '上下文保持', instructions: '指令保持', 'working-memory': '会话内事实更新（非插件记忆测试）' };
      const states = { running: '进行中', stopping: '正在停止，等待在途请求结算', stopped: '已停止', completed: '检测完成', paused: '已暂停', failed: '执行失败', interrupted: '上次运行被中断' };
      const reasonNames = {
        'isolated-executor-unavailable': '当前 COO 未提供隔离执行器，暂不能启动深度体检。',
        'reservation-or-context-unavailable': '无法核对请求预算，或所选长度档超过当前上下文容量。',
        'budget-too-small': '本次题集超过执行预留上限。请核对 Token 上限或减少测试组后重新预检；仍受限时需检查执行器。',
        'preflight-expired': '预检已过期，请重新预检并确认。',
        'configuration-changed': '模型或配置已变化，需重新预检。',
        'consent-required': '开始前需要明确确认本次数据范围与 Token 上限。',
        'usage-unavailable': '存在未回报用量，后续请求已暂停。',
        'request-failed': '请求失败，已计入可确认用量并停止后续请求。',
        'request-timeout': '请求超时，已请求取消并停止后续请求。',
        'storage-unavailable': '无法可靠保存检测状态，检测未继续。',
        'storage-invalid': '现有检测记录损坏或无法读取，核对完成前不能启动新检测。',
        'user-stopped': '用户请求停止。', 'process-restarted': '进程曾重启，在途用量可能尚未回报。',
        'budget-reached': '达到本次运行保护上限。', 'already-running': '已有检测正在运行。',
        'previous-usage-unsettled': '上次运行仍有未结算用量，核对完成前不能启动新检测。',
        'world-stopped': '插件已停止，后续请求已取消。',
        'cooperative-host-unavailable': 'COO 隔离运行桥尚未接入，无法启动真实链路检测。',
        'cooperative-inspection-failed': '未能核对 COO 隔离运行环境，暂不能开始。',
        'model-transport-unavailable': '当前没有可核验计数与单次请求限制的模型执行器；可先选择本地机制验证。',
        'cleanup-unverified': '上次测试空间清理未能验证，核对完成前不能开始下一轮。',
        'preflight-preparation-failed': '本地材料预检失败，未发送模型请求。',
        'cooperative-execution-failed': 'COO 测试步骤未能完成，请查看运行证据；不能据此判定模型能力差。',
        'executor-limit-violation': '执行器用量或尝试次数超出约定，已暂停后续步骤。',
      };
      const explain = (code) => reasonNames[code] ?? (String(code ?? '').startsWith('capability-') ? '执行器缺少强制隔离、计量或停止能力。' : '无法完成操作，请检查执行器状态后重新预检。');
      const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '待核算';
      const active = () => ['running', 'stopping'].includes(status?.run?.state);
      ctx.root.classList.add('sc-panel');
      const root = make('div', 'sc-root sc-deep-root');
      ctx.root.append(root);
      let stage = globalThis.location?.hash === '#cooperative' ? 'cooperative' : 'preflight';
      let preflight = null;
      let status = null;
      let cooperativeStatus = null;
      let cooperativePlan = null;
      let cooperativeInventory = null;
      let cooperativeMode = 'mechanism';
      let cooperativeGroups = new Set(['handoff', 'memory']);
      let cooperativeConsent = false;
      let error = '';
      let busy = false;
      let polling = false;
      let selected = new Set(Object.keys(groupNames));
      let limits = { maxRequests: 20, maxInputTokens: 160000, maxOutputTokens: 4096, maxCostCny: 2 };

      const button = (text, action, primary = false, disabled = false) => {
        const node = make('button', `sc-deep-button${primary ? ' sc-deep-button-primary' : ''}`, text);
        node.type = 'button'; node.disabled = disabled;
        node.addEventListener('click', action, { signal: ctx.signal });
        return node;
      };
      const section = (title, body, note) => {
        const panel = make('section', 'sc-deep-card');
        const head = make('div', 'sc-deep-card-heading');
        head.append(make('h3', '', title));
        if (note) head.append(make('span', '', note));
        panel.append(head, body);
        return panel;
      };
      const fact = (label, value, note = '') => {
        const node = make('div', 'sc-deep-fact');
        node.append(make('span', '', label), make('b', '', value));
        if (note) node.append(make('small', '', note));
        return node;
      };
      const note = (text, warn = false) => make('div', `sc-deep-callout${warn ? ' sc-deep-callout-warn' : ''}`, text);

      async function call(method, args = []) {
        const value = await ctx.invoke(method, args);
        if (!value?.ok) throw new Error(value?.error ?? 'request-failed');
        return value;
      }
      async function prepare() {
        preflight = await call('deepPreflight', [{ groups: [...selected], limits }]);
      }
      async function prepareCooperative() {
        cooperativePlan = await call('cooperativePreflight', [{ mode: cooperativeMode, groups: [...cooperativeGroups] }]);
        cooperativeConsent = false;
      }
      async function refreshPreflight() {
        if (busy) return;
        busy = true; error = ''; paint();
        try { await prepare(); } catch (failure) { preflight = null; error = explain(failure.message); }
        finally { busy = false; if (!ctx.signal.aborted) paint(); }
      }
      async function start() {
        if (busy || !preflight?.ready) return;
        busy = true; error = '';
        const plan = preflight.plan;
        paint();
        try {
          await call('deepStart', [{ planId: plan.id, disclosureHash: plan.disclosureHash, accepted: true }]);
          preflight = null;
          status = await call('deepStatus'); stage = 'running';
        } catch (failure) { error = explain(failure.message); preflight = null; }
        finally { busy = false; if (!ctx.signal.aborted) paint(); }
      }
      async function stop() {
        if (busy) return;
        busy = true; error = ''; paint();
        try { await call('deepStop'); status = await call('deepStatus'); }
        catch (failure) { error = explain(failure.message); }
        finally { busy = false; if (!ctx.signal.aborted) paint(); }
      }
      function invalidate() { preflight = null; }

      function memoryScopeCard(scope) {
        const content = make('div', 'sc-deep-card-body');
        if (!scope) { content.append(note('未取得记忆检测对象信息，不能据此判断任何原生记忆或插件已被检测。')); }
        else {
          content.append(note(scope.explanation));
          for (const target of scope.targets) {
            const row = make('div', 'sc-deep-disclosure');
            row.append(make('h4', '', `${target.name} · ${target.status}`), make('p', '', target.detail));
            content.append(row);
          }
        }
        return section('记忆检测范围', content, '原生记忆与插件分别列明');
      }

      function renderPreflight(content) {
        const lead = make('div', 'sc-deep-intro');
        lead.append(make('h2', '', '深度体检'), make('p', '', '受控调用当前模型，观察上下文保持、指令遵循和会话内事实更新。结果只适用于本次配置与题集，不生成综合总分。'));
        content.append(lead, note('本次测试会消耗 Token。开始前请确认发送范围、Token 上限与预计耗时；已发出的请求即使停止，也可能继续消耗 Token。', true));
        if (preflight && !preflight.ready) {
          const blockers = preflight.blockers?.length ? preflight.blockers : preflight.capability?.blockers ?? [];
          content.append(note([...new Set(blockers.map(explain))].join(' '), true));
        }
        const budget = make('div', 'sc-deep-budget-grid sc-deep-preflight-grid');
        const plan = preflight?.plan;
        budget.append(fact('模型', plan?.model ?? status?.capability?.model ?? '未选择'),
          fact('预计请求', plan ? `${num(plan.totals.requests)} 次` : '待预检'),
          fact('输入 / 输出 Token 上限', plan ? `${num(plan.totals.inputTokens)} / ${num(plan.totals.outputTokens)}` : '待核算', '输入是发送的材料，输出是模型的回答；这里显示预留上限'),
          fact('预计耗时', plan?.durationMs ? `${num(plan.durationMs[0] / 60000)}–${num(plan.durationMs[1] / 60000)} 分钟` : '暂无可靠估时', '缺少匹配样本时不填固定时间'),
          fact('数据类型', '合成测试材料', '不读取真实对话与用户记忆；另含执行器声明的提示'),
          fact('运行方式', '独立测试 · 顺序执行', '不调用工具，不写持久记忆，不自动重试'));
        content.append(section('用量上限与运行条件', budget, '预检不调用模型'));
        content.append(memoryScopeCard(status?.memoryScope));
        const columns = make('div', 'sc-deep-columns');
        const groups = make('div', 'sc-deep-card-body');
        for (const [key, name] of Object.entries(groupNames)) {
          const row = make('label', 'sc-deep-option');
          const input = make('input'); input.type = 'checkbox'; input.checked = selected.has(key); input.disabled = busy || active();
          input.addEventListener('change', () => { input.checked ? selected.add(key) : selected.delete(key); invalidate(); paint(); }, { signal: ctx.signal });
          const copy = make('div'); copy.append(make('b', '', name), make('small', '', {
            context: '2K / 8K / 16K 合成字符档，覆盖首、中、尾三个位置。精确 Token 预算单独核算。',
            instructions: '多轮合成消息中的格式约束与干扰，不模拟真实自动交接。',
            'working-memory': '同一隔离请求内的事实更正，不代表持久记忆插件的录入或召回。',
          }[key])); row.append(input, copy); groups.append(row);
        }
        const fields = make('div', 'sc-deep-limit-grid');
        for (const [key, label, step] of [['maxRequests', '请求上限', '1'], ['maxInputTokens', '输入 Token 上限', '1'], ['maxOutputTokens', '输出 Token 上限', '1']]) {
          const row = make('label'); row.append(make('span', '', label));
          const input = make('input', 'sc-deep-number'); input.type = 'number'; input.value = String(limits[key]); input.min = step; input.step = step; input.disabled = busy || active();
          input.addEventListener('change', () => { limits[key] = Number(input.value); invalidate(); paint(); }, { signal: ctx.signal });
          row.append(input); fields.append(row);
        }
        groups.append(fields);
        const privacy = make('div', 'sc-deep-card-body');
        privacy.append(note('本版使用合成材料，主要需要留意 Token 消耗和模型服务的数据处理。确认后才会发起请求。'));
        privacy.append(make('p', '', '合成材料与预检列明的提示内容将发送给所选模型服务方；本版不读取真实对话或用户记忆，不调用工具、不写持久记忆。'));
        privacy.append(make('p', '', '请核对上方 Token 上限和预计耗时。点击停止仅阻止后续请求，已发出的请求仍可能消耗 Token；关闭页面不会停止任务。'));
        if (preflight?.capability?.dataScope) privacy.append(make('p', '', `执行器发送范围：${preflight.capability.dataScope}`));
        const disclosureDetails = make('details');
        disclosureDetails.append(make('summary', '', '查看数据处理、运行保护与结果记录详情'));
        for (const text of preflight?.disclosure ?? [
          '数据发送与隐私：仅计划发送合成材料与执行器声明的提示内容，不读取真实对话或用户记忆。当前完整发送范围尚未核验，不能启动。服务方的数据处理与保留按其自身规则执行，本插件不作不留存承诺。',
          'Token 与运行占用：启动后会消耗 Token 与账号额度，失败或停止的请求也可能有消耗。预留不是实耗，未回报用量不记为零；运行中请勿切换模型或配置。',
          '隔离与副作用边界：本版不写入持久记忆、不调用工具、不自动重试。执行器的独立测试、用量上限与停止能力不满足要求时禁止启动。',
          '停止与异常：停止只阻止后续请求，已发送的请求可能继续消耗 Token；关闭页面不会停止任务。用量缺失、配置变化或达到保护上限时停止后续请求。',
          '结果用途与记录：仅描述当前配置下的少量合成样本，不保证日常表现，不直接推荐修改设置。本地仅保留最近一轮题号、判定与计量，不保存原始提示或回答。导出文件请妥善保管。',
        ]) {
          const split = text.indexOf('：');
          if (split < 0) { disclosureDetails.append(make('p', '', text)); continue; }
          const row = make('div', 'sc-deep-disclosure');
          row.append(make('h4', '', text.slice(0, split)), make('p', '', text.slice(split + 1)));
          disclosureDetails.append(row);
        }
        privacy.append(disclosureDetails);
        columns.append(section('检测项目与 Token 上限', groups), section('开始前须知', privacy, '用量、数据和停止规则')); content.append(columns);
        const actions = make('div', 'sc-deep-actions');
        const refresh = button(busy ? '正在预检…' : '重新预检', () => void refreshPreflight(), false, busy || active() || !selected.size);
        actions.append(refresh);
        const consent = make('label', 'sc-deep-consent');
        const check = make('input'); check.type = 'checkbox'; check.disabled = busy || active() || !preflight?.ready;
        const launch = button('开始深度体检', () => void start(), true, true);
        check.addEventListener('change', () => { launch.disabled = !check.checked || !preflight?.ready || busy; }, { signal: ctx.signal });
        consent.append(check, make('span', '', '我已阅读开始前须知，了解数据会发送给所选模型服务方、测试会消耗 Token、停止不撤销已发请求，以及本次结果的适用范围；同意按上述预检范围开始。'));
        content.append(consent); actions.append(launch); content.append(actions);
        if (plan) content.append(make('p', 'sc-deep-footnote', '预检 5 分钟内有效；任何配置或 Token 上限变更都需重新确认。关闭页面不会自动停止运行，请使用停止按钮。'));
      }

      function renderRun(content) {
        const run = status?.run;
        if (!run) { content.append(note('尚无检测记录。请先完成预检并明确确认。')); return; }
        const intro = make('div', 'sc-deep-intro'); intro.append(make('h2', '', states[run.state] ?? '状态未知'), make('p', '', `运行编号 ${run.id} · 方法 ${run.method} · 当前项目 ${run.current ?? '无在途项目'}`)); content.append(intro);
        const stats = make('div', 'sc-deep-budget-grid sc-deep-usage-grid');
        stats.append(fact('已发请求', `${run.requests} / ${run.totals.requests}`), fact('输入 Token', num(run.usage.inputTokens)), fact('输出 Token', num(run.usage.outputTokens)), fact('累计 Token', num(run.usage.inputTokens + run.usage.outputTokens), '已回报输入 + 输出；不包含未知用量'));
        content.append(section('实时消耗', stats, run.usage.complete ? '已回报用量' : '存在未回报用量'));
        if (run.reason) content.append(note(explain(run.reason), true));
        if (run.unsettled) content.append(note(`尚未回报用量的请求预留：输入 ${num(run.unsettled.inputTokens)} / 输出 ${num(run.unsettled.outputTokens)} Token。这是上限，不是实耗；不能把未知用量算成零。`, true));
        const progress = make('progress', 'sc-deep-native-progress'); progress.max = run.totals.requests; progress.value = run.results.length; progress.setAttribute('aria-label', '已完成请求比例'); content.append(progress);
        const actions = make('div', 'sc-deep-actions'); actions.append(button(run.state === 'stopping' ? '等待在途请求结算' : '停止测试', () => void stop(), false, busy || !active() || run.state === 'stopping'));
        actions.append(make('span', 'sc-deep-footnote', '停止阻止后续请求，在途请求可能继续消耗 Token。关页后任务继续。')); content.append(actions);
      }

      function renderReport(content) {
        const run = status?.run; const report = status?.report;
        if (!run || !report) { content.append(note('尚无深度体检报告。未执行的项目不会显示演示成绩。')); return; }
        content.append(make('h2', '', '深度体检报告'), note(`${states[run.state] ?? run.state} · 不生成综合总分。仅描述本次题集与当前配置。`));
        content.append(section('结果速读', note(report.summary)));
        content.append(memoryScopeCard(report.memoryScope));
        const facts = make('div', 'sc-deep-budget-grid');
        facts.append(fact('模型', run.model), fact('运行方法', run.method), fact('输入 / 输出 Token', `${num(run.usage.inputTokens)} / ${num(run.usage.outputTokens)}`, '仅含已回报用量，包含失败请求的已知消耗'), fact('计量状态', run.usage.complete && !run.unsettled ? '已回报' : '存在未回报用量'));
        content.append(section('本次运行条件与消耗', facts));
        const readings = make('div', 'sc-deep-reading-grid');
        for (const item of report.groups) {
          const card = make('article', 'sc-deep-reading');
          card.append(make('h3', '', item.name), make('span', 'sc-deep-pill', item.outcomeLabel),
            make('p', '', item.explanation), make('h4', '', '建议下一步'), make('p', '', item.nextStep));
          readings.append(card);
        }
        content.append(section('对你意味着什么', readings, '先看解读，再按需查看下方证据'));
        const rows = make('div', 'sc-deep-table-wrap'); const table = make('table', 'sc-deep-table');
        const header = make('tr'); for (const label of ['项目', '结论', '有效 / 计划', '通过 / 未通过', '无效', '未执行', '证据强度']) header.append(make('th', '', label)); const head = make('thead'); head.append(header); table.append(head);
        const body = make('tbody');
        for (const item of report.groups) {
          const row = make('tr');
          for (const value of [item.name, item.outcomeLabel, `${item.valid} / ${item.planned}`, `${item.pass} / ${item.fail}`, item.invalid, item.notRun, item.evidenceLabel]) row.append(make('td', '', value));
          body.append(row);
        }
        table.append(body); rows.append(table); content.append(section('分项结果与证据', rows));
        if (report.lengths?.length) {
          const lengths = make('div', 'sc-deep-card-body');
          const positionNames = { begin: '首部', middle: '中部', end: '尾部' };
          const outcomes = { pass: '通过', fail: '未通过', invalid: '无效' };
          for (const length of report.lengths) lengths.append(make('p', '', `${length.label}：${length.samples.map((sample) => `${positionNames[sample.position] ?? sample.position} ${outcomes[sample.outcome] ?? '未知'}`).join(' · ')}`));
          lengths.append(make('p', '', '每个位置仅一个样本，字符档不等于 Token 窗口；当前证据不足以推荐扩大或缩短上下文。'));
          content.append(section('上下文长度档证据', lengths));
        }
        const terms = make('details', 'sc-deep-card-body'); terms.append(make('summary', '', '看不懂术语？查看测试内容与判读方法'));
        for (const item of report.groups) terms.append(make('p', '', `${item.name}：${item.purpose}`));
        terms.append(make('p', '', '有效样本：能完成判分的回答。无效请求：超时、取消或缺少用量等，不能当作模型能力差。通过：符合本题预设答案，不等于日常使用永不出错。'),
          make('p', '', '证据强度：描述本次样本覆盖程度，不是统计置信度或长期可靠率。字符档：测试材料的字符数量，不等于模型的 Token 窗口。'));
        content.append(terms);
        const details = make('details', 'sc-deep-card-body'); details.append(make('summary', '', '查看逐项合成测试证据'));
        for (const item of report.evidence) details.append(make('p', 'sc-deep-footnote', `${item.id} · ${item.outcome} · ${item.reason}`)); content.append(details);
        content.append(note(`未覆盖：${report.untested.join('、')}。${report.limitations.join(' ')}`));
        if (!run.usage.complete || run.unsettled) content.append(note('用量回报不完整，已回报 Token 只是已知部分。请查看运行状态中的未回报请求预留，不要把未知用量当作零。', true));
        const actions = make('div', 'sc-deep-actions');
        actions.append(button('导出文字报告', async () => {
          try {
            const result = await call('deepText');
            const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }));
            const link = make('a'); link.href = url; link.download = `deep-checkup-${run.id}.txt`; link.click();
            ctx.timeout(() => URL.revokeObjectURL(url), 1000);
          } catch { error = '报告导出失败，请稍后重试。'; paint(); }
        })); content.append(actions);
      }

      function renderCooperative(content) {
        const capability = cooperativeStatus?.capability;
        const intro = make('div', 'sc-deep-intro');
        intro.append(make('h2', '', 'COO 协作链路验证'), make('p', '', '在独立本地目录运行 COO 原生交接与记忆存储机制。模型对照仅在宿主提供可靠隔离和 Token 计量时开放。不会操作当前主会话。'));
        content.append(intro, note(capability?.ready
          ? `检测策略：${capability.runtime.origin === 'live-host' ? '当前 COO 运行设置' : '示例设置（不是当前配置）'}；阶段 ${num(capability.runtime.stageTokens)} Token，软线 ${num(capability.runtime.softTokens)}，交接笔记预算 ${num(capability.runtime.noteBudgetTokens)}。`
          : 'COO 隔离运行桥尚未接入。此页不会退回普通认知请求或模拟真实 COO 结果。', !capability?.ready));
        if (capability?.source) content.append(note(`源码依据：${capability.source.name}；指纹 ${capability.source.fingerprint.slice(0, 16)}。`));
        const inventory = make('div', 'sc-deep-actions');
        inventory.append(button('读取插件清单', async () => {
          ctx.ui.toast('体检将读取本机插件清单中的名称、类型和版本；不读取记忆正文，不发送给模型。', 'ok');
          try { cooperativeInventory = await call('cooperativeInventory'); } catch { cooperativeInventory = { inventory: { status: 'unavailable', rows: [], detail: '清单接口不可用，无法判断安装情况。' } }; }
          paint();
        }, false, !capability?.ready || busy || activeCooperative()));
        content.append(inventory);
        if (cooperativeInventory?.inventory) {
          const card = make('div', 'sc-deep-card-body');
          card.append(make('p', '', cooperativeInventory.inventory.detail));
          for (const row of cooperativeInventory.inventory.rows ?? []) card.append(make('p', 'sc-deep-footnote', `${row.name} · ${row.kind} · ${row.version} · ${row.enabled === null ? '启用状态未知' : row.enabled ? '已启用' : '未启用'}`));
          content.append(section('本机扩展清单', card, cooperativeInventory.inventory.status));
        }
        if (cooperativeStatus?.run) renderCooperativeResult(content, cooperativeStatus.run);
        const controls = make('div', 'sc-deep-card-body');
        const mode = make('select', 'sc-deep-number');
        for (const [value, label] of [['mechanism', '仅本地机制验证，不调用模型'], ['model', '机制验证 + 模型前后对照']]) {
          const option = make('option', '', label); option.value = value; option.selected = cooperativeMode === value; mode.append(option);
        }
        mode.disabled = busy || activeCooperative(); mode.addEventListener('change', () => { cooperativeMode = mode.value; cooperativePlan = null; cooperativeConsent = false; paint(); }, { signal: ctx.signal });
        controls.append(mode);
        for (const [key, label, detail] of [['context', '128K／256K 长上下文', '25%／50%／75% 三档；完整请求 Token 计数'], ['handoff', '真实交接保留', '开始／中段／末段合成任务；手动触发交接'], ['memory', '隔离记忆生命周期', '写入→新会话读取→更正→删除验证']]) {
          const row = make('label', 'sc-deep-option'); const check = make('input'); check.type = 'checkbox'; check.checked = cooperativeGroups.has(key);
          check.disabled = busy || activeCooperative() || (key === 'context' && cooperativeMode !== 'model');
          check.addEventListener('change', () => { check.checked ? cooperativeGroups.add(key) : cooperativeGroups.delete(key); cooperativePlan = null; cooperativeConsent = false; paint(); }, { signal: ctx.signal });
          row.append(check, make('span', '', label), make('small', '', detail)); controls.append(row);
        }
        const actions = make('div', 'sc-deep-actions');
        actions.append(button(busy ? '正在预检…' : '核算本次范围与 Token', async () => {
          busy = true; cooperativePlan = null; paint();
          try { await prepareCooperative(); } catch (failure) { error = explain(failure.message); }
          finally { busy = false; if (!ctx.signal.aborted) paint(); }
        }, false, !capability?.ready || busy || activeCooperative() || !cooperativeGroups.size));
        content.append(section('选择检测范围', controls), actions);
        if (cooperativePlan) {
          const panel = make('div', 'sc-deep-card-body');
          panel.append(note(cooperativePlan.ready ? `预计模型请求 ${num(cooperativePlan.plan.totals.requests)} 次；输入上限 ${num(cooperativePlan.plan.totals.inputTokens)} Token；输出上限 ${num(cooperativePlan.plan.totals.outputTokens)} Token。${cooperativePlan.plan.mode === 'mechanism' ? '机制模式不调用模型。' : '已按模型计数器核算；发送材料与处理规则见下方说明。'}` : `本次不能启动：${explain(cooperativePlan.error)}`, !cooperativePlan.ready));
          if (cooperativePlan.ready) panel.append(make('p', 'sc-deep-footnote', '预计耗时：暂无可靠估时。缺少相同模型与配置的延迟样本，不沿用旧版固定时间。'));
          if (cooperativePlan.disclosure) {
            const details = make('details', 'sc-deep-card-body'); details.append(make('summary', '', '查看本次数据、隔离、停止与清理说明'));
            for (const text of cooperativePlan.disclosure) details.append(make('p', '', text)); panel.append(details);
          }
          if (cooperativePlan.ready) {
            const consent = make('label', 'sc-deep-option'); const check = make('input'); check.type = 'checkbox'; check.checked = cooperativeConsent;
            check.addEventListener('change', () => { cooperativeConsent = check.checked; paint(); }, { signal: ctx.signal });
            consent.append(check, make('span', '', '我已核对本次范围、Token 上限和数据说明，同意只在隔离测试目录运行。'));
            const run = button('开始 COO 协作检测', async () => {
              if (!cooperativeConsent || busy) return;
              busy = true; paint();
              try { await call('cooperativeStart', [{ planId: cooperativePlan.plan.id, disclosureHash: cooperativePlan.plan.disclosureHash, accepted: true }]); cooperativePlan = null; cooperativeStatus = await call('cooperativeStatus'); stage = 'cooperative'; }
              catch (failure) { error = explain(failure.message); }
              finally { busy = false; if (!ctx.signal.aborted) paint(); }
            }, true, !cooperativeConsent || busy);
            panel.append(consent, run);
          }
          content.append(section('启动前预检', panel));
        }
      }

      function activeCooperative() { return ['running', 'stopping'].includes(cooperativeStatus?.run?.state); }
      function renderCooperativeResult(content, run) {
        const facts = make('div', 'sc-deep-budget-grid');
        facts.append(fact('运行状态', states[run.state] ?? run.state), fact('模式', run.mode === 'model' ? '模型 + COO 机制' : '仅 COO 机制'),
          fact('已回报输入 / 输出 Token', `${num(run.usage.inputTokens)} / ${num(run.usage.outputTokens)}`),
          fact('累计 Token', num(run.usage.inputTokens + run.usage.outputTokens), run.unsettled ? '还有未回报用量，此处不是完整消耗' : '只统计已回报用量'),
          fact('本机隔离目录清理', ({ verified: '已验证', unverified: '未验证', pending: '等待收尾' })[run.cleanup?.status] ?? '处理中'), fact('策略来源', run.runtime.origin === 'live-host' ? '当前 COO' : '示例策略'));
        content.append(section('本次运行与实时消耗', facts));
        if (run.reason) content.append(note(`暂停或停止原因：${explain(run.reason)} 未完成项不会当作模型能力失败。`, true));
        if (run.unsettled) content.append(note('存在未回报模型请求，已停止后续模型调用；已知 Token 不能视为全部消耗。', true));
        for (const row of run.results ?? []) {
          const card = make('div', 'sc-deep-reading');
          const label = ({ 'handoff-begin': '交接保留 · 信息位于开头', 'handoff-middle': '交接保留 · 信息位于中段', 'handoff-end': '交接保留 · 信息位于末尾' })[row.id]
            ?? (row.group === 'context' ? `长上下文 · ${num(row.evidence?.targetInputTokens)} Token 档` : row.target?.name ?? row.id);
          const outcome = ({ pass: '通过', fail: '未通过', invalid: '证据不足' })[row.outcome] ?? row.outcome;
          card.append(make('h3', '', label), make('span', 'sc-deep-pill', `${row.group === 'handoff' ? '机制' : ''}${outcome}`), make('p', '', row.explanation));
          if (row.model) card.append(make('span', 'sc-deep-pill', row.model.baseline ? row.model.after ? '回答对照通过' : '回答需复测' : '基线未通过，无法归因'),
            make('p', '', row.model.attribution));
          if (row.evidence) {
            const details = make('details', 'sc-deep-card-body'); details.append(make('summary', '', '查看可核验运行证据'));
            details.append(make('pre', 'sc-deep-footnote', JSON.stringify(row.evidence, null, 2))); card.append(details);
          }
          content.append(card);
        }
        if (run.cleanup?.status === 'unverified') content.append(note('独立目录清理未能验证，已阻止继续运行。请先检查并处理清理状态。', true));
        if (activeCooperative()) content.append(button('停止后续步骤', async () => { await call('cooperativeStop'); cooperativeStatus = await call('cooperativeStatus'); paint(); }, false));
        if (!activeCooperative() && run.cleanup?.status === 'verified') content.append(button('导出文字报告', async () => {
          try { const result = await call('cooperativeText'); const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }));
            const link = make('a'); link.href = url; link.download = `coo-deep-checkup-${run.id}.txt`; link.click(); ctx.timeout(() => URL.revokeObjectURL(url), 1000);
          } catch { error = '报告导出失败，请稍后重试。'; paint(); }
        }));
      }

      function paint() {
        if (ctx.signal.aborted) return;
        root.replaceChildren();
        const tabs = make('nav', 'sc-deep-tabs'); tabs.setAttribute('aria-label', '深度体检阶段');
        for (const [key, text] of [['preflight', '启动前'], ['running', '运行中'], ['report', '结果报告'], ['cooperative', 'COO 链路验证']]) {
          const tab = button(text, () => { stage = key; error = ''; paint(); });
          tab.className = `sc-deep-tab${stage === key ? ' is-active' : ''}`; tab.setAttribute('aria-current', stage === key ? 'page' : 'false'); tabs.append(tab);
        }
        root.append(tabs);
        if (status?.storageError || status?.loadError) root.append(note('检测记录未能可靠保存或读取；请先核对本地记录，避免遗漏未结算消耗。', true));
        if (error) { const node = note(error, true); node.setAttribute('role', 'alert'); root.append(node); }
        const content = make('div', 'sc-deep-content'); root.append(content);
        if (stage === 'running') renderRun(content); else if (stage === 'report') renderReport(content); else if (stage === 'cooperative') renderCooperative(content); else renderPreflight(content);
      }

      paint();
      try {
        status = await call('deepStatus');
        if (active()) stage = 'running'; else await prepare();
      } catch (failure) { error = explain(failure.message); }
      try { cooperativeStatus = await call('cooperativeStatus'); if (activeCooperative()) stage = 'cooperative'; } catch { /* host bridge reports its unavailable state in this tab when wired */ }
      if (!ctx.signal.aborted) paint();
      ctx.interval(async () => {
        if (ctx.signal.aborted || polling || busy || (!active() && !activeCooperative())) return;
        polling = true;
        try {
          if (activeCooperative()) cooperativeStatus = await call('cooperativeStatus');
          else status = await call('deepStatus');
          if (!ctx.signal.aborted && stage !== 'preflight') paint();
        }
        catch { error = '状态更新失败，任务可能仍在运行。请恢复连接后检查。'; if (stage !== 'preflight') paint(); }
        finally { polling = false; }
      }, 1500);
    },
  };
}
