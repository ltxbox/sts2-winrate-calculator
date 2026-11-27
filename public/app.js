'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// 自选对比最多几张候选卡（2026-11-27 主人要的：三张不够用）
const CMP_MAX = 10;
const UP_MAX = 10;
// 药水栏上限：游戏里默认 3 个，但加了药水栏遗物/mod 能到更多，按 10 放开
const POTION_MAX = 10;
const TYPE_NAME = { 1: '攻击', 2: '技能', 3: '能力', 4: '状态', 5: '诅咒', 6: '特殊' };
const TYPE_CLASS = { 1: 't-attack', 2: 't-skill', 3: 't-power', 4: 't-status', 5: 't-curse', 6: 't-special' };
const RARITY_NAME = { 1: '基础', 2: '普通', 3: '罕见', 4: '稀有', 5: '特殊', 6: '特殊', 7: '衍生', 8: '状态', 9: '诅咒', 10: '事件' };
const KIND_NAME = { boss: 'Boss', elite: '精英', normal: '普通', weak: '弱怪', event: '事件' };

const DEFAULT_DECK = [
  { cardId: 'ASCENDERS_BANE', count: 1 },
  { cardId: 'BODYGUARD', count: 1, upgradeLevels: 1 },
  { cardId: 'BORROWED_TIME', count: 1 },
  { cardId: 'DEFEND_NECROBINDER', count: 3 },
  { cardId: 'DEFY', count: 1 },
  { cardId: 'DIRGE', count: 1, upgradeLevels: 1 },
  { cardId: 'PULL_AGGRO', count: 1, upgradeLevels: 1 },
  { cardId: 'STRIKE_NECROBINDER', count: 1 },
  { cardId: 'UNLEASH', count: 1 },
  { cardId: 'WISP', count: 1 },
];
const DEFAULT_RELICS = ['PRECARIOUS_SHEARS', 'STRIKE_DUMMY', 'KUNAI', 'STONE_CRACKER'];

const state = {
  meta: null,
  startingDecks: {},
  cardsById: new Map(), relicsById: new Map(), enchById: new Map(), encById: new Map(),
  deck: DEFAULT_DECK.map(d => ({ ...d })),
  relics: [...DEFAULT_RELICS],
  potions: [],
  encounter: 'SOUL_FYSH_BOSS',
  character: 'NECROBINDER',
  hp: 37, maxHp: 66, ascension: 10, actIndex: 0,
  gameMode: 'Standard', dreadBoss: '', dreadList: [], serverCaps: null,
  count: 100, prefix: 'HISRUN', potionPolicy: 'Disabled',
  jobId: null, timer: null, job: null, running: false, encKind: 'boss', encMap: '全部', encGroups: [],
  mode: 'single', cmpCards: [], lastJob: null,
  startingRelics: {},
  // 遗物计数器（从存档读来的实际数字）：{ RELIC_ID: { ints:[{name,value}], bools:[...] } }
  relicProps: {},
  restOpts: { pct: 30, base: 'max', pillow: false, furnace: false },
  // 中间「测算结果」栏收不收起来（收起后左栏变宽）；midAuto = 这次收起是开跑时自动做的，跑完要自动展开
  midCollapsed: false,
  midAuto: false,
  // 卡组列表高度（px，拖分隔线设的；0 = 用默认 42%）
  deckListH: 0,
};

/* 并发：按 CPU 核数取，16 核 -> 12（实测比 4 路快 1.74 倍） */
const CONCURRENCY = Math.max(4, Math.min(12, (navigator.hardwareConcurrency || 8) - 2));
/* ---------- 本地记忆：关掉浏览器再打开还在 ---------- */
const STORE_KEY = 'sts2-ui.v1';
let _persistTimer = null;
/* ---------- 页面内错误条：把出错现场变成一段能复制走的话 ---------- */
function reportError(msg, detail) {
  const bar = document.getElementById('errBar');
  if (!bar) return;
  bar.querySelector('.msg').textContent = msg;
  bar.dataset.detail = detail || '';
  bar.style.display = 'flex';
}
function hideError() {
  const bar = document.getElementById('errBar');
  if (bar) bar.style.display = 'none';
}
function errorDump() {
  const bar = document.getElementById('errBar');
  const total = state.deck.reduce((s, d) => s + d.count, 0);
  const enc = state.encById.get(state.encounter);
  return [
    '【StS2 胜率计算器 · 诊断】',
    '时间：' + new Date().toLocaleString('zh-CN'),
    '页面：' + location.href,
    '浏览器：' + navigator.userAgent,
    '模式：' + state.mode,
    `角色/飞升：${state.character} / ${state.ascension}`,
    `血量：${state.hp}/${state.maxHp}`,
    `遭遇：${state.encounter}${enc ? '（' + enc.name + '）' : ''}`,
    `卡组：${total} 张 / ${state.deck.length} 种`,
    `参数：样本 ${state.count}，前缀 ${state.prefix}，药水 ${state.potionPolicy}`,
    '最近任务：' + (state.lastJob ? state.lastJob.id + ' / ' + state.lastJob.mode : '(无)'),
    '',
    '错误：' + (bar ? bar.querySelector('.msg').textContent : ''),
    bar && bar.dataset.detail ? '详情：' + bar.dataset.detail : '',
  ].join('\n');
}
function bindErrorBar() {
  const copy = document.getElementById('errCopy');
  const close = document.getElementById('errClose');
  if (copy) copy.onclick = async () => {
    const text = errorDump();
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; }
      ta.remove();
    }
    setTimeout(() => { copy.textContent = '复制诊断信息'; }, 2000);
  };
  if (close) close.onclick = hideError;
}
/* ---------- 中间「测算结果」栏：收起来，把地方让给左边的卡组/卡池 ----------
   自动：开跑时收、跑完自动展开；手动：栏头的 ⟨/⟩ 按钮、收起后的竖条、Alt+M 都能切换。
   规则：手动收起来的，跑完不会被强行展开（只有「开跑时自动收的」才会自动展开）。 */

function midPanels() { return $$('.mid-panel'); }

function setMidProgress(text) {
  $$('.mid-prog').forEach(el => { el.textContent = text || ''; });
}

function applyMidCollapsed(collapsed) {
  state.midCollapsed = !!collapsed;
  $$('main.cols').forEach(m => m.classList.toggle('mid-collapsed', state.midCollapsed));
  midPanels().forEach(p => p.classList.toggle('is-collapsed', state.midCollapsed));
  $$('.mid-toggle').forEach(b => {
    b.textContent = state.midCollapsed ? '⟩' : '⟨';
    b.title = state.midCollapsed ? '展开结果栏（Alt+M）' : '收起结果栏，给左边腾地方（Alt+M）';
  });
  if (!state.midCollapsed) setMidProgress('');
  saveLocal();
}

// auto=true：这次收起是「开跑」自动做的，记下来，跑完自动展开
function setMidCollapsed(collapsed, auto) {
  state.midAuto = auto ? !!collapsed : false;
  applyMidCollapsed(collapsed);
}
function autoCollapseMid() {
  // 已经是手动的收起了就别动它——否则「手动收起」会被当成「自动收起」，跑完又自己弹开
  if (state.midCollapsed) return;
  setMidCollapsed(true, true);
}
function autoExpandMid() { if (state.midAuto) { state.midAuto = false; setMidCollapsed(false); } }

function bindMidCollapse() {
  midPanels().forEach(panel => {
    const head = panel.querySelector('.panel-head');
    if (!head) return;
    if (!head.querySelector('.mid-toggle')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost small mid-toggle';
      b.onclick = e => { e.stopPropagation(); setMidCollapsed(!state.midCollapsed); };
      head.appendChild(b);
    }
    if (!panel.querySelector('.mid-strip')) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'mid-strip';
      s.title = '展开结果栏（Alt+M）';
      s.innerHTML = '<i>⟩</i><span class="mid-label">测算结果</span><b class="mid-prog"></b>';
      s.onclick = () => setMidCollapsed(false);
      panel.insertBefore(s, panel.firstChild);
    }
  });
  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      setMidCollapsed(!state.midCollapsed);
    }
  });
  applyMidCollapsed(!!state.midCollapsed);
}

/* ---------- 卡组 / 卡池之间的分隔线：上下拖，改卡组占多高（双击回默认 42%） ---------- */
function bindDeckSplit() {
  const list = $('#deckList'), sp = $('#deckSplit');
  if (!list || !sp) return;
  const panel = list.closest('.panel');
  const clampH = h => {
    const max = Math.max(140, (panel ? panel.clientHeight : 600) - 190);
    return Math.max(80, Math.min(max, Math.round(h)));
  };
  const apply = h => {
    const v = clampH(h);
    list.style.height = v + 'px';
    list.style.maxHeight = 'none';   // 拖过以后就按拖的来，别被默认的 42% 顶住
    state.deckListH = v;
    return v;
  };
  if (state.deckListH > 0) apply(state.deckListH);
  let drag = null;
  sp.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { sp.setPointerCapture(e.pointerId); } catch { }
    sp.classList.add('dragging');
    drag = { y: e.clientY, h: list.getBoundingClientRect().height };
  });
  sp.addEventListener('pointermove', e => { if (drag) apply(drag.h + (e.clientY - drag.y)); });
  const end = () => { if (!drag) return; drag = null; sp.classList.remove('dragging'); saveLocal(); };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('dblclick', () => { list.style.height = ''; list.style.maxHeight = ''; state.deckListH = 0; saveLocal(); });
  window.addEventListener('resize', () => { if (state.deckListH > 0) apply(state.deckListH); });
}

function qStore(q) {
  return (q || []).map(it => ({ enc: it.enc, done: !!it.done, winrate: it.winrate == null ? null : it.winrate, summary: it.summary || null, best: it.best || null, group: it.group || null, groupLabel: it.groupLabel || null, rows: it.rows ? it.rows.slice(0, 60) : null, report: it.report || null }));
}
function qRestore(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(it => it && it.enc).map(it => ({
    enc: it.enc, done: !!it.done, running: false,
    winrate: it.winrate == null ? null : it.winrate, summary: it.summary || null, best: it.best || null, status: '',
    group: it.group || null, groupLabel: it.groupLabel || null, rows: it.rows || null, report: it.report || null,
  }));
}
function saveLocal() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1,
        deck: state.deck, relics: state.relics, potions: state.potions, relicProps: state.relicProps,
        character: state.character, encounter: state.encounter, encKind: state.encKind, encMap: state.encMap || '全部', encGroups: state.encGroups || [], encGroups: state.encGroups || [],
        hp: state.hp, maxHp: state.maxHp, ascension: state.ascension, actIndex: state.actIndex,
        gameMode: state.gameMode, dreadBoss: state.dreadBoss,
        count: state.count, prefix: state.prefix, potionPolicy: state.potionPolicy,
        mode: state.mode, cmpCards: state.cmpCards, restOpts: state.restOpts, lastJob: state.lastJob,
        midCollapsed: !!state.midCollapsed,
        queue: qStore(state.queue),
        queueCmp: qStore(state.queueCmp),
        queueUp: qStore(state.queueUp),
        deckListH: state.deckListH || 0,
      }));
    } catch { }
  }, 250);
}
function loadLocal() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { }
  if (!s || s.v !== 1) return false;
  const arr = v => (Array.isArray(v) ? v : []);
  state.deck = arr(s.deck).filter(d => d && d.cardId).map(normEntry);
  state.relics = arr(s.relics).filter(Boolean);
  state.potions = arr(s.potions).filter(Boolean);
  // 遗物计数器：老存档没有这一项就留空（数值为 0 = 求解器默认）
  if (s.relicProps && typeof s.relicProps === 'object' && !Array.isArray(s.relicProps)) {
    const clean = {};
    for (const [id, v] of Object.entries(s.relicProps)) {
      if (!v || typeof v !== 'object') continue;
      const ints = arr(v.ints).filter(x => x && x.name).map(x => ({ name: String(x.name), value: Number(x.value) || 0 }));
      const bools = arr(v.bools).filter(x => x && x.name).map(x => ({ name: String(x.name), value: !!x.value }));
      if (ints.length || bools.length) clean[id] = { ints, bools };
    }
    state.relicProps = clean;
  } else state.relicProps = {};
  if (s.character) state.character = s.character;
  if (s.encounter) state.encounter = s.encounter;
  if (s.encKind) state.encKind = s.encKind;
  if (s.encMap) state.encMap = s.encMap;
  if (Array.isArray(s.encGroups)) state.encGroups = s.encGroups.filter(k => GROUP_KINDS[k]);
  if (Number.isFinite(s.hp)) state.hp = s.hp;
  if (Number.isFinite(s.maxHp)) state.maxHp = s.maxHp;
  if (Number.isFinite(s.ascension)) state.ascension = s.ascension;
  if (Number.isFinite(s.actIndex)) state.actIndex = s.actIndex;
  if (s.gameMode === 'Dread' || s.gameMode === 'Standard') state.gameMode = s.gameMode;
  if (typeof s.dreadBoss === 'string') state.dreadBoss = s.dreadBoss;
  state.queue = qRestore(s.queue);
  state.queueCmp = qRestore(s.queueCmp);
  state.queueUp = qRestore(s.queueUp);
  if (Number.isFinite(s.count)) state.count = s.count;
  if (s.prefix) state.prefix = s.prefix;
  if (s.potionPolicy) state.potionPolicy = s.potionPolicy;
  if (s.mode) state.mode = s.mode;
  state.cmpCards = arr(s.cmpCards).filter(c => c && c.cardId);
  if (s.lastJob && s.lastJob.id) state.lastJob = { id: String(s.lastJob.id), mode: s.lastJob.mode || 'single' };
  if (s.restOpts) state.restOpts = { ...state.restOpts, ...s.restOpts };
  state.midCollapsed = !!s.midCollapsed;
  state.deckListH = Number.isFinite(s.deckListH) ? s.deckListH : 0;
  const st = starterRelicOf(state.character);
  if (st) state.relics = state.relics.filter(r => r !== st);
  return true;
}
function syncInputs() {
  const set = (id, v) => { const el = $('#' + id); if (el != null && v != null) el.value = v; };
  set('hp', state.hp); set('maxhp', state.maxHp); set('ascension', state.ascension);
  set('count', state.count); set('prefix', state.prefix); set('potionPolicy', state.potionPolicy);
  const gm = $('#gameMode'); if (gm) gm.value = state.gameMode;
  renderDread();
}

function modePayload() {
  // relicProps 跟着每次请求走：遗物计数（钢笔尖打了几张攻击之类）直接影响战斗推演，
  // 不带上的话同一个遗物在 0 层和 9 层会被算成一样（2026-11-27 主人要求）。
  return {
    gameMode: state.gameMode === 'Dread' ? 'Dread' : 'Standard',
    dreadBoss: state.gameMode === 'Dread' ? state.dreadBoss : '',
    relicProps: relicPropsForRequest(),
  };
}
function dreadNameOf(id) {
  const d = (state.dreadList || []).find(x => x.encounterId === id);
  return d ? d.name : String(id || '');
}

/* ---------- 恐惧模式：选「恐惧首领」（领域来源）+ 锁死 A10 ---------- */
const DREAD_UNSUPPORTED = ['KNOWLEDGE_DEMON_BOSS'];   // 战斗中要选「灾祸」，离线没有这个选择器
function renderDread() {
  const wrap = $('#dreadWrap'), sel = $('#dreadBoss'), asc = $('#ascension'), gm = $('#gameMode');
  if (!wrap || !sel || !asc) return;
  const unsupported = (state.serverCaps || {}).dread === false;   // 没重启过的旧服务端
  if (gm) {
    gm.disabled = unsupported;
    gm.title = unsupported
      ? '这个服务端还是旧版本（没重启过），暂时算不了恐惧模式；重启服务后就能选'
      : '恐惧模式只有进阶 10，领域效果由「恐惧首领」决定';
  }
  if (unsupported && state.gameMode === 'Dread') state.gameMode = 'Standard';
  const isDread = state.gameMode === 'Dread';
  wrap.style.display = isDread ? '' : 'none';
  if (!isDread) { asc.disabled = false; asc.title = ''; return; }
  const list = state.dreadList || [];
  if (!sel.options.length) {
    sel.innerHTML = list.map(d => {
      const bad = DREAD_UNSUPPORTED.includes(d.encounterId);
      return `<option value="${esc(d.encounterId)}"${bad ? ' disabled' : ''}>${esc(d.name)}${bad ? '（暂不支持）' : ''}</option>`;
    }).join('');
  }
  if (!state.dreadBoss || !list.some(d => d.encounterId === state.dreadBoss && !DREAD_UNSUPPORTED.includes(d.encounterId))) {
    const first = list.find(d => !DREAD_UNSUPPORTED.includes(d.encounterId));
    state.dreadBoss = first ? first.encounterId : '';
  }
  sel.value = state.dreadBoss;
  const cur = list.find(d => d.encounterId === state.dreadBoss);
  sel.title = cur ? ('领域：' + cur.desc) : '';
  if (state.ascension !== 10) state.ascension = 10;
  asc.value = 10;
  asc.disabled = true;
  asc.title = '恐惧模式固定进阶 10';
}

/* ---------- 角色初始卡组 ---------- */
const ASCENDERS_BANE = 'ASCENDERS_BANE';
function starterDeckAt(character, ascension) {
  const d = state.startingDecks[character];
  if (!d) return null;
  const out = d.map(c => ({ cardId: c.cardId, count: c.count, upgradeLevels: c.upgradeLevels || 0 }));
  // 进阶 5 起，初始卡组里多一张诅咒「进阶之灾」（实测 A1–A4 没有，A5 起有）
  if (Number(ascension) >= 5 && !out.some(c => c.cardId === ASCENDERS_BANE)) {
    out.push({ cardId: ASCENDERS_BANE, count: 1, upgradeLevels: 0 });
  }
  return out;
}
function starterDeck(character) {
  return starterDeckAt(character, state.ascension);
}
const deckSig = deck => deck.map(d => `${d.cardId}|${d.count}|${d.upCount || 0}`).sort().join(',');
// 当前卡组还是不是"初始卡组"（两种进阶变体都算）——是的话才跟着进阶改
function isStarterLike() {
  const cur = deckSig(state.deck);
  return [0, 5].some(a => {
    const d = starterDeckAt(state.character, a);
    return d && deckSig(d) === cur;
  });
}
function applyStartingDeck(character) {
  const d = starterDeck(character);
  if (!d) return false;
  state.deck = d;
  renderDeck();
  return true;
}

