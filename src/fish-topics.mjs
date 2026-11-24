// 只识别主题，报告和画像提示词只带主题及聚合数字。
const TOPICS = [
  ['food', '做饭和吃饭', 'cooking and meals', /吃饭|开饭|做饭|下厨|菜单|好吃|夜宵|早餐|午饭|晚饭|小吃|饭团|汤圆|火锅/u],
  ['sweet', '甜点和奶茶', 'desserts and milk tea', /甜点|蛋糕|布丁|奶茶|冰淇淋|曲奇|巧克力|松饼/u],
  ['garden', '种东西', 'gardening', /浇花|浇水|种花|种菜|花园|发芽|采摘|收成|盆栽/u],
  ['drawing', '画画和配色', 'drawing and colours', /画画|画图|画一张|插画|草图|配色|颜料|笔刷|绘画|画稿/u],
  ['outfit', '穿搭和装扮', 'outfits and styling', /穿搭|装扮|换装|衣服|裙子|围裙|发型|领结|女仆装|发饰/u],
  ['companions', '陪伴和问候', 'check-ins and company', /陪你|陪着|一起待|慢慢来|照顾好|抱抱|别着急|我陪/u],
  ['sleep', '睡觉和休息', 'sleep and rest', /睡觉|晚安|早安|困了|打哈欠|休息|睡醒|午睡|熬夜|起床/u],
  ['rain', '天气和雨声', 'weather and rain', /下雨|雨声|放晴|阴天|天气|雷声|雪天|阵雨|刮风/u],
  ['ocean', '海里和鲸鱼', 'the sea and whales', /鲸鱼|海洋|海底|海浪|贝壳|海星|水族馆|潮汐/u],
  ['games', '玩游戏', 'games', /打游戏|玩游戏|游戏机|游戏卡|联机|开一局|过关|通关|闯关/u],
  ['music', '听歌和音乐', 'music', /听歌|歌单|歌曲|音乐|演奏|钢琴|吉他|循环播放/u],
  ['videos', '看视频', 'videos', /看视频|刷视频|短视频|B站|视频片段|番剧|动画片/u],
  ['notes', '写信和便签', 'letters and notes', /写信|便签|笔记|日记|信封|回信|小纸条/u],
  ['study', '论文和作业', 'papers and coursework', /论文|写作业|改稿|投稿|文献|实验|答辩|报告稿/u],
  ['coding', '代码和工具', 'code and tools', /代码|脚本|调试|报错|编程|插件|代码库/u],
  ['trip', '出去走走', 'outings', /散步|出门|旅行|露营|看海|逛街|去公园|爬山/u],
  ['celebrate', '节日和庆祝', 'celebrations', /庆祝|生日|礼物|派对|聚餐|节日|纪念日/u],
  ['pets', '猫狗和小动物', 'pets and animals', /猫咪|小猫|狗狗|小狗|猫粮|宠物|兔子|仓鼠/u],
];

export function observeFishTopics(tally, text, day) {
  if (typeof text !== 'string' || !text.trim()) return;
  for (const [id, zh, en, pattern] of TOPICS) {
    if (!pattern.test(text.slice(0, 1800))) continue;
    const row = tally.get(id) ?? { id, zh, en, count: 0, days: new Set() };
    row.count += 1;
    row.days.add(day);
    tally.set(id, row);
  }
}

export function finishFishTopics(tally) {
  return [...tally.values()].filter(({ count, days }) => count >= 3 && days.size >= 2)
    .sort((a, b) => b.count - a.count || b.days.size - a.days.size || a.id.localeCompare(b.id))
    .slice(0, 6).map(({ days, ...row }) => ({ ...row, days: days.size }));
}
