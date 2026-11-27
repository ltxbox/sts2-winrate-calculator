/*
 * decklogic.js —— 卡组 ↔ 求解器请求 的纯逻辑（不碰 DOM，能被 node 直接测）
 *
 * 直接原因是两个 bug（2026-11-26 主人报）：
 *   1) 同名卡没法只控制附魔一张：以前附魔挂在「卡种」上，一选就整组都附魔。
 *      升级早就是按张数控制的（upCount），附魔照抄：enchCount。
 *   2) 从存档导入时，同一种卡会被拆成多条（按 升级/附魔 分组），界面上却按 cardId 找行，
 *      于是第二条点的按钮改的是第一条 —— 导入要合并成一行。
 *
 * 一条卡组行的模型（和界面一一对应）：
 *   { cardId, count, upCount, enchantmentId, enchantmentAmount, enchCount }
 *   - count    这种卡共几张
 *   - upCount  其中几张是升级态
 *   - enchCount 其中几张附了 enchantmentId 那个魔（0 = 一张都不附）
 *
 * 求解器的请求按「升级 × 附魔」拆成最多 4 条：
 *   升级+附魔 / 只升级 / 只附魔 / 都没有
 * 两者张数之和超过总数时，多出来的部分是两张都占的（both）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clampInt = (v, lo, hi) => {
    const n = Math.floor(Number(v) || 0);
    return Math.max(lo, Math.min(hi, n));
  };

  /** 把界面行归一成确定形状（缺字段就按老语义补）。 */
  function normalizeEntry(d = {}) {
    const count = Math.max(1, clampInt(d.count, 1, 99));
    const rawUp = d.upCount != null ? d.upCount : (d.upgradeLevels ? count : 0);
    const upCount = clampInt(rawUp, 0, count);
    const enchantmentId = d.enchantmentId || null;
    // 老数据/老存档只有 enchantmentId、《没有》enchCount —— 那时的语义是「整组都附魔」，
    // 所以这里缺省成 count，保持旧行为不变；显式给了 0 才是「一张都不附」。
    const rawEnch = d.enchCount != null ? d.enchCount : (enchantmentId ? count : 0);
    const enchCount = enchantmentId ? clampInt(rawEnch, 0, count) : 0;
    return {
      cardId: d.cardId,
      count,
      upCount,
      enchantmentId,
      enchantmentAmount: Number(d.enchantmentAmount) || 0,
      enchCount,
    };
  }

  /** 卡组行 → 求解器请求里的 deck（同名卡按 升级/附魔 拆条）。 */
  function expandDeck(deck = []) {
    const out = [];
    for (const raw of deck) {
      const d = normalizeEntry(raw);
      const { count: n, upCount: up, enchCount: ench, enchantmentId } = d;
      const both = Math.max(0, up + ench - n);
      const plain = n - up - ench + both;
      const upOnly = up - both;
      const enchOnly = ench - both;
      const base = { cardId: d.cardId };
      if (plain > 0) out.push({ ...base, count: plain, upgradeLevels: 0 });
      if (upOnly > 0) out.push({ ...base, count: upOnly, upgradeLevels: 1 });
      if (enchOnly > 0) out.push({ ...base, count: enchOnly, upgradeLevels: 0, enchantmentId, enchantmentAmount: d.enchantmentAmount });
      if (both > 0) out.push({ ...base, count: both, upgradeLevels: 1, enchantmentId, enchantmentAmount: d.enchantmentAmount });
    }
    return out;
  }

  /**
   * 游戏存档导入的行 → 界面行。
   * 存档里一条 = (卡 + 升级等级 + 附魔) 一组，同一种卡会出现多条；界面一行只能挂一种附魔，
   * 所以按 cardId 合并：张数相加、升级张数相加、附魔取「张数最多的那种」。
   * 同名卡上真有两种不同附魔时没法在一行里表达——不悄悄丢，塞一条 warning 出去。
   */
  function mergeImported(rows = []) {
    const warnings = [];
    const byCard = new Map();
    for (const r of rows) {
      if (!r || !r.cardId) continue;
      const n = Math.max(1, clampInt(r.count, 1, 99));
      const up = r.upgradeLevels ? n : 0;
      let g = byCard.get(r.cardId);
      if (!g) {
        g = { cardId: r.cardId, count: 0, upCount: 0, ench: new Map() };
        byCard.set(r.cardId, g);
      }
      g.count += n;
      g.upCount += up;
      if (r.enchantmentId) {
        const e = g.ench.get(r.enchantmentId) || { count: 0, amount: 0 };
        e.count += n;
        e.amount = Math.max(e.amount, Number(r.enchantmentAmount) || 0);
        g.ench.set(r.enchantmentId, e);
      }
    }
    const deck = [];
    for (const g of byCard.values()) {
      let enchantmentId = null;
      let enchantmentAmount = 0;
      let enchCount = 0;
      if (g.ench.size) {
        const ranked = [...g.ench.entries()].sort((a, b) => b[1].count - a[1].count);
        enchantmentId = ranked[0][0];
        enchCount = ranked[0][1].count;
        enchantmentAmount = ranked[0][1].amount;
        if (ranked.length > 1) {
          const rest = ranked.slice(1).reduce((s, x) => s + x[1].count, 0);
          warnings.push(`${g.cardId} 有 ${rest} 张是另一种附魔，界面上只能保留「${enchantmentId}」这一种，那几张按无附魔算`);
        }
      }
      deck.push(normalizeEntry({
        cardId: g.cardId,
        count: g.count,
        upCount: g.upCount,
        enchantmentId,
        enchantmentAmount,
        enchCount,
      }));
    }
    return { deck, warnings };
  }

  /* ---------- 文字描述导入卡组（2026-11-27 主人要的） ----------
   *
   * 主人原话：「一个是文字描述导入卡组功能，比如绿护卫，白致死汲取，删一打，
   * 这种文字提供的信息就是默认在初始卡组的基础上进行修改」。
   *
   * 所以这里不是「解析一份完整卡组」，而是解析**改动**：
   *   · 「绿护卫」  = 加一张升级过的护卫
   *   · 「白致死汲取」= 加一张没升级的致死汲取
   *   · 「删一打」  = 从初始卡组里删一张「打击」（一 = 1）
   *   · 「2绿打击」 = 加两张升级的打击
   * 默认底子是**当前角色的初始卡组**（含进阶 5 起的「进阶之灾」）——
   * 主人拿它描述一局打完之后改出来的卡组，比逐个点快得多。
   *
   * 命名靠卡名匹配，不靠 ID：卡名去掉空格、颜色前缀、末尾「+」之后正好是一个卡名；
   * 差一点时按「初始卡组里的前缀」兜底（「打」→「打击」、「防」→「防御」）。
   */
  const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const squashName = s => String(s == null ? '' : s).replace(/[\s\u3000]+/g, '');
  const DEL_HEAD = /^(删|删掉|去掉|移除|减|少|扣掉|-|－|—)/;
  const UP_COLOR = /^(绿|升级|升)(?![色的])/;
  const PLAIN_COLOR = /^(白|未升级)(?![色的])/;

  /** 一行里的数量：2 / 2张 / 两张 / 一 都认。返回 [n, 剩下的字] */
  function takeCount(s) {
    let m = /^(\d{1,2})(?:张|个|张牌)?\s*[xX×*]?/.exec(s);
    if (m && Number(m[1]) > 0) return [Math.min(20, Number(m[1])), s.slice(m[0].length)];
    m = /^[xX×*](\d{1,2})/.exec(s);
    if (m && Number(m[1]) > 0) return [Math.min(20, Number(m[1])), s.slice(m[0].length)];
    m = /^([一二两三四五六七八九十])(?:张|个)?/.exec(s);
    if (m) return [CN_DIGIT[m[1]] || 1, s.slice(m[0].length)];
    return [1, s];
  }

  /** 卡名索引：squash(名) → [id]；同名卡按角色挑。 */
  function nameIndex(cards) {
    const byName = new Map();
    for (const c of cards || []) {
      const n = squashName(c.name);
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(String(c.id));
    }
    return byName;
  }
  const pickId = (ids, character) => {
    if (!ids || !ids.length) return null;
    if (ids.length === 1) return ids[0];
    const want = `_${character || ''}`;
    return ids.find(id => character && id.endsWith(want)) || ids.find(id => character && id.includes(character)) || ids[0];
  };

  /**
   * 认一张卡：先精确，再「初始卡组里的前缀」（打/防），最后全卡库前缀。
   * @returns {{cardId:string, name:string}|null}
   */
  function findCard(token, cards, byName, starterNames, character) {
    const t = squashName(token);
    if (!t) return null;
    if (byName.has(t)) {
      const id = pickId(byName.get(t), character);
      const c = (cards || []).find(x => String(x.id) === id);
      return { cardId: id, name: c ? c.name : t };
    }
    if (t.length <= 2) {
      const hit = starterNames.find(n => n.startsWith(t)) || [...byName.keys()].find(n => n.startsWith(t) && n.length <= t.length + 1);
      if (hit) return { cardId: pickId(byName.get(hit), character), name: hit };
    }
    // 卡名中间带标点/异体字时：token 是卡名的一段
    let best = null;
    for (const [n, ids] of byName) {
      if (n.length < 2) continue;
      if (n.includes(t) && (!best || n.length < best.name.length)) best = { cardId: pickId(ids, character), name: n };
    }
    return best;
  }

  /**
   * 解析「在初始卡组基础上改」的一段话。
   *
   * @param {string} text      主人写的话
   * @param {Array}  cards     meta.cards
   * @param {Array}  starter   初始卡组 [{cardId,count,upCount?}]
   * @param {{character?:string}} opts
   * @returns {{deck:Array, rows:Array, unmatched:Array, total:number}}
   *   deck  改完的卡组（界面行形状）
   *   rows  每一处改动（给预览用）
   *   unmatched 没认出来的短语
   */
  function parseTextDelta(text, cards, starter, opts = {}) {
    const character = opts.character || '';
    const byName = nameIndex(cards);
    const cardById = new Map((cards || []).map(c => [String(c.id), c]));
    const starterNames = [];
    for (const d of starter || []) {
      const c = cardById.get(String(d.cardId));
      if (c) starterNames.push(squashName(c.name));
    }
    // 底子：按 cardId 合并
    const lines = [];
    const at = new Map();
    for (const d of starter || []) {
      const cardId = String(d.cardId || '');
      if (!cardId) continue;
      const n = Math.max(1, Math.floor(Number(d.count) || 1));
      const up = d.upCount != null ? Math.max(0, Math.min(n, Number(d.upCount) || 0))
        : (d.upgradeLevels ? n : 0);
      let row = at.get(cardId);
      if (!row) { row = { cardId, count: 0, upCount: 0 }; at.set(cardId, row); lines.push(row); }
      row.count += n;
      row.upCount += up;
    }

    const rows = [];
    const unmatched = [];
    const tokens = String(text || '').split(/[\n,，、;；/]+/).map(x => x.trim()).filter(Boolean);
    for (const raw of tokens) {
      let s = squashName(raw);
      if (!s) continue;
      const del = DEL_HEAD.test(s);
      if (del) s = s.replace(DEL_HEAD, '');
      let [n, rest] = takeCount(s);
      s = rest;
      // 颜色/升级写法：绿 = 已升级、白 = 未升级、末尾 + 也算升级
      let up = null;
      if (UP_COLOR.test(s)) { up = true; s = s.replace(UP_COLOR, ''); }
      else if (PLAIN_COLOR.test(s)) { up = false; s = s.replace(PLAIN_COLOR, ''); }
      if (/[+＋]$/.test(s)) { up = true; s = s.replace(/[+＋]$/, ''); }
      s = s.replace(/^(的|张|个)/, '').replace(/(牌|卡)$/, '');
      const hit = findCard(s, cards, byName, starterNames, character) || findCard(raw.replace(/^[删去掉移除减少扣-]+/, ''), cards, byName, starterNames, character);
      if (!hit) { unmatched.push(raw); continue; }
      if (del) {
        const row = at.get(hit.cardId);
        if (!row) { unmatched.push(raw + '（卡组里没有）'); continue; }
        // 先删没升级的，再删升级的
        const plain = row.count - row.upCount;
        const fromPlain = Math.min(plain, n);
        const removedUp = Math.min(row.upCount, n - fromPlain);
        row.count -= fromPlain + removedUp;
        row.upCount -= removedUp;
        if (row.count <= 0) { at.delete(hit.cardId); const i = lines.indexOf(row); if (i >= 0) lines.splice(i, 1); }
        rows.push({ op: 'del', cardId: hit.cardId, name: hit.name, count: fromPlain + removedUp, raw });
      } else {
        let row = at.get(hit.cardId);
        if (!row) { row = { cardId: hit.cardId, count: 0, upCount: 0 }; at.set(hit.cardId, row); lines.push(row); }
        row.count += n;
        if (up) row.upCount += n;
        rows.push({ op: 'add', cardId: hit.cardId, name: hit.name, count: n, up: up === true, raw });
      }
    }
    const deck = lines
      .filter(r => r.count > 0)
      .map(r => normalizeEntry({ cardId: r.cardId, count: r.count, upCount: Math.min(r.count, r.upCount) }));
    return { deck, rows, unmatched, total: deck.reduce((s, d) => s + d.count, 0) };
  }

  /** 角色 → 初始最大生命（值来自 sts2.dll 的 get_StartingHp，别改）。 */
  const CHARACTER_HP = {
    IRONCLAD: 80,
    SILENT: 70,
    DEFECT: 75,
    REGENT: 75,
    NECROBINDER: 66,
    FOOL: 77,
  };

  function maxHpOf(character, table = CHARACTER_HP) {
    const v = table && table[character];
    return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  }

  return { normalizeEntry, expandDeck, mergeImported, parseTextDelta, findCard, nameIndex, CHARACTER_HP, maxHpOf };
});