/* ---------- 角色自带遗物（harness 会自动加，列表里不能再重复给） ---------- */
function starterRelicOf(character) {
  return state.startingRelics[character] || null;
}
function applyStartingRelics(character) {
  // 自带遗物是隐式的：清空"额外遗物"，让 harness 自己加那件
  state.relics = [];
  renderRelicChips();
}
// 请求前统一过一遍：自带的从列表里剔除，避免重复生效
function relicsForRequest() {
  const st = starterRelicOf(state.character);
  return state.relics.filter(r => r !== st);
}

// 只带列表里这些遗物的计数；没有计数就不带（求解器按默认 0 处理）
function relicPropsForRequest() {
  const out = {};
  for (const id of relicsForRequest()) {
    const p = state.relicProps[id];
    if (!p) continue;
    const ints = (p.ints || []).filter(x => x && x.name);
    const bools = (p.bools || []).filter(x => x && x.name);
    if (ints.length || bools.length) out[id] = { ints, bools };
  }
  return out;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const art = a => a ? '/assets/' + a : '';
// 没有卡图（例如开源仓库里没带游戏素材）时退成「无图」占位，不显示裂图
// 注意：这个 data URI 会塞进 onerror 的 JS 字符串里，所以不能出现任何引号（encodeURIComponent 会把双引号转成 %22）
const NO_ART = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="100%" height="100%" fill="#222631"/><text x="50%" y="55%" font-size="10" fill="#8b93a3" text-anchor="middle">无图</text></svg>');
const imgTag = (c, cls) => c.art
  ? `<img class="${cls || ''}" loading="lazy" src="${art(c.art)}" alt="${esc(c.name)}" onerror="this.onerror=null;this.src='${NO_ART}'">`
  : `<img class="${cls || ''}" alt="" src="${NO_ART}">`;

async function init() {
  try {
    const r = await fetch('/assets/meta.json');
    state.meta = await r.json();
  } catch (e) {
    $('#progressText').textContent = 'meta 加载失败';
    console.error(e);
    return;
  }
  try {
    const r2 = await fetch('/assets/starting_decks.json');
    state.startingDecks = await r2.json();
  } catch { state.startingDecks = {}; }
  try {
    const r3 = await fetch('/assets/starting_relics.json');
    state.startingRelics = await r3.json();
  } catch { state.startingRelics = {}; }
  try {
    const r4 = await fetch('/assets/dread.json');
    state.dreadList = await r4.json();
  } catch { state.dreadList = []; }
  for (const c of state.meta.cards) state.cardsById.set(c.id, c);
  for (const r of state.meta.relics) state.relicsById.set(r.id, r);
  for (const e of state.meta.enchantments) state.enchById.set(e.id, e);
  for (const e of state.meta.encounters) state.encById.set(e.id, e);

  const restored = loadLocal();
  if (!restored) {
    const d = starterDeck(state.character);
    if (d) state.deck = d;
    state.relics = [];   // 全新打开：只有角色自带那件，额外遗物留空
  }
  syncInputs();
  // 老存档里可能是"没有进阶之灾"的初始卡组，按当前进阶自动补/去
  if (restored && isStarterLike()) {
    const want = starterDeck(state.character);
    if (want && deckSig(want) !== deckSig(state.deck)) state.deck = want;
  }
  const _e = state.encById.get(state.encounter);
  if (_e && _e.kind) state.encKind = _e.kind;

  renderCharacters();
  bindTop();
  renderRelicChips();
  renderDeck();
  renderPool();


  renderResults();
  bindDeckPool();
  bindPresets();
  bindRefresh();
  bindRelicDlg();
  bindPotionDlg();
  bindTextImport();
  renderPotionChips();
  if ($('#exportSummary')) $('#exportSummary').onclick = exportSummary;
  const st = document.getElementById('selftest');
  if (st) st.addEventListener('click', runSelftest);
  checkDiag();
}

/* ---------- 环境自检：启动时查一遍，坏了就在顶上挂横幅；「自检」按钮真跑一局 ---------- */
async function checkDiag() {
  const box = document.getElementById('diagBanner');
  if (!box) return;
  let d = null;
  try {
    // 老版本服务端没有 /api/diag：先问 ping，别去撞 404（控制台会留红字）
    const ping = await (await fetch('/api/ping')).json();
    // 记一下服务端能力：老服务端（没重启过的那个）不认 gameMode，界面就别给它开恐惧开关
    state.serverCaps = { diag: !!(ping && ping.diag), dread: !!(ping && ping.dread) };
    renderDread();
    if (!ping || !ping.diag) { box.style.display = 'none'; return; }
    d = await (await fetch('/api/diag')).json();
  } catch (e) { return; }
  if (!d || d.ok) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = `<div class="diag-title">环境有问题：现在多半算不出结果</div>` +
    (d.problems || []).map(p => `<div class="diag-item"><b>${esc(p.code)}</b>${esc(p.msg)}${p.fix ? `<span class="muted"> → ${esc(p.fix)}</span>` : ''}</div>`).join('') +
    `<button class="ghost small" id="diagRetry">重新自检</button>`;
  box.style.display = 'block';
  const btn = document.getElementById('diagRetry');
  if (btn) btn.onclick = checkDiag;
}

async function runSelftest() {
  const btn = document.getElementById('selftest');
  if (!btn) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '自检中…';
  try {
    const body = {
      deck: deckForRequest(), relics: relicsForRequest(), potions: state.potions,
      encounter: state.encounter, character: state.character, ascension: state.ascension,
      actIndex: state.actIndex || 0, hp: state.hp, maxHp: state.maxHp,
      ...modePayload(), count: 1, prefix: 'SELFTEST', potionPolicy: state.potionPolicy,
      concurrency: 1, profile: 'VeryHigh', beam: 60, nodes: 20000, budget: 1500,
    };
    const r = await fetch('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '提交失败');
    let job = null;
    for (let i = 0; i < 90; i++) {
      job = await (await fetch('/api/job/' + j.id)).json();
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise(res => setTimeout(res, 700));
    }
    const v = (job && job.variants && job.variants[0]) || {};
    const one = (v.results || [])[0];
    if (one && one.won != null) {
      $('#progressText').textContent = `自检通过 ✓（${one.sec}s，战损 ${one.hpLost == null ? '—' : one.hpLost}）`;
      hideError();
      checkDiag();
    } else {
      reportError('自检没跑通：' + ((job && job.lastError) || '模拟器没产出结果'), JSON.stringify((job && job.variants) || {}, null, 1));
    }
  } catch (e) {
    reportError('自检失败：' + e.message, e.stack || '');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------- top bar ---------- */
function renderCharacters() {
  const sel = $('#character');
  sel.innerHTML = state.meta.characters
    .filter(c => !/^RANDOM|ROTATING/.test(c.id))
    .map(c => `<option value="${c.id}" ${c.id === state.character ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  sel.onchange = () => {
    state.character = sel.value;
    // 换角色连带换最大生命上限，并回满血（值取自 sts2.dll 的 StartingHp，见 decklogic.js）
    const hp = DeckLogic.maxHpOf(state.character);
    if (hp) { state.maxHp = hp; state.hp = hp; }
    applyStartingDeck(state.character);      // 换角色自动换成该角色的初始卡组
    applyStartingRelics(state.character);    // 遗物也回到该角色的默认（自带那件由 harness 自动加）
    syncInputs();
    saveLocal();
  };
}

function bindTop() {
  const map = { hp: 'hp', maxhp: 'maxHp', ascension: 'ascension', count: 'count', prefix: 'prefix', potionPolicy: 'potionPolicy' };
  for (const [id, key] of Object.entries(map)) {
    const el = $('#' + id);
    el.addEventListener('input', () => {
      state[key] = id === 'prefix' || id === 'potionPolicy' ? el.value : Number(el.value);
      if (key === 'hp') {   // 当前血不能超过血上限
        const cap = state.maxHp || DeckLogic.maxHpOf(state.character) || 999;
        if (!Number.isFinite(state.hp) || state.hp < 1) state.hp = 1;
        if (state.hp > cap) { state.hp = cap; el.value = cap; }
      }
    });
    if (id === 'potionPolicy') el.addEventListener('change', () => { state.potionPolicy = el.value; });
  }
  $('#run').addEventListener('click', run);
  $('#csv').addEventListener('click', exportCsv);
  const gmSel = $('#gameMode');
  if (gmSel) gmSel.addEventListener('change', () => { state.gameMode = gmSel.value; renderDread(); saveLocal(); });
  const dbSel = $('#dreadBoss');
  if (dbSel) dbSel.addEventListener('change', () => { state.dreadBoss = dbSel.value; renderDread(); saveLocal(); });
  // 改飞升：如果卡组还是初始卡组，就跟着加减「进阶之灾」
  $('#ascension').addEventListener('change', () => {
    if (isStarterLike()) applyStartingDeck(state.character);
  });
  $('#countQuick').onclick = e => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    state.count = Number(b.dataset.n);
    $('#count').value = state.count;
  };
}

/* ---------- relics ---------- */
// 遗物计数器（存档 props.ints/bools 里的字段）的中文叫法；没有的就直接显示原字段名
const RELIC_PROP_LABEL = {
  AttacksPlayed: '攻击', SkillsPlayed: '技能', PowersPlayed: '能力', CardsPlayed: '出牌',
  TurnsPlayed: '回合', FloorsClimbed: '层', GoldGained: '金币', DamageTaken: '受伤',
  DamageDealt: '伤害', CombatsWon: '胜场', Combats: '战斗', AttacksDrawn: '抽攻击',
  CardsDrawn: '抽牌', PotionsUsed: '用药', RoomsEntered: '房间', ElitesDefeated: '精英',
  BossesDefeated: '首领', CardsUpgraded: '升级', CardsRemoved: '删牌', WasUsed: '已用',
};

/** 一件遗物的计数控件（只有存档里真带了计数才有） */
function relicCounterHTML(id) {
  const p = state.relicProps[id];
  if (!p) return '';
  const parts = [];
  for (const it of p.ints || []) {
    const label = RELIC_PROP_LABEL[it.name] || it.name;
    parts.push(`<label class="rc" title="${esc(it.name)}">${esc(label)}<input type="number" min="0" max="9999" data-prop="${esc(it.name)}" value="${esc(String(Number(it.value) || 0))}"></label>`);
  }
  for (const it of p.bools || []) {
    const label = RELIC_PROP_LABEL[it.name] || it.name;
    parts.push(`<label class="rc cb" title="${esc(it.name)}"><input type="checkbox" data-prop="${esc(it.name)}"${it.value ? ' checked' : ''}>${esc(label)}</label>`);
  }
  return parts.length ? `<span class="counters">${parts.join('')}</span>` : '';
}

function renderRelicChips() {
  const box = $('#relicList');
  const st = starterRelicOf(state.character);
  const stRelic = st ? state.relicsById.get(st) : null;
  const head = st
    ? `<span class="chip auto" title="角色自带，由 harness 自动加入，不能移除">${stRelic ? imgTag(stRelic) : ''}<span>${esc(stRelic ? stRelic.name : st)}</span><span class="tag-auto">自带</span></span>`
    : '';
  const rest = state.relics.filter(r => r !== st);
  if (!rest.length) { box.innerHTML = head + '<span class="muted">点「+ 选遗物」加额外遗物</span>'; return; }
  box.innerHTML = head + rest.map(id => {
    const r = state.relicsById.get(id);
    const name = r ? r.name : id;
    return `<span class="chip" data-id="${esc(id)}">${r ? imgTag(r) : ''}<span>${esc(name)}</span>${relicCounterHTML(id)}<span class="x" data-op="del" title="移除">×</span></span>`;
  }).join('');
  box.onclick = e => {
    const x = e.target.closest('[data-op=del]');
    if (!x) return;
    const id = x.closest('.chip').dataset.id;
    state.relics = state.relics.filter(r => r !== id);
    delete state.relicProps[id];
    renderRelicChips();
    saveLocal();
  };
  // 改计数：直接落进 state.relicProps，下一次测算就带上（也存进本地记忆）
  box.oninput = e => {
    const inp = e.target;
    if (!inp.dataset || !inp.dataset.prop) return;
    const chip = inp.closest('.chip');
    if (!chip) return;
    const p = state.relicProps[chip.dataset.id];
    if (!p) return;
    const isBool = inp.type === 'checkbox';
    const item = (p[isBool ? 'bools' : 'ints'] || []).find(x => x.name === inp.dataset.prop);
    if (!item) return;
    item.value = isBool ? inp.checked : Math.max(0, Math.min(9999, Math.round(Number(inp.value) || 0)));
    saveLocal();
  };
}

function bindRelicDlg() {
  const dlg = $('#relicDlg');
  $('#addRelic').onclick = () => { renderRelicGrid(''); dlg.showModal(); $('#relicSearch').focus(); };
  $('#relicDlgClose').onclick = () => dlg.close();
  $('#relicSearch').oninput = e => renderRelicGrid(e.target.value);
}

function renderRelicGrid(q) {
  const ql = (q || '').trim().toLowerCase();
  const st = starterRelicOf(state.character);
  const list = state.meta.relics.filter(r => !ql || r.name.toLowerCase().includes(ql) || r.id.toLowerCase().includes(ql));
  $('#relicDlgCount').textContent = `${list.length} 个`;
  $('#relicGrid').innerHTML = list.map(r => {
    const isStarter = r.id === st;
    const on = isStarter || state.relics.includes(r.id);
    return `<div class="relic-opt ${on ? 'on' : ''} ${isStarter ? 'auto' : ''}" data-id="${esc(r.id)}" title="${esc(r.desc)}${isStarter ? '\n（角色自带，自动生效，不用手动加）' : ''}">
      ${r.art ? `<img loading="lazy" src="${art(r.art)}" alt="">` : '<img alt="">'}
      <div><div class="rn">${esc(r.name)}</div><div class="rr">${esc(isStarter ? '角色自带' : (r.rarity || ''))}</div></div>
    </div>`;
  }).join('');
  $('#relicGrid').onclick = e => {
    const opt = e.target.closest('.relic-opt');
    if (!opt) return;
    const id = opt.dataset.id;
    if (id === starterRelicOf(state.character)) return;   // 自带的不让再点，避免重复生效
    if (state.relics.includes(id)) state.relics = state.relics.filter(r => r !== id);
    else state.relics.push(id);
    opt.classList.toggle('on');
    renderRelicChips();
  };
}

/* ---------- 药水：自己加/删（2026-11-27 主人要的「药水自定义」） ---------- */
function potionById(id) { return (state.meta.potions || []).find(p => p.id === id); }
function renderPotionChips() {
  const box = $('#potionList');
  if (!box) return;
  if (!state.potions.length) { box.innerHTML = `<span class="muted">点「+ 选药水」加药水（最多 ${POTION_MAX} 瓶）</span>`; return; }
  box.innerHTML = state.potions.map((id, i) => {
    const p = potionById(id);
    return `<span class="chip" data-idx="${i}" title="${esc(p ? p.desc : id)}"><span>${esc(p ? p.name : id)}</span><span class="x" data-op="del" title="移除">×</span></span>`;
  }).join('');
  box.onclick = e => {
    const x = e.target.closest('[data-op=del]');
    if (!x) return;
    state.potions.splice(Number(x.closest('.chip').dataset.idx), 1);
    renderPotionChips(); saveLocal();
  };
}
function bindPotionDlg() {
  const dlg = $('#potionDlg');
  if (!dlg || !$('#addPotion')) return;
  $('#addPotion').onclick = () => { renderPotionGrid(''); dlg.showModal(); $('#potionSearch').focus(); };
  $('#potionDlgClose').onclick = () => dlg.close();
  $('#potionSearch').oninput = e => renderPotionGrid(e.target.value);
}
function renderPotionGrid(q) {
  const ql = (q || '').trim().toLowerCase();
  const list = (state.meta.potions || []).filter(p => !ql ||
    p.name.toLowerCase().includes(ql) || p.id.toLowerCase().includes(ql) || String(p.desc || '').toLowerCase().includes(ql));
  $('#potionDlgCount').textContent = `${list.length} 种 · 已带 ${state.potions.length}/${POTION_MAX}`;
  $('#potionGrid').innerHTML = list.map(p => {
    const n = state.potions.filter(x => x === p.id).length;
    return `<div class="relic-opt potion-opt ${n ? 'on' : ''}" data-id="${esc(p.id)}" title="${esc(p.desc)}">
      <div><div class="rn">${esc(p.name)}</div><div class="rr">${esc(p.rarity || '')}${n ? ` · 已带 ${n}` : ''}</div></div>
    </div>`;
  }).join('');
  $('#potionGrid').onclick = e => {
    const opt = e.target.closest('.potion-opt');
    if (!opt) return;
    if (state.potions.length >= POTION_MAX) {
      $('#potionDlgCount').textContent = `最多 ${POTION_MAX} 瓶（药水栏上限）`;
      return;
    }
    state.potions.push(opt.dataset.id);
    renderPotionChips(); renderPotionGrid(q); saveLocal();
  };
}

/* ---------- 文字导入卡组：在初始卡组上改（2026-11-27 主人要的） ---------- */
let _textParsed = null;
function textDeckBase(useCurrent) {
  if (useCurrent) return state.deck.map(d => ({ cardId: d.cardId, count: d.count, upCount: d.upCount || 0 }));
  const st = starterDeck(state.character) || [];
  return st.map(d => ({ cardId: d.cardId, count: d.count, upCount: d.upgradeLevels ? d.count : 0 }));
}
function renderTextPreview(useCurrent) {
  const text = $('#textInput').value;
  const base = textDeckBase(useCurrent);
  const r = DeckLogic.parseTextDelta(text, state.meta.cards, base, { character: state.character });
  _textParsed = r;
  const baseTotal = base.reduce((s, d) => s + d.count, 0);
  const head = `<div class="muted tiny">底子：${useCurrent ? '当前卡组' : '初始卡组'} ${baseTotal} 张 → 改完 ${r.total} 张（${r.deck.length} 种）</div>`;
  const rows = r.rows.map(x => {
    const c = state.cardsById.get(x.cardId) || {};
    const up = x.op === 'add' ? (x.up ? '+' : '') : '';
    return `<div class="tp-row ${x.op}"><span class="tp-op">${x.op === 'add' ? '+' : '−'}</span><span>${esc(x.name)}${up}</span><span class="muted">×${x.count}</span></div>`;
  }).join('');
  const warn = r.unmatched.length ? `<div class="tp-warn">没认出来的：${esc(r.unmatched.join('，'))}</div>` : '';
  $('#textPreview').innerHTML = head + (rows || '<div class="muted tiny">上面写一句，这里先给你看改成了什么样。</div>') + warn;
  $('#textWarn').textContent = r.rows.length ? (r.unmatched.length ? '认得出的照常用，认不出的跳过' : '') : '还没认出改动';
  $('#textApply').disabled = !r.rows.length;
}
function bindTextImport() {
  const dlg = $('#textDlg');
  if (!dlg || !$('#textImport')) return;
  $('#textImport').onclick = () => { dlg.showModal(); $('#textInput').focus(); renderTextPreview($('#textBaseCur').checked); };
  $('#textDlgClose').onclick = () => dlg.close();
  $('#textInput').oninput = () => renderTextPreview($('#textBaseCur').checked);
  $('#textBaseCur').onchange = () => renderTextPreview($('#textBaseCur').checked);
  $('#textApply').onclick = () => {
    if (!_textParsed || !_textParsed.rows.length) return;
    state.deck = _textParsed.deck;
    renderDeck(); saveLocal();
    dlg.close();
    $('#refreshInfo').textContent = `文字导入：改了 ${_textParsed.rows.length} 处，共 ${_textParsed.total} 张`;
  };
}

/* ---------- 导出结算图：卡组有什么卡、升没升、遗物有什么（2026-11-27 主人要的） ---------- */
function summaryText() {
  const cName = state.cardsById.get(state.character);
  const encName = (state.encById.get(state.encounter) || {}).name || state.encounter;
  const total = state.deck.reduce((s, d) => s + d.count, 0);
  const stR = starterRelicOf(state.character);
  const relics = state.relics.filter(id => id !== stR);
  const relicName = id => (state.relicsById.get(id) || {}).name || id;
  const cnt = id => {
    const p = state.relicProps[id];
    if (!p) return '';
    const bits = (p.ints || []).map(x => `${RELIC_PROP_LABEL[x.name] || x.name} ${x.value}`);
    for (const b of p.bools || []) if (b.value) bits.push(RELIC_PROP_LABEL[b.name] || b.name);
    return bits.length ? `（${bits.join('，')}）` : '';
  };
  return { cName, encName, total, relics, stR, relicName, cnt };
}
async function exportSummary() {
  const btn = $('#exportSummary');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const { cName, encName, total, relics, stR, relicName, cnt } = summaryText();
    const W = 1120, PAD = 36, SCALE = 2;
    const font = (px, weight) => `${weight || 400} ${px}px "Microsoft YaHei","PingFang SC",system-ui,sans-serif`;
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d');
    const F_HEAD = font(17), F_ITEM = font(17), F_NAME = font(18), F_TITLE = font(34, 700);
    // 卡片：两列，每行「名字(+ 升级标记) …… ×N 类型」；遗物/药水：自动换行的一串
    const byType = { 1: '攻击', 2: '技能', 3: '能力', 4: '状态', 5: '诅咒', 6: '特殊' };
    const cardRows = state.deck.map(d => {
      const c = state.cardsById.get(d.cardId) || { name: d.cardId, type: 0 };
      const up = (d.upCount || 0) > 0;
      const upAll = up && d.upCount >= d.count;
      return {
        name: c.name + (up ? (upAll ? '+' : `+×${d.upCount}`) : ''),
        up, count: d.count, type: byType[c.type] || '',
        ench: d.enchantmentId ? ((state.enchById.get(d.enchantmentId) || {}).name || d.enchantmentId) : '',
      };
    });
    const relicTokens = [];
    if (stR) relicTokens.push(relicName(stR) + '（自带）');
    for (const id of relics) relicTokens.push(relicName(id) + cnt(id));
    const potionTokens = state.potions.map(id => (potionById(id) || {}).name || id);

    // 先量一遍，才能定画布高度（Canvas 只能从上往下画）
    const measure = (text, f) => { ctx.font = f; return ctx.measureText(text).width; };
    const wrap = (tokens, maxW, f, sep = '   ') => {
      const out = []; let line = ''; let w = 0;
      for (const tk of tokens) {
        const tw = measure(tk, f) + measure(sep, f);
        if (line && w + tw > maxW) { out.push(line); line = tk; w = measure(tk, f) + measure(sep, f); }
        else { line = line + sep + tk; w += tw; }
      }
      if (line) out.push(line);
      return out;
    };
    const relicLines = wrap(relicTokens, W - PAD * 2, F_ITEM);
    const potionLines = wrap(potionTokens, W - PAD * 2, F_ITEM);
    const cardColW = (W - PAD * 2) / 2;
    const cardLineH = 30;
    const cardRowsCount = Math.ceil(cardRows.length / 2);
    const headerH = 104;
    const relicH = 34 + relicLines.length * 30;
    const potionH = state.potions.length ? 34 + potionLines.length * 30 : 0;
    const cardsH = 40 + cardRowsCount * cardLineH + 8;
    const footerH = 44;
    const H = headerH + relicH + potionH + cardsH + footerH + PAD;

    cvs.width = W * SCALE; cvs.height = H * SCALE;
    ctx.scale(SCALE, SCALE);
    // 背景
    ctx.fillStyle = '#0f141b'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#161d27'; ctx.fillRect(0, 0, W, headerH);
    ctx.fillStyle = '#f2c65d'; ctx.fillRect(0, headerH - 3, W, 3);
    // 标题
    ctx.font = F_TITLE; ctx.fillStyle = '#eef3fa';
    ctx.fillText('卡组结算', PAD, 56);
    ctx.font = F_HEAD; ctx.fillStyle = '#9aa7b8';
    ctx.fillText(`${cName ? cName.name : state.character} · A${state.ascension} · ${state.hp}/${state.maxHp} HP · ${state.gameMode === 'Dread' ? '恐惧' : '标准'} · ${encName}`, PAD, 84);
    ctx.textAlign = 'right';
    ctx.fillText(`${total} 张 · ${relics.length + (stR ? 1 : 0)} 遗物 · ${state.potions.length} 药水`, W - PAD, 56);
    ctx.fillText(new Date().toLocaleString('zh-CN'), W - PAD, 84);
    ctx.textAlign = 'left';

    let y = headerH + 40;
    const section = (title) => {
      ctx.font = font(19, 700); ctx.fillStyle = '#f2c65d';
      ctx.fillText(title, PAD, y);
      y += 26;
    };
    section(`遗物（${relics.length + (stR ? 1 : 0)}）`);
    ctx.font = F_ITEM;
    for (const line of relicLines) {
      ctx.fillStyle = '#cfd8e3';
      ctx.fillText(line.trim(), PAD, y);
      y += 30;
    }
    y += 6;
    if (state.potions.length) {
      section(`药水（${state.potions.length}）`);
      ctx.font = F_ITEM;
      for (const line of potionLines) {
        ctx.fillStyle = '#cfd8e3';
        ctx.fillText(line.trim(), PAD, y);
        y += 30;
      }
      y += 6;
    }
    y += 10;
    section(`卡牌（${total} 张 / ${state.deck.length} 种）`);
    y += 4;
    ctx.font = F_NAME;
    for (let i = 0; i < cardRows.length; i += 2) {
      for (let k = 0; k < 2; k++) {
        const row = cardRows[i + k];
        if (!row) continue;
        const x = PAD + k * cardColW;
        ctx.textAlign = 'left';
        ctx.fillStyle = row.up ? '#8ee39a' : '#e8eef7';
        ctx.fillText(row.name, x, y);
        let tail = `×${row.count}`;
        if (row.type) tail += '  ' + row.type;
        if (row.ench) tail += '  ' + row.ench;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#8b98a9';
        ctx.font = font(15);
        ctx.fillText(tail, x + cardColW - 24, y);
        ctx.font = F_NAME;
      }
      y += cardLineH;
    }
    ctx.textAlign = 'left';
    ctx.font = font(14);
    ctx.fillStyle = '#6f7d8f';
    ctx.fillText('StS2 胜率测算 · 导出的卡组结算（+ = 已升级）', PAD, H - 18);

    const blob = await new Promise(res => cvs.toBlob(res, 'image/png'));
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = URL.createObjectURL(blob);
    a.download = `卡组结算-${cName ? cName.name : state.character}-${total}张-${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    btn.textContent = '已导出';
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
  } catch (e) {
    btn.textContent = '导出失败';
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2000);
    reportError('导出结算图失败：' + e.message, e.stack || '');
  }
}

/* ---------- deck editor ---------- */
function bindDeckPool() {
  $('#cardSearch').addEventListener('input', renderPool);
  $('#typeFilter').addEventListener('change', renderPool);
  $('#clearDeck').onclick = () => { state.deck = []; renderDeck(); };
  $('#resetDeck').onclick = () => {
    if (!applyStartingDeck(state.character)) alert('没有这个角色的初始卡组数据');
  };
  $('#cardPool').addEventListener('click', e => {
    const item = e.target.closest('.card-item');
    if (!item) return;
    addCard(item.dataset.id);
  });
  $('#deckList').addEventListener('click', e => {
    const item = e.target.closest('.deck-item');
    if (!item) return;
    const id = item.dataset.id;
    const d = state.deck.find(x => x.cardId === id);
    if (!d) return;
    const op = e.target.closest('[data-op]')?.dataset.op;
    if (op === 'plus') d.count = Math.min(20, d.count + 1);
    else if (op === 'minus') { d.count -= 1; if (d.count <= 0) state.deck = state.deck.filter(x => x !== d); }
    else if (op === 'del') state.deck = state.deck.filter(x => x !== d);
    else return;
    renderDeck();
  });
  $('#deckList').addEventListener('change', e => {
    const item = e.target.closest('.deck-item');
    const op = e.target.dataset.op;
    if (!item || (op !== 'up' && op !== 'ench')) return;
    const d = state.deck.find(x => x.cardId === item.dataset.id);
    if (!d) return;
    if (op === 'up') d.upCount = e.target.checked ? d.count : 0;
    if (op === 'ench') {
      const v = e.target.value || '';
      d.enchantmentId = v || undefined;
      d.enchantmentAmount = 0;
      // 选了附魔默认整组都附（和以前一致），再用「N张附魔」往下调到只附其中几张
      d.enchCount = v ? d.count : 0;
    }
    renderDeck();
  });
  // 同名卡里只升级/只附魔其中几张（比如 4 张打击里只有 1 张是打击+、另 1 张附了伶俐）
  $('#deckList').addEventListener('input', e => {
    const op = e.target.dataset.op;
    if (op !== 'upn' && op !== 'enchn') return;
    const item = e.target.closest('.deck-item');
    const d = state.deck.find(x => x.cardId === item.dataset.id);
    if (!d) return;
    const n = Math.max(0, Math.min(d.count, Number(e.target.value) || 0));
    if (op === 'upn') {
      d.upCount = n;
      d.upgradeLevels = n > 0 ? 1 : 0;
      const tag = item.querySelector('.up-tag');
      if (tag) {
        tag.style.display = n > 0 ? '' : 'none';
        tag.textContent = n > 0 && n < d.count ? `升级 ${n}/${d.count}` : '升级';
      }
      return;
    }
    d.enchCount = n;
    const tag = item.querySelector('.ench-tag');
    if (tag) {
      tag.style.display = n > 0 ? '' : 'none';
      tag.textContent = n > 0 && n < d.count ? `附魔 ${n}/${d.count}` : '附魔';
    }
  });
  // 数量减少时，已升级/已附魔的张数不能超过总数
  $('#deckList').addEventListener('click', () => {
    for (const d of state.deck) {
      if ((d.upCount || 0) > d.count) d.upCount = d.count;
      if ((d.enchCount || 0) > d.count) d.enchCount = d.count;
    }
  }, true);
}

function addCard(id) {
  const d = state.deck.find(x => x.cardId === id);
  if (d) d.count = Math.min(20, d.count + 1);
  else state.deck.push({ cardId: id, count: 1 });
  renderDeck();
}

function renderDeck() {
  const box = $('#deckList');
  const total = state.deck.reduce((s, d) => s + d.count, 0);
  $('#deckCount').textContent = `${total} 张 / ${state.deck.length} 种`;
  if (!state.deck.length) { box.innerHTML = '<div class="empty">卡组为空，从下面卡池点卡牌加入</div>'; return; }
  box.innerHTML = state.deck.map(d => {
    const c = state.cardsById.get(d.cardId) || { id: d.cardId, name: d.cardId, type: 0, rarity: 0, art: null, upgradable: 0 };
    const upN = Math.min(d.count, Math.max(0, d.upCount || 0));
    const up = upN > 0;
    // 附魔也按张数算：老数据没有 enchCount 时，语义还是「整组都附魔」
    const enchN = Math.min(d.count, Math.max(0, d.enchCount != null ? d.enchCount : (d.enchantmentId ? d.count : 0)));
    const enchOn = !!d.enchantmentId && enchN > 0;
    const tn = TYPE_NAME[c.type] || '';
    const rn = c.rarity && RARITY_NAME[c.rarity] !== tn ? (RARITY_NAME[c.rarity] || '') : '';
    const costTxt = c.cost == null ? '' : (c.cost >= 0 ? c.cost + '费' : '不可打出');
    const enchOpts = ['<option value="">无附魔</option>'].concat(
      state.meta.enchantments.map(e => `<option value="${e.id}" ${d.enchantmentId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`)
    ).join('');
    const upTag = up ? `<span class="up-tag">${upN < d.count ? `升级 ${upN}/${d.count}` : '升级'}</span>` : '';
    const enchTag = enchOn ? `<span class="ench-tag">${enchN < d.count ? `附魔 ${enchN}/${d.count}` : '附魔'}</span>` : '';
    // 只有一张：勾选框；多张：可以指定其中几张是升级态
    const upCtl = d.count === 1
      ? `<label title="已升级"><input type="checkbox" data-op="up" ${up ? 'checked' : ''}></label>`
      : `<label class="upnum" title="其中有几张是升级态">强化<input type="number" data-op="upn" min="0" max="${d.count}" value="${upN}">张</label>`;
    // 附魔张数：选了附魔、且这种卡不止一张时才需要（一张的就是「附/不附」）
    const enchCtl = d.enchantmentId && d.count > 1
      ? `<label class="upnum" title="其中有几张附了魔"><input type="number" data-op="enchn" min="0" max="${d.count}" value="${enchN}">张附魔</label>`
      : '';
    return `<div class="deck-item" data-id="${esc(d.cardId)}">
      <div class="row1">
        ${imgTag(c)}
        <div class="info">
          <div class="name">${esc(c.name)}${c.upgradable && upN === d.count && d.count > 1 ? '+' : ''} ${upTag} ${enchTag}</div>
          <div class="sub muted">${[tn, rn, costTxt].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="ops">
          <button class="ghost small" data-op="minus" title="减一">−</button>
          <span class="num">${d.count}</span>
          <button class="ghost small" data-op="plus" title="加一">+</button>
          <button class="ghost small" data-op="del" title="移除">×</button>
        </div>
      </div>
      <div class="ctl">
        ${upCtl}
        <span class="ctl-sep">附魔</span>
        <select data-op="ench">${enchOpts}</select>
        ${enchCtl}
      </div>
    </div>`;
  }).join('');
}

/* 把界面行归一成求解器条目（纯逻辑在 decklogic.js，node 里能单测） */
function normEntry(d) {
  return DeckLogic.normalizeEntry(d);
}

function deckForRequest() {
  // 同名卡按「升级张数 × 附魔张数」拆条，最多拆成 4 条（见 decklogic.js 的注释）
  return DeckLogic.expandDeck(state.deck);
}

function bindRefresh() {
  $('#refresh').onclick = refreshFromGame;
}

async function refreshFromGame() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const r = await fetch('/api/import');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '读取失败');
    // 服务端没有进行中的存档时会回 200 + ok:false（不是错，只是没得读）
    if (j.ok === false) throw new Error(j.error || '没有找到进行中的存档');
    // 存档里同一种卡会按「升级/附魔」拆成多条，界面一行只能挂一种附魔 → 合并成一行
    const merged = DeckLogic.mergeImported(j.deck || []);
    state.deck = merged.deck;
    state.relics = j.relics || [];
    // 计数遗物的实际数字（存档里 props.ints）；界面会显示成可改的数字框
    state.relicProps = (j.relicProps && typeof j.relicProps === 'object') ? j.relicProps : {};
    state.potions = j.potions || [];
    renderPotionChips();
    state.character = j.character;
    state.hp = j.hp;
    state.maxHp = j.maxHp;
    state.ascension = j.ascension;
    state.actIndex = j.actIndex || 0;
    if (j.encounter) state.encounter = j.encounter;
    $('#hp').value = j.hp;
    $('#maxhp').value = j.maxHp;
    $('#ascension').value = j.ascension;
    renderCharacters();
    renderDeck();
    renderRelicChips();
    const enc = state.encById.get(state.encounter);
    if (enc) {
      state.encKind = enc.kind;
      $$('#encTabs button').forEach(x => x.classList.toggle('active', x.dataset.kind === enc.kind));
      renderEncLists();
    }
    const t = j.savedAt ? new Date(j.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    $('#refreshInfo').textContent = '存档 ' + t + (merged.warnings.length ? ` · ⚠ ${merged.warnings.length} 种卡附魔不统一，见控制台` : '');
    if (merged.warnings.length) console.warn('[导入] 同名卡附魔不统一：\n' + merged.warnings.join('\n'));
    btn.textContent = '已刷新';
    setTimeout(() => { btn.textContent = '刷新'; btn.disabled = false; }, 1200);
  } catch (e) {
    btn.textContent = '刷新失败';
    $('#refreshInfo').textContent = e.message;
    setTimeout(() => { btn.textContent = '刷新'; btn.disabled = false; }, 2400);
  }
}

function renderPool() {
  const q = $('#cardSearch').value.trim().toLowerCase();
  const tf = $('#typeFilter').value;
  let list = state.meta.cards.filter(c =>
    (!tf || String(c.type) === tf) &&
    (!q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));
  const LIMIT = 160;
  const shown = list.slice(0, LIMIT);
  const pool = $('#cardPool');
  pool.innerHTML = shown.map(c => `
    <div class="card-item" data-id="${esc(c.id)}" title="${esc(c.name)}${c.desc ? '\n' + esc(c.desc) : ''}">
      ${imgTag(c)}
      <div class="cost">${c.cost == null ? '?' : (c.cost >= 0 ? c.cost : 'X')}</div>
      <div class="t ${TYPE_CLASS[c.type] || ''}">${TYPE_NAME[c.type] || ''}</div>
      <div class="cap">${esc(c.name)}</div>
    </div>`).join('');
  if (list.length > LIMIT) pool.insertAdjacentHTML('beforeend', `<div class="empty" style="grid-column:1/-1">还有 ${list.length - LIMIT} 张，继续输入搜索</div>`);
}

/* ---------- encounters ---------- */
/* 怪物资料外链：Spire Codex 的中文遭遇页（id 小写就能对上） */
function encUrl(id) { return 'https://spire-codex.com/zhs/beta/encounters/' + String(id || '').toLowerCase(); }
function encLink(id, name) {
  return `<a class="enc-link" href="${encUrl(id)}" target="_blank" rel="noreferrer noopener" title="去 Spire Codex 看这只怪的资料（血量、行动、敌人）">${esc(name || id)} ↗</a>`;
}

/* 三个模式共用一套「遭遇 + 排队」面板：同一份内容、同一套 id 规则，只是挂在不同容器里 */
const ENC_IDS = {
  single: { search: 'encSearch', mapTabs: 'encMapTabs', tabs: 'encTabs', list: 'encList', qAdd: 'qAdd', qRun: 'qRun', qClear: 'qClear', qList: 'qList', qResult: 'qResult' },
  compare: { search: 'cmpEncSearch', mapTabs: 'cmpEncMapTabs', tabs: 'cmpEncTabs', list: 'cmpEncList', qAdd: 'cmpQAdd', qRun: 'cmpQRun', qClear: 'cmpQClear', qList: 'cmpQList', qResult: 'cmpQResult' },
  upgrade: { search: 'upEncSearch', mapTabs: 'upEncMapTabs', tabs: 'upEncTabs', list: 'upEncList', qAdd: 'upQAdd', qRun: 'upQRun', qClear: 'upQClear', qList: 'upQList', qResult: 'upQResult' },
};
/* 先选地图（四张图 + 全部 + 事件），再选怪的种类 */
const ENC_MAPS = ['全部', '密林', '暗巷', '巢穴', '荣耀', '事件'];
const ENC_KINDS = [['weak', '弱怪'], ['normal', '普通'], ['elite', '精英'], ['boss', 'Boss'], ['event', '事件']];
/* 名单压缩：一次把整类怪都排进去，跑完出「单卡战损预估」数据图 */
const GROUP_KINDS = { weak: '全部弱怪', normal: '全部普通怪', elite: '全部精英', boss: '全部Boss' };
const GROUP_PREFIX = '__GROUP_';
const ENC_MOUNTED = {};   // mode -> root element

function mountEncPanel(rootSel, mode) {
  const root = typeof rootSel === 'string' ? $(rootSel) : rootSel;
  if (!root) return;
  const id = ENC_IDS[mode];
  root.innerHTML = `
    <div class="panel-head"><h3>遭遇</h3><input id="${id.search}" type="search" placeholder="搜索怪物"></div>
    <div class="tabs map-tabs" id="${id.mapTabs}">
      ${ENC_MAPS.map(m => `<button data-map="${m}"${m === (state.encMap || '全部') ? ' class="active"' : ''}>${m}</button>`).join('')}
    </div>
    <div class="tabs" id="${id.tabs}">
      ${ENC_KINDS.map(([k, label]) => `<button data-kind="${k}"${k === state.encKind ? ' class="active"' : ''}>${label}</button>`).join('')}
    </div>
    <div id="${id.list}" class="enc-list"></div>
    <div class="panel-head pool-head queue-head"><h3>排队（多怪连着算）</h3>
      <button id="${id.qAdd}" class="ghost small" title="把当前选中的遭遇加进队列">+ 加入</button>
      <button id="${id.qRun}" class="primary small" title="按队列顺序一只一只算">开始排队</button>
      <button id="${id.qClear}" class="ghost small">清空</button></div>
    <div id="${id.qList}" class="queue-list"></div>
    <div id="${id.qResult}" class="queue-result"></div>`;
  ENC_MOUNTED[mode] = root;
  const tabs = $('#' + id.tabs);
  tabs.onclick = e => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    state.encKind = b.dataset.kind;
    renderEncLists();
  };
  const mapTabs = $('#' + id.mapTabs);
  if (mapTabs) mapTabs.onclick = e => {
    const b = e.target.closest('button[data-map]');
    if (!b) return;
    state.encMap = b.dataset.map;
    saveLocal();
    renderEncLists();
  };
  const search = $('#' + id.search);
  search.value = state.encQ || '';
  search.oninput = () => { state.encQ = search.value; renderEncLists(); };
  const qAdd = $('#' + id.qAdd);
  if (qAdd) qAdd.onclick = () => addToQueue(mode);
  const qRunBtn = $('#' + id.qRun);
  if (qRunBtn) qRunBtn.onclick = () => runQueue(mode);
  const qClear = $('#' + id.qClear);
  if (qClear) qClear.onclick = () => {
    if (qArr(mode).some(it => it.running)) { qHint(mode, '有任务正在算——先点上面「■ 终止」'); return; }
    state[mode === 'single' ? 'queue' : mode === 'compare' ? 'queueCmp' : 'queueUp'] = [];
    saveLocal(); renderQueue(mode); renderQueueResults(mode);
  };
  renderEncLists();
  renderQueue(mode);
  renderQueueResults(mode);
}

function renderEncLists() {
  const q = String(state.encQ || '').trim().toLowerCase();
  const list = state.meta.encounters.filter(e => e.kind === state.encKind
    && ((state.encMap || '全部') === '全部' || (e.map || '事件') === state.encMap)
    && (!q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)));
  for (const [mode, root] of Object.entries(ENC_MOUNTED)) {
    const id = ENC_IDS[mode];
    const box = $('#' + id.list);
    if (!box) continue;
    const map = state.encMap || '全部';
    // 名单压缩：地图不是「全部/事件」时，把这一类的全部怪合成一行
    const groupRow = (!q && map !== '全部' && map !== '事件') ? Object.entries(GROUP_KINDS).map(([k, label]) => {
      const n = state.meta.encounters.filter(e => e.kind === k && (e.map || '事件') === map).length;
      if (!n) return '';
      return `<div class="enc-item group ${(state.encGroups || []).includes(k) ? 'active' : ''}" data-group="${k}" title="把${map}的 ${n} 只${label.replace('全部', '')}一次排进队，每只按上面的样本数跑，跑完出一张战损数据图">
        <span>▣ ${esc(label)}</span><span class="gcount">${n} 只</span>
      </div>`;
    }).join('') : '';
    box.innerHTML = groupRow + (list.map(e => `
      <div class="enc-item ${state.encounter === e.id ? 'active' : ''}" data-id="${esc(e.id)}">
        <span>${esc(e.name)}</span><a class="enc-ext" href="${encUrl(e.id)}" target="_blank" rel="noreferrer noopener" title="去 Spire Codex 看这只怪的资料（血量、行动、敌人）">资料 ↗</a>
        <span class="id">${esc(e.id)}</span>
      </div>`).join('') || (groupRow ? '' : '<div class="empty">没有匹配的遭遇</div>'));
    box.onclick = ev => {
      if (ev.target.closest('.enc-ext')) return;   // 点「资料 ↗」是开外链，不改当前遭遇
      const it = ev.target.closest('.enc-item');
      if (!it) return;
      if (it.dataset.group) {
        // 「全部弱怪」这类可以多选：选几组就一起跑
        const k = it.dataset.group;
        const arr = state.encGroups || (state.encGroups = []);
        const at = arr.indexOf(k);
        if (at >= 0) arr.splice(at, 1); else arr.push(k);
        saveLocal();
      } else {
        state.encounter = it.dataset.id;
      }
      renderEncLists();
      renderQueueAll();
    };
    const tabs = $('#' + id.tabs);
    if (tabs) $$('#' + id.tabs + ' button').forEach(x => x.classList.toggle('active', x.dataset.kind === state.encKind));
    const mt = $('#' + id.mapTabs);
    if (mt) $$('#' + id.mapTabs + ' button').forEach(x => x.classList.toggle('active', (x.dataset.map || '全部') === (state.encMap || '全部')));
    const s = $('#' + id.search);
    if (s && s.value !== (state.encQ || '')) s.value = state.encQ || '';
  }
}
/* ---------- run + results ---------- */
async function run() {
  if (!state.deck.length) { alert('卡组不能为空'); return; }
  // 选了「全部弱怪 / 全部普通怪…」：一次把这几组怪全跑一遍，跑完出数据图
  if ((state.encGroups || []).length) {
    addToQueue('single');
    runQueue('single');
    return;
  }
  if (!state.encounter) { alert('先选一个遭遇'); return; }
  autoCollapseMid();
  state.running = true;
  $('#run').disabled = true;
  $('#csv').disabled = true;
  state.results = [];
  state.job = null;
  $('#winrate').textContent = '…';
  $('#progLabel').textContent = '测算中';
  $('#progressText').textContent = '提交中';
  $('#bar').style.width = '0%';
  $('#resultList').innerHTML = '';
  try {
    const body = {
      deck: deckForRequest(),
      relics: relicsForRequest(),
      potions: state.potions,
      encounter: state.encounter,
      character: state.character,
      ascension: state.ascension,
      actIndex: state.actIndex || 0,
      hp: state.hp,
      maxHp: state.maxHp,
      count: state.count,
      ...modePayload(), prefix: state.prefix || 'UI',
      potionPolicy: state.potionPolicy,
      concurrency: CONCURRENCY,
      profile: 'VeryHigh',
      beam: 135,
      nodes: 100000,
      budget: 5000,
    };
    const r = await fetch('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '提交失败');
    state.jobId = j.id;
    state.lastJob = { id: j.id, mode: 'single' }; saveLocal();
    $('#progressText').textContent = `0/${j.total}`;
    setMidProgress(`0/${j.total}`);
    poll();
  } catch (e) {
    state.running = false;
    $('#run').disabled = false;
    $('#progressText').textContent = '提交失败：' + e.message;
    reportError('提交失败：' + e.message, e.stack || '');
  }
}

async function poll() {
  if (!state.jobId) return;
  try {
    const r = await fetch('/api/job/' + state.jobId);
    if (r.status === 404) {
      state.jobId = null;
      $('#progressText').textContent = '任务不存在（服务重启过）';
      return;
    }
    if (!r.ok) throw new Error('查询失败');
    const job = await r.json();
    if (job && job.status === 'gone') {
      state.jobId = null; state.runningJob = null; syncStopBtn();
      $('#progressText').textContent = '任务不存在（服务重启过）';
      return;
    }
    state.job = job;
    state.runningJob = { id: state.jobId };
    syncStopBtn();
    renderResults(job);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      state.runningJob = null;
      syncStopBtn();
      state.running = false;
      $('#run').disabled = false;
      $('#bar').style.width = '100%';
      $('#progressText').textContent = job.status === 'cancelled' ? `已终止 ${job.done}/${job.total}` : job.status === 'failed' ? '失败' : `完成 ${job.done}/${job.total}`;
      $('#progLabel').textContent = job.status === 'cancelled' ? '已终止' : job.status === 'failed' ? '失败' : '已完成';
      // 汇总在 variants[0].summary 里（publicJob 没有顶层 summary）——之前只认 job.summary，导致「导出 CSV」一直灰着
      if (job.summary || (job.variants && job.variants[0] && job.variants[0].summary)) $('#csv').disabled = false;
      if (job.status === 'failed') $('#progressText').textContent = '失败：' + (job.lastError || '');
      autoExpandMid();
      return;
    }
    $('#progressText').textContent = `${job.done}/${job.total}`;
    setMidProgress(`${job.done}/${job.total}`);
    $('#bar').style.width = (job.total ? job.done / job.total * 100 : 0) + '%';
    state.timer = setTimeout(poll, 900);
  } catch (e) {
    state.timer = setTimeout(poll, 1500);
  }
}

