/** Local aggregate diagnostics; no external assets, unsafe HTML, model calls or raw logs. */
export function makePassivePanel(view) {
  return { async mount(ctx) {
    const titles = { tokens: 'Token 消耗', memory: '记忆状态', context: '上下文适配' };
    const el = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = String(text); return n; };
    const format = (n) => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(n) : '未知';
    const percent = (n) => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '未知';
    const root = el('div', 'sc-deep-root sc-pass-root'); ctx.root.append(root);
    const head = el('header', 'sc-pass-head'); const lead = el('div'); lead.append(el('h2', '', titles[view]), el('p', '', '日常被动诊断 · 本地只读 · 不额外调用模型'));
    const actions = el('div', 'sc-pass-actions'); head.append(lead, actions); root.append(head);
    const body = el('div'); root.append(body); let data = null, busy = false, notice = '';
    const button = (text, fn) => { const b = el('button', 'sc-deep-button', text); b.type = 'button'; b.addEventListener('click', fn, { signal: ctx.signal }); return b; };
    const box = (text, warn = false) => el('p', `sc-deep-callout${warn ? ' sc-deep-callout-warn' : ''}`, text);
    const card = (title, content, help = '') => { const n = el('section', 'sc-deep-card'); n.append(el('h3', '', title)); if (help) n.append(el('p', 'sc-pass-muted', help)); n.append(content); return n; };
    const tile = (name, value, help = '') => { const n = el('div', 'sc-deep-fact'); n.append(el('span', '', name), el('b', '', value)); if (help) n.append(el('small', '', help)); return n; };
    const tiles = (...nodes) => { const grid = el('div', 'sc-pass-grid'); grid.append(...nodes); return grid; };
    const list = (rows) => { const n = el('ul', 'sc-pass-notes'); for (const text of rows) n.append(el('li', '', text)); return n; };
    const details = (title, lines) => { const n = el('details', 'sc-deep-card'); n.append(el('summary', '', title), list(lines)); return n; };
    const table = (headers, rows) => {
      const wrap = el('div', 'sc-pass-table-wrap'); const t = el('table', 'sc-pass-table'); const h = el('tr');
      for (const text of headers) { const n = el('th', '', text); n.setAttribute('scope', 'col'); h.append(n); }
      const thead = el('thead'); thead.append(h); t.append(thead); const tbody = el('tbody');
      if (!rows.length) { const tr = el('tr'); const td = el('td', 'sc-pass-muted', '暂无可用记录'); td.setAttribute('colspan', String(headers.length)); tr.append(td); tbody.append(tr); }
      for (const row of rows) { const tr = el('tr'); for (const text of row) tr.append(el('td', '', text)); tbody.append(tr); }
      t.append(tbody); wrap.append(t); return wrap;
    };
    const bars = (rows, key = 'knownTotal') => {
      const n = el('div', 'sc-pass-bars'); const max = Math.max(1, ...rows.map((r) => r[key] ?? 0));
      if (!rows.length) return box('没有可用时段记录；缺少日志不代表消耗为零。');
      for (const row of rows) { const line = el('div', 'sc-pass-bar-row'); line.append(el('span', '', row.name)); const track = el('div', 'sc-pass-track'); const fill = el('div', 'sc-pass-fill'); fill.style.width = `${Math.max(0, row[key] ?? 0) / max * 100}%`; track.append(fill); line.append(track, el('span', '', `${format(row[key])} · ${format(row.requests)} 条`)); n.append(line); }
      return n;
    };
    function renderTokens() {
      const u = data.usage, a = data.activity;
      body.append(box(u.summary, u.complete < u.requests || u.state !== 'ready'));
      body.append(tiles(tile('已知输入', u.inputKnown ? format(u.input) : '未知', `${u.inputKnown}/${u.requests} 条已回报`),
        tile('已知输出', u.outputKnown ? format(u.output) : '未知', `${u.outputKnown}/${u.requests} 条已回报`),
        tile('已知合计', u.inputKnown + u.outputKnown ? format(u.knownTotal) : '未知', '输入 + 输出；缺报部分未计入'),
        tile('用量记录', format(u.requests), `完整计量 ${format(u.complete)} 条`),
        tile('配对样本缓存命中', percent(u.cacheRate), `${u.cacheKnown}/${u.requests} 条可计算；缓存包含在输入中`),
        tile('失败／取消／丢弃的已知量', u.requests ? format(u.failedKnown) : '未知', '计入总量；未上报用途与状态不猜测')));
      const charts = el('div', 'sc-pass-columns'); charts.append(card('每天什么时候用得多', bars(u.days), '按部署时区分日；只绘制有记录的日期，未记录日期不补零。'), card('一天中的高耗时段', bars(u.hours.slice(0, 8)), `按 ${u.timezone} 聚合各天同一小时；这是峰值分布，不直接判异常。`)); body.append(charts);
      body.append(card('同模型、同角色的历史参考', u.comparisons.length ? table(['对照组／日期', '本期单次已知量', '历史参考', '变化'], u.comparisons.map((r) => [`${r.name}\n${r.day}`, format(r.average), `${format(r.baseline)}（${r.baselineDays} 天）`, `${r.ratio.toFixed(2)} 倍 · ${r.state === 'higher' ? '较参考升高' : '未达到提示线'}`])) : box('需要至少 4 个完整历史日期，每天同模型、同角色至少 5 条完整计量；当前数据不足。'), '比较最近一个合格的完整日期与更早日期；单次均值达历史参考 1.5 倍时提示。角色相同不代表任务相同，任务变化也会影响结果。'));
      body.append(card('缓存与输出计量', tiles(tile('配对样本缓存输入', u.cacheKnown ? format(u.cached) : '未知', '已包含在输入量中'), tile('配对样本未缓存输入', format(u.uncachedPaired), '仅输入与缓存都回报的样本'), tile('已知推理 Token', u.reasoningKnown ? format(u.reasoning) : '未知', '通常属于输出，不重复加总'))));
      body.append(card('模型、角色与用途', table(['分类', '已知 Token', '用量记录', '完整计量'], [...u.byModel.slice(0, 12).map((r) => [`模型 · ${r.name}`, format(r.knownTotal), format(r.requests), `${r.complete}/${r.requests}`]), ...u.byRole.slice(0, 12).map((r) => [`角色 · ${r.name}`, format(r.knownTotal), format(r.requests), `${r.complete}/${r.requests}`]), ...u.byPurpose.map((r) => [`用途 · ${r.name}`, format(r.knownTotal), format(r.requests), `${r.complete}/${r.requests}`])]), '用途由 COO 记录上报；未标注不会推断成日常对话。'));
      body.append(card('插件独立上报的用量', table(['World ID', '已知 Token', '记录／完整'], u.worldReported.map((r) => [r.name, format(r.knownTotal), `${r.requests} / ${r.complete}`])), `仅列 worlds.<id> 仪表项，是独立上报量。共享／未归因池：${format(u.shared.knownTotal)} 已知 Token，不能按工具调用次数分配给插件。`));
      body.append(card('插件活动与回执体量', table(['来源 ID', '调用／失败', '回执字符', '典型耗时', '活动高峰'], a.rows.map((r) => [r.id, `${r.calls} / ${r.failures}`, r.charsKnown ? `${format(r.chars)}（${r.charsKnown} 条有长度）` : '未回报', r.medianMs === null ? '未知' : `${format(r.medianMs)} ms`, r.peakAt ? new Date(r.peakAt).toLocaleString('zh-CN', { timeZone: u.timezone }) : '未知'])), '排序依据是回执字符，不是 Token 费用；回执只是可能进入后续请求的一部分，未做字符转 Token 或共享账单归因。'));
      body.append(details('数据覆盖与口径', [u.limits, `usage 来源：${u.state}；采样截断：${u.source.limited ? '是' : '否'}；坏行 ${u.source.bad}；无效时间 ${u.source.invalidTime}；明确 ID 去重 ${u.source.duplicates}。`, `工具活动来源：${a.state}；扫描 ${a.files} 份日志；采样上限触发：${a.limited ? '是' : '否'}；不可读 ${a.unreadable ?? 0} 份；坏行 ${a.bad ?? 0}。`, '用量日志最多读取末尾 8 MiB／20,000 行；工具日志最多 256 个运行目录、每份末尾 256 KiB／1,000 行。达到上限时只代表窗口内样本。', '没有来源分块、可靠分词与请求关联证据时，不显示精确插件 Token 榜、前缀 Token 或记忆注入 Token。']));
    }
    function renderMemory() {
      const m = data.memory; body.append(box(m.summary));
      body.append(tiles(tile('宿主清单', ({ ready: '已读取', 'not-read': '尚未读取', unavailable: '宿主未提供' })[m.inventoryState] ?? '未能核实', '清单不证明记忆类型或调用链'), tile('主动检测的记忆实现', '0', '本页只读观察'), tile('当前会话正在使用', '未核实', '不能按目录或安装状态推断')));
      const refresh = button('读取宿主插件清单', async () => {
        if (busy) return; busy = true; refresh.disabled = true;
        try { const result = await ctx.invoke('passiveInventory', []); notice = result.ok ? '已尝试读取宿主白名单元数据；未读取设置、记忆正文或密钥。' : '当前宿主未提供可用清单接口，安装与使用情况保持未知。'; ctx.ui?.toast?.(notice, 'plain'); await load(false); }
        catch { notice = '读取清单失败；不据此判断插件未安装。'; render(); }
        finally { busy = false; refresh.disabled = false; }
      }); body.append(refresh);
      body.append(card('实际覆盖到哪里', table(['来源／版本', '状态', '启用', '当前使用／主动检测', '证据与边界'], m.rows.map((r) => [r.version ? `${r.name}\n${r.version}` : r.name, ({ listed: '宿主列出', observed: '文件可读', missing: '路径缺失', unreadable: '读取失败', 'not-directory': '不是目录' })[r.status] ?? '未知', r.enabled === null ? '未知' : r.enabled ? '已启用' : '已禁用', '未核实／未执行', `${r.evidence}。${r.detail}`]))));
      if (m.telemetry) { const t = m.telemetry; body.append(card(t.name, tiles(tile('条目样本', format(t.count)), tile('检索次数', format(t.retrievals)), tile('返回候选的比例', percent(t.hitRate)), tile('标注为已注入的比例', percent(t.injectedRate)), tile('平均检索耗时', t.avgMs === null ? '未知' : `${format(t.avgMs)} ms`)), t.detail)); }
      else body.append(box('没有可用的兼容记忆日志统计。这可能是原生实现、其它插件格式、尚无活动或日志不可读，不能直接判定没有记忆或记忆故障。'));
      body.append(details('如何理解记忆状态', m.limitations));
    }
    function renderContext() {
      const c = data.context; body.append(box(c.summary));
      body.append(tiles(tile('上下文配置目标', format(c.configured), '不是每次请求都使用这么多'), tile('当前模型标称窗口', format(c.modelWindow), '不等于扣除输出后的有效输入上限'), tile('请求输入中位数', format(c.estimatedMedianInput), `${c.inputSamples} 个主会话计量样本`), tile('请求输入 P90', format(c.p90Input), '90% 样本不超过此位置附近的输入量'), tile('实时上下文占用', '尚不可测', 'World 未获得实时占用接口'), tile('有日期的交接笔记', c.handoffSource === 'ready' ? format(c.handoffs) : '来源不可用', c.handoffLimited ? '至少达到 30 份采样上限' : '笔记数不等于完整交接次数')));
      body.append(card('当前策略与观测', table(['项目', '值', '解释'], [['软交接比例', percent(c.softRatio), '配置值，不证明实际由此触发'], ['软目标 Token', format(c.softTarget), '配置目标 × 软比例'], ['保留比例', percent(c.keepRatio), '保留策略，不等于知识保留率'], ['观察到的最大请求输入', format(c.maxObservedInput), '可能含历史模型与配置，不能与当前窗口直接算占用率'], ['输入达到配置目标 85% 的样本', format(c.samplesNearTarget), '仅体量提示线，不是 COO 实际触发线'], ['交接前后 Token／触发原因／成本', '未获得可关联证据', '不凭笔记大小、条数或文件修改时间推断']])));
      body.append(card('该怎么调整', box(c.advice), '本页不自动修改配置。128K、256K 都需要结合实际任务和模型能力判断。'));
      body.append(details('观测边界与下一步', c.limitations));
    }
    function render() {
      body.replaceChildren(); if (!data) { body.append(box(notice || '正在读取本机聚合记录…')); return; }
      body.append(el('p', 'sc-pass-muted', `${data.sampleDays} 天窗口 · ${data.usage.timezone} · 更新于 ${new Date(data.generatedAt).toLocaleString('zh-CN')} · 以下为已知样本`));
      if (notice) body.append(box(notice));
      ({ tokens: renderTokens, memory: renderMemory, context: renderContext })[view]();
      body.append(el('p', 'sc-pass-muted', data.disclosure));
    }
    async function load(force) {
      try { const result = await ctx.invoke('passiveReport', [!!force]); if (ctx.signal?.aborted) return; if (!result?.ok || !result.report) throw Error('unavailable'); data = result.report; render(); }
      catch { notice = '读取诊断记录失败，请稍后刷新。未用演示数据替代真实统计。'; render(); }
    }
    const refresh = button('刷新数据', async () => { if (busy) return; busy = true; refresh.disabled = true; try { await load(true); } finally { busy = false; refresh.disabled = false; } });
    const download = button('导出诊断报告', async () => {
      try { const result = await ctx.invoke('passiveText', []); if (!result?.ok) throw Error('export'); const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' })); const a = el('a'); a.href = url; a.download = '鱼鱼体检-日常被动诊断.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      catch { notice = '导出未完成，请稍后重试。'; render(); }
    });
    actions.append(refresh, download); render(); await load(false);
  } };
}
