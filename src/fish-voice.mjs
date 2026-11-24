const PATTERNS = [
  ['care', /慢慢来|别着急|别担心|我陪你|辛苦了|先歇会|我在呢/u],
  ['steps', /(?:^|\n)\s*(?:[一二三1-9][、.)．]|第[一二三]步)|先.+再|分成.{0,8}步/u],
  ['ask', /[？?]\s*$/u],
  ['precise', /具体来说|准确地说|确切地说|有个细节|细一点说|要分情况|还要看/u],
  ['light', /嘿嘿|哈哈|好耶|耶[！!～~]|[～~]{2,}|[😆😄🥳]/u],
  ['soft', /要不要|可以试试|要是愿意|如果你想|你觉得呢|不着急/u],
  ['direct', /^(?:好[，。！!]|可以[，。]|收到[，。]|说重点|简单说|结论是)/u],
];

export function observeVoice(tally, text, day) {
  for (const [key, pattern] of PATTERNS) {
    if (!pattern.test(text.slice(0, 1800))) continue;
    const hit = tally.get(key) ?? { id: key, count: 0, days: new Set() };
    hit.count += 1;
    hit.days.add(day);
    tally.set(key, hit);
  }
}

export function summarizeVoice(tally, total) {
  if (total < 6) return [];
  return [...tally.values()].filter(({ count, days }) => count >= Math.max(3, total * .12) && days.size >= 2)
    .sort((a, b) => b.count - a.count || b.days.size - a.days.size)
    .map(({ id, count, days }) => ({ id, count, days: days.size }));
}