/* ---------- 战损区间（最好 / 最坏 / 平均） ---------- */
function hpRangeOf(s) {
  const num = v => (Number.isFinite(v) ? v : null);
  return { lo: num(s && s.minHpLost), hi: num(s && s.maxHpLost), avg: num(s && s.avgHpLost) };
}
function hpRangeText(s, withAvg = true) {
  const { lo, hi, avg } = hpRangeOf(s);
  const avgTxt = withAvg && avg != null ? ` <span class="muted tiny">平均 ${avg.toFixed(1)}</span>` : '';
  if (lo == null || hi == null) return (avg == null ? '—' : `平均 ${avg.toFixed(1)}`) + '';
  return `<b>${lo === hi ? lo : lo + '–' + hi}</b>${avgTxt}`;
}

/** 分析区的条状列表：打出次数 / 每回合伤害都用它 */
function barBlock(title, rows, opts) {
  const o = opts || {};
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  if (!rows.length) return '';
  return `<div class="bar-card">
    <div class="attr-title">${esc(title)}</div>
    <div class="bar-list">${rows.map(r => `<div class="bar-row">
      <span class="bar-name" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="bar"><i style="width:${Math.max(2, r.value / max * 100).toFixed(1)}%"></i></span>
      <span class="bar-num">${esc(r.text)}</span>
    </div>`).join('')}</div>
  </div>`;
}

