function enhancePersonaShowcase(root, report, ctx) {
  try {
    const p = report?.personality;
    const profile = p?.profile;
    if (!p || !profile || !root) return;
    const zh = (ctx?.lang ?? 'zh') !== 'en';
    const mk = (tag, cls = '', text = '') => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    };
    const kids = (node) => Array.isArray(node?.children) ? node.children : [...(node?.children ?? [])];
    const findClass = (node, cls) => {
      const queue = [node];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur) continue;
        const cn = String(cur.className ?? '');
        if (cn.split(/\s+/).includes(cls)) return cur;
        for (const ch of kids(cur)) queue.push(ch);
      }
      return null;
    };

    const tagData = p.tags ?? {};
    const topTags = Array.isArray(tagData.tags) ? tagData.tags : [];

    // 1. Hero 名片：自然融入一句克制、有温度的主观侧写评语
    const hero = findClass(root, 'sc-profile-hero') || kids(root)[0];
    const heroText = findClass(root, 'sc-profile-text') || findClass(root, 'sc-profile-hero-text');
    if (hero && zh && profile.subjectiveNote && heroText) {
      heroText.append(mk('p', 'sc-showcase-quote', `“${profile.subjectiveNote}”`));
    }

    // 2. 左栏「性格分析」：克制、专业的心理测评侧写架构
    const columns = findClass(root, 'sc-profile-columns');
    const analysis = columns ? kids(columns)[0] : null;
    const recent = columns ? kids(columns)[1] : null;
    if (analysis && zh) {
      analysis.classList.add('sc-showcase-analysis');
      const sitRows = kids(analysis).filter((n) => String(n.className ?? '').includes('sc-situation') || n.tagName === 'DETAILS');

      // 2a. 测评信度与言行对照（专业心理测评核心）
      const checkItems = [];
      if (p.consistency?.sentence) {
        checkItems.push({ label: '言行一致度（自述 vs 实际行为）', value: p.consistency.label || '已比对', desc: p.consistency.sentence });
      } else if (p.taken) {
        checkItems.push({ label: '言行一致度', value: '样本积累中', desc: '待日常行为四维齐备后，自动比对自述倾向与日常表现的一致程度。' });
      }
      if (p.anchors?.pairs > 0 && Number.isFinite(p.anchors.agreeRate)) {
        const rate = Math.round(p.anchors.agreeRate * 100);
        checkItems.push({ label: '作答稳定度（锚点核验）', value: `${rate}%`, desc: rate >= 70 ? '相似情境前后选择连贯，本次自述信度良好。' : '部分相似情境存在摇摆，建议后续复测对照。' });
      }
      if (checkItems.length) {
        const psychBox = mk('div', 'sc-psych-verify');
        psychBox.append(mk('span', 'sc-showcase-sec-label', '测评信度与言行对照'));
        for (const ci of checkItems) {
          const row = mk('div', 'sc-psych-row');
          const top = mk('div', 'sc-psych-row-top');
          top.append(mk('span', 'sc-psych-label', ci.label), mk('strong', 'sc-psych-val', ci.value));
          row.append(top, mk('p', 'sc-psych-desc', ci.desc));
          psychBox.append(row);
        }
        analysis.append(psychBox);
      }

      // 2b. 四维心理倾向双极量表（单色专业刻度，告别花哨彩虹条）
      const axes = [
        ['EI', '外向主动 (E)', '内向慢热 (I)'],
        ['SN', '具象细节 (S)', '直觉联想 (N)'],
        ['TF', '理性解题 (T)', '共情感受 (F)'],
        ['JP', '条理规划 (J)', '随性灵活 (P)'],
      ];
      const axisItems = axes.map(([k, left, right]) => {
        const fromSelf = Number.isFinite(p.selfAxes?.[k]);
        const v = fromSelf ? p.selfAxes[k] : (Number.isFinite(p.behaviorAxes?.[k]) ? p.behaviorAxes[k] : null);
        return v !== null ? { k, left, right, v: Math.max(5, Math.min(95, Math.round(v))), source: fromSelf ? '测验' : '行为' } : null;
      }).filter(Boolean);
      if (axisItems.length) {
        const specWrap = mk('div', 'sc-showcase-spectrum');
        const hasSelf = axisItems.some((a) => a.source === '测验');
        specWrap.append(mk('span', 'sc-showcase-sec-label', `四维心理倾向（${hasSelf ? '依据奇遇小测自述' : '依据日常行为观测'}）`));
        for (const a of axisItems) {
          const row = mk('div', 'sc-spec-row');
          const labels = mk('div', 'sc-spec-labels');
          labels.append(
            mk('span', a.v >= 50 ? 'sc-spec-strong' : '', `${a.left} ${a.v}%`),
            mk('span', a.v < 50 ? 'sc-spec-strong' : '', `${100 - a.v}% ${a.right}`),
          );
          const track = mk('div', 'sc-spec-track');
          const mid = mk('span', 'sc-spec-mid');
          const bar = mk('span', 'sc-spec-bar');
          if (a.v >= 50) {
            bar.style.left = `${100 - a.v}%`;
            bar.style.width = `${a.v - 50}%`;
          } else {
            bar.style.left = '50%';
            bar.style.width = `${50 - a.v}%`;
          }
          const dot = mk('span', 'sc-spec-dot');
          dot.style.left = `${100 - a.v}%`;
          track.append(mid, bar, dot);
          row.append(labels, track);
          specWrap.append(row);
        }
        analysis.append(specWrap);
      }

      // 2c. 情境判断依据收纳抽屉
      if (sitRows.length > 0) {
        const drawer = mk('details', 'sc-showcase-drawer');
        drawer.append(mk('summary', '', `展开核对 ${sitRows.length} 条情境判断依据`));
        const box = mk('div', 'sc-showcase-drawer-body');
        for (const row of sitRows) box.append(row);
        drawer.append(box);
        analysis.append(drawer);
      }
    }

    // 3. 右栏「最近的她」：素雅 Q&A 短问答 + 近期记录 + 行为侧写特征（与左栏高度齐平）
    if (recent && zh) {
      recent.classList.add('sc-showcase-recent');
      const insertAnchor = kids(recent)[1] ?? null;

      // 带问题标题的素雅 Q&A 短问答
      const FALLBACK_Q = {
        scene1: '如果在意的人一下午没理你 / 街角小画',
        scene2: '如果今天的天气替你说一句心里话',
        scene3: '给未来寄一件小礼物 / 逃跑半天去干嘛',
        scene4: '只属于你的小房间里最不能少的三样东西',
      };
      const creativeList = Array.isArray(p.creative?.responses) ? p.creative.responses.filter((r) => r?.response) : [];
      if (creativeList.length) {
        const quotesBox = mk('div', 'sc-creative-showcase');
        quotesBox.append(mk('span', 'sc-showcase-sec-label', '小问答摘录'));
        const sorted = [...creativeList].sort((a, b) => String(a.response).length - String(b.response).length);
        for (const item of sorted.slice(0, 2)) {
          const card = mk('blockquote', 'sc-creative-bubble');
          const rawQ = (item.question || FALLBACK_Q[item.id] || '奇遇小提问').replace(/（[^）]*字以内[^）]*）/g, '').trim();
          card.append(mk('small', 'sc-creative-q', `问：${rawQ}`));
          const ans = String(item.response).trim();
          const clipped = ans.length > 72 ? `${ans.slice(0, 72)}…` : ans;
          card.append(mk('p', '', `“${clipped}”`));
          quotesBox.append(card);
        }
        if (insertAnchor) recent.insertBefore(quotesBox, insertAnchor);
        else recent.append(quotesBox);
      }

      // 行为侧写特征（移入右栏底部，既贴合生活侧写，又与左栏视觉齐平）
      if (topTags.length) {
        const wall = mk('div', 'sc-showcase-tagwall');
        wall.append(mk('span', 'sc-showcase-sec-label', '行为侧写特征'));
        const list = mk('div', 'sc-showcase-pills');
        for (const t of topTags.slice(0, 4)) {
          const chip = mk('div', 'sc-vibe-chip');
          chip.append(mk('strong', '', t.nick || t.label), mk('span', '', t.roast || t.label));
          list.append(chip);
        }
        wall.append(list);
        recent.append(wall);
      }
    }

    // 4. 奇遇小测默认展开，样式保持克制沉稳
    const quizEl = findClass(root, 'sc-profile-quiz');
    if (quizEl && zh) {
      quizEl.open = true;
      quizEl.classList.add('sc-showcase-quiz');
      const sum = kids(quizEl)[0];
      if (sum && sum.tagName === 'SUMMARY') {
        sum.textContent = p.taken
          ? '奇遇小测（已完成测评 · 可随时复测或补充小问答）'
          : '奇遇小测 · 让她亲自作答情境题，完善心理侧写';
      }
    }
  } catch { /* non-fatal visual enhancement */ }
}
