/** Local aggregate diagnostics; no external assets, unsafe HTML, model calls or raw logs. */
export function makePassivePanel(view) {
  return { async mount(ctx) {
    const titles = { tokens: 'Token 消耗', memory: '记忆状态', context: '上下文适配' };
    const el = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = String(text); return n; };
    const format = (n) => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(n) : '未知';
    const formatTokenCompact = (n) => !Number.isFinite(n) ? '未知' : n < 1000 ? format(n) : n < 1000000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1000000).toFixed(1)}M`;
    const token = (n) => ({ text: formatTokenCompact(n), title: Number.isFinite(n) ? String(n) : null });
    const percent = (n) => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '未知';
    const root = el('div', 'sc-deep-root sc-pass-root'); ctx.root.append(root);
    const head = el('header', 'sc-pass-head'); const lead = el('div'); lead.append(el('h2', '', titles[view]), el('p', '', '日常被动诊断 · 本地只读 · 不额外调用模型'));
    const actions = el('div', 'sc-pass-actions'); head.append(lead, actions); root.append(head);
    const body = el('div'); root.append(body); let data = null, busy = false, notice = '';
    const button = (text, fn) => { const b = el('button', 'sc-deep-button', text); b.type = 'button'; b.addEventListener('click', fn, { signal: ctx.signal }); return b; };
    const box = (text, warn = false) => el('p', `sc-deep-callout${warn ? ' sc-deep-callout-warn' : ''}`, text);
    const card = (title, content, help = '') => { const n = el('section', 'sc-deep-card'); n.append(el('h3', '', title)); if (help) n.append(el('p', 'sc-pass-muted', help)); n.append(content); return n; };
    const tile = (name, value, help = '') => { const n = el('div', 'sc-deep-fact'); const b = el('b', '', value?.text ?? value); if (value?.title) b.title = value.title; n.append(el('span', '', name), b); if (help) n.append(el('small', '', help)); return n; };
    const tiles = (...nodes) => { const grid = el('div', 'sc-pass-grid'); grid.append(...nodes); return grid; };
    const list = (rows) => { const n = el('ul', 'sc-pass-notes'); for (const text of rows) n.append(el('li', '', text)); return n; };
    const details = (title, lines) => { const n = el('details', 'sc-deep-card'); n.append(el('summary', '', title), list(lines)); return n; };
    const table = (headers, rows) => {
      const wrap = el('div', 'sc-pass-table-wrap'); const t = el('table', 'sc-pass-table'); const h = el('tr');
      for (const text of headers) { const n = el('th', '', text); n.setAttribute('scope', 'col'); h.append(n); }
      const thead = el('thead'); thead.append(h); t.append(thead); const tbody = el('tbody');
      if (!rows.length) { const tr = el('tr'); const td = el('td', 'sc-pass-muted', '暂无可用记录'); td.setAttribute('colspan', String(headers.length)); tr.append(td); tbody.append(tr); }
      for (const row of rows) { const tr = el('tr'); for (const value of row) { const td = el('td'); if (value && typeof value !== 'string' && typeof value !== 'number') td.append(value); else td.textContent = String(value); tr.append(td); } tbody.append(tr); }
      t.append(tbody); wrap.append(t); return wrap;
    };
    const bars = (rows, key = 'knownTotal') => {
      const n = el('div', 'sc-pass-bars'); const max = Math.max(1, ...rows.map((r) => r[key] ?? 0));
      if (!rows.length) return box('没有可用时段记录；缺少日志不代表消耗为零。');
      for (const row of rows) { const line = el('div', 'sc-pass-bar-row'); line.append(el('span', '', row.name)); const track = el('div', 'sc-pass-track'); const fill = el('div', 'sc-pass-fill'); fill.style.width = `${Math.max(0, row[key] ?? 0) / max * 100}%`; track.append(fill); const value = el('span', '', `${formatTokenCompact(row[key])} · ${format(row.requests)} 条`); if (Number.isFinite(row[key])) value.title = String(row[key]); line.append(track, value); n.append(line); }
      return n;
    };
    function renderTokens() {
      const u = data.usage, a = data.activity;
      body.append(box(u.summary, u.complete < u.requests || u.state !== 'ready'));
      body.append(tiles(tile('已知输入', u.inputKnown ? token(u.input) : '未知', `${u.inputKnown}/${u.requests} 条已回报`),
        tile('已知输出', u.outputKnown ? token(u.output) : '未知', `${u.outputKnown}/${u.requests} 条已回报`),
        tile('已知合计', u.inputKnown + u.outputKnown ? token(u.knownTotal) : '未知', '输入 + 输出；缺报部分未计入'),
        tile('用量记录', format(u.requests), `完整计量 ${format(u.complete)} 条`),
        tile('配对样本缓存命中', percent(u.cacheRate), `${u.cacheKnown}/${u.requests} 条可计算；缓存包含在输入中`),
        tile('失败／取消／丢弃的已知量', u.requests ? token(u.failedKnown) : '未知', '计入总量；未上报用途与状态不猜测')));
      const charts = el('div', 'sc-pass-columns'); charts.append(card('每天什么时候用得多', bars(u.days), '按部署时区分日；只绘制有记录的日期，未记录日期不补零。'), card('一天中的高耗时段', bars(u.hours.slice(0, 8)), `按 ${u.timezone} 聚合各天同一小时；这是峰值分布，不直接判异常。`)); body.append(charts);
      body.append(card('缓存与输出计量', tiles(
        tile('配对样本缓存输入', u.cacheKnown ? token(u.cached) : '未知', '已包含在输入量中'),
        tile('配对样本未缓存输入', token(u.uncachedPaired), '仅输入与缓存都回报的样本'),
        tile('已知推理 Token', u.reasoningKnown ? token(u.reasoning) : '未知', '通常属于输出，不重复加总'),
      )));
      const fallbackLabels = {
        qqbot: 'QQ 群聊', terrarium: '生态缸', ego: 'Ego 浏览器', socialmedia: '小鲸鱼爱冲浪',
        'self-checkup': '体检报告', parlor: '客厅', starpost: '星邮', feast: '鱼的每一天',
        fishtools: '鱼脑', eat: '吃饭', imggen: '生图工作室', fishdaily: '肥鱼和你的日常',
        shop: '鱼宝商城', fun: '娱乐时间', map: '鱼的小世界', clawbot: '微信小龙虾',
        learn: '学习', webanswer: '联网问答', 'gpt-sovits': 'GPTSovits 语音',
        'bilibili-video': 'B 站视频', 'Persona／归属未上报': '主对话 / 未归属',
      };
      const labelMap = { ...fallbackLabels, ...(data.pluginLabels ?? {}) };
      const plugins = new Map();
      for (const r of a.rows) plugins.set(r.id, { id: r.id, calls: r.calls, replyChars: r.charsKnown ? r.chars : 0, reported: null });
      for (const r of u.worldReported) {
        const id = String(r.name); const row = plugins.get(id) ?? { id, calls: 0, replyChars: 0, reported: null };
        row.reported = r.knownTotal; row.calls = Math.max(row.calls, r.requests); plugins.set(id, row);
      }
      const ranking = [...plugins.values()].map((r) => {
        const display = labelMap[r.id] ?? '';
        return { ...r, display, amount: r.reported ?? Math.round(r.replyChars / 2), kind: r.reported === null ? '估算' : '实报' };
      }).sort((x, y) => y.amount - x.amount);
      const totalPlugin = ranking.reduce((sum, r) => sum + r.amount, 0);
      const maxPlugin = Math.max(1, ...ranking.map((r) => r.amount));
      const palette = ['#34d399', '#38bdf8', '#a78bfa', '#fbbf24', '#fb7185', '#2dd4bf', '#64748b'];
      const pluginBody = el('div', 'sc-pass-plugin-wrap');
      if (totalPlugin > 0) {
        const topN = ranking.slice(0, 6);
        const restAmount = ranking.slice(6).reduce((s, r) => s + r.amount, 0);
        const slices = topN.map((r, i) => ({ name: r.display || r.id, amount: r.amount, color: palette[i % palette.length] }));
        if (restAmount > 0) slices.push({ name: `其他 (${ranking.length - 6} 项)`, amount: restAmount, color: palette[6] });
        let acc = 0;
        const stops = slices.map((s) => {
          const start = (acc / totalPlugin) * 100; acc += s.amount; const end = (acc / totalPlugin) * 100;
          return `${s.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
        });
        const pieWrap = el('div', 'sc-pass-pie-wrap');
        const donut = el('div', 'sc-pass-donut');
        donut.style.background = `conic-gradient(${stops.join(', ')})`;
        const hole = el('div', 'sc-pass-donut-hole');
        hole.append(el('strong', '', formatTokenCompact(totalPlugin)), el('span', '', '插件估算总计'));
        donut.append(hole);
        const legend = el('div', 'sc-pass-legend');
        for (const s of slices) {
          const item = el('div', 'sc-pass-legend-item');
          const dot = el('i', 'sc-pass-legend-dot'); dot.style.background = s.color;
          const pct = `${((s.amount / totalPlugin) * 100).toFixed(1)}%`;
          item.append(dot, el('span', 'sc-pass-legend-name', s.name), el('strong', 'sc-pass-legend-pct', pct), el('span', 'sc-pass-legend-val', formatTokenCompact(s.amount)));
          legend.append(item);
        }
        pieWrap.append(donut, legend);
        pluginBody.append(pieWrap);
      }
      const pluginRows = ranking.map((r, i) => {
        const name = el('div', 'sc-pass-plugin-name');
        if (r.display && r.display !== r.id) name.append(el('strong', '', r.display), el('small', '', r.id));
        else name.append(el('strong', '', r.id));
        const bar = el('div', 'sc-pass-track'); const fill = el('div', 'sc-pass-fill');
        fill.style.width = `${r.amount / maxPlugin * 100}%`;
        if (i < 6) fill.style.background = palette[i];
        bar.append(fill);
        const pctText = totalPlugin > 0 ? ` · ${((r.amount / totalPlugin) * 100).toFixed(1)}%` : '';
        const amount = el('span', '', `${formatTokenCompact(r.amount)} ${r.kind}${pctText}`); amount.title = String(r.amount);
        return [name, bar, amount, `${format(r.calls)} 次`];
      });
      pluginBody.append(table(['插件', '消耗占比', '消耗量', '调用次数'], pluginRows));
      body.append(card('各插件消耗排行', pluginBody, 'Coo 账单未按插件拆分；有独立上报时优先显示实报 Token，其余按工具回执体量估算带入 Token。'));
      body.append(details('数据覆盖与口径', [u.limits, `usage 来源：${u.state}；采样截断：${u.source.limited ? '是' : '否'}；坏行 ${u.source.bad}；无效时间 ${u.source.invalidTime}；明确 ID 去重 ${u.source.duplicates}。`, `工具活动来源：${a.state}；扫描 ${a.files} 份日志；采样上限触发：${a.limited ? '是' : '否'}；不可读 ${a.unreadable ?? 0} 份；坏行 ${a.bad ?? 0}。`, '用量日志最多读取末尾 8 MiB／20,000 行；工具日志最多 256 个运行目录、每份末尾 256 KiB／1,000 行。达到上限时只代表窗口内样本。', '没有来源分块、可靠分词与请求关联证据时，不显示精确插件 Token 榜、前缀 Token 或记忆注入 Token。']));
    }
    function renderMemory() {
      const m = data.memory; body.append(box(m.summary));
      const pluginRows = m.rows.filter((r) => r.id !== 'workspace-storage');
      const enabledCount = pluginRows.filter((r) => r.enabled === true).length;
      const wsRow = m.rows.find((r) => r.id === 'workspace-storage');
      body.append(tiles(
        tile('宿主清单', ({ ready: '已实时读取', 'not-read': '尚未读取', unavailable: '宿主未提供' })[m.inventoryState] ?? '未能核实', '来自本机宿主扩展接口'),
        tile('已识别记忆插件', m.inventoryState === 'ready' ? `${pluginRows.length} 个` : '待读取', m.inventoryState === 'ready' ? `其中已启用 ${enabledCount} 个` : '需读取宿主清单'),
        tile('本地记忆存储', wsRow?.status === 'observed' ? '读写正常' : '未就绪', wsRow?.evidence ?? '工作区记忆目录'),
      ));
      const refresh = button('刷新宿主插件清单', async () => {
        if (busy) return; busy = true; refresh.disabled = true;
        try { const result = await ctx.invoke('passiveInventory', []); notice = result.ok ? '已刷新本机宿主插件清单。' : '当前宿主未提供可用清单接口，安装与使用情况保持未知。'; ctx.ui?.toast?.(notice, 'plain'); await load(false); }
        catch { notice = '读取清单失败；不据此判断插件未安装。'; render(); }
        finally { busy = false; refresh.disabled = false; }
      }); body.append(refresh);
      const pill = (text, tone = 'muted') => el('span', `sc-pass-pill sc-pass-pill-${tone}`, text);
      body.append(card('记忆来源与近期活跃', table(['来源／版本', '状态', '启用', '近期活跃与说明'], m.rows.map((r) => [
        r.version ? `${r.name}\n${r.version}` : r.name,
        pill(({ listed: '已安装', observed: '文件可读', missing: '路径缺失', unreadable: '读取失败', 'not-directory': '不是目录' })[r.status] ?? '未知', r.status === 'observed' || r.status === 'listed' ? 'ok' : 'warn'),
        pill(r.enabled === null ? '未知' : r.enabled ? '已启用' : '已禁用', r.enabled === true ? 'ok' : 'muted'),
        `${r.evidence}。${r.detail}`,
      ]))));
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