/** 打出次数（全部样本合计）：每张牌一共几次、平均每局几次 */
function playsBlock(summary) {
  const list = summary && summary.plays;
  if (!list || !list.length) return '';
  const perRun = summary.playsPerRun != null ? summary.playsPerRun : null;
  const top = list.slice(0, 12);
  const rows = top.map(p => ({
    label: cardName(p.cardId), value: p.total,
    text: `${p.total} 次 · 每局 ${p.avg.toFixed(1)}${p.perPlay != null ? ` · 每次 ${p.perPlay} 伤害` : ''}`,
  }));
  const rest = list.slice(12);
  if (rest.length) {
    const total = rest.reduce((s, p) => s + p.total, 0);
    const avg = perRun ? total / (summary.runs || 1) : null;
    rows.push({ label: `其他 ${rest.length} 种`, value: total, text: `${total} 次${avg == null ? '' : ' · 每局 ' + avg.toFixed(1)}` });
  }
  const head = `打出次数（全部样本合计）${perRun != null ? ` · 平均每局 ${perRun} 张` : ''}${summary.playsPerTurn != null ? ` · 每回合 ${summary.playsPerTurn} 张` : ''}`;
  return barBlock(head, rows);
}

/** 每回合伤害（各样本按回合号平均） */
function turnsBlock(summary) {
  const list = summary && summary.damageByTurn;
  if (!list || list.length < 2) return '';
  const rows = list.map(t => ({ label: `第 ${t.turn} 回合`, value: t.damage, text: String(t.damage) }));
  const head = `每回合伤害（平均）${summary.dmgPerTurn != null ? ` · 平均每回合 ${summary.dmgPerTurn}` : ''}`;
  return barBlock(head, rows);
}

/** 结束回合分布：几回合打完的有几局（平均值看不出「一半碾压一半拖死」） */
function turnHistBlock(summary) {
  const list = summary && summary.turnsHist;
  if (!list || !list.length) return '';
  const total = list.reduce((s, x) => s + x.runs, 0);
  const rows = list.map(x => ({
    label: `${x.turns} 回合`, value: x.runs,
    text: `${x.runs} 局${total ? ` · ${(x.runs / total * 100).toFixed(0)}%` : ''}`,
  }));
  return barBlock('结束回合分布（几回合打完的有几局）', rows);
}

/** 对比卡里的紧凑分析：每局打出 / 每次伤害 / 结束回合分布 / 剩能量 / 常打的牌 */
/* 某张牌在这套里每局打出几次（plays 里按 cardId 找） */
function playsOf(s, cardId) {
  if (!s || !cardId) return null;
  return (s.plays || []).find(p => p.cardId === cardId) || null;
}
function fmtPlay(n) {
  if (n == null) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
/* 选中的那张牌：每局打出几次、跟基线比差多少、每次打多少伤害 */
function cardPlaysLine(s, o) {
  const cp = playsOf(s, o.cardId);
  const cur = cp ? cp.avg : 0;
  const bp = o.baseS ? playsOf(o.baseS, o.cardId) : null;
  const base = bp ? bp.avg : 0;
  const d = cur - base;
  let dtxt = '';
  if (o.baseS) dtxt = Math.abs(d) < 0.05 ? `（跟${o.baseLabel}一样）` : `（比${o.baseLabel} ${d > 0 ? '+' : '−'}${fmtPlay(Math.abs(d))}）`;
  const dmg = cp && cp.perPlay != null ? ` · 每次 <b>${cp.perPlay.toFixed(1)}</b> 伤害` : '';
  return `<div class="cardplays">${esc(o.name || cardName(o.cardId))} 每局打出 <b>${fmtPlay(cur)}</b> 次${dtxt}${dmg}</div>`;
}
function cmpAnalysisMini(s, o) {
  const opts = o || {};
  if (!s) return '';
  const parts = [];
  if (s.playsPerRun != null) parts.push(`${opts.cardId ? '全卡组' : '每局打出'} <b>${s.playsPerRun}</b> 张`);
  if (s.attrTotal != null && s.playsTotal) parts.push(`每次 <b>${(s.attrTotal / s.playsTotal).toFixed(1)}</b> 伤害`);
  if (s.energyWastePerTurn != null) parts.push(`剩能量 <b>${s.energyWastePerTurn}</b>/回合`);
  const hist = (s.turnsHist || []).slice(0, 6).map(x => `${x.turns}回合×${x.runs}`).join(' · ');
  const top = (s.plays || []).slice(0, 3).map(p => `${cardName(p.cardId)} ${p.total}`).join(' · ');
  if (!parts.length && !hist && !top) return '';
  return `<div class="cmp-mini2">
    ${opts.cardId ? cardPlaysLine(s, opts) : ''}
    ${parts.length ? `<div>${parts.join(' · ')}</div>` : ''}
    ${hist ? `<div class="muted tiny">结束回合：${esc(hist)}</div>` : ''}
    ${top ? `<div class="muted tiny">常打的：${esc(top)}</div>` : ''}
  </div>`;
}

function renderResults(job) {
  if (!job) {
    $('#winrate').textContent = '—';
    $('#resultStats').innerHTML = '';
    $('#singleAttr').innerHTML = '';
    $('#singlePlays').innerHTML = '';
    $('#singleTurns').innerHTML = '';
    $('#singleTurnHist').innerHTML = '';
    $('#resultList').innerHTML = '<div class="empty">选好卡组和遭遇，点右上「开始测算」</div>';
    return;
  }
  const v = (job.variants && job.variants[0]) || { results: [], deck: [], summary: null };
  const results = v.results || [];
  const done = results.length;
  const wins = results.filter(r => r.won === true).length;
  const valid = results.filter(r => r.hpLost != null);
  const avg = valid.length ? valid.reduce((s, r) => s + r.hpLost, 0) / valid.length : null;
  if (done) $('#winrate').textContent = (wins / done * 100).toFixed(1) + '%';
  else $('#winrate').textContent = '…';
  // 胜率的 95% 置信区间：样本少的时候 ± 很大，别把 3 个点的差别当结论
  const ci = v.summary && v.summary.winrateCI;
  const ciTxt = (ci && done) ? `±${(ci.half * 100).toFixed(1)}%` : '';
  const enc = state.encById.get(job.encounter);
  const c = state.character && state.meta.characters.find(x => x.id === job.character);
  const deckSize = (v.deck || []).reduce((s, d) => s + (d.count || 1), 0);
  // 掉血区间：按样本里的最少 / 最多算，顺手记下是哪两个种子，鼠标悬停能看到
  const losses = valid.map(r => r.hpLost);
  const minL = losses.length ? Math.min(...losses) : null;
  const maxL = losses.length ? Math.max(...losses) : null;
  const minRec = valid.find(r => r.hpLost === minL);
  const maxRec = valid.find(r => r.hpLost === maxL);
  const rangeTxt = minL == null ? '—' : (minL === maxL ? String(minL) : `${minL}–${maxL}`);
  const rangeTitle = minL == null ? '' :
    `最少 ${minL}${minRec ? '（' + minRec.seed + '）' : ''} · 最多 ${maxL}${maxRec ? '（' + maxRec.seed + '）' : ''} · ${valid.length} 局里统计`;
  // 失败局平均「还差多少血没打死」（只在有失败局时显示）
  const lossRuns = valid.filter(r => r.won === false);
  const avgDef = lossRuns.length
    ? Math.round(lossRuns.reduce((s, r) => s + (Number.isFinite(r.deficit) ? r.deficit : 0), 0) / lossRuns.length * 10) / 10
    : 0;
  $('#resultStats').innerHTML = [
    `<span>配置 <b>${esc(c ? c.name : job.character)}</b> · ${job.ascension}飞升 · ${v.hp}/${v.maxHp}HP</b></span>`,
    job.gameMode === 'Dread'
      ? `<span>模式 <b style="color:#c0392b">恐惧</b> · 领域 <b>${esc(dreadNameOf(job.dreadBoss))}</b></span>`
      : `<span>模式 <b>标准</b></span>`,
    `<span>遭遇 <b>${esc(enc ? enc.name : job.encounter)}</b></span>`,
    `<span>卡组 <b>${deckSize}</b> 张 · 遗物 <b>${(job.relics || []).length}</b></span>`,
    `<span>已跑 <b>${done}/${job.total}</b> · 胜 <b>${wins}</b></span>`,
    `<span title="${esc(rangeTitle)}">预估掉血 <b>${rangeTxt}</b>${avg == null ? '' : ` <span class="muted tiny">平均 ${avg.toFixed(1)}</span>`}</span>`,
    (v.summary && v.summary.medianHpLost != null) ? `<span title="一半样本的掉血不超过这个数，比平均值抗极端值">中位数 <b>${v.summary.medianHpLost}</b></span>` : '',
    (v.summary && v.summary.playsPerRun != null) ? `<span title="每局平均打出多少张牌">每局打出 <b>${v.summary.playsPerRun}</b> 张</span>` : '',
    (v.summary && v.summary.avgPotionsUsed) ? `<span title="每局平均用掉的药水数">用药 <b>${v.summary.avgPotionsUsed}</b> 瓶</span>` : '',
    ciTxt ? `<span title="95% 置信区间（Wilson）：${(ci.lo * 100).toFixed(1)}% – ${(ci.hi * 100).toFixed(1)}%，样本越多区间越窄">胜率 <b>${ciTxt}</b></span>` : '',
    (v.summary && v.summary.energyWastePerTurn != null) ? `<span title="估算：回合开始的能量减去这回合出牌花掉的费用。靠遗物/牌中途回的能量看不见">剩能量 <b>${v.summary.energyWastePerTurn}</b>/回合</span>` : '',
    (avgDef > 0) ? `<span title="失败局平均还差多少血没打死">没打死时差 <b>${avgDef}</b> 血</span>` : '',
    job.elapsedSec ? `<span>耗时 <b>${job.elapsedSec}s</b></span>` : '',
  ].join('');
  if (job.lastError) $('#resultStats').insertAdjacentHTML('beforeend', `<span style="color:#c0392b">错误：${esc(job.lastError)}</span>`);
  $('#singleAttr').innerHTML = (v.summary && v.summary.attribution && v.summary.attribution.length)
    ? attrBlock(v.summary.attribution, '伤害归因（全部样本合计）') : '';
  $('#singlePlays').innerHTML = playsBlock(v.summary);
  $('#singleTurns').innerHTML = turnsBlock(v.summary);
  $('#singleTurnHist').innerHTML = turnHistBlock(v.summary);
  const rows = results.slice().reverse().map(r => {
    const cls = r.won === true ? 'win' : (r.won === false ? 'loss' : '');
    // 掉血最少的 / 最多的那一局打个标，方便对回是哪个种子
    const tag = (minL != null && minL !== maxL && r.hpLost != null)
      ? (r.hpLost === minL ? '<span class="tag-min">最少</span>' : (r.hpLost === maxL ? '<span class="tag-max">最多</span>' : ''))
      : '';
    return `<div class="res-row ${cls}"><span>${esc(r.seed)}</span><span class="won">${r.won === true ? '胜' : r.won === false ? '负' : '—'}</span><span>${r.hpLost == null ? '' : '战损 ' + r.hpLost + tag}${r.turns ? ' · ' + r.turns + '回合' : ''}${r.sec ? ' · ' + r.sec + 's' : ''}</span></div>`;
  }).join('');
  $('#resultList').innerHTML = rows || '<div class="empty">等待第一局结果…</div>';
}

function exportCsv() {
  const job = state.job;
  const v = job && job.variants && job.variants[0];
  if (!v || !v.results || !v.results.length) return;
  const head = ['seed', 'won', 'hpLost', 'deficit', 'turns', 'status', 'sec'];
  const lines = [head.join(',')];
  for (const r of v.results) lines.push([r.seed, r.won, r.hpLost, r.deficit, r.turns, r.status, r.sec].map(v2 => v2 == null ? '' : v2).join(','));
  const { lo, hi, avg } = hpRangeOf(v.summary || {});
  if (lo != null && hi != null) lines.push(['# 预估掉血区间', lo, hi, '平均', avg == null ? '' : avg.toFixed(2)].join(','));
  // 打出次数也一并导出，方便自己在 Excel 里排序看
  const plays = (v.summary && v.summary.plays) || [];
  if (plays.length) {
    lines.push('# 打出次数（全部样本合计）', ['cardId', '卡名', '次数', '每局平均'].join(','));
    for (const p of plays) lines.push([p.cardId, cardName(p.cardId), p.total, p.avg.toFixed(2)].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sts2-' + (job.encounter || 'run') + '-' + job.total + 'seeds.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 卡组预设（多套卡组来回切） ---------- */
const PRESET_KEY = 'sts2-ui.presets.v1';
function loadPresets() {
  try { const a = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function savePresets(list) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch { } }

function renderPresets(selected) {
  const list = loadPresets();
  const sel = $('#presetSel');
  sel.innerHTML = '<option value="">预设…</option>' + list.map((p, i) =>
    `<option value="${i}" ${String(selected) === String(i) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#presetDel').disabled = !list.length;
}

function applyPreset(p) {
  if (!p) return;
  if (p.character && p.character !== state.character) {
    state.character = p.character;
    $('#character').value = p.character;
  }
  state.deck = (p.deck || []).map(normEntry);
  const st = starterRelicOf(state.character);
  state.relics = (p.relics || []).filter(r => r && r !== st);
  state.relicProps = (p.relicProps && typeof p.relicProps === 'object') ? p.relicProps : {};
  renderDeck(); renderRelicChips(); saveLocal();
}

function bindPresets() {
  renderPresets();
  $('#presetSel').onchange = e => {
    if (e.target.value === '') return;
    applyPreset(loadPresets()[Number(e.target.value)]);
  };
  $('#presetSave').onclick = () => {
    const n = state.deck.reduce((s, d) => s + d.count, 0);
    const name = prompt('这套卡组叫什么名字？', `${state.cardsById.get(state.character)?.name || state.character} ${n} 张`);
    if (!name || !name.trim()) return;
    const list = loadPresets();
    const item = { name: name.trim(), character: state.character, deck: state.deck.map(d => ({ ...d })), relics: state.relics.slice(), relicProps: relicPropsForRequest() };
    const i = list.findIndex(p => p.name === item.name);
    if (i >= 0) list[i] = item; else list.push(item);
    savePresets(list);
    renderPresets(i >= 0 ? i : list.length - 1);
  };
  $('#presetDel').onclick = () => {
    const v = $('#presetSel').value;
    if (v === '') { alert('先在下拉里选一个预设'); return; }
    const list = loadPresets();
    if (!list[Number(v)]) return;
    if (!confirm(`删掉预设「${list[Number(v)].name}」？`)) return;
    list.splice(Number(v), 1);
    savePresets(list);
    renderPresets();
  };
}

/* ================= 伤害归因饼图 ================= */
const ATTR_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#95a5a6', '#34495e', '#d35400'];
const cardName = id => (id === '__other__' ? '其他来源' : (state.cardsById.get(id)?.name || id));

function pieSVG(items, size) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const R = size / 2, r = R * 0.56, cx = R, cy = R;
  if (!total) return `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="#2a2f3a" stroke-width="${R - r}"/></svg>`;
  if (items.length === 1) {
    return `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${ATTR_COLORS[0]}" stroke-width="${R - r}"/></svg>`;
  }
  let a0 = -Math.PI / 2;
  const paths = items.map((it, i) => {
    const frac = it.value / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const pt = (a, rr) => [(cx + Math.cos(a) * rr).toFixed(2), (cy + Math.sin(a) * rr).toFixed(2)];
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r);
    const d = `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${ATTR_COLORS[i % ATTR_COLORS.length]}"><title>${esc(it.label)} ${Math.round(it.value)}</title></path>`;
  }).join('');
  return `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${paths}</svg>`;
}

function attrBlock(attr, title, opts) {
  const o = opts || {};
  const top = (attr || []).filter(a => a.damage >= 1).slice(0, o.max || 9);
  if (!top.length) return '';
  const pie = pieSVG(top.map(a => ({ label: cardName(a.cardId), value: a.damage })), o.size || 132);
  const legend = `<div class="legend">${top.map((a, i) => `<div class="lg"><i style="background:${ATTR_COLORS[i % ATTR_COLORS.length]}"></i><span class="lg-name">${esc(cardName(a.cardId))}</span><b>${Math.round(a.damage)}</b><span class="muted">${(a.share * 100).toFixed(0)}%</span></div>`).join('')}</div>`;
  if (o.compact) return `<div class="cmp-mini">${pie}${legend}</div>`;
  return `<div class="attr-card">
    <div class="attr-title">${esc(title)}</div>
    <div class="attr-body">${pie}${legend}</div>
  </div>`;
}

/* ================= 模式切换 ================= */
function buildEncSelect(sel, value) {
  if (!sel) return;
  const kinds = [['boss', 'Boss'], ['elite', '精英'], ['normal', '普通'], ['weak', '弱怪'], ['event', '事件']];
  sel.innerHTML = kinds.map(([k, n]) => {
    const list = state.meta.encounters.filter(e => e.kind === k);
    if (!list.length) return '';
    return `<optgroup label="${n}">${list.map(e => `<option value="${esc(e.id)}" ${e.id === value ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`;
  }).join('');
}

function bindModes() {
  // 任何输入/点击/切换都落到 localStorage（防抖 250ms）
  ['input', 'change', 'click'].forEach(ev => document.addEventListener(ev, saveLocal, true));
  $('#modes').onclick = e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    $$('#modes button').forEach(x => x.classList.toggle('active', x === b));
    $('#modeSingle').classList.toggle('hidden', state.mode !== 'single');
    $('#modeCompare').classList.toggle('hidden', state.mode !== 'compare');
    $('#modeRest').classList.toggle('hidden', state.mode !== 'rest');
    $('#modeUpgrade').classList.toggle('hidden', state.mode !== 'upgrade');
    if (state.mode === 'compare') { renderCmpSlots(); renderCmpPool(); renderCmpState(); }
    if (state.mode === 'rest') { renderRestPanel(); renderRestState(); }
    if (state.mode === 'upgrade') renderUpgradeAll();
  };
  // 多选一升级
  state.upPicks = state.upPicks || [];
  const upRunBtn = $('#upRun');
  if (upRunBtn) upRunBtn.onclick = runUpgrade;
  const upClearBtn = $('#upClear');
  if (upClearBtn) upClearBtn.onclick = () => { state.upPicks = []; renderUpSlots(); renderUpDeck(); };


  // 三卡对比
  state.cmpCards = state.cmpCards || [];
  $('#cmpSearch').oninput = renderCmpPool;
  $('#cmpType').onchange = renderCmpPool;
  $('#cmpClear').onclick = () => { state.cmpCards = []; renderCmpSlots(); };
  $('#cmpRun').onclick = runCompare;

  // 升级 vs 睡觉
  $('#restRun').onclick = runRest;
  ['#restPct', '#restBase', '#restPillow', '#restFurnace'].forEach(s => $(s).oninput = renderRestMath);
  $('#restPillow').onchange = renderRestMath;
  $('#restFurnace').onchange = renderRestMath;
  $('#restBase').onchange = renderRestMath;
  $('#restEnc').onchange = e => { state.encounter = e.target.value; renderRestState(); };
  // 恢复上次的回血参数
  $('#restPct').value = state.restOpts.pct;
  $('#restBase').value = state.restOpts.base;
  $('#restPillow').checked = !!state.restOpts.pillow;
  $('#restFurnace').checked = !!state.restOpts.furnace;

  // 恢复上次停留的模式（会顺带把候选卡/回血面板渲染出来）
  if (state.mode && state.mode !== 'single') {
    const b = $(`#modes button[data-mode="${state.mode}"]`);
    if (b) b.click();
  }

  // 调试用：?mode=compare / ?selftest=1 自动切模式并跑一轮 / ?job=<id> 直接看某次结果
  // 深链接：?char=IRONCLAD 直接选角色（走和手动切换完全相同的路径）
  const q = new URLSearchParams(location.search);
  const ch = q.get('char');
  if (ch) {
    const sel = $('#character');
    if ([...sel.options].some(o => o.value === ch)) { sel.value = ch; sel.dispatchEvent(new Event('change')); }
  }
  const m = q.get('mode');
  if (m) { const b = $(`#modes button[data-mode="${m}"]`); if (b) b.click(); }
  if (q.has('selftest')) {
    state.cmpCards = [{ cardId: 'ERADICATE' }, { cardId: 'GRAVEBLAST' }, { cardId: 'FRIENDSHIP' }];
    $('#count').value = 3; state.count = 3;
    const b = $('#modes button[data-mode="compare"]'); if (b) b.click();
    setTimeout(runCompare, 300);
  }
  if (q.has('job')) {
    const id = q.get('job');
    fetch('/api/job/' + id).then(r => r.ok ? r.json() : null).then(job => {
      if (job) attachJob(id, job.mode);
    }).catch(() => { });
  } else if (state.lastJob && state.lastJob.id) {
    // 刷新/重开浏览器：接回上次那个任务（跑完了就直接画，还在跑就接着显示进度）
    attachJob(state.lastJob.id, state.lastJob.mode);
  }
}

/* 接上一个任务：正在跑的也要接住，关掉浏览器不影响服务端继续算 */
function attachJob(id, mode) {
  const m = mode === 'compare' || mode === 'rest' ? mode : 'single';
  const btn = $(`#modes button[data-mode="${m}"]`);
  if (btn) btn.click();
  state.lastJob = { id, mode: m };
  saveLocal();
  if (m === 'single') { state.jobId = id; return poll(); }
  const prog = $('#' + (m === 'compare' ? 'cmpProgress' : 'restProgress'));
  return pollJob(id, job => {
    if (!job) { prog.textContent = '任务不存在（服务重启过）'; return; }
    if (job.status === 'done') {
      prog.textContent = `完成 ${job.done}/${job.total}（${job.elapsedSec || 0}s）`;
      if (m === 'compare') renderCompare(job); else renderRest(job);
    } else {
      prog.textContent = `${job.done}/${job.total} · ${job.elapsedSec || 0}s · 服务端运行中`;
    }
  });
}

/* ================= 三卡对比 ================= */
function renderCmpState() {
  const n = state.deck.reduce((s, d) => s + d.count, 0);
  $('#cmpState').innerHTML = [
    `<div>卡组 <b>${n}</b> 张 · 遗物 <b>${state.relics.length}</b> 件</div>`,
    `<div>血量 <b>${state.hp}/${state.maxHp}</b> · 飞升 <b>${state.ascension}</b></div>`,
    `<div>遭遇 <b>${esc(state.encById.get(state.encounter)?.name || state.encounter)}</b></div>`,
  ].join('');
}

function renderCmpSlots() {
  const box = $('#cmpSlots');
  // 至少摆 3 个空槽（看着像「三选一」的老习惯），选多了就长到 10 个
  const n = Math.min(CMP_MAX, Math.max(3, state.cmpCards.length + 1));
  const slots = Array.from({ length: n }, (_, i) => {
    const c = state.cmpCards[i];
    if (!c) return `<div class="slot empty" data-slot="${i}">槽 ${i + 1}<span class="muted tiny">点下面的牌</span></div>`;
    const card = state.cardsById.get(c.cardId) || { id: c.cardId, name: c.cardId };
    return `<div class="slot" data-i="${i}">
      ${imgTag(card)}
      <div class="slot-name">${esc(card.name)}</div>
      <label class="chk tiny"><input type="checkbox" data-up="${i}" ${c.upgradeLevels ? 'checked' : ''}> 升级态</label>
      <button class="ghost small" data-del="${i}">×</button>
    </div>`;
  }).join('');
  box.innerHTML = slots;
  box.onclick = e => {
    const del = e.target.closest('[data-del]');
    if (del) { state.cmpCards.splice(Number(del.dataset.del), 1); renderCmpSlots(); return; }
    if (e.target.closest('.slot.empty')) $('#cmpSearch').focus();
  };
  box.onchange = e => {
    const up = e.target.closest('[data-up]');
    if (up) state.cmpCards[Number(up.dataset.up)].upgradeLevels = up.checked ? 1 : 0;
  };
}

function renderCmpPool() {
  const q = ($('#cmpSearch').value || '').trim().toLowerCase();
  const tf = $('#cmpType').value;
  const list = state.meta.cards.filter(c =>
    (!tf || String(c.type) === tf) &&
    (!q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));
  const LIMIT = 120;
  $('#cmpPool').innerHTML = list.slice(0, LIMIT).map(c => `
    <div class="card-item" data-id="${esc(c.id)}" title="${esc(c.name)}${c.desc ? '\n' + esc(c.desc) : ''}">
      ${imgTag(c)}
      <div class="cost">${c.cost == null ? '?' : (c.cost >= 0 ? c.cost : 'X')}</div>
      <div class="t ${TYPE_CLASS[c.type] || ''}">${TYPE_NAME[c.type] || ''}</div>
      <div class="cap">${esc(c.name)}</div>
    </div>`).join('') || '<div class="empty">没有匹配</div>';
  $('#cmpPool').onclick = e => {
    const it = e.target.closest('.card-item');
    if (!it) return;
    if (state.cmpCards.length >= CMP_MAX) { alert(`最多 ${CMP_MAX} 张`); return; }
    if (state.cmpCards.some(x => x.cardId === it.dataset.id)) return;
    state.cmpCards.push({ cardId: it.dataset.id, upgradeLevels: 0 });
    renderCmpSlots();
  };
}

async function runCompare() {
  if (!state.deck.length) { alert('卡组是空的：先在「单场测算」里导入或组牌'); return; }
  if (state.cmpCards.length < 1) { alert('至少选一张候选卡'); return; }
  autoCollapseMid();
  const btn = $('#cmpRun');
  btn.disabled = true;
  $('#cmpResult').innerHTML = '<div class="empty">跑着…</div>';
  try {
    const body = {
      deck: deckForRequest(),
      relics: relicsForRequest(), potions: state.potions, encounter: state.encounter,
      character: state.character, ascension: state.ascension, actIndex: state.actIndex || 0,
      ...modePayload(), hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'CMP',
      potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
      nodes: 100000, budget: Number($('#cmpBudget').value) || 8000,
      candidates: state.cmpCards.map(c => ({ cardId: c.cardId, upgradeLevels: c.upgradeLevels || 0 })),
    };
    const r = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '提交失败');
    state.lastJob = { id: j.id, mode: 'compare' }; saveLocal();
    await pollJob(j.id, job => {
      $('#cmpProgress').textContent = `${job.done}/${job.total} · ${job.elapsedSec || 0}s`;
      if (job.status === 'done') renderCompare(job);
    });
  } catch (e) {
    $('#cmpResult').innerHTML = `<div class="empty" style="color:#e74c3c">${esc(e.message)}</div>`;
    reportError('对比失败：' + e.message, e.stack || '');
  } finally {
    btn.disabled = false;
  }
}

function renderCompare(job, opts) {
  const o = opts || {};
  const box = $(o.container || '#cmpResult');
  const base = job.variants[0];
  const bs = base.summary || {};
  // 只选了一张牌时，基线那张卡也把「每局几次」写出来，方便直接对数字
  const candIds = [...new Set(job.variants.slice(1).map(v => v.card && v.card.cardId).filter(Boolean))];
  const baseCardId = candIds.length === 1 ? candIds[0] : null;
  const rows = job.variants.map((v, i) => {
    const s = v.summary || {};
    const isBase = i === 0;
    const dpp = s.deltaWinratePp;
    const dcls = dpp == null || Math.abs(dpp) < 0.05 ? 'same' : (dpp > 0 ? 'up' : 'down');
    // 和「不放这张」比 —— 对比模式本来就是跟跳过比，直接把人话写出来
    const dtxt = isBase ? '基线（不放牌）' : (dpp == null ? '比不放 —' : `比不放 ${dpp > 0 ? '+' : ''}${dpp.toFixed(1)}pp`);
    const rel = s.relWinrate == null ? '' : (isBase ? '' : `（相对 ${s.relWinrate > 0 ? '+' : ''}${(s.relWinrate * 100).toFixed(0)}%）`);
    const label = isBase ? (o.baseLabel || '基线（不加牌）') : (o.prefix || '') + cardName(v.card && v.card.cardId) + (o.prefix ? '' : (v.card && v.card.upgradeLevels ? '+' : ''));
    const card = !isBase && v.card ? state.cardsById.get(v.card.cardId) : null;
    return `<div class="cmp-card ${isBase ? 'base' : ''}">
      <div class="top">
        ${card ? `<span class="thumb">${imgTag(card)}</span>` : ''}
        <span class="who" title="${esc(label)}">${esc(label)}</span>
        <span class="wr">${((s.winrate || 0) * 100).toFixed(1)}%${s.winrateCI ? `<span class="wr-ci muted tiny">±${(s.winrateCI.half * 100).toFixed(1)}%</span>` : ''}</span>
      </div>
      <div class="kv">
        <span class="delta ${dcls}">${dtxt}<span class="muted tiny">${rel}</span></span>
        <span>战损 ${hpRangeText(s)}</span>
        <span class="muted">${[s.avgTurns ? s.avgTurns + ' 回合' : '', s.runs ? (s.wins ?? 0) + '/' + s.runs + ' 局' : ''].filter(Boolean).join(' · ')}</span>
      </div>
      ${s.attribution && s.attribution.length ? attrBlock(s.attribution, '伤害归因', { compact: true, size: 118, max: 5 }) : ''}
      ${cmpAnalysisMini(s, isBase ? (baseCardId ? { cardId: baseCardId } : null) : { cardId: v.card && v.card.cardId, baseS: bs, baseLabel: o.cardBaseLabel || '不放这张' })}
    </div>`;
  }).join('');

  // 判个结论
  const cands = job.variants.slice(1).map((v, i) => ({ label: cardName(v.card?.cardId || ''), s: v.summary || {} }));
  cands.sort((a, b) => (b.s.winrate - a.s.winrate) || ((a.s.avgHpLost ?? 999) - (b.s.avgHpLost ?? 999)));
  const best = cands[0];
  const baseS = job.variants[0].summary || {};
  const bestDpp = (best && baseS.winrate != null && best.s.winrate != null) ? (best.s.winrate - baseS.winrate) * 100 : null;
  const hpDiff = (best && baseS.avgHpLost != null && best.s.avgHpLost != null) ? baseS.avgHpLost - best.s.avgHpLost : null;
  const dppTxt = bestDpp == null
    ? ''
    : Math.abs(bestDpp) >= 0.05
      ? `（比不放 ${bestDpp > 0 ? '+' : ''}${bestDpp.toFixed(1)}pp）`
      : hpDiff != null && Math.abs(hpDiff) > 1
        ? `（胜率跟不放一样，掉血${hpDiff > 0 ? '少' : '多'} ${Math.abs(hpDiff).toFixed(1)}）`
        : '（跟不放一样）';
  const worstWr = cands.length ? Math.min(...cands.map(c => c.s.winrate || 0)) : 0;
  const tied = cands.length > 1 && (cands[0].s.winrate || 0) - worstWr < 0.05
    && Math.abs((cands[0].s.avgHpLost ?? 0) - (cands[cands.length - 1].s.avgHpLost ?? 0)) < 3;
  const verdict = !best
    ? ''
    : (best.s.winrate || 0) <= 0
      ? `样本里这几张都没赢过（全灭）——先看看血量/遭遇是不是太狠，再比一次更靠谱。`
      : (o.verb === '该升' && tied)
        ? `这几张升哪张都差不多（胜率差不到 5pp、战损差不到 3）——按别的手感挑就行。`
        : `${o.verb || '最稳的是'} <b>${esc(best.label)}</b>${dppTxt}：胜率 ${((best.s.winrate || 0) * 100).toFixed(1)}%，预估掉血 ${hpRangeText(best.s)}。`;
  box.innerHTML = `<div class="verdict">${verdict}</div><div class="cmp-cards">${rows}</div>`;
}

/* ================= 三选一升级（卡组内挑三张，各自升一级比） ================= */
let upHintTimer = null;
function upHint(text) {
  const p = $('#upProgress');
  if (!p) return;
  p.textContent = text;
  p.classList.add('warn');
  clearTimeout(upHintTimer);
  upHintTimer = setTimeout(() => { p.classList.remove('warn'); p.textContent = ''; }, 3000);
}
function upDeckEntries() {
  return state.deck.map((d, i) => ({ ...d, i }));
}
function renderUpSlots() {
  const box = $('#upSlots');
  if (!box) return;
  const n = Math.min(UP_MAX, Math.max(1, state.upPicks.length + 1));
  box.innerHTML = Array.from({ length: n }, (_, i) => {
    const idx = state.upPicks[i];
    const d = idx == null ? null : state.deck[idx];
    if (!d) return `<div class="slot empty">方案 ${i + 1}<span class="muted tiny">点下面的牌</span></div>`;
    const card = state.cardsById.get(d.cardId) || { id: d.cardId, name: d.cardId };
    return `<div class="slot" data-i="${i}">
      ${imgTag(card)}
      <div class="slot-name">${esc(card.name)}</div>
      <div class="muted tiny">已升 ${d.upgradeLevels || 0}/${d.count} 张</div>
      <button class="ghost small" data-del="${i}">×</button>
    </div>`;
  }).join('');
  box.onclick = e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    state.upPicks.splice(Number(del.dataset.del), 1);
    renderUpSlots(); renderUpDeck();
  };
}
function renderUpDeck() {
  const box = $('#upDeck');
  if (!box) return;
  const n = state.deck.reduce((s, d) => s + d.count, 0);
  const cnt = $('#upDeckCount');
  if (cnt) cnt.textContent = `${n} 张`;
  box.innerHTML = upDeckEntries().map(d => {
    const card = state.cardsById.get(d.cardId) || { id: d.cardId, name: d.cardId };
    const picked = state.upPicks.includes(d.i);
    const full = (d.upgradeLevels || 0) >= d.count;
    return `<div class="up-item${picked ? ' on' : ''}${full ? ' full' : ''}" data-i="${d.i}" title="${full ? '这一行已经全升级了，没得升' : '点一下加入 / 再点一次移出'}">
      ${imgTag(card)}
      <span class="nm">${esc(card.name)}</span>
      <span class="upn">升 ${d.upgradeLevels || 0}/${d.count}</span>
    </div>`;
  }).join('') || '<div class="empty">卡组是空的</div>';
  box.onclick = e => {
    const it = e.target.closest('.up-item');
    if (!it) return;
    if (it.classList.contains('full')) return;
    const i = Number(it.dataset.i);
    const at = state.upPicks.indexOf(i);
    if (at >= 0) state.upPicks.splice(at, 1);
    else if (state.upPicks.length >= UP_MAX) { upHint('最多十张——先点上面槽位里的 × 移出一张'); return; }
    else state.upPicks.push(i);
    renderUpSlots(); renderUpDeck();
  };
}
function renderUpState() {
  const n = state.deck.reduce((s, d) => s + d.count, 0);
  const cnt = $('#upDeckCount');
  if (cnt) cnt.textContent = `${n} 张 · 血 ${state.hp}/${state.maxHp} · 飞升 ${state.ascension}`;
  const box = $('#upState');   // 旧的「当前状态」块已经并进上面这行
  if (!box) return;
  box.innerHTML = [
    `<div>卡组 <b>${n}</b> 张 · 遗物 <b>${state.relics.length}</b> 件</div>`,
    `<div>血量 <b>${state.hp}/${state.maxHp}</b> · 飞升 <b>${state.ascension}</b></div>`,
    `<div>遭遇 <b>${esc(state.encById.get(state.encounter)?.name || state.encounter)}</b></div>`,
  ].join('');
}
function renderUpgradeAll() {
  renderUpSlots(); renderUpDeck(); renderUpState();
}
async function runUpgrade() {
  if (state.upPicks.length < 1) { upHint('至少选一张要升级的牌'); return; }
  autoCollapseMid();
  const btn = $('#upRun');
  btn.disabled = true;
  $('#upResult').innerHTML = '<div class="empty">跑着…</div>';
  try {
    const deck = state.deck.map(d => ({
      cardId: d.cardId, count: d.count, upgradeLevels: d.upgradeLevels || 0,
      enchantmentId: d.enchantmentId || null, enchantmentAmount: d.enchantmentAmount || 0,
    }));
    const body = {
      deck, relics: relicsForRequest(), potions: state.potions, encounter: state.encounter,
      character: state.character, ascension: state.ascension, ...modePayload(), actIndex: state.actIndex || 0,
      hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'UP',
      potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
      nodes: 100000, budget: Number($('#upBudget').value) || 8000,
      picks: state.upPicks.map(i => ({ index: i })),
    };
    const r = await fetch('/api/upgrade3', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '提交失败');
    state.lastJob = { id: j.id, mode: 'upgrade3' }; saveLocal();
    await pollJob(j.id, job => {
      const p = $('#upProgress');
      if (p) p.textContent = `${job.done}/${job.total} · ${job.elapsedSec || 0}s`;
      if (job.status === 'done') renderCompare(job, { container: '#upResult', baseLabel: '基线（不升级）', cardBaseLabel: '不升级', verb: '该升', prefix: '升级 ' });
    });
  } catch (e) {
    $('#upResult').innerHTML = `<div class="empty" style="color:#e74c3c">${esc(e.message)}</div>`;
    reportError('升级对比失败：' + e.message, e.stack || '');
  } finally {
    btn.disabled = false;
  }
}

/* ================= 升级 vs 睡觉 ================= */
function renderRestState() {
  buildEncSelect($('#restEnc'), state.encounter);
  const n = state.deck.reduce((s, d) => s + d.count, 0);
  $('#restState').innerHTML = [
    `<div>卡组 <b>${n}</b> 张 · 遗物 <b>${state.relics.length}</b> 件</div>`,
    `<div>血量 <b>${state.hp}/${state.maxHp}</b> · 飞升 <b>${state.ascension}</b></div>`,
    `<div>遭遇 <b>${esc(state.encById.get(state.encounter)?.name || state.encounter)}</b></div>`,
  ].join('');
}

function renderRestPanel() {
  const sel = $('#restCard');
  const cur = sel.value;
  // 选项按「卡组里的第几行」来，不按卡名：同名两行（比如同一张牌一行升过一行没升）
  // 以前 value 是卡名，选一张等于整组一起升，也看不出到底升 1 张还是全升。
  sel.innerHTML = state.deck.map((d, i) => {
    const c = state.cardsById.get(d.cardId) || { name: d.cardId };
    const up = d.upgradeLevels || 0;
    const dup = state.deck.filter(x => x.cardId === d.cardId).length > 1;
    const tag = dup ? `（第 ${i + 1} 行）` : '';
    // 只写「第 N 行」区分同名行；不写 ×张数 / 已升几，免得让人以为能一次升多张——一次只升 1 张
    const gone = up >= d.count ? ' · 已升满' : '';
    return `<option value="${i}" ${String(i) === cur ? 'selected' : ''}${up >= d.count ? ' disabled' : ''}>${esc(c.name)}${tag}${gone}</option>`;
  }).join('') || '<option value="">卡组为空</option>';
  renderRestState();
  renderRestMath();
}

function restInputs() {
  const pct = Number($('#restPct').value) || 0;
  const base = $('#restBase').value === 'current' ? state.hp : state.maxHp;
  const pillow = $('#restPillow').checked;
  const furnace = $('#restFurnace').checked;
  state.restOpts = { pct: Number($('#restPct').value) || 0, base: $('#restBase').value, pillow, furnace };
  const heal = Math.round(base * pct / 100) + (pillow ? 15 : 0);
  const maxHp = state.maxHp + (furnace ? 5 : 0);
  const hp = Math.min(maxHp, state.hp + heal + (furnace ? 5 : 0));
  return { pct, base, pillow, furnace, heal, maxHp, hp };
}

function renderRestMath() {
  const r = restInputs();
  $('#restMath').textContent = `睡觉：回 ${r.heal} 点（${r.pct}% × ${r.base}${r.pillow ? ' + 枕头15' : ''}${r.furnace ? ' + 石炉5上限' : ''}）→ ${r.hp}/${r.maxHp} 血进战斗；升级：${state.hp}/${state.maxHp} 血、多一张升级牌。`;
}

async function runRest() {
  if (!state.deck.length) { alert('卡组是空的'); return; }
  const targetIndex = Number($('#restCard').value);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= state.deck.length) { alert('先选一张要升级的卡'); return; }
  autoCollapseMid();
  const btn = $('#restRun');
  btn.disabled = true;
  $('#restResult').innerHTML = '<div class="empty">跑着…</div>';
  try {
    const r0 = restInputs();
    const body = {
      deck: deckForRequest(),
      relics: relicsForRequest(), potions: state.potions, encounter: state.encounter,
      character: state.character, ascension: state.ascension, actIndex: state.actIndex || 0,
      ...modePayload(), hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'REST',
      potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
      nodes: 100000, budget: Number($('#restBudget').value) || 8000,
      targetIndex,
      rest: { healPercent: r0.pct, base: $('#restBase').value, pillow: r0.pillow, furnace: r0.furnace },
    };
    const r = await fetch('/api/rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '提交失败');
    state.lastJob = { id: j.id, mode: 'rest' }; saveLocal();
    await pollJob(j.id, job => {
      $('#restProgress').textContent = `${job.done}/${job.total} · ${job.elapsedSec || 0}s`;
      if (job.status === 'done') renderRest(job);
    });
  } catch (e) {
    $('#restResult').innerHTML = `<div class="empty" style="color:#e74c3c">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderRest(job) {
  const up = job.variants[0], rest = job.variants[1];
  const us = up.summary || {}, rs = rest.summary || {};
  const rows = [up, rest].map(v => {
    const s = v.summary || {};
    const dpp = s.deltaWinratePp;
    const dcls = dpp == null || Math.abs(dpp) < 0.05 ? 'same' : (dpp > 0 ? 'up' : 'down');
    return `<div class="cmp-card">
      <div class="top">
        <span class="who">${esc(v.label)}</span>
        <span class="wr">${((s.winrate || 0) * 100).toFixed(1)}%${s.winrateCI ? `<span class="wr-ci muted tiny">±${(s.winrateCI.half * 100).toFixed(1)}%</span>` : ''}</span>
      </div>
      <div class="kv">
        <span class="delta ${dcls}">${dpp == null ? '' : (dpp > 0 ? '+' : '') + dpp.toFixed(1) + 'pp'}</span>
        <span>战损 ${hpRangeText(s)}</span>
        <span class="muted">血 ${v.hp}/${v.maxHp}</span>
      </div>
      ${s.attribution && s.attribution.length ? attrBlock(s.attribution, '伤害归因', { compact: true, size: 118, max: 5 }) : ''}
      ${cmpAnalysisMini(s, { cardId: (up.card && up.card.cardId) || (v.card && v.card.cardId), baseS: v === up ? rs : null, baseLabel: '不升级' })}
    </div>`;
  }).join('');
  const dwr = (rs.winrate || 0) - (us.winrate || 0);
  const dhp = (rs.avgHpLost ?? 0) - (us.avgHpLost ?? 0);
  let verdict;
  if (Math.abs(dwr) >= 0.15) verdict = dwr > 0 ? '建议 <b>睡觉</b>：胜率明显更高。' : '建议 <b>升级</b>：胜率明显更高。';
  else if (Math.abs(dhp) >= 3) verdict = dhp < 0 ? '建议 <b>睡觉</b>：胜率相当，但战损更少。' : '建议 <b>升级</b>：胜率相当，但战损更少。';
  else verdict = '两者差不多：胜率和战损差距都在噪声范围内，可以按别的需要选。';
  const m = job.meta && job.meta.rest;
  const math = m ? `回血 ${m.heal}（${m.healPercent}% × ${m.base === 'current' ? '当前' : '上限'}血量${m.pillow ? ' +15' : ''}${m.furnace ? ' +5 上限' : ''}）：${m.hpBefore}/${m.maxHpBefore} → ${m.hpAfter}/${m.maxHpAfter}` : '';
  $('#restResult').innerHTML = `<div class="verdict">${verdict}<div class="muted tiny" style="margin-top:4px">${esc(math)}</div></div><div class="cmp-cards">${rows}</div>`;
}

/* ================= 排队：三个模式各一条队，一只一只算 ================= */
function qArr(mode) {
  if (mode === 'compare') { if (!state.queueCmp) state.queueCmp = []; return state.queueCmp; }
  if (mode === 'upgrade') { if (!state.queueUp) state.queueUp = []; return state.queueUp; }
  if (!state.queue) state.queue = [];
  return state.queue;
}
function qName(id) {
  if (String(id || '').startsWith(GROUP_PREFIX)) return qGroupLabel(id);
  const e = state.encById.get(id);
  return e ? e.name : id;
}
/* 「全部弱怪」这类是名单压缩：一组怪一起排队，跑完出一张数据图 */
function groupIds(kind) {
  const map = state.encMap || '全部';
  return state.meta.encounters
    .filter(e => e.kind === kind && (map === '全部' || (e.map || '事件') === map))
    .map(e => e.id);
}
function qGroupLabel(id) {
  const kind = String(id || '').slice(GROUP_PREFIX.length);
  return `${state.encMap || '全部'} · ${GROUP_KINDS[kind] || '全部'}`;
}
function renderQueue(mode) {
  const id = ENC_IDS[mode];
  if (!id) return;
  const box = $('#' + id.qList);
  if (!box) return;
  const q = qArr(mode);
  if (!q.length) {
    box.innerHTML = '<div class="muted tiny">从上面点怪物、点「+ 加入」；也可以直接加「全部弱怪 / 全部普通怪 / 全部精英 / 全部Boss」，跑完会生成一张战损数据图。</div>';
  } else {
    box.innerHTML = q.map((it, i) => `<div class="q-item${it.running ? ' run' : ''}${it.done ? ' done' : ''}" data-i="${i}">
      <span class="q-idx">${i + 1}</span>
      <span class="q-name" title="${esc(it.status || '')}">${it.group ? esc(it.groupLabel || qGroupLabel(it.enc)) : encLink(it.enc, qName(it.enc))}${it.group ? ` <span class="muted tiny">${it.group.length} 只</span>` : ''}</span>
      <span class="q-st">${it.running ? '算着…' : it.done ? (it.winrate == null ? '完了' : `${(it.winrate * 100).toFixed(1)}%`) : '等着'}</span>
      <button class="ghost small" data-qdel="${i}" title="从队列里去掉（正在算的那只先点「■ 终止」）">×</button>
    </div>`).join('');
  }
  const btn = $('#' + id.qRun);
  if (btn) btn.disabled = !q.some(it => !it.done);
  const add = $('#' + id.qAdd);
  if (add) add.disabled = !state.encounter && !(state.encGroups || []).length;
  const cl = $('#' + id.qClear);
  if (cl) cl.disabled = !q.length;
  box.onclick = e => {
    const del = e.target.closest('[data-qdel]');
    if (!del) return;
    const i = Number(del.dataset.qdel);
    const it = qArr(mode)[i];
    if (it && it.running) { qHint(mode, '这只正在算——先点上面「■ 终止」'); return; }
    qArr(mode).splice(i, 1);
    saveLocal(); renderQueue(mode);
  };
}
function renderQueueAll() { for (const m of Object.keys(ENC_IDS)) renderQueue(m); }
function qHint(mode, text) {
  const id = ENC_IDS[mode];
  const box = $('#' + id.qResult);
  if (!box) return;
  const old = box.querySelector('.q-warn');
  if (old) old.remove();
  const d = document.createElement('div');
  d.className = 'q-warn muted tiny';
  d.textContent = text;
  box.prepend(d);
  setTimeout(() => d.remove(), 4000);
}
function addToQueue(mode) {
  const groups = (state.encGroups || []).slice();
  if (groups.length) {
    // 选了几组就排几组（已经排在队里还没跑的不重复加）
    for (const k of groups) {
      const ids = groupIds(k);
      if (!ids.length) continue;
      const label = `${state.encMap || '全部'} · ${GROUP_KINDS[k] || '全部'}`;
      if (qArr(mode).some(it => it.group && it.groupLabel === label && !it.done)) continue;
      qArr(mode).push({ enc: '__GROUP', group: ids, groupLabel: label, done: false, running: false, winrate: null });
    }
    saveLocal(); renderQueue(mode);
    return;
  }
  if (!state.encounter) return;
  qArr(mode).push({ enc: state.encounter, done: false, running: false, winrate: null });
  saveLocal(); renderQueue(mode);
}
/* 三个模式各自的请求体（排队和单独跑共用，别写成两份） */
function solvePayload(enc) {
  return {
    deck: deckForRequest(), relics: relicsForRequest(), potions: state.potions, encounter: enc,
    character: state.character, ascension: state.ascension, actIndex: state.actIndex || 0,
    ...modePayload(), hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'Q',
    potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
    nodes: 100000, budget: 5000,
  };
}
function cmpPayload(enc) {
  return {
    deck: deckForRequest(), relics: relicsForRequest(), potions: state.potions, encounter: enc,
    character: state.character, ascension: state.ascension, actIndex: state.actIndex || 0,
    ...modePayload(), hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'CMP',
    potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
    nodes: 100000, budget: Number($('#cmpBudget') && $('#cmpBudget').value) || 8000,
    candidates: state.cmpCards.map(c => ({ cardId: c.cardId, upgradeLevels: c.upgradeLevels || 0 })),
  };
}
function upgPayload(enc) {
  return {
    deck: deckForRequest(), relics: relicsForRequest(), potions: state.potions, encounter: enc,
    character: state.character, ascension: state.ascension, actIndex: state.actIndex || 0,
    ...modePayload(), hp: state.hp, maxHp: state.maxHp, count: state.count, prefix: state.prefix || 'UP',
    potionPolicy: state.potionPolicy, concurrency: CONCURRENCY, profile: 'VeryHigh', beam: 135,
    nodes: 100000, budget: Number($('#upBudget') && $('#upBudget').value) || 8000,
    picks: state.upPicks.map(i => ({ index: i })),
  };
}
const QUEUE_RUN = {
  single: { url: '/api/solve', body: solvePayload, base: job => job.variants[0] },
  compare: { url: '/api/compare', body: cmpPayload, base: job => job.variants[0] },
  upgrade: { url: '/api/upgrade3', body: upgPayload, base: job => job.variants[0] },
};
/* 一组怪跑完：每只的胜率/战损/回合 + 选中那张牌的次数，交给服务端出一张数据图 */
function estimateRowFrom(job, enc, mode) {
  const v = (job.variants || [])[0] || {};
  const s = v.summary || {};
  let cardPlays = null;
  if (mode !== 'single' && job.variants && job.variants.length > 1) {
    const cand = job.variants[1];
    const id = cand && cand.card && cand.card.cardId;
    const p = id ? playsOf(cand.summary || {}, id) : null;
    cardPlays = p ? p.avg : null;
  }
  return {
    enc, name: qName(enc), winrate: s.winrate,
    avgHpLost: s.avgHpLost, minHpLost: s.minHpLost, maxHpLost: s.maxHpLost,
    avgTurns: s.avgTurns, cardPlays,
  };
}
async function saveEstimateReport(it, mode) {
  const cands = mode === 'compare'
    ? state.cmpCards.map(c => cardName(c.cardId)).join(' / ')
    : mode === 'upgrade'
      ? state.upPicks.map(i => cardName(state.deck[i] && state.deck[i].cardId)).join(' / ')
      : '';
  const title = `单卡战损预估 · ${it.groupLabel || '一组怪'}`;
  try {
    const r = await fetch('/api/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, map: state.encMap, kind: (it.groupLabel || '').split('·').pop().trim(),
        candidate: cands, mode, count: state.count, rows: it.rows || [],
      }),
    });
    const j = await r.json();
    return r.ok && j.ok ? j : null;
  } catch (e) {
    reportError('数据图生成失败：' + e.message, e.stack || '');
    return null;
  }
}
async function runQueue(mode) {
  const q = qArr(mode);
  const first = q.findIndex(it => !it.done);
  if (first < 0) { qHint(mode, '队列都算完了'); return; }
  if (!state.deck.length) { qHint(mode, '卡组是空的：先在「单场测算」里导入或组牌'); return; }
  if (mode === 'compare' && !state.cmpCards.length) { qHint(mode, '先选至少一张候选卡'); return; }
  if (mode === 'upgrade' && !state.upPicks.length) { qHint(mode, '先选至少一张要升级的牌'); return; }
  if (!state.encounter && !(state.encGroups || []).length) { qHint(mode, '先选一个遭遇，或点上面的「全部弱怪 / 全部普通怪…」'); return; }
  if ((state.encGroups || []).length && !qArr(mode).some(it => !it.done)) addToQueue(mode);
  autoCollapseMid();
  const cfg = QUEUE_RUN[mode];
  const id = ENC_IDS[mode];
  const btn = $('#' + id.qRun);
  if (btn) btn.disabled = true;
  let stopped = false;
  for (let i = first; i < q.length; i++) {
    const it = q[i];
    if (it.done) continue;
    it.running = true; renderQueue(mode);
    try {
      /* ---- 名单压缩：一组怪，每只 1 场，跑完出数据图 ---- */
      if (it.group && it.group.length) {
        const rows = [];
        const total = it.group.length;
        for (let k = 0; k < total; k++) {
          const sub = it.group[k];
          it.status = `${k + 1}/${total} · ${qName(sub)}`; renderQueue(mode);
          const body = cfg.body(sub);
          // 场数就按上面「样本数」来，不写死；跑多少场由用户决定
          const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || '提交失败');
          const job = await pollJob(j.id, jb => {
            if (jb) { it.status = `${k + 1}/${total} · ${jb.done}/${jb.total}`; renderQueue(mode); }
            if (jb && jb.status === 'cancelled') stopped = true;
          });
          if (stopped || !job || job.status === 'cancelled') { it.status = '被终止'; it.done = true; it.running = false; renderQueue(mode); break; }
          rows.push(estimateRowFrom(job, sub, mode));
        }
        if (stopped) { it.running = false; renderQueue(mode); break; }
        it.rows = rows;
        it.done = true; it.running = false; it.status = `${rows.length}/${total} 只`;
        it.winrate = rows.length ? rows.reduce((a, b) => a + (b.winrate || 0), 0) / rows.length : null;
        it.summary = {
          winrate: it.winrate,
          avgHpLost: rows.length ? rows.reduce((a, b) => a + (b.avgHpLost || 0), 0) / rows.length : null,
          avgTurns: rows.length ? rows.reduce((a, b) => a + (b.avgTurns || 0), 0) / rows.length : null,
        };
        it.report = await saveEstimateReport(it, mode);
        renderQueue(mode); renderQueueResults(mode);
        continue;
      }
      /* ---- 单只怪 ---- */
      const body = cfg.body(it.enc);
      const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '提交失败');
      const job = await pollJob(j.id, jb => {
        if (jb) { it.status = `${jb.done}/${jb.total} · ${jb.elapsedSec || 0}s`; renderQueue(mode); }
        if (jb && jb.status === 'cancelled') stopped = true;
      });
      it.running = false;
      if (stopped || !job || job.status === 'cancelled') { it.status = '被终止'; it.done = true; renderQueue(mode); break; }
      const baseV = cfg.base(job) || {};
      const s = baseV.summary || {};
      it.done = true; it.winrate = s.winrate; it.summary = s; it.status = '';
      // 对比/升级还有「哪张最好、差多少」，以及这张牌每局打出几次（这才是他要看的）
      if (mode !== 'single' && job.variants && job.variants.length > 1) {
        const cands = job.variants.slice(1).map(v => ({ label: (v.card && cardName(v.card.cardId)) || v.label, cardId: v.card && v.card.cardId, s: v.summary || {} }));
        cands.sort((a, b) => (b.s.winrate || 0) - (a.s.winrate || 0) || ((a.s.avgHpLost ?? 999) - (b.s.avgHpLost ?? 999)));
        const best = cands[0];
        const bp = best ? playsOf(best.s, best.cardId) : null;
        const bbase = best ? playsOf(s, best.cardId) : null;
        it.best = best ? {
          label: best.label,
          cardId: best.cardId,
          dpp: ((best.s.winrate || 0) - (s.winrate || 0)) * 100,
          winrate: best.s.winrate,
          plays: bp ? bp.avg : null,
          basePlays: bbase ? bbase.avg : 0,
        } : null;
      }
      renderQueue(mode); renderQueueResults(mode);
    } catch (e) {
      it.running = false; it.status = '失败：' + e.message; it.error = e.message;
      renderQueue(mode);
      reportError('排队第 ' + (i + 1) + ' 项失败：' + e.message, e.stack || '');
      break;
    }
  }
  if (btn) btn.disabled = false;
  autoExpandMid();
}
function renderQueueResults(mode) {
  const id = ENC_IDS[mode];
  const box = $('#' + id.qResult);
  if (!box) return;
  const done = qArr(mode).filter(it => it.done && it.summary);
  if (!done.length) { box.innerHTML = ''; return; }
  const head = mode === 'single'
    ? '<tr><th>遭遇</th><th>胜率</th><th>战损</th><th>回合</th><th>每局打出</th><th>每次伤害</th></tr>'
    : '<tr><th>遭遇</th><th>基线胜率</th><th>最好的</th><th>战损</th><th>回合</th><th>这张牌每局</th></tr>';
  const rows = done.map(it => {
    const s = it.summary;
    /* 一组怪（全部弱怪…）：排一行汇总，明细看数据图 */
    if (it.group) {
      const link = it.report ? `<a class="q-report-link" href="${it.report.url}" target="_blank" rel="noreferrer noopener" title="打开这张战损数据图（每只怪的掉血/胜率）">数据图 ↗</a>` : '—';
      return `<tr class="q-group-row">
        <td>${esc(it.groupLabel || '一组怪')}<span class="muted tiny"> ${it.group.length} 只</span></td>
        <td class="num"><b>${((s.winrate || 0) * 100).toFixed(1)}%</b><span class="muted tiny"> 平均</span></td>
        <td class="num" colspan="2">平均战损 ${(s.avgHpLost ?? 0).toFixed(1)}</td>
        <td class="num">${s.avgTurns != null ? s.avgTurns + ' 回合' : '—'}</td>
        <td class="num">${link}</td>
      </tr>`;
    }
    const common = `<td>${encLink(it.enc, qName(it.enc))}</td>
      <td class="num"><b>${((s.winrate || 0) * 100).toFixed(1)}%</b>${s.winrateCI ? `<span class="muted tiny"> ±${(s.winrateCI.half * 100).toFixed(1)}</span>` : ''}</td>`;
    if (mode === 'single') {
      return `<tr>${common}
        <td class="num">${hpRangeText(s)}</td>
        <td class="num">${s.avgTurns != null ? s.avgTurns : '—'}</td>
        <td class="num">${s.playsPerRun != null ? s.playsPerRun : '—'}</td>
        <td class="num">${(s.attrTotal != null && s.playsTotal) ? (s.attrTotal / s.playsTotal).toFixed(1) : '—'}</td>
      </tr>`;
    }
    const b = it.best;
    return `<tr>${common}
      <td class="num">${b ? `${esc(b.label)} <span class="${b.dpp > 0 ? 'up' : b.dpp < 0 ? 'down' : 'same'}">${b.dpp > 0 ? '+' : ''}${b.dpp.toFixed(1)}pp</span>` : '—'}</td>
      <td class="num">${hpRangeText(s)}</td>
      <td class="num">${s.avgTurns != null ? s.avgTurns : '—'}</td>
      <td class="num">${b && b.plays != null ? `${fmtPlay(b.plays)} 次<span class="muted tiny">（基线 ${fmtPlay(b.basePlays)}）</span>` : '—'}</td>
    </tr>`;
  }).join('');
  // 生成过的数据图都列出来，方便直接点开/另存
  const reports = done.filter(it => it.report);
  const repBox = reports.length
    ? `<div class="q-reports">数据图：${reports.map(it => `<a href="${it.report.url}" target="_blank" rel="noreferrer noopener">${esc(it.report.name)}</a>`).join(' · ')}</div>`
    : '';
  box.innerHTML = `<table class="q-table"><thead>${head}</thead><tbody>${rows}</tbody></table>${repBox}`;
}

/* ================= 通用轮询 ================= */
function pollJob(id, onUpdate) {
  state.runningJob = { id };
  syncStopBtn();
  return new Promise(resolve => {
    const tick = async () => {
      try {
        const r = await fetch('/api/job/' + id);
        if (!r.ok) { state.runningJob = null; syncStopBtn(); if (onUpdate) onUpdate(null); return resolve(null); }
        const job = await r.json();
        if (job && job.status === 'gone') { state.runningJob = null; syncStopBtn(); if (onUpdate) onUpdate(null); return resolve(null); }
        if (onUpdate) onUpdate(job);
        if (job && job.total) setMidProgress(`${job.done}/${job.total}`);
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
          state.runningJob = null; syncStopBtn();
          autoExpandMid(); return resolve(job);
        }
      } catch { }
      setTimeout(tick, 900);
    };
    tick();
  });
}

/* 终止按钮：只在有任务跑着的时候出现 */
function syncStopBtn() {
  const b = $('#stopRun');
  if (!b) return;
  b.classList.toggle('hidden', !state.runningJob);
  b.disabled = false;
  b.textContent = '■ 终止';
}

async function stopRunning() {
  const rj = state.runningJob;
  if (!rj) return;
  const b = $('#stopRun');
  if (b) { b.disabled = true; b.textContent = '正在停…'; }
  try {
    const r = await fetch('/api/job/' + rj.id + '/cancel', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '停不下来');
    state.lastStop = { id: rj.id, killed: j.killed, done: j.done, total: j.total, at: Date.now() };
  } catch (e) {
    reportError('终止失败：' + e.message, e.stack || '');
    if (b) { b.disabled = false; b.textContent = '■ 终止'; }
  }
}

const _p = new URLSearchParams(location.search);
if (_p.has('watch')) {
  state.jobId = _p.get('watch');
  setTimeout(poll, 300);
}
if (_p.has('autotest')) {
  state.count = Math.min(50, Number(_p.get('autotest')) || 5);
  const el = $('#count'); if (el) el.value = state.count;
  setTimeout(run, 400);
}
if (_p.has('refresh')) {
  setTimeout(refreshFromGame, 400);
}
init().then(() => { bindModes(); bindErrorBar(); bindShot(); bindMidCollapse(); bindDeckSplit(); bindQueue(); });

/* 终止按钮 + 三个模式各自的「遭遇/排队」面板挂载 */
function bindQueue() {
  const stop = $('#stopRun');
  if (stop) stop.onclick = stopRunning;
  syncStopBtn();
  mountEncPanel('#encPanel', 'single');
  mountEncPanel('#cmpEncPanel', 'compare');
  mountEncPanel('#upEncPanel', 'upgrade');
}
/* ---------- 截图导入：卡组 + 遗物 ---------- */
const shot = { img: null, cards: [], relics: [], feats: null };

function shotUI() {
  return {
    dlg: $('#shotDlg'), drop: $('#shotDrop'), file: $('#shotFile'), prev: $('#shotPreview'),
    info: $('#shotInfo'), cards: $('#shotCardList'), relics: $('#shotRelicList'),
    warn: $('#shotWarn'), apply: $('#shotApply'), close: $('#shotClose'),
  };
}

function charNameOf(id) {
  const c = ((state.meta && state.meta.characters) || []).find(x => x.id === id);
  return c ? c.name : (id || '未知');
}

function shotReset() {
  const u = shotUI();
  shot.img = null; shot.cards = []; shot.relics = [];
  shot.role = null; shot.ms = 0;
  if (!u.dlg) return;
  u.prev.style.display = 'none'; u.prev.src = '';
  u.cards.innerHTML = ''; u.relics.innerHTML = '';
  u.info.textContent = ''; u.warn.textContent = '';
  u.apply.disabled = true;
  u.drop.style.display = '';
}

async function shotOpen() {
  const u = shotUI();
  shotReset();
  if (!u.dlg) return;
  u.dlg.showModal();
  if (!shot.feats) {
    try {
      const rs = await fetch('/assets/relic-feats.json');
      const raw = await rs.json();
      shot.feats = raw.map(r => ({ id: r.id, name: r.name, f: Uint8Array.from(atob(r.f), ch => ch.charCodeAt(0)) }));
    } catch { shot.feats = []; }
  }
}

function shotDataUrlOf(img, maxW = 1920) {
  const k = Math.min(1, maxW / img.naturalWidth);
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/png');
}

function shotMatchRelics(img) {
  const feats = shot.feats || [];
  const W = img.naturalWidth, H = img.naturalHeight;
  const sx = W / 1920, sy = H / 1080;
  const out = [];
  for (let i = 0; i < 14; i++) {
    const cx = (356 + i * 67.5) * sx, cy = 560 * sy;
    const half = 34 * Math.min(sx, sy);
    const t = document.createElement('canvas');
    const n = Math.max(24, Math.round(half * 2));
    t.width = n; t.height = n;
    const tc = t.getContext('2d');
    tc.drawImage(img, cx - half, cy - half, half * 2, half * 2, 0, 0, n, n);
    const d = tc.getImageData(0, 0, n, n).data;
    let x0 = n, y0 = n, x1 = -1, y1 = -1, lit = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = (y * n + x) * 4;
        if ((d[p] + d[p + 1] + d[p + 2]) / 3 > 42) {
          lit++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0 || lit < n * n * 0.03) { out.push(null); continue; }
    const s = document.createElement('canvas'); s.width = 32; s.height = 32;
    const sc = s.getContext('2d');
    sc.fillStyle = '#1e1b21'; sc.fillRect(0, 0, 32, 32);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const k = 32 / Math.max(bw, bh);
    const nw = Math.max(1, Math.round(bw * k)), nh = Math.max(1, Math.round(bh * k));
    sc.drawImage(t, x0, y0, bw, bh, Math.round((32 - nw) / 2), Math.round((32 - nh) / 2), nw, nh);
    const f = sc.getImageData(0, 0, 32, 32).data;
    const scored = [];
    for (const r of feats) {
      let dist = 0;
      for (let px = 0; px < 1024; px++) {
        const q = px * 4, q3 = px * 3;
        const dr = f[q] - r.f[q3], dg = f[q + 1] - r.f[q3 + 1], db = f[q + 2] - r.f[q3 + 2];
        dist += dr * dr + dg * dg + db * db;
      }
      scored.push({ id: r.id, name: r.name, d: dist / 1024 });
    }
    scored.sort((a, b) => a.d - b.d);
    out.push({ tile: s.toDataURL(), top: scored.slice(0, 6), selected: '' });
  }
  return out;
}

async function shotTakeImage(img) {
  const u = shotUI();
  shot.img = img;
  u.drop.style.display = 'none';
  u.prev.style.display = '';
  u.prev.src = img.src;
  u.info.textContent = '识别中…（约 3 秒）';
  u.warn.textContent = '';
  u.apply.disabled = true;
  let r;
  try {
    const res = await fetch('/api/shot-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: shotDataUrlOf(img) }),
    });
    r = await res.json();
    if (!res.ok) throw new Error(r.error || ('HTTP ' + res.status));
  } catch (e) {
    u.info.textContent = '';
    u.warn.textContent = '识别失败：' + (e.message || e);
    return;
  }
  shot.cards = (r.cards || []).map(c => ({ ...c, alts: c.alts || [] }));
  // 低置信行如果已经有同名的高置信行，默认不计入：卡组页里「打击」被读成「玫击」(56%) 时，
  // 并进去会把 3 张算成 4 张，等于静默多一张卡。不勾就不算，勾回来也行。
  for (const c of shot.cards) {
    c.use = !(c.conf < 0.8 && shot.cards.some(o => o !== c && o.cardId === c.cardId && o.conf >= 0.8));
  }
  shot.role = r.role;
  shot.ms = r.ms;
  // 遗物行只在「结算/跑图记录」截图里有；卡组浏览页没有，按比例裁会裁到卡牌
  try { shot.relics = r.kind === 'history' ? shotMatchRelics(img) : []; } catch { shot.relics = []; }
  shotRenderCards();
  shotRenderRelics();
  const ws = (r.warnings || []).slice(0, 3);
  if (r.unknown && r.unknown.length) ws.push(`有 ${r.unknown.length} 处没认出来`);
  u.warn.textContent = ws.join('；');
  u.apply.disabled = !shot.cards.length;
}

function shotUseTotal() {
  return shot.cards.reduce((s, c) => s + (c.use === false ? 0 : (Number(c.count) || 1)), 0);
}

function shotUpdateInfo() {
  const u = shotUI();
  if (!u.info) return;
  const relicN = shot.relics.filter(Boolean).length;
  const skipped = shot.cards.filter(c => c.use === false).length;
  u.info.textContent = `角色 ${charNameOf(shot.role)} · ${shotUseTotal()} 张卡`
    + (relicN ? ` · ${relicN} 件遗物` : '')
    + (skipped ? ` · ${skipped} 行未计入` : '')
    + ` · ${shot.ms || 0}ms`;
}

function shotRenderCards() {
  const u = shotUI();
  if (!u.cards) return;
  if (!shot.cards.length) { u.cards.innerHTML = '<div class="empty">没认出卡牌。换个清晰点的截图，或者手动改卡组。</div>'; return; }
  u.cards.innerHTML = shot.cards.map((c, i) => {
    const card = c.cardId ? state.cardsById.get(c.cardId) : null;
    const alts = [{ id: c.cardId, name: c.name || c.raw }, ...(c.alts || [])].filter(o => o.id);
    const uniq = [...new Map(alts.map(o => [o.id, o])).values()];
    const sel = uniq.length > 1
      ? `<select data-op="card">${uniq.map(o => `<option value="${esc(o.id)}" ${o.id === c.cardId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
      : '';
    return `<div class="shot-card ${c.conf < 0.75 ? 'low' : ''}${c.use === false ? ' off' : ''}" data-i="${i}">
      ${card ? imgTag(card) : '<span class="shot-noimg"></span>'}
      <div class="sc-main">
        <div class="sc-name">${esc(c.name || c.raw || '未识别')}${c.up ? ' <span class="up-tag">升级</span>' : ''}</div>
        <div class="sc-sub muted tiny">${c.onlyDesc ? '只认出描述，请核对' : ''}${c.raw && c.raw !== (c.name || '') ? ' 截图里是「' + esc(c.raw) + '」' : ''}</div>
      </div>
      ${sel}
      <label class="sc-use" title="不勾就不计入卡组"><input type="checkbox" data-op="use" ${c.use === false ? '' : 'checked'}>计入</label>
      <label class="sc-up"><input type="checkbox" data-op="up" ${c.up ? 'checked' : ''}>升级</label>
      <input class="sc-count" type="number" min="1" max="9" data-op="count" value="${Number(c.count) || 1}">
      <button class="ghost small" data-op="del" title="从导入结果里删掉">×</button>
    </div>`;
  }).join('');
  shotUpdateInfo();
}

function shotRenderRelics() {
  const u = shotUI();
  if (!u.relics) return;
  const items = shot.relics.filter(Boolean);
  if (!items.length) { u.relics.innerHTML = ''; return; }
  const opts = (shot.feats || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  u.relics.innerHTML = `<div class="shot-relics-head muted tiny">遗物：自动认不准（游戏里的图标带发光/描边，跟素材对不上），对着小图点下拉自己选；不选就不动卡组里的遗物。</div>` +
    shot.relics.map((r, i) => {
      if (!r) return '';
      const sel = r.selected || '';
      const head = `<option value="" ${sel ? '' : 'selected'}>（未选）</option>`;
      const top = (r.top || []).slice(0, 6);
      const topOpts = top.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
      const allOpts = opts.map(f => `<option value="${esc(f.id)}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
      return `<div class="shot-relic" data-i="${i}"><img src="${r.tile}" alt=""><select data-op="relic">${head}<optgroup label="最像的">${topOpts}</optgroup><optgroup label="全部遗物">${allOpts}</optgroup></select></div>`;
    }).join('');
}

function shotApplyNow() {
  const cards = shot.cards.filter(c => c.cardId && Number(c.count) > 0 && c.use !== false);
  if (!cards.length) return;
  state.deck = cards.map(c => {
    const n = Math.max(1, Number(c.count) || 1);
    return { cardId: c.cardId, count: n, upCount: c.up ? n : 0 };
  });
  const relics = shot.relics.map(r => r && r.selected).filter(Boolean);
  if (relics.length) state.relics = relics;
  renderDeck();
  renderRelicChips();
  saveLocal();
  $('#shotDlg').close();
}

function shotLoadBlob(file) {
  const img = new Image();
  img.onload = () => shotTakeImage(img);
  img.onerror = () => { const u = shotUI(); if (u.warn) u.warn.textContent = '这张图读不出来，换一张试试'; };
  img.src = URL.createObjectURL(file);
}

function bindShot() {
  const u = shotUI();
  if (!u.dlg || !$('#shotImport')) return;
  $('#shotImport').onclick = shotOpen;
  u.close.onclick = () => u.dlg.close();
  u.apply.onclick = shotApplyNow;
  u.file.onchange = () => {
    const f = u.file.files && u.file.files[0];
    if (f) shotLoadBlob(f);
    u.file.value = '';
  };
  ['dragenter', 'dragover'].forEach(ev => u.drop.addEventListener(ev, e => { e.preventDefault(); u.drop.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(ev => u.drop.addEventListener(ev, e => { e.preventDefault(); u.drop.classList.remove('on'); }));
  u.drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) shotLoadBlob(f);
  });
  document.addEventListener('paste', e => {
    if (!u.dlg.open) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); shotLoadBlob(f); return; }
      }
    }
  });
  u.cards.addEventListener('click', e => {
    const btn = e.target.closest('[data-op="del"]');
    if (!btn) return;
    const row = btn.closest('.shot-card');
    shot.cards.splice(Number(row.dataset.i), 1);
    shotRenderCards();
  });
  u.cards.addEventListener('change', e => {
    const row = e.target.closest('.shot-card');
    if (!row) return;
    const c = shot.cards[Number(row.dataset.i)];
    if (!c) return;
    const op = e.target.dataset.op;
    if (op === 'up') { c.up = e.target.checked; shotRenderCards(); }
    else if (op === 'use') { c.use = e.target.checked; shotUpdateInfo(); }
    else if (op === 'count') { c.count = Math.max(1, Math.min(9, Number(e.target.value) || 1)); shotUpdateInfo(); }
    else if (op === 'card') {
      const id = e.target.value;
      const alt = (c.alts || []).find(a => a.id === id);
      c.cardId = id;
      c.name = alt ? alt.name : ((state.cardsById.get(id) || {}).name || id);
      shotRenderCards();
    }
  });
  u.relics.addEventListener('change', e => {
    const row = e.target.closest('.shot-relic');
    if (!row) return;
    const r = shot.relics[Number(row.dataset.i)];
    if (r) r.selected = e.target.value;
  });
}
