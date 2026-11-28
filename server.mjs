// StS2 求解器可视化 UI 的本地服务：静态文件 + /api/meta + /api/solve + /api/compare + /api/rest + /api/job/:id
// 只接 OfflineSearchHarness，不做任何前端模拟。
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from './lib/shot.mjs';
import { createStore, buildEncounterIndex } from './lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(ROOT, 'runs');
const LOGS = path.join(ROOT, 'logs');

/* 服务端崩了也要留下证据：写进 logs\服务端错误.txt */
function crashLog(where, e) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, '服务端错误.txt'),
      `[${new Date().toISOString()}] ${where}\n${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { }
}
process.on('uncaughtException', e => { crashLog('uncaughtException', e); console.error('[崩溃]', e); });
process.on('unhandledRejection', e => { crashLog('unhandledRejection', e); console.error('[未处理的 Promise]', e); });

// 求解器：优先用包内自带的 harness（exe + 同目录 dll）；没有就靠环境变量指一个
const HARNESS_EXE = path.join(ROOT, 'harness', 'OfflineSearchHarness.exe');

function resolveHarness() {
  if (fs.existsSync(HARNESS_EXE)) return { cmd: HARNESS_EXE, pre: [], how: 'exe' };
  if (process.env.STS2_HARNESS) return { cmd: process.env.STS2_DOTNET || 'dotnet', pre: [process.env.STS2_HARNESS], how: 'env' };
  return { cmd: '', pre: [], how: 'missing' };
}
const HARNESS = resolveHarness();
const HARNESS_CMD = HARNESS.cmd;
const HARNESS_PRE = HARNESS.pre;
const PORT = Number(process.env.PORT || 8766);

/* 并行上限：不再写死 12，按这台机器算（别人的机器更好就该能开更多）。
   - 逻辑核数 = os.cpus().length（Windows 上是逻辑线程数）
   - 推荐值 = 物理核数 ≈ 逻辑核数 / 2（8 核 16 线程 -> 8）
   - 硬上限 = 逻辑核数，最多 64；可用环境变量 STS2_MAX_CONCURRENCY 覆盖
   - 再按内存兜底：每个常驻 worker 按 400MB 估算，别把别人机器跑爆 */
const LOGICAL_CORES = Math.max(2, os.cpus().length || 8);
const PHYSICAL_CORES = Math.max(1, Math.floor(LOGICAL_CORES / 2));
const MAX_CONCURRENCY = Math.max(2, Math.min(
  64,
  Number(process.env.STS2_MAX_CONCURRENCY) || LOGICAL_CORES,
));
function concurrencyBudget() {
  // 每个常驻 worker 实测约 300–500MB（Godot 静态 + 求解器状态），按 500MB 算并只用 70% 空闲内存
  const byRam = Math.floor((os.freemem() * 0.7) / (500 * 1024 * 1024));
  return Math.max(2, Math.min(MAX_CONCURRENCY, byRam));
}

/* ---------- 把模拟器的崩溃翻译成人话 ---------- */
function explainHarnessFailure(tail, code) {
  const t = String(tail || '');
  if (/runtimeconfig\.json'? was not found|Failed to run as a self-contained app/i.test(t)) {
    return '模拟器的 runtimeconfig 还没生成（一般是用 node 直接起的服务，没走 启动.cmd）。关掉窗口、双击 启动.cmd 启动一次，它会按本机路径生成。';
  }
  if (/You must install or update \.NET|Framework 'Microsoft\.NETCore\.App' version '9/i.test(t)) {
    return '这台机器没装 .NET 9 运行时。装一下：https://dotnet.microsoft.com/download/dotnet/9.0 （选 “Run console apps” 那栏），装完关掉窗口重开 启动.cmd。';
  }
  if (/The framework '.+?' was not found/i.test(t)) {
    return '缺 .NET 运行时（找不到 Microsoft.NETCore.App 9.x）。装 .NET 9 后重开 启动.cmd。';
  }
  if (/Could not load file or assembly|FileNotFound|does not exist/i.test(t)) {
    return '模拟器启动失败：缺文件或版本对不上（多半是 harness 或游戏目录不对）。先重开 启动.cmd 让它重新探测；还不行把 logs\\ 里的报错发我。';
  }
  if (/Unrecognized|Unknown option|usage:\s*OfflineSearchHarness/i.test(t)) {
    return '模拟器不认这次传的参数——harness 和计算器版本对不上。用包里自带的 harness\\，别单独替换。';
  }
  if (/__STS2_DATA_DIR__|__COMBATSOLVER_DLL__|__RITSULIB_/.test(t) || /Invalid character|Illegal characters in path/i.test(t)) {
    return '模拟器的路径配置还没被初始化（里面还是占位符）。用 启动.cmd 启动，它会自动探测游戏目录并填好。';
  }
  const last = t.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
  return `模拟器退出（退出码 ${code == null ? '?' : code}）${last ? '：' + last : '，而且没有任何输出。'} 详细日志见 logs\\服务端错误.txt 或 runs\\.`;
}

/* ---------- 环境自检（给前端横幅用） ---------- */
function readRuntimeConfig() {
  const rc = path.join(ROOT, 'harness', 'OfflineSearchHarness.runtimeconfig.json');
  if (!fs.existsSync(rc)) return { exists: false };
  try {
    const raw = fs.readFileSync(rc, 'utf8');
    return { exists: true, raw, placeholders: /__[A-Z_]+__/.test(raw), json: JSON.parse(raw) };
  } catch (e) {
    return { exists: true, raw: '', broken: String(e.message) };
  }
}

function diagnose() {
  const problems = [];
  const push = (code, msg, fix) => problems.push({ code, msg, fix: fix || '' });
  const rc = readRuntimeConfig();

  if (HARNESS.how === 'missing') {
    push('harness-missing', '找不到 harness\\OfflineSearchHarness.exe —— 包不完整，或者你是直接双击 server.mjs 起的。', '双击包里的 启动.cmd');
  }
  if (rc.exists && rc.placeholders) {
    push('needs-init', '模拟器的路径还是占位符（__STS2_DATA_DIR__ 之类），说明没走 启动.cmd 初始化。', '双击 启动.cmd，它会自动探测游戏目录并填好');
  }
  if (rc.exists && rc.broken) push('runtimeconfig-broken', 'runtimeconfig 读不了：' + rc.broken, '重新解压一份包试试');

  if (rc.exists && rc.json && !rc.placeholders) {
    const p = (rc.json.runtimeOptions && rc.json.runtimeOptions.configProperties) || {};
    const must = [['Sts2DataDir', '游戏数据目录'], ['CombatSolverDll', '求解器 CombatSolver.dll'], ['RitsuLibCompatDir', 'RitsuLib 兼容层']];
    for (const [k, label] of must) {
      const v = p[k];
      if (!v) { push('missing-' + k, `runtimeconfig 里没写 ${k}（${label}）。`, '重开 启动.cmd'); continue; }
      if (!fs.existsSync(v)) push('bad-' + k, `${label} 不存在：${v}`, '确认游戏/模组装好了，或删掉 harness\\OfflineSearchHarness.runtimeconfig.json 后重开 启动.cmd 重新探测');
    }
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) push('node-old', `Node 版本太旧（${process.versions.node}），至少要 18。`, '用包里 node\\node.exe（启动.cmd 默认就用它）');

  return { ok: problems.length === 0, harness: HARNESS.how, node: process.versions.node, problems };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const jobs = new Map();
let seq = 0;
fs.mkdirSync(RUNS, { recursive: true });

/* ---------- 结果数据库（SQLite）：每跑完一次自动入库，历史可一键回填 ---------- */
const DB_PATH = process.env.STS2_DB || path.join(ROOT, 'data', 'sts2.db');
let store = null;
let storeError = null;
try {
  store = createStore(DB_PATH);
} catch (e) {
  // 库坏了不能让整个服务起不来：页面照旧能算，只是「数据」页会提示原因
  storeError = String((e && e.message) || e);
  crashLog('db-open', e);
}
let encIndexCache = null;
function encounterIndex() {
  if (encIndexCache) return encIndexCache;
  encIndexCache = buildEncounterIndex(readJson(path.join(ROOT, 'assets', 'meta.json')) || { encounters: [] });
  return encIndexCache;
}
/** 跑完（或被终止但有结果）就把这次测算写进库。出错只记日志，不影响结果回给前端。 */
function recordToDb(job, source = 'auto') {
  if (!store || !job) return;
  try {
    if (store.getSetting('autoRecord') === '0') return;
    store.recordJob(publicJob(job), {
      source, createdAt: new Date().toISOString(),
      label: job.label || null,
      encounter: encounterIndex()[job.encounter] || (job.encounter ? { name: job.encounter, map: null, kind: null } : null),
    });
  } catch (e) {
    crashLog('db-record', e);
  }
}

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  let base = PUBLIC;
  if (rel.startsWith('/assets/') || rel.startsWith('/data/')) base = ROOT;
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 24e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ---------- 伤害归因：从 harness-result.json 的 planActions + 每回合血量快照算 ---------- */

// 一帧状态串：turn=2;hp=73;max_hp=73;...;E0=1/QUEEN/queen/415/419/0/MOVE;E1=...
function parseStamp(stamp) {
  if (!stamp) return null;
  const turn = Number((stamp.match(/\bturn=(\d+)/) || [])[1] || 0);
  const m = stamp.match(/hp=(\d+);max_hp=(\d+)/);
  const enemies = [];
  // E0=<n>/<ENEMY_ID>/<标签>/<hp>/<max>/<block>/<move>
  // 第三段不一定是小写标签：恐怖鳗鱼这类是 '-'，所以这里不能限定字符集
  const re = /E(\d+)=\d+\/([A-Z0-9_]+)\/(?:[^/]*)\/(\d+)\/(\d+)\//g;
  let x;
  while ((x = re.exec(stamp))) enemies.push({ idx: Number(x[1]), id: x[2], hp: Number(x[3]), max: Number(x[4]) });
  return { turn, hp: m ? Number(m[1]) : null, maxHp: m ? Number(m[2]) : null, energy: energyOf(stamp), hpSum: enemies.reduce((s, e) => s + e.hp, 0), enemies };
}

// 状态串里的 energy=N（回合开始时的能量）
function energyOf(stamp) {
  const m = /(?:^|;)energy=(\d+)/.exec(stamp || '');
  return m ? Number(m[1]) : null;
}

// 一局里「每个回合的帧」，按回合号去重排序（rootLiveStamp 是第 1 回合，continuations 是后面各回合）
function framesOf(hr) {
  const s = hr && hr.search;
  if (!s) return [];
  const frames = [];
  if (s.rootLiveStamp) frames.push(parseStamp(s.rootLiveStamp));
  for (const c of s.continuations || []) frames.push(parseStamp(c && c.StateText));
  const seen = new Set();
  const list = frames.filter(f => f && !seen.has(f.turn) && seen.add(f.turn));
  list.sort((a, b) => a.turn - b.turn);
  return list;
}

// 把一局的 planActions 变成 {回合: [牌]}，并附带牌面伤害（vars=Damage=N）和费用（energy=False:1）
function parsePlayActions(actions) {
  const byTurn = new Map();
  for (const a of actions || []) {
    const m = /^(\d+):PlayCard:([A-Z0-9_]+):(.*)$/.exec(a);
    if (!m) continue;
    const turn = Number(m[1]);
    const vars = (/vars=([^|]*)/.exec(m[3]) || [])[1] || '';
    const dmg = Number((/Damage=(\d+)/.exec(vars) || [])[1] || 0);
    const costM = /\|energy=[A-Za-z]+:(\d+)/.exec(m[3]);
    const cost = costM ? Number(costM[1]) : 0;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push({ cardId: m[2], face: dmg, cost });
  }
  return byTurn;
}

/**
 * 一局的出牌顺序：[[第 1 回合打的牌…], [第 2 回合…]]，按 planActions 里的先后。
 * 「最好/最差那一局」要看的就是这个。
 */
function playOrder(hr) {
  const byTurn = parsePlayActions((hr && hr.search && hr.search.planActions) || []);
  const turns = [...byTurn.keys()].sort((a, b) => a - b);
  return turns.map(t => byTurn.get(t).map(p => p.cardId));
}

/**
 * 能量浪费（估算）：每回合开始时的 energy 减去这回合出牌花掉的总费用。
 * 中途靠遗物/牌回的能量看不见，所以只能估；回合开始时就没花完的部分会算进来。
 */
function energyWaste(hr) {
  const frames = framesOf(hr);
  if (!frames.length) return null;
  const plays = parsePlayActions((hr.search && hr.search.planActions) || []);
  let waste = 0;
  let turns = 0;
  for (const f of frames) {
    if (f.energy == null) continue;
    const spent = (plays.get(f.turn) || []).reduce((s, p) => s + (p.cost || 0), 0);
    waste += Math.max(0, f.energy - spent);
    turns++;
  }
  if (!turns) return null;
  return { waste, turns, perTurn: waste / turns };
}

/**
 * 打出次数：planActions 里每张牌打了几次（"3:PlayCard:STRIKE_REGENT:..."）。
 * 只数 PlayCard；EndTurn 之类不算。回来的是 { byCard, total, turns }。
 */
function playCounts(hr) {
  const acts = (hr && hr.search && hr.search.planActions) || [];
  const byCard = Object.create(null);
  let total = 0;
  let maxTurn = 0;
  for (const a of acts) {
    const m = /^(\d+):PlayCard:([A-Z0-9_]+)/.exec(a);
    if (m) {
      byCard[m[2]] = (byCard[m[2]] || 0) + 1;
      total += 1;
      maxTurn = Math.max(maxTurn, Number(m[1]));
      continue;
    }
    const t = /^(\d+):/.exec(a);   // EndTurn 之类也带回合号，用来数「打到第几回合」
    if (t) maxTurn = Math.max(maxTurn, Number(t[1]));
  }
  return { byCard, total, turns: maxTurn || null };
}

/**
 * 伤害归因：按「每回合敌人实际掉的血」分摊到该回合打出的伤害牌，权重用牌面伤害。
 * 这一回合没有任何带伤害的牌却掉了血（召唤物 / 中毒 / 能力等），记到 __other__。
 */
function attributeResult(hr) {
  const s = hr && hr.search;
  if (!s) return null;
  const q = hr.comparisonQuality;
  const enemyRaw = pick(q, 'enemyHp');
  const finalEnemyHp = Number.isFinite(enemyRaw) ? Number(enemyRaw) : null;
  const frames2 = framesOf(hr);
  if (!frames2.length) return null;
  const plays = parsePlayActions(s.planActions);

  const byCard = Object.create(null);
  let total = 0;
  const perTurn = [];
  for (let i = 0; i < frames2.length; i++) {
    const cur = frames2[i];
    const next = frames2[i + 1];
    const nextHp = next ? next.hpSum : (finalEnemyHp != null ? finalEnemyHp : cur.hpSum); // 最后一帧之后结算到战斗结束
    const dmg = Math.max(0, cur.hpSum - nextHp);
    if (!dmg) continue;
    total += dmg;
    const list = (plays.get(cur.turn) || []).filter(p => p.face > 0);
    const wsum = list.reduce((a, p) => a + p.face, 0);
    if (!list.length || !wsum) {
      byCard.__other__ = (byCard.__other__ || 0) + dmg;
      perTurn.push({ turn: cur.turn, damage: dmg, attributed: '__other__' });
      continue;
    }
    for (const p of list) byCard[p.cardId] = (byCard[p.cardId] || 0) + dmg * p.face / wsum;
    perTurn.push({ turn: cur.turn, damage: dmg, cards: list.map(p => p.cardId) });
  }
  return { byCard, total, perTurn, turns: frames2.length };
}

/* ---------- 请求构造与单局运行 ---------- */

function pileOf(encounter) {
  if (encounter.endsWith('_BOSS')) return 'Boss';
  if (encounter.endsWith('_ELITE')) return 'Elite';
  return 'Monster';
}

/** 遗物计数器（存档 props.ints / props.bools）→ 求解器请求里的 props；没有计数就不带 */
function withRelicProps(base, relicId, map) {
  const p = map && map[relicId];
  if (!p) return base;
  // harness 的 UnattendedRelicInjection 认的是 integerMembers / booleanMembers（反射写进 RelicModel
  // 的同名字段，比如钢笔尖的 AttacksPlayed）；写成 props 会被当未知字段直接忽略——2026-11-27 查源码确认。
  const integerMembers = {};
  for (const x of p.ints || []) {
    if (x && x.name) integerMembers[String(x.name)] = Math.max(0, Math.round(Number(x.value) || 0));
  }
  const booleanMembers = {};
  for (const x of p.bools || []) {
    if (x && x.name) booleanMembers[String(x.name)] = !!x.value;
  }
  const out = { ...base };
  if (Object.keys(integerMembers).length) out.integerMembers = integerMembers;
  if (Object.keys(booleanMembers).length) out.booleanMembers = booleanMembers;
  return out;
}

function buildRequest(job, deck, seed) {
  const runCards = [];
  for (const c of deck) {
    const item = { cardId: c.cardId, pile: 'Deck', count: c.count || 1 };
    if (c.upgradeLevels) item.upgradeLevels = c.upgradeLevels;
    if (c.enchantmentId) { item.enchantmentId = c.enchantmentId; if (c.enchantmentAmount) item.enchantmentAmount = c.enchantmentAmount; }
    runCards.push(item);
  }
  return {
    schemaVersion: 1,
    scenarioId: seed,
    characterId: job.character,
    encounterId: job.encounter,
    seed,
    ascension: job.ascension,
    // 恐惧模式：游戏里只有 A10，领域由「恐惧首领」决定（本地补丁：离线夹具已支持）
    gameMode: job.gameMode === 'Dread' ? 'Dread' : 'Standard',
    actIndexForTest: Number.isInteger(job.actIndex) ? job.actIndex : 0,
    targetRoomType: pileOf(job.encounter),
    ...(job.gameMode === 'Dread' && job.dreadBoss ? { dreadBossEncounterId: job.dreadBoss } : {}),
    preserveNativeCombatStateForTest: true,
    clearRunDeck: true,
    runCards,
    cards: [],
    // 遗物带的计数器（钢笔尖的攻击张数、各种「计数遗物」）要一起送进求解器，
    // 不然 A10 里同一个遗物在 0 层和 9 层会被算成一样。（2026-11-27 主人要求）
    relics: job.relics.map(r => withRelicProps({ relicId: r, addWithoutObtainedEffects: true }, r, job.relicProps)),
    potions: job.potions.map(p => ({ potionId: p })),
    potionPolicyForTest: job.potionPolicy === 'Smart' ? 'Smart' : 'Disabled',
    preCombatPlayerCurrentHpOverride: null,
    fixedSearchBudget: true,
    searchBudgetOverrideMilliseconds: job.budget,
    stopAfterInitialSolverResultAssertion: true,
    timeoutSeconds: 300,
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// harness-result.json 是 PascalCase（Won），result.json 是 camelCase（won），这里统一取
function pick(obj, name) {
  if (!obj) return undefined;
  if (obj[name] !== undefined) return obj[name];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  if (obj[cap] !== undefined) return obj[cap];
  return undefined;
}

function prepareRunRequest(job, variant, seed) {
  const dir = path.join(job.dir, variant.key, String(seed).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const reqPath = path.join(dir, 'request.json');
  fs.writeFileSync(reqPath, JSON.stringify(buildRequest(job, variant.deck, seed), null, 1), 'utf8');
  return { dir, reqPath };
}

// 跑完（或失败）之后统一从产物目录读出这一局的行：单跑和常驻两条路共用
function buildRunRow(job, variant, seed, dir, sec, errTail, code) {
  let row = { seed, won: null, hpLost: null, deficit: null, status: 'no-result', sec };
  const hr = readJson(path.join(dir, 'harness-result.json'));
  const r = hr || readJson(path.join(dir, 'result.json'));
  if (r) {
    const q = r.comparisonQuality;
    const wonVal = pick(q, 'won');
    const hpVal = pick(q, 'projectedBattleHpLost');
    const lostHp = Number.isFinite(hpVal) ? hpVal : (wonVal === false ? variant.hp : null);
    const turnVal = pick(q, 'combatEndedTurn');
    const enemyVal = pick(q, 'enemyHp');
    const deficitVal = pick(q, 'strategicHpDeficit');
    row = {
      seed, won: wonVal === undefined ? null : !!wonVal,
      hpLost: lostHp,
      deficit: Number.isFinite(deficitVal) ? deficitVal : null,
      turns: Number.isFinite(turnVal) ? turnVal : null,
      enemyHp: Number.isFinite(enemyVal) ? enemyVal : null,
      status: r.status || r.reachedMilestone || '?', sec,
    };
    if (!q && r.error) job.lastError = String(r.error);
  } else {
    // 没有结果文件 = 模拟器没跑成，把原因翻译出来，别让界面只显示 “失败”
    const hint = explainHarnessFailure(errTail, code);
    job.lastError = hint;
    row.note = hint;
  }
  // 伤害归因只在 harness-result.json 里（有 planActions）
  const attr = hr ? attributeResult(hr) : null;
  if (attr) { row.attr = attr.byCard; row.perTurn = attr.perTurn; }
  // 打出次数（每张牌打了几次），同样从 planActions 数出来
  const plays = hr ? playCounts(hr) : null;
  if (plays) {
    row.plays = plays.byCard;
    row.playsTotal = plays.total;
    // 求解器的 quality 里没有「战斗在第几回合结束」，就用出牌记录里最大的回合号顶上
    if (!Number.isFinite(row.turns) && plays.turns) row.turns = plays.turns;
  }
  // 能量浪费（估算）：回合开始能量 - 这回合出牌费用
  const ew = hr ? energyWaste(hr) : null;
  if (ew) { row.energyWaste = Math.round(ew.waste * 10) / 10; row.energyWastePerTurn = Math.round(ew.perTurn * 100) / 100; }
  // 出牌顺序也留下来（最好/最差那两局要给人看牌序）
  if (hr) { try { row.order = playOrder(hr); } catch { } }
  // 药水用量只有 quality 里给（打了 / 用了几个）
  const qualityObj = (hr && hr.comparisonQuality) || (r && r.comparisonQuality);
  const potVal = pick(qualityObj, 'ProjectedBattlePotionCount');
  if (Number.isFinite(potVal)) row.potionsUsed = potVal;
  if (job.cancelled) row.status = 'cancelled';
  // 明细删掉，省磁盘（KEEP_RUNS=1 时保留，便于排查）
  if (!process.env.KEEP_RUNS) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
  return row;
}

/* 单跑：每局 spawn 一个 harness 进程（老路径，出问题时的退路；STS2_HARNESS_SERVE=0 强制走这里）。 */
function runOne(job, variant, seed) {
  return new Promise(resolve => {
    const { dir, reqPath } = prepareRunRequest(job, variant, seed);
    const args = [...HARNESS_PRE, '--request', reqPath, '--label', seed, '--out', dir,
      '--profile', job.profile, '--beam', String(job.beam), '--nodes', String(job.nodes),
      '--potion-policy', job.potionPolicy];
    // 血量两个旋钮：本地补过的 harness 认这两个参数（进战斗后直接改玩家血量），
    // 1.0.3 官方 build 不认，传了会直接退——所以更新 harness 后别换回官方 exe。
    if (variant.hp > 0) args.push('--player-hp', String(variant.hp));
    if (variant.maxHp > 0) args.push('--player-max-hp', String(variant.maxHp));
    const started = Date.now();
    let child;
    let errTail = '';
    try {
      if (!HARNESS_CMD) throw new Error('没有可用的模拟器（harness 不在包里，也没配 STS2_HARNESS）');
      child = spawn(HARNESS_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      if (job.children) job.children.add(child);
    } catch (e) {
      job.lastError = explainHarnessFailure('', null) + ' 内部：' + e.message;
      return resolve({ seed, won: null, hpLost: null, deficit: null, status: 'spawn-error', sec: 0, note: job.lastError });
    }
    // 收集 stderr 末尾，失败时用来解释原因（stdout 只丢，避免管道塞满）
    child.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-8000); });
    child.stdout.on('data', () => { });
    child.on('error', e => {
      job.lastError = explainHarnessFailure('', null) + ' 内部：' + e.message;
      resolve({ seed, won: null, hpLost: null, deficit: null, status: 'spawn-error', sec: 0, note: job.lastError });
    });
    child.on('exit', (code) => {
      if (job.children) job.children.delete(child);
      const sec = Math.round((Date.now() - started) / 100) / 10;
      resolve(buildRunRow(job, variant, seed, dir, sec, errTail, code));
    });
  });
}

/* ---------- 常驻 worker（2026-11-28） ----------
   harness 加了 --serve：进程起一次，按行收请求 JSON（request / out / label / hp / maxHp），
   每局回一行 @@DONE。省掉每局约 2 秒的 exe 启动 + 游戏静态初始化。
   本机实测：同一根请求冷启动单跑 3.9 秒 → 常驻第二局起 0.7~1.5 秒，胜/战损/回合/展开节点逐项一致。
   一个 JS 并发槽挂一个常驻进程；进程挂了这一局补一次单跑，下一局重新起进程。
   出问题可以 STS2_HARNESS_SERVE=0 整体退回按局 spawn 的老路径。 */
const SERVE_ENABLED = process.env.STS2_HARNESS_SERVE !== '0';
const SERVE_RECYCLE_RUNS = Math.max(20, Number(process.env.STS2_SERVE_RECYCLE) || 150);
const SERVE_RUN_TIMEOUT_MS = Math.max(60000, Number(process.env.STS2_SERVE_TIMEOUT_MS) || 15 * 60 * 1000);

function serveArgs(job) {
  return [...HARNESS_PRE, '--serve',
    '--profile', job.profile, '--beam', String(job.beam), '--nodes', String(job.nodes),
    '--potion-policy', job.potionPolicy, '--workspace', job.dir];
}

function startServeWorker(job) {
  const child = spawn(HARNESS_CMD, serveArgs(job), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const w = { child, buf: '', tail: '', ready: false, dead: false, seq: 0, pending: null };
  if (job.children) job.children.add(child);
  child.stdout.on('data', d => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl).replace(/\r$/, '');
      w.buf = w.buf.slice(nl + 1);
      if (line.startsWith('@@READY')) { w.ready = true; continue; }
      if (!line.startsWith('@@DONE ')) continue;   // 每局的步骤表之类的普通输出直接忽略
      let msg = null;
      try { msg = JSON.parse(line.slice(7)); } catch { continue; }
      const p = w.pending;
      if (!p || msg.id !== p.id) continue;
      w.pending = null;
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  child.stderr.on('data', d => { w.tail = (w.tail + d.toString()).slice(-8000); });
  const killPending = (why) => {
    w.dead = true;
    if (job.children) job.children.delete(child);
    const p = w.pending;
    if (p) { w.pending = null; clearTimeout(p.timer); p.reject(new Error(why)); }
  };
  child.on('exit', code => killPending('worker 退出（' + code + '）'));
  child.on('error', e => killPending('worker 起不来：' + ((e && e.message) || e)));
  w.send = (payload) => new Promise((resolve, reject) => {
    if (w.dead) return reject(new Error('worker 已退出'));
    const id = 'w' + (++w.seq);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { }
      const p = w.pending;
      if (p && p.id === id) { w.pending = null; p.reject(new Error('这一局超过 ' + Math.round(SERVE_RUN_TIMEOUT_MS / 60000) + ' 分钟没回')); }
    }, SERVE_RUN_TIMEOUT_MS);
    w.pending = { id, resolve, reject, timer };
    try { child.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
    catch (e) { w.pending = null; clearTimeout(timer); reject(e); }
  });
  return w;
}

function closeServeWorker(slot) {
  const w = slot && slot.worker;
  if (!w) return;
  slot.worker = null;
  slot.runs = 0;
  try { w.child.stdin.write('{"cmd":"quit"}\n'); } catch { }
  setTimeout(() => { try { w.child.kill(); } catch { } }, 800);
}

async function runOneServe(job, slot, variant, seed) {
  const { dir, reqPath } = prepareRunRequest(job, variant, seed);
  if (!slot.worker || slot.worker.dead) slot.worker = startServeWorker(job);
  const started = Date.now();
  try {
    const msg = await slot.worker.send({
      request: reqPath, out: dir, label: String(seed),
      hp: variant.hp > 0 ? variant.hp : 0, maxHp: variant.maxHp > 0 ? variant.maxHp : 0,
    });
    const sec = Math.round((Date.now() - started) / 100) / 10;
    const tail = slot.worker ? slot.worker.tail : '';
    if (!msg.ok) job.lastError = explainHarnessFailure(tail, 1) + ' 内部：' + (msg.error || '');
    slot.fallbackOnce = false;
    slot.runs = (slot.runs || 0) + 1;
    if (slot.runs >= SERVE_RECYCLE_RUNS) closeServeWorker(slot);   // 长任务定期换新进程，别让内存慢慢涨
    return buildRunRow(job, variant, seed, dir, sec, tail, msg.ok ? 0 : 1);
  } catch (e) {
    const sec = Math.round((Date.now() - started) / 100) / 10;
    try { closeServeWorker(slot); } catch { }
    if (job.cancelled) return { seed, won: null, hpLost: null, deficit: null, status: 'cancelled', sec };
    // 常驻这条路坏了：这一局改用单跑补上（同一个槽只补一次，免得每局都多花一次启动）
    if (!slot.fallbackOnce) {
      slot.fallbackOnce = true;
      job.lastError = explainHarnessFailure('', 1) + ' 常驻 worker 出问题，改用单跑：' + ((e && e.message) || e);
      return runOne(job, variant, seed);
    }
    job.lastError = explainHarnessFailure('', 1) + ' 常驻 worker 出问题：' + ((e && e.message) || e);
    return { seed, won: null, hpLost: null, deficit: null, status: 'spawn-error', sec, note: job.lastError };
  }
}

function summarizeVariant(v) {
  const rows = v.results;
  const wins = rows.filter(r => r.won === true).length;
  const valid = rows.filter(r => r.hpLost !== null && r.hpLost !== undefined);
  const byCard = Object.create(null);
  let totalDmg = 0;
  for (const r of rows) {
    if (!r.attr) continue;
    for (const [k, d] of Object.entries(r.attr)) byCard[k] = (byCard[k] || 0) + d;
  }
  for (const d of Object.values(byCard)) totalDmg += d;
  const attr = Object.entries(byCard)
    .map(([cardId, damage]) => ({ cardId, damage: Math.round(damage * 10) / 10, share: totalDmg ? damage / totalDmg : 0 }))
    .sort((a, b) => b.damage - a.damage);
  // ---- 打出次数：每张牌在全部样本里一共打了几次、平均每局几次 ----
  const playByCard = Object.create(null);
  let playsTotal = 0;
  let runsWithPlays = 0;
  for (const r of rows) {
    if (!r.plays) continue;
    runsWithPlays++;
    for (const [k, n] of Object.entries(r.plays)) playByCard[k] = (playByCard[k] || 0) + n;
    playsTotal += r.playsTotal || 0;
  }
  const playList = Object.entries(playByCard)
    .map(([cardId, total]) => ({ cardId, total, avg: runsWithPlays ? total / runsWithPlays : 0 }))
    .sort((a, b) => b.total - a.total);
  // 每次打出值多少伤害（伤害归因 ÷ 打出次数）——判断一张牌是不是「空转」
  const dmgOf = Object.create(null);
  for (const a of attr) dmgOf[a.cardId] = a.damage;
  for (const p of playList) {
    const d = dmgOf[p.cardId];
    p.damage = d == null ? null : Math.round(d * 10) / 10;
    p.perPlay = (d != null && p.total) ? Math.round(d / p.total * 10) / 10 : null;
  }
  const attrTotal = Object.values(dmgOf).reduce((s, d) => s + d, 0);
  // ---- 能量浪费（估算，只看有记录的局）----
  const eRows = rows.filter(r => Number.isFinite(r.energyWaste));
  const energyWaste = eRows.length ? Math.round(eRows.reduce((s, r) => s + r.energyWaste, 0) / eRows.length * 10) / 10 : null;
  const energyWastePerTurn = eRows.length
    ? Math.round(eRows.reduce((s, r) => s + (r.energyWastePerTurn || 0), 0) / eRows.length * 100) / 100 : null;
  // ---- 结束回合分布：几回合打完的有几局 ----
  const hist = Object.create(null);
  for (const r of rows) {
    if (!Number.isFinite(r.turns)) continue;
    hist[r.turns] = (hist[r.turns] || 0) + 1;
  }
  const turnsHist = Object.keys(hist).map(Number).sort((a, b) => a - b)
    .map(turns => ({ turns, runs: hist[turns] }));
  // ---- 胜率的 95% 置信区间（Wilson）----
  const nRuns = rows.length;
  const p = nRuns ? wins / nRuns : 0;
  const z = 1.96;
  const denom = 1 + z * z / Math.max(1, nRuns);
  const center = nRuns ? (p + z * z / (2 * nRuns)) / denom : 0;
  const half = nRuns ? (z * Math.sqrt(p * (1 - p) / nRuns + z * z / (4 * nRuns * nRuns)) / denom) : 0;
  const winrateCI = { lo: Math.max(0, center - half), hi: Math.min(1, center + half), half };
  // ---- 每回合伤害：把每局「第 N 回合造成多少伤害」按回合号加起来再除以局数 ----
  const turnDmg = Object.create(null);
  let runsWithTurns = 0;
  for (const r of rows) {
    if (!r.perTurn || !r.perTurn.length) continue;
    runsWithTurns++;
    for (const t of r.perTurn) turnDmg[t.turn] = (turnDmg[t.turn] || 0) + (t.damage || 0);
  }
  const damageByTurn = Object.keys(turnDmg).map(Number).sort((a, b) => a - b)
    .map(turn => ({ turn, damage: Math.round((turnDmg[turn] / Math.max(1, runsWithTurns)) * 10) / 10 }));
  // ---- 药水用量、失败时差多少血 ----
  const potionRuns = rows.filter(r => Number.isFinite(r.potionsUsed));
  const avgPotionsUsed = potionRuns.length ? potionRuns.reduce((s, r) => s + r.potionsUsed, 0) / potionRuns.length : null;
  const lossRows = valid.filter(r => r.won === false);
  const avgDeficit = lossRows.length ? lossRows.reduce((s, r) => s + (Number.isFinite(r.deficit) ? r.deficit : 0), 0) / lossRows.length : null;
  // 战损中位数（比平均抗极端值）
  const lossValues = valid.map(r => r.hpLost).sort((a, b) => a - b);
  const medianHpLost = lossValues.length
    ? (lossValues.length % 2 ? lossValues[(lossValues.length - 1) / 2]
      : (lossValues[lossValues.length / 2 - 1] + lossValues[lossValues.length / 2]) / 2)
    : null;
  const avgTurns = rows.filter(r => r.turns).length
    ? rows.filter(r => r.turns).reduce((s, r) => s + r.turns, 0) / rows.filter(r => r.turns).length : null;
  // ---- 战损分布：按整数掉血分桶，柱子太多就两两并 ----
  const hpCount = Object.create(null);
  for (const r of valid) {
    const v0 = Math.max(0, Math.round(r.hpLost));
    hpCount[v0] = (hpCount[v0] || 0) + 1;
  }
  let hpHist = Object.keys(hpCount).map(Number).sort((a, b) => a - b)
    .map(v0 => ({ from: v0, to: v0, runs: hpCount[v0] }));
  if (hpHist.length > 14) {
    const step = Math.ceil(hpHist.length / 14);
    const merged = [];
    for (let i = 0; i < hpHist.length; i += step) {
      const slice = hpHist.slice(i, i + step);
      merged.push({ from: slice[0].from, to: slice[slice.length - 1].to, runs: slice.reduce((s, x) => s + x.runs, 0) });
    }
    hpHist = merged;
  }
  // ---- 最好的一局 / 最差的一局：带上那一局的出牌顺序 ----
  const pickRun = row => (row ? {
    seed: row.seed, hpLost: row.hpLost, turns: row.turns, won: row.won, deficit: row.deficit,
    enemyHp: row.enemyHp, sec: row.sec, order: Array.isArray(row.order) ? row.order : null,
  } : null);
  const bestRow = valid.slice().sort((a, b) => (a.hpLost - b.hpLost) || ((b.won === true) - (a.won === true)))[0] || null;
  const worstRow = valid.slice().sort((a, b) => (b.hpLost - a.hpLost) || ((a.won === true) - (b.won === true)))[0] || null;
  v.summary = {
    runs: rows.length, wins, losses: rows.length - wins,
    winrate: rows.length ? wins / rows.length : 0,
    avgHpLost: valid.length ? valid.reduce((s, r) => s + r.hpLost, 0) / valid.length : null,
    minHpLost: valid.length ? Math.min(...valid.map(r => r.hpLost)) : null,
    maxHpLost: valid.length ? Math.max(...valid.map(r => r.hpLost)) : null,
    avgTurns: avgTurns == null ? null : Math.round(avgTurns * 10) / 10,
    damageTotal: Math.round(totalDmg),
    attribution: attr,
    // —— 2026-11-27 新加的几项「分析」 ——
    plays: playList,
    playsTotal: playsTotal,
    playsPerRun: runsWithPlays ? Math.round((playsTotal / runsWithPlays) * 10) / 10 : null,
    playsPerTurn: (runsWithPlays && avgTurns) ? Math.round((playsTotal / runsWithPlays / avgTurns) * 10) / 10 : null,
    damageByTurn,
    dmgPerTurn: (avgTurns && totalDmg) ? Math.round((totalDmg / rows.length / avgTurns) * 10) / 10 : null,
    avgPotionsUsed: avgPotionsUsed == null ? null : Math.round(avgPotionsUsed * 10) / 10,
    avgDeficit: avgDeficit == null ? null : Math.round(avgDeficit * 10) / 10,
    medianHpLost: medianHpLost == null ? null : Math.round(medianHpLost * 10) / 10,
    // —— 2026-11-27 12:1x 又加的：能量浪费、回合分布、胜率置信区间、每张牌每次打出的伤害 ——
    energyWaste,
    energyWastePerTurn,
    turnsHist,
    winrateCI,
    attrTotal: Math.round(attrTotal * 10) / 10,
    // —— 2026-11-28 他要求：战损分布 + 最好/最差那一局的牌序 ——
    hpHist,
    bestRun: pickRun(bestRow),
    worstRun: pickRun(worstRow),
  };
  return v.summary;
}

/* ---------- 断点续接的落盘（2026-11-27 22:2x 他要求：进程中止别白跑几个小时） ----------
   两个文件：runs/<id>/job.json 存任务配置；runs/<id>/results.jsonl 每跑完一个样本追加一行（紧凑行，
   不含 planActions，1000 个样本也就几百 KB~几 MB）。服务被杀/重启后靠这两样重建任务接着跑。 */
function jobConfig(job) {
  return {
    id: job.id, mode: job.mode, seeds: job.seeds, meta: job.meta || null,
    relics: job.relics || [], relicProps: job.relicProps || {}, potions: job.potions || [],
    encounter: job.encounter, character: job.character, ascension: job.ascension,
    gameMode: job.gameMode || 'Standard', dreadBoss: job.dreadBoss || '',
    profile: job.profile, beam: job.beam, nodes: job.nodes, concurrency: job.concurrency,
    potionPolicy: job.potionPolicy, budget: job.budget, actIndex: job.actIndex || 0,
    createdAt: job.startedAt || Date.now(),
    label: job.label || null,
    variants: (job.variants || []).map(v => ({ key: v.key, label: v.label, deck: v.deck, card: v.card || null, hp: v.hp, maxHp: v.maxHp })),
  };
}
function saveJobConfig(job) {
  try { fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(jobConfig(job), null, 1), 'utf8'); } catch { }
}
function appendResultRow(job, vKey, seed, row) {
  try { fs.appendFileSync(path.join(job.dir, 'results.jsonl'), JSON.stringify({ v: vKey, seed, row }) + '\n', 'utf8'); } catch { }
}
function readResultRows(jobDir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(jobDir, 'results.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o.row && o.v) out.push(o); } catch { }
  }
  return out;
}
function writeSummary(job) {
  try { fs.writeFileSync(path.join(job.dir, 'summary.json'), JSON.stringify({ job: publicJob(job) }, null, 1), 'utf8'); } catch { }
}

async function runVariants(job) {
  /* 2026-11-27 22:2x 他要求「断点续接」：中断过的任务再跑，只补没跑过的种子，不从头来。
     已经算完的样本在 v.results 里（进程重启后由 results.jsonl 读回来）。 */
  const tasks = [];
  for (const v of job.variants) {
    const have = new Set((v.results || []).map(r => String(r.seed)));
    for (const s of job.seeds) if (!have.has(String(s))) tasks.push({ v, s });
  }
  job.total = job.variants.length * job.seeds.length;
  job.done = job.variants.reduce((n, v) => n + (v.results ? v.results.length : 0), 0);
  if (!tasks.length) {
    // 什么都没剩下：直接按已完成收尾（续接时补完最后几个样本会走到这里）
    job.finishedAt = Date.now();
    job.status = 'done';
    finishSummaries(job);
    writeSummary(job);
    recordToDb(job);
    return;
  }
  const workers = Math.max(1, Math.min(job.concurrency, tasks.length));
  let idx = 0;
  /* 「代」标记：终止或续接都给 job.gen 加一，上一轮还在 await 的 worker 循环发现代变了就退场，
     不会因为 job.cancelled 被续接清成 false 又接着领任务（那样会把样本算两遍）。 */
  const gen = job.gen || 0;
  const stale = () => (job.gen || 0) !== gen || job.cancelled;
  job.startedAt = job.startedAt || Date.now();
  // 常驻模式：每个并发槽挂一个常驻 harness 进程（见 runOneServe）；出问题用 STS2_HARNESS_SERVE=0 退回按局 spawn
  const slots = (SERVE_ENABLED && HARNESS_CMD) ? Array.from({ length: workers }, () => ({ worker: null, runs: 0 })) : null;
  let slotSeq = 0;
  async function worker() {
    const slot = slots ? slots[slotSeq++] : null;
    try {
      while (true) {
        if (stale()) return;
        const i = idx++;
        if (i >= tasks.length) return;
        const t = tasks[i];
        const row = slot ? await runOneServe(job, slot, t.v, t.s) : await runOne(job, t.v, t.s);
        if ((job.gen || 0) !== gen) return;
        if (job.cancelled && row.status === 'cancelled') return;
        t.v.results.push(row);
        appendResultRow(job, t.v.key, t.s, row);
        job.done = (job.done || 0) + 1;
      }
    } finally {
      if (slot) closeServeWorker(slot);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  if ((job.gen || 0) !== gen) return;   // 这轮已经被新的续接顶替，别再改状态、别再写库
  job.finishedAt = Date.now();
  if (job.cancelled) {
    job.status = 'cancelled';
    job.elapsedSec = Math.round((job.finishedAt - job.startedAt) / 100) / 10;
    try { for (const v of job.variants) if (v.results.length) summarizeVariant(v); } catch { }
    // 终止也要留下能看的数据：部分样本的汇总写成 summary.json（他说的「终止也可出数据」）
    writeSummary(job);
    recordToDb(job);
    return;
  }
  job.status = 'done';
  finishSummaries(job);
  job.elapsedSec = Math.round((job.finishedAt - job.startedAt) / 100) / 10;
  writeSummary(job);
  recordToDb(job);
}

/* 每个变体算汇总 + 相对基线的差值（done 和 cancelled 两条路都用） */
function finishSummaries(job) {
  for (const v of job.variants) if ((v.results || []).length) summarizeVariant(v);
  const base = job.variants[0].summary;
  for (const v of job.variants) {
    if (!v.summary) continue;
    v.summary.deltaWinratePp = base ? (v.summary.winrate - base.winrate) * 100 : null;
    v.summary.deltaHpLost = (base && v.summary.avgHpLost != null && base.avgHpLost != null) ? v.summary.avgHpLost - base.avgHpLost : null;
    v.summary.relWinrate = base && base.winrate > 0 ? (v.summary.winrate - base.winrate) / base.winrate : null;
  }
}

function publicVariant(v) {
  return {
    key: v.key, label: v.label, hp: v.hp, maxHp: v.maxHp,
    deck: v.deck, card: v.card || null,
    results: v.results, summary: v.summary || null,
  };
}

/* ---------- 单卡战损预估：把一组怪跑完，出一张数据图和一份能直接打开的 HTML ---------- */
const EST_DIR = path.join(RUNS, 'estimates');
fs.mkdirSync(EST_DIR, { recursive: true });

const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ATTR_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#95a5a6', '#34495e', '#d35400'];
const cardLabel = (id, names) => (id === '__other__' ? '其他来源' : ((names && names[id]) || id));

/* 环形饼图：伤害归因（跟「单场测算」里那张一样的画法） */
function pieSvg(items, size) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const R = size / 2, r = R * 0.56, cx = R, cy = R;
  const open = `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
  if (!total) return `${open}<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="#2a2f3a" stroke-width="${R - r}"/></svg>`;
  if (items.length === 1) return `${open}<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${ATTR_COLORS[0]}" stroke-width="${R - r}"/></svg>`;
  let a0 = -Math.PI / 2;
  const paths = items.map((it, i) => {
    const frac = it.value / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const pt = (a, rr) => [(cx + Math.cos(a) * rr).toFixed(2), (cy + Math.sin(a) * rr).toFixed(2)];
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r);
    const dd = `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
    a0 = a1;
    return `<path d="${dd}" fill="${ATTR_COLORS[i % ATTR_COLORS.length]}"><title>${escHtml(it.label)} ${Math.round(it.value)}</title></path>`;
  }).join('');
  return `${open}${paths}</svg>`;
}

function attrBlockHtml(attr, title, opts) {
  const o = opts || {};
  const list = (attr || []).filter(a => a && a.cardId && Number(a.damage) >= 1).slice(0, o.max || 9);
  if (!list.length) return '';
  const pie = pieSvg(list.map(a => ({ label: cardLabel(a.cardId, o.names), value: Number(a.damage) })), o.size || 132);
  const legend = `<div class="legend">${list.map((a, i) => `<div class="lg"><i style="background:${ATTR_COLORS[i % ATTR_COLORS.length]}"></i><span>${escHtml(cardLabel(a.cardId, o.names))}</span><b>${Math.round(Number(a.damage))}</b><span class="muted">${((Number(a.share) || 0) * 100).toFixed(0)}%</span></div>`).join('')}</div>`;
  return `<div class="attr-card">
    <div class="attr-title">${escHtml(title)}</div>
    <div class="attr-body">${pie}${legend}</div>
  </div>`;
}

function estimateHtml(d) {
  const when = new Date().toLocaleString('zh-CN');
  const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const src = (Array.isArray(d.blocks) && d.blocks.length) ? d.blocks : [{ key: 'base', title: '默认卡组', rows: d.rows || [] }];
  const blocks = src.map((b, i) => ({
    key: String((b && b.key) || ('b' + i)),
    title: (b && b.title) || (i ? '候选卡' : '默认卡组'),
    note: (b && b.note) || '',
    cardId: (b && b.cardId) || null,
    rows: ((b && b.rows) || []).filter(r => r && r.name),
  })).filter(b => b.rows.length);
  if (!blocks.length) blocks.push({ key: 'base', title: '默认卡组', note: '', rows: [] });
  const names = d.cardNames || {};
  const cardNameOf = id => (names && names[id]) || id;
  // 战损分布：每局掉多少血（2026-11-28 他要的）
  const histHtml = (hist, runsTotal) => {
    if (!Array.isArray(hist) || !hist.length) return '';
    const total = runsTotal || hist.reduce((s, x) => s + (Number(x.runs) || 0), 0) || 1;
    const max = Math.max(...hist.map(x => Number(x.runs) || 0), 1);
    const rows = hist.map(x => {
      const n = Number(x.runs) || 0;
      const label = x.from === x.to ? String(x.from) : x.from + '–' + x.to;
      const w = Math.max(1.5, n / max * 100);
      return '<div class="drow"><span class="dlab">' + escHtml(label) + ' 血</span><span class="dtrack"><i style="width:' + w.toFixed(1) + '%"></i></span><b class="dnum">' + n + '</b><span class="dpct">' + (n / total * 100).toFixed(0) + '%</span></div>';
    }).join('');
    return '<div class="dist"><div class="sect-h">战损分布（每局掉多少血 · 共 ' + total + ' 局）</div>' + rows + '</div>';
  };
  // 某一局的出牌情况：按回合列出打出的牌
  const runHtml = (title, run, cls) => {
    if (!run) return '';
    const order = Array.isArray(run.order) ? run.order : [];
    const turns = order.map((cards, i) => {
      const list = (cards || []).map(c => '<span class="pc">' + escHtml(cardNameOf(c)) + '</span>').join(' → ');
      return '<div class="turn"><span class="tno">第 ' + (i + 1) + ' 回合</span><span class="tcards">' + (list || '<span class="muted">（这回合没打牌）</span>') + '</span></div>';
    }).join('');
    const hp = run.hpLost == null ? '—' : (Number.isInteger(run.hpLost) ? String(run.hpLost) : Number(run.hpLost).toFixed(1));
    const tail = (run.turns != null ? ' · ' + run.turns + ' 回合' : '') + ' · ' + (run.won ? '赢' : '输')
      + (run.deficit != null && !run.won ? ' · 差 ' + run.deficit + ' 血' : '');
    return '<div class="runblk ' + cls + '">'
      + '<div class="run-h">' + escHtml(title) + '<span class="muted">种子 ' + (escHtml(run.seed) || '—') + ' · 掉 ' + hp + ' 血' + tail + '</span></div>'
      + '<div class="run-body">' + (turns || '<div class="muted">这局没记下出牌顺序（老任务没有这项）</div>') + '</div>'
      + '</div>';
  };

  const baseWr = new Map();
  for (const r of blocks[0].rows) baseWr.set(r.enc || r.name, num(r.winrate) || 0);

  const panels = blocks.map((b, bi) => {
    const rows = b.rows;
    const sorted = rows.slice().sort((a, c) => (num(c.avgHpLost) || 0) - (num(a.avgHpLost) || 0));
    const losses = rows.map(r => num(r.avgHpLost) || 0);
    const maxLoss = Math.max(1, ...losses);
    const avgLoss = losses.length ? losses.reduce((a, c) => a + c, 0) / losses.length : 0;
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    const avgWr = rows.length ? rows.reduce((a, c) => a + (num(c.winrate) || 0), 0) / rows.length : 0;
    const isBase = bi === 0;
    const isCard = !isBase && b.key.indexOf('card:') === 0;
    const cols = isCard ? 6 : 5;

    // 整块的伤害归因：每只怪的归因加起来
    const sum = Object.create(null);
    let total = 0;
    for (const r of rows) for (const a of (r.attribution || [])) { if (!a || !a.cardId) continue; sum[a.cardId] = (sum[a.cardId] || 0) + (num(a.damage) || 0); }
    for (const v of Object.values(sum)) total += v;
    const attrAll = Object.entries(sum)
      .map(([cardId, damage]) => ({ cardId, damage, share: total ? damage / total : 0 }))
      .sort((a, c) => c.damage - a.damage);

    const bars = sorted.map(r => {
      const v = num(r.avgHpLost) || 0;
      const wr = num(r.winrate) || 0;
      const pct = Math.max(1.5, (v / maxLoss) * 100);
      const color = wr >= 0.99 ? '#3fa96a' : wr >= 0.7 ? '#c8a13a' : wr > 0 ? '#d1823a' : '#c65a5a';
      const lostTag = wr < 0.999 ? ' <span class="lost">打不过</span>' : '';
      return `<div class="brow"><span class="bname" title="${escHtml(r.name)}">${escHtml(r.name)}${lostTag}</span>
      <span class="btrack"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></span>
      <b class="bval">${v.toFixed(1)}</b>
      <b class="bwr" style="color:${wr >= 0.999 ? '#7fd6a0' : wr > 0 ? '#e0b070' : '#d76a6a'}">${(wr * 100).toFixed(0)}%</b></div>`;
    }).join('');

    const trs = sorted.map(r => {
      const wr = num(r.winrate) || 0;
      const lost = wr < 0.999;
      const lo = num(r.minHpLost), hi = num(r.maxHpLost);
      const range = (lo == null || hi == null) ? '' : (lo === hi ? String(lo) : `${lo}–${hi}`);
      const lossTxt = num(r.avgHpLost) == null ? '—' : Number(r.avgHpLost).toFixed(1);
      const baseOf = r.baseWinrate != null ? num(r.baseWinrate) : (isCard ? (baseWr.has(r.enc || r.name) ? baseWr.get(r.enc || r.name) : null) : null);
      const playsTxt = isCard
        ? (r.cardPlays == null ? '—' : Number(r.cardPlays).toFixed(1))
        : (r.playsPerRun == null ? '—' : Number(r.playsPerRun).toFixed(1));
      const attr = (r.attribution || []).filter(a => a && a.cardId && num(a.damage) >= 1);
      const detail = `<tr class="mdetail"><td colspan="${cols}"><div class="dd">
        <div class="dd-stats">
          <span>胜率 <b>${(wr * 100).toFixed(0)}%</b>${r.runs != null ? `<span class="muted"> · ${r.runs} 局</span>` : ''}</span>
          <span>战损 <b>${lossTxt}</b>${range ? `<span class="muted">（${escHtml(range)}）</span>` : ''}${r.medianHpLost != null ? `<span class="muted"> · 中位数 ${Number(r.medianHpLost).toFixed(1)}</span>` : ''}</span>
          <span>回合 <b>${r.avgTurns == null ? '—' : escHtml(r.avgTurns)}</b></span>
          <span>${isCard ? '这张牌每局' : '每局打出'} <b>${playsTxt}</b></span>
        </div>
        ${histHtml(r.hpHist, r.runs)}
        ${runHtml('最好的一局（掉血最少）', r.best, 'best')}
        ${runHtml('最差的一局（掉血最多）', r.worst, 'worst')}
        ${attr.length ? attrBlockHtml(attr, '这只怪的伤害归因（打出的伤害各来自哪张牌）', { size: 116, max: 8, names }) : '<div class="muted">这只怪没记下伤害归因</div>'}
      </div></td></tr>`;
      return `<tr class="mrow"><td><span class="caret">▸</span>${escHtml(r.name)}${lost ? ' <span class="lost">打不过</span>' : ''}</td>
      <td class="num">${lossTxt}<span class="muted">${range ? '（' + escHtml(range) + '）' : ''}</span></td>
      <td class="num" style="color:${wr >= 0.999 ? '#7fd6a0' : wr > 0 ? '#e0b070' : '#d76a6a'}">${(wr * 100).toFixed(0)}%</td>
      ${isCard ? `<td class="num muted">${baseOf == null ? '—' : (baseOf * 100).toFixed(0) + '%'}</td>` : ''}
      <td class="num">${r.avgTurns == null ? '—' : escHtml(r.avgTurns)}</td>
      <td class="num">${playsTxt}</td></tr>${detail}`;
    }).join('');

    return `<section class="panel${bi === 0 ? ' show' : ''}" data-k="${escHtml(b.key)}">
  <div class="panel-head">${escHtml(b.title)}${b.note ? ` <span class="muted">· ${escHtml(b.note)}</span>` : ''}</div>
  <div class="cards">
    <div class="card"><span>平均战损</span><b>${avgLoss.toFixed(1)}</b></div>
    <div class="card"><span>最狠的一只</span><b class="sm">${escHtml(worst ? worst.name : '—')}</b><span>${worst ? (num(worst.avgHpLost) || 0).toFixed(1) : ''}</span></div>
    <div class="card"><span>最轻的一只</span><b class="sm">${escHtml(best ? best.name : '—')}</b><span>${best ? (num(best.avgHpLost) || 0).toFixed(1) : ''}</span></div>
    <div class="card"><span>平均胜率</span><b>${(avgWr * 100).toFixed(0)}%</b></div>
    <div class="card"><span>怪物数</span><b>${rows.length}</b></div>
  </div>
  <div class="bars">
    <div class="bar-head"><span>怪物</span><span></span><span class="num">平均战损</span><span class="num">胜率</span></div>
    ${bars}
  </div>
  ${attrAll.length ? attrBlockHtml(attrAll, '伤害归因 · 这一块所有怪物合计（横条＝战损，饼图＝伤害来自哪张牌）', { size: 150, max: 9, names }) : ''}
  <table><thead><tr><th>怪物</th><th class="num">平均战损（区间）</th>
    <th class="num">${isBase ? '胜率' : '胜率（用这张后）'}</th>${isCard ? '<th class="num">基线胜率</th>' : ''}
    <th class="num">回合</th><th class="num">${isCard ? '这张牌每局' : '每局打出'}</th></tr></thead>
  <tbody>${trs}</tbody></table>
  <div class="foot">点任意一行展开：这只怪自己的战损、回合、以及它的伤害归因饼图。</div>
</section>`;
  }).join('');

  const tabs = blocks.length > 1
    ? `<div class="tabs">${blocks.map((b, i) => `<button class="tab${i === 0 ? ' active' : ''}" data-k="${escHtml(b.key)}">${escHtml(b.title)}</button>`).join('')}</div>`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escHtml(d.title || '单卡战损预估')}</title>
<style>
 body{margin:0;padding:26px 32px 48px;background:#14171d;color:#e6edf7;font:14px/1.6 "Microsoft YaHei",system-ui,-apple-system,sans-serif}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#93a1b5;font-size:12.5px;margin-bottom:16px}
 .tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
 .tab{padding:7px 16px;border:1px solid #2a3140;border-radius:8px;background:#1a1f27;color:#a8b6ca;cursor:pointer;font-size:13.5px;font-family:inherit}
 .tab:hover{background:#222835;color:#e6edf7}
 .tab.active{background:#2b5fa8;border-color:#3b82f6;color:#fff}
 .panel{display:none} .panel.show{display:block}
 .panel-head{color:#9fb0c6;font-size:12.5px;margin:0 0 10px}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 20px}
 .card{background:#1d222b;border:1px solid #2a3140;border-radius:10px;padding:10px 16px;min-width:150px}
 .card span{color:#8d9bb0;font-size:12px}
 .card b{display:block;font-size:20px;margin-top:2px}
 .card b.sm{font-size:15px;line-height:1.55}
 .bars{margin:0 0 20px}
 .bar-head,.brow{display:grid;grid-template-columns:240px 1fr 70px 70px;align-items:center;gap:10px}
 .bar-head{color:#96a4b8;font-size:12px;padding:0 0 6px}
 .brow{padding:3px 0}
 .bname{color:#cfd8e8;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .btrack{background:#1b2029;border-radius:5px;height:18px;overflow:hidden}
 .btrack i{display:block;height:100%;border-radius:5px;opacity:.9}
 .bval,.bwr{font-size:12.5px;font-weight:400;font-variant-numeric:tabular-nums;text-align:right}
 .dist{margin:10px 0 14px}
 .sect-h{color:#9fb0c6;font-size:12.5px;margin:0 0 6px}
 .drow{display:grid;grid-template-columns:72px 1fr 56px 48px;align-items:center;gap:8px;padding:2px 0}
 .dlab{color:#b9c5d6;font-size:12.5px;font-variant-numeric:tabular-nums}
 .dtrack{background:#1b2029;border-radius:4px;height:14px;overflow:hidden}
 .dtrack i{display:block;height:100%;background:#4a86d8;border-radius:4px;opacity:.9}
 .dnum,.dpct{font-size:12px;color:#cfd8e8;text-align:right;font-variant-numeric:tabular-nums}
 .runblk{border:1px solid #2a3140;border-radius:8px;padding:8px 12px;margin:8px 0;background:#1a1f27}
 .runblk.best{border-color:#2e6b46}
 .runblk.worst{border-color:#6b3030}
 .run-h{font-size:12.5px;color:#cfd8e8;margin-bottom:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
 .run-body{max-height:230px;overflow:auto}
 .turn{display:grid;grid-template-columns:86px 1fr;gap:8px;padding:1px 0;font-size:12.5px}
 .tno{color:#8d9bb0}
 .tcards{color:#dbe4f2}
 .pc{background:#243043;border-radius:4px;padding:0 5px}
 .attr-card{background:#1d222b;border:1px solid #2a3140;border-radius:10px;padding:12px 16px;margin:0 0 18px;display:inline-block;max-width:100%}
 .attr-title{color:#9fb0c6;font-size:12.5px;margin-bottom:8px}
 .attr-body{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
 .legend{display:flex;flex-direction:column;gap:4px;font-size:12.5px;min-width:190px}
 .lg{display:grid;grid-template-columns:10px 1fr auto auto;gap:8px;align-items:center}
 .lg i{width:10px;height:10px;border-radius:2px}
 .lg b{font-weight:500;font-variant-numeric:tabular-nums}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{border-bottom:1px solid #262d39;padding:7px 8px;text-align:left}
 th{color:#96a4b8;font-weight:500;white-space:nowrap}
 th.num,td.num,.num{text-align:right;font-variant-numeric:tabular-nums}
 tbody tr.mrow{cursor:pointer}
 tbody tr.mrow:hover{background:#1a1f27}
 .caret{display:inline-block;width:14px;color:#7f8ea5;transition:transform .15s}
 tr.mrow.open .caret{transform:rotate(90deg)}
 tr.mdetail{display:none}
 tr.mdetail.show{display:table-row}
 tr.mdetail td{background:#171c24;padding:0;border-bottom:1px solid #262d39}
 .dd{padding:12px 14px}
 .dd-stats{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:#a8b6ca;margin-bottom:10px}
 .muted{color:#77849a;font-size:11.5px}
 .lost{color:#d76a6a;font-size:11px;border:1px solid #6b3a3a;border-radius:4px;padding:0 4px}
 .foot{margin-top:14px;color:#6f7c90;font-size:11.5px;line-height:1.8}
</style></head><body>
<h1>${escHtml(d.title || '单卡战损预估')}</h1>
<div class="sub">${escHtml([d.map, d.kind, d.candidate ? '候选卡：' + d.candidate : '', (d.count || 1) + ' 场/只', when].filter(Boolean).join(' · '))}</div>
${tabs}
${panels}
<div class="foot">每只怪按上方「样本数」跑 ${d.count || 1} 场；战损＝这些场次平均掉的血，「打不过」是没打过的那只（不算战损）。饼图＝打出的伤害各来自哪张牌。数据由包内 OfflineSearchHarness 现算。</div>
<script>
document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){
  document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
  t.classList.add('active');
  var k=t.getAttribute('data-k');
  document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('show',p.getAttribute('data-k')===k);});
});});
document.querySelectorAll('tr.mrow').forEach(function(tr){tr.addEventListener('click',function(){
  var d=tr.nextElementSibling; if(!d||!d.classList.contains('mdetail')) return;
  var open=d.classList.toggle('show'); tr.classList.toggle('open',open);
});});
</script>
</body></html>`;
}

function saveEstimate(d) {
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  const safe = String(d.title || '单卡战损预估').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
  const name = `${safe}-${stamp}.html`;
  fs.writeFileSync(path.join(EST_DIR, name), estimateHtml(d), 'utf8');
  return { ok: true, name, file: path.join(EST_DIR, name), url: '/api/estimate/' + encodeURIComponent(name) };
}

function publicJob(job) {
  return {
    id: job.id, mode: job.mode, status: job.status, total: job.total, done: job.done,
    seeds: job.seeds, encounter: job.encounter, character: job.character, ascension: job.ascension,
    profile: job.profile, beam: job.beam, nodes: job.nodes, concurrency: job.concurrency,
    potionPolicy: job.potionPolicy, budget: job.budget, relics: job.relics, potions: job.potions,
    label: job.label || null,
    variants: job.variants.map(publicVariant),
    meta: job.meta || null,
    gameMode: job.gameMode || 'Standard',
    dreadBoss: job.dreadBoss || '',
    lastError: job.lastError || null,
    resumable: !!(job.done < job.total),
    elapsedSec: job.finishedAt ? Math.round((job.finishedAt - job.startedAt) / 100) / 10
      : (job.startedAt ? Math.round((Date.now() - job.startedAt) / 100) / 10 : 0),
  };
}

/* ---------- 从游戏存档导入实时状态 ---------- */
const START_RELICS = path.join(ROOT, 'data', 'characters_starting_relics.json');

// Steam 库位置：优先从 runtimeconfig 里的游戏路径反推，再兜几个常见位置
function steamRoots() {
  const roots = [];
  try {
    const rc = readRuntimeConfig();
    const p = rc.json?.runtimeOptions?.configProperties?.Sts2DataDir;
    if (p) {
      // …\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64 → …\steamapps 的父目录
      const m = p.replace(/\\/g, '/').match(/^(.*)\/steamapps\//i);
      if (m) roots.push(m[1]);
    }
  } catch { }
  roots.push('C:/Program Files (x86)/Steam', 'C:/Program Files/Steam', 'D:/Steam', 'E:/Steam', 'D:/SteamLibrary');
  return [...new Set(roots)];
}

function findCurrentSave() {
  const roots = steamRoots();
  const cands = [];
  for (const root of roots) {
    const ud = path.join(root, 'userdata');
    let users;
    try { users = fs.readdirSync(ud); } catch { continue; }
    for (const u of users) {
      for (const rel of [['2868840', 'remote', 'modded'], ['2868840', 'remote']]) {
        const base = path.join(ud, u, ...rel);
        let dirs;
        try { dirs = fs.readdirSync(base); } catch { continue; }
        for (const d of dirs) {
          const s = path.join(base, d, 'saves', 'current_run.save');
          try { const st = fs.statSync(s); cands.push({ path: s, mtime: st.mtimeMs }); } catch { }
        }
      }
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0] || null;
}

function importGameState() {
  const save = findCurrentSave();
  if (!save) throw new Error('找不到 current_run.save：先在游戏里进过房间');
  const j = JSON.parse(fs.readFileSync(save.path, 'utf8'));
  const p = j.players && j.players[0];
  if (!p) throw new Error('存档里没有 players[0]');
  const strip = (s, pre) => (s && String(s).toUpperCase().startsWith(pre) ? String(s).slice(pre.length) : s);
  const norm = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let starts = {};
  // 老路径 data/characters_starting_relics.json 早就不存在了，结果「自带遗物」被当成普通遗物导进界面；
  // 以 assets/starting_relics.json（前端也用这份）为准，data 那份有就优先。
  for (const f of [path.join(ROOT, 'data', 'characters_starting_relics.json'), START_RELICS]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      starts = (parsed && parsed.characters) || parsed || {};
      break;
    } catch { }
  }
  const character = strip(p.character_id, 'CHARACTER.');
  const startRelic = Object.entries(starts).find(([k]) => norm(k) === norm(character));
  const skip = new Set(startRelic ? [norm(startRelic[1])] : []);
  const skipped = [];
  const relics = [];
  // 计数遗物的实际数字（钢笔尖 AttacksPlayed、各种计数器）存在 props 里，界面要显示、可改，
  // 所以和遗物 id 一起带出去；key 是遗物 id。
  const relicProps = {};
  for (const r of p.relics || []) {
    const id = strip(r.id, 'RELIC.');
    if (!id) continue;
    const pr = r.props;
    if (pr && ((pr.ints && pr.ints.length) || (pr.bools && pr.bools.length))) {
      relicProps[id] = {
        ints: (pr.ints || []).filter(x => x && x.name).map(x => ({ name: String(x.name), value: Number(x.value) || 0 })),
        bools: (pr.bools || []).filter(x => x && x.name).map(x => ({ name: String(x.name), value: !!x.value })),
      };
    }
    if (skip.has(norm(id))) { skipped.push(id); continue; }
    relics.push(id);
  }
  const deckMap = new Map();
  for (const c of p.deck || []) {
    const id = strip(c.id, 'CARD.');
    if (!id) continue;
    const up = c.current_upgrade_level || 0;
    const encId = c.enchantment && c.enchantment.id ? strip(c.enchantment.id, 'ENCHANTMENT.') : null;
    const encAmt = c.enchantment && c.enchantment.amount ? Number(c.enchantment.amount) : 0;
    const key = id + '|' + up + '|' + (encId || '');
    if (!deckMap.has(key)) {
      const item = { cardId: id, count: 0, upgradeLevels: up };
      if (encId) { item.enchantmentId = encId; item.enchantmentAmount = encAmt; }
      deckMap.set(key, item);
    }
    deckMap.get(key).count++;
  }
  const act = (j.acts || [])[j.current_act_index] || {};
  const encounter = strip(act.rooms && act.rooms.boss_id, 'ENCOUNTER.');
  const potions = (p.potions || []).filter(q => q && q.id).map(q => strip(q.id, 'POTION.'));
  return {
    ok: true, savePath: save.path, savedAt: new Date(save.mtime).toISOString(),
    character, hp: p.current_hp, maxHp: p.max_hp, ascension: j.ascension, actIndex: j.current_act_index,
    encounter, deck: [...deckMap.values()], relics, relicProps, potions, skippedRelics: skipped,
  };
}

/* ---------- 截图导入卡组：Windows OCR + 卡名匹配 ---------- */

let cardNameIndex = null;
function cardNames() {
  if (cardNameIndex) return cardNameIndex;
  const meta = readJson(path.join(ROOT, 'assets', 'meta.json')) || { cards: [] };
  const byName = new Map();
  for (const c of meta.cards || []) {
    const n = String(c.name || '').replace(/[\s\u3000]+/g, '');
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(String(c.id));
  }
  cardNameIndex = byName;
  return byName;
}

const squash = s => String(s || '').replace(/[\s\u3000]+/g, '');

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function pickCardId(ids, character) {
  if (!ids || !ids.length) return null;
  if (ids.length === 1) return ids[0];
  const want = `_${character}`;
  return ids.find(id => id.endsWith(want)) || ids.find(id => id.includes(character)) || ids[0];
}

/** 把一行 OCR 文本里的卡名找出来；找不到返回 null */
function matchCardLine(line, character) {
  const byName = cardNames();
  let s = squash(line).replace(/[+＋]$/, '');
  if (!s) return null;
  if (byName.has(s)) return { cardId: pickCardId(byName.get(s), character), name: s, junk: 0 };
  // 行尾带 +、前面带附魔图标（被 OCR 读成怪字）时，卡名是中间一段：取最长的命中
  let best = null;
  for (const [name, ids] of byName) {
    if (name.length < 2) continue;
    const at = s.indexOf(name);
    if (at < 0) continue;
    const leftover = s.length - name.length;
    if (leftover > 2) continue;             // 剩下太多说明不是这行
    if (!best || name.length > best.name.length) best = { cardId: pickCardId(ids, character), name, junk: leftover };
  }
  if (best) return best;
  // OCR 错一个字时兜底：找长度相当、相似度够高的卡名
  let fuzzy = null;
  for (const [name, ids] of byName) {
    if (Math.abs(name.length - s.length) > 1) continue;
    for (let i = 0; i <= Math.max(0, s.length - name.length); i++) {
      const seg = s.slice(i, i + name.length);
      if (seg.length < 2) continue;
      const d = lev(seg, name);
      const ratio = 1 - d / Math.max(seg.length, name.length);
      if (ratio >= 0.66 && (!fuzzy || ratio > fuzzy.ratio)) fuzzy = { cardId: pickCardId(ids, character), name, ratio };
    }
  }
  return fuzzy;
}

function parseDeckText(text, character) {
  const deck = new Map();      // `${cardId}|${up}` -> count
  const rows = [];
  const unmatched = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let s = squash(line);
    let count = 1;
    const m = /^(\d+)[xX×*]/.exec(s);
    if (m) { count = Math.max(1, Math.min(20, Number(m[1]))); s = s.slice(m[0].length); }
    const up = /[+＋]$/.test(s);
    const hit = matchCardLine(s, character);
    if (!hit) { if (line.length >= 2 && line.length <= 24) unmatched.push(line); continue; }
    const key = `${hit.cardId}|${up ? 1 : 0}`;
    deck.set(key, (deck.get(key) || 0) + count);
    rows.push({ cardId: hit.cardId, name: hit.name, count, upgradeLevels: up ? 1 : 0, raw: line });
  }
  const out = Array.from(deck.entries()).map(([k, count]) => {
    const [cardId, up] = k.split('|');
    return { cardId, count, upgradeLevels: Number(up), upCount: Number(up) ? count : 0 };
  });
  return { deck: out, rows, unmatched, total: out.reduce((s, d) => s + d.count, 0) };
}

function ocrImage(file) {
  const ps = path.join(ROOT, 'data', 'ocr.ps1');
  if (!fs.existsSync(ps)) throw new Error('缺少 data/ocr.ps1');
  const out = file + '.txt';
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Image', file, '-Out', out],
    { encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: 'pipe' });
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch { text = ''; }
  try { fs.unlinkSync(out); } catch { }
  return text;
}

/* ---------- 模式校验：标准 / 恐惧 ---------- */
// 知识恶魔的领域在战斗开始时要玩家选「灾祸」，离线夹具没有这个选择器（会 NullReference 崩），先挡掉。
const DREAD_UNSUPPORTED = new Set(['KNOWLEDGE_DEMON_BOSS']);
function resolveMode(body) {
  if (body.gameMode !== 'Dread') return { gameMode: 'Standard', dreadBoss: '' };
  const boss = String(body.dreadBoss || '');
  if (!boss) throw Object.assign(new Error('恐惧模式要选一个「恐惧首领」——领域效果由它决定。'), { status: 400 });
  if (DREAD_UNSUPPORTED.has(boss)) {
    throw Object.assign(new Error('知识恶魔的领域在战斗开始要选「灾祸」，离线模拟没有这个选择器，暂时算不了。换一个恐惧首领吧。'), { status: 400 });
  }
  return { gameMode: 'Dread', dreadBoss: boss };
}

/* ---------- 公共：建 job ---------- */
function newJob(body, mode, variants, meta) {
  const modeSel = resolveMode(body);
  const seeds = Array.isArray(body.seeds) && body.seeds.length
    ? body.seeds
    : Array.from({ length: Math.max(1, Math.min(1000, Number(body.count) || 2)) }, (_, i) => `${body.prefix || 'UI'}-${String((Number(body.start) || 0) + i).padStart(4, '0')}`);
  const id = 'job' + (++seq) + '-' + Date.now().toString(36);
  const job = {
    id, mode, status: 'running', total: 0, done: 0, seeds,
    variants, meta: meta || null,
    // 结果文件夹（归类路径，比如 骨头初始卡组对战一层弱怪数据测试/删2打）：跑完自动入库时写进 jobs.label
    label: String(body.label || '').trim().slice(0, 240) || null,
    relics: body.relics || [], relicProps: body.relicProps || {}, potions: body.potions || [], encounter: body.encounter,
    character: body.character || 'NECROBINDER',
    ascension: modeSel.gameMode === 'Dread' ? 10 : (Number(body.ascension) || 0),
    gameMode: modeSel.gameMode, dreadBoss: modeSel.dreadBoss,
    profile: body.profile || 'VeryHigh', beam: Number(body.beam) || 135, nodes: Number(body.nodes) || 100000,
    // 并行：用户选的值，但不超过「这台机器的逻辑核数 / 内存预算」，默认按物理核数
    concurrency: Math.max(1, Math.min(
      concurrencyBudget(),
      Number(body.concurrency) || PHYSICAL_CORES,
    )),
    potionPolicy: body.potionPolicy || 'Disabled', budget: Number(body.budget) || 5000,
    actIndex: Number(body.actIndex) || 0,
    dir: path.join(RUNS, id), lastError: null, startedAt: Date.now(),
    cancelled: false, children: new Set(),
  };
  fs.mkdirSync(job.dir, { recursive: true });
  saveJobConfig(job);
  jobs.set(id, job);
  runVariants(job).catch(e => { job.status = 'failed'; job.lastError = String(e && e.message || e); });
  return job;
}

/* ---------- 终止：杀掉这一局正在跑的模拟器子进程，剩下的样本不再派发 ---------- */
function cancelJob(job) {
  if (!job || job.status !== 'running') return { ok: false, error: '这个任务已经不在跑了' };
  job.cancelled = true;
  job.status = 'cancelled';
  job.gen = (job.gen || 0) + 1;   // 让这一轮还在跑的 worker 循环退场（见 runVariants 里的 stale()）
  job.finishedAt = Date.now();
  job.elapsedSec = Math.round((job.finishedAt - job.startedAt) / 100) / 10;
  let killed = 0;
  for (const c of job.children || []) {
    try { c.kill('SIGTERM'); killed++; } catch { }
  }
  // Windows 上模拟器有时不理会 SIGTERM，1.5 秒后补一刀
  setTimeout(() => {
    for (const c of job.children) { try { c.kill('SIGKILL'); } catch { } }
    job.children.clear();
  }, 1500);
  // 立刻把「已经算出来的那部分」汇总落盘：终止也能出数据，并且能续接
  try { for (const v of job.variants) if ((v.results || []).length) summarizeVariant(v); } catch { }
  writeSummary(job);
  return { ok: true, killed, done: job.done, total: job.total };
}

/* ---------- 启动时把历史结果读回来（重启不再清空） ---------- */
function loadHistory(limit = 40) {
  let entries = [];
  try {
    entries = fs.readdirSync(RUNS, { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => ({ name: d.name, mtime: fs.statSync(path.join(RUNS, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    const saved = readJson(path.join(RUNS, e.name, 'summary.json'));
    const j = saved && saved.job;
    if (!j || !j.id || jobs.has(j.id)) continue;
    if (j.status === 'running') continue; // 上次没跑完的不恢复
    const job = { ...j, dir: path.join(RUNS, e.name), lastError: j.lastError || null };
    jobs.set(job.id, job);
    const num = Number((/^job(\d+)-/.exec(job.id) || [])[1] || 0);
    if (num > seq) seq = num;
    n++;
  }
  return n;
}

/* ---------- 启动时把「没跑完的任务」重建出来，等界面来续接 ----------
   进程被杀/重启时，内存里的 job 没了；runs/<id>/job.json + results.jsonl 还在，就能接着补。 */
function rebuildUnfinished() {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return 0; }
  for (const d of dirs) {
    const dir = path.join(RUNS, d.name);
    const cfg = readJson(path.join(dir, 'job.json'));
    if (!cfg || !cfg.id || jobs.has(cfg.id)) continue;
    const rows = readResultRows(dir);
    const total = (cfg.variants || []).length * (cfg.seeds || []).length;
    if (!total) continue;
    const done = rows.length;
    if (done >= total) continue;   // 跑完的不需要续接
    const variants = (cfg.variants || []).map(v => ({ ...v, results: [], summary: null }));
    for (const r of rows) {
      const v = variants.find(x => x.key === r.v);
      if (v) v.results.push(r.row);
    }
    const job = {
      ...cfg, variants, dir, total, done, status: 'interrupted', cancelled: false, gen: 0,
      children: new Set(), lastError: '上次没跑完（进程被关掉或服务重启）',
      startedAt: cfg.createdAt || Date.now(), finishedAt: null, elapsedSec: null,
    };
    try { for (const v of variants) if (v.results.length) summarizeVariant(v); } catch { }
    jobs.set(job.id, job);
    const num = Number((/^job(\d+)-/.exec(job.id) || [])[1] || 0);
    if (num > seq) seq = num;
    n++;
  }
  return n;
}

/* 还没跑完、可以续接的任务（界面上给一个「继续跑」） */
function unfinishedJobs() {
  return [...jobs.values()]
    .filter(j => (j.status === 'cancelled' || j.status === 'interrupted') && j.done < j.total
      && (!j.dir || fs.existsSync(path.join(j.dir, 'job.json'))))   // 目录没了的（被删了）就别再挂在续接条上
    .map(j => {
      const enc = encounterIndex()[j.encounter];
      return {
        id: j.id, mode: j.mode, status: j.status, done: j.done, total: j.total,
        encounter: j.encounter || '', encounterName: (enc && enc.name) || j.encounter || '',
        character: j.character || '', startedAt: j.startedAt || null,
        label: (j.meta && (j.meta.label || j.meta.title)) || '',
      };
    })
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function normDeck(deck) {  return (deck || []).map(d => ({
    cardId: d.cardId, count: Number(d.count) || 1,
    upgradeLevels: Number(d.upgradeLevels) || 0,
    enchantmentId: d.enchantmentId || null, enchantmentAmount: Number(d.enchantmentAmount) || 0,
  }));
}

// 遭遇 id 必须真的存在于当前版本的 meta 里。
// 2026-11-27：本地化里留着改名前的旧名字（密林野生生物 = 密林爬虫的旧名），
// 前端一旦选中它，harness 建不出这场战斗，整批种子全失败、任务看起来「直接断完」。
// 所以这里提前拦住，给一句能看懂的话，而不是让它跑一整个必死的任务。
function requireEncounter(body, res) {
  if (!body.encounter) {
    send(res, 400, { error: '必须选一个遭遇' });
    return false;
  }
  if (!encounterIndex()[body.encounter]) {
    send(res, 400, {
      error: `「${body.encounter}」在当前版本里没有这个遭遇（多半是旧版本残留的名字）。刷新页面（Ctrl+F5）重新选一个。`,
    });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const u = new URL(url, 'http://localhost');
  try {
    if (req.method === 'POST' && u.pathname === '/api/solve') {
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!requireEncounter(body, res)) return;
      const deck = normDeck(body.deck);
      const v = { key: 'base', label: '当前卡组', deck, hp: Number(body.hp) || 0, maxHp: Number(body.maxHp) || 0, results: [], summary: null };
      const job = newJob(body, 'single', [v]);
      return send(res, 200, { id: job.id, total: 0, variants: 1 });
    }

    if (req.method === 'POST' && u.pathname === '/api/compare') {
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!requireEncounter(body, res)) return;
      const cands = (body.candidates || []).filter(c => c && c.cardId);
      if (!cands.length) return send(res, 400, { error: '至少给一张候选卡' });
      if (cands.length > 10) return send(res, 400, { error: '最多十张候选卡' });
      const deck = normDeck(body.deck);
      const hp = Number(body.hp) || 0, maxHp = Number(body.maxHp) || 0;
      const variants = [{ key: 'base', label: '基线（不放卡）', deck, hp, maxHp, results: [], summary: null }];
      for (const c of cands) {
        const add = { cardId: c.cardId, count: 1, upgradeLevels: Number(c.upgradeLevels) || 0 };
        if (c.enchantmentId) { add.enchantmentId = c.enchantmentId; add.enchantmentAmount = Number(c.enchantmentAmount) || 0; }
        variants.push({
          key: 'v' + variants.length, label: c.cardId, deck: [...deck, add], hp, maxHp,
          card: add, results: [], summary: null,
        });
      }
      const job = newJob(body, 'compare', variants, { baseline: 'base' });
      return send(res, 200, { id: job.id, variants: variants.length });
    }

    if (req.method === 'POST' && u.pathname === '/api/upgrade3') {
      // 自选升级：基线 = 卡组不动；每个方案 = 只把某一条的「已升级张数」+1，其余不变
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!requireEncounter(body, res)) return;
      const deck = normDeck(body.deck);
      const idxs = [...new Set((body.picks || [])
        .map(p => Number(p && p.index))
        .filter(i => Number.isInteger(i) && i >= 0 && i < deck.length))];
      if (idxs.length < 1) return send(res, 400, { error: '至少选一张要升级的牌' });
      if (idxs.length > 10) return send(res, 400, { error: '最多十张候选卡' });
      const hp = Number(body.hp) || 0, maxHp = Number(body.maxHp) || 0;
      const variants = [{ key: 'base', label: '基线（不升级）', deck, hp, maxHp, results: [], summary: null }];
      for (const idx of idxs) {
        const d = deck[idx];
        const up = Number(d.upgradeLevels) || 0;
        if (up >= d.count) return send(res, 400, { error: `${d.cardId} 这一行已经没有可以升级的副本了（${up}/${d.count}）` });
        const upDeck = deck.map((x, i) => (i === idx ? { ...x, upgradeLevels: up + 1 } : x));
        variants.push({
          key: 'v' + variants.length, label: '升级 ' + d.cardId, deck: upDeck, hp, maxHp,
          card: { cardId: d.cardId, upgradeLevels: 0 }, results: [], summary: null,
        });
      }
      const job = newJob(body, 'upgrade3', variants, { baseline: 'base', picks: idxs });
      return send(res, 200, { id: job.id, variants: variants.length });
    }

    if (req.method === 'POST' && u.pathname === '/api/rest') {
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!requireEncounter(body, res)) return;
      const deck = normDeck(body.deck);
      const hp = Number(body.hp) || 0, maxHp = Number(body.maxHp) || 0;
      const opts = body.rest || {};
      const pillow = !!opts.pillow, furnace = !!opts.furnace;
      const pct = Number(opts.healPercent ?? 30) / 100;
      const base = opts.base === 'current' ? hp : maxHp;

      // 升级：只把「选中的那一行」升 1 张（按行号，不按卡名——同名两行各升各的）
      const tIdx = Number.isInteger(Number(body.targetIndex)) && Number(body.targetIndex) >= 0 && Number(body.targetIndex) < deck.length
        ? Number(body.targetIndex) : -1;
      const tCard = body.targetCardId;
      if (tIdx < 0 && !tCard) return send(res, 400, { error: '要选一张要升级的卡' });
      if (tIdx >= 0) {
        const d = deck[tIdx];
        if (!d) return send(res, 400, { error: '这张牌不在卡组里' });
        if ((Number(d.upgradeLevels) || 0) >= d.count) return send(res, 400, { error: `${d.cardId} 这一行已经没有可升级的副本了（${d.upgradeLevels || 0}/${d.count}）` });
      }
      const upDeck = deck.map((d, i) => (i === tIdx ? { ...d, upgradeLevels: (Number(d.upgradeLevels) || 0) + 1 }
        : tIdx < 0 && d.cardId === tCard ? { ...d, upgradeLevels: (Number(d.upgradeLevels) || 0) + 1 } : d));
      const targetLabel = tIdx >= 0 ? (deck[tIdx] && deck[tIdx].cardId) : tCard;

      // 睡觉：不回血牌，加血（+上限）
      const heal = Math.round(base * pct) + (pillow ? 15 : 0);
      const restMax = maxHp + (furnace ? 5 : 0);
      const restHp = Math.min(restMax, hp + heal + (furnace ? 5 : 0));

      const variants = [
        { key: 'upgrade', label: '升级 ' + targetLabel, deck: upDeck, hp, maxHp, results: [], summary: null },
        { key: 'rest', label: '睡觉回血', deck, hp: restHp, maxHp: restMax, results: [], summary: null },
      ];
      const job = newJob(body, 'rest', variants, {
        targetCardId: targetLabel, targetIndex: tIdx,
        rest: { healPercent: Number(opts.healPercent ?? 30), pillow, furnace, base: opts.base || 'max', heal, hpBefore: hp, hpAfter: restHp, maxHpBefore: maxHp, maxHpAfter: restMax },
      });
      return send(res, 200, { id: job.id, variants: 2, rest: job.meta.rest });
    }

    if (req.method === 'POST' && u.pathname === '/api/deck-image') {
      try {
        const body = await readBody(req);
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(body.image || ''));
        if (!m) return send(res, 400, { error: '图片格式不支持（要 png/jpg 的 dataURL）' });
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length) return send(res, 400, { error: '图片是空的' });
        const dir = path.join(RUNS, '_ocr');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'shot-' + Date.now() + '.png');
        fs.writeFileSync(file, buf);
        let text;
        try { text = ocrImage(file); }
        catch (e) { return send(res, 500, { error: 'OCR 失败：' + String(e.stderr || e.message || e).slice(0, 300) }); }
        const parsed = parseDeckText(text, body.character || '');
        try { fs.unlinkSync(file); } catch { }
        return send(res, 200, { ...parsed, text });
      } catch (e) {
        return send(res, 500, { error: String(e && e.message || e) });
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/shot-import') {
      // 截图导入：前端把图缩到宽 <=1920 的 PNG 传上来，服务端放大 2 倍跑 Windows OCR，
      // 再按「卡名行 + 描述块」匹配 717 张卡库。遗物由前端用 canvas 比对 assets/relic-feats.json。
      const body = await readBody(req);
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(String(body.image || ''));
      if (!m) return send(res, 400, { error: '图片格式不支持（要 png/jpg 的 dataURL）' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 5000) return send(res, 400, { error: '图片太小，可能没传成功' });
      const dir = path.join(RUNS, '_ocr');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'shot-' + Date.now() + '.png');
      fs.writeFileSync(file, buf);
      try {
        const t0 = Date.now();
        const r = analyzeImage(file);
        return send(res, 200, { ...r, ms: Date.now() - t0, image: 'data:image/png;base64,' + buf.toString('base64') });
      } catch (e) {
        return send(res, 500, { error: '识别失败：' + String((e && (e.stderr || e.message)) || e).slice(0, 400) });
      } finally {
        try { fs.unlinkSync(file); } catch { }
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/import') {
      try { return send(res, 200, importGameState()); }
      catch (e) {
        const msg = String(e && e.message || e);
        // 没有进行中的存档是常态（刚打完一局/还没进过战斗），不是服务出错：
        // 用 200 + ok:false 回，前端弹一句人话，别在控制台留个红色的 500
        if (/current_run\.save/.test(msg)) return send(res, 200, { ok: false, code: 'NO_SAVE', error: msg });
        return send(res, 500, { error: msg });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/jobs/unfinished') {
      return send(res, 200, { jobs: unfinishedJobs() });
    }
    if (req.method === 'POST' && /^\/api\/job\/[^/]+\/resume$/.test(u.pathname)) {
      const id = u.pathname.slice('/api/job/'.length, -'/resume'.length);
      const job = jobs.get(id);
      if (!job) return send(res, 404, { error: '找不到这个任务（服务重启后没重建出来）' });
      if (job.status === 'running') return send(res, 409, { error: '这个任务正在跑' });
      if (!(job.done < job.total)) return send(res, 409, { error: '这个任务已经跑完了' });
      job.cancelled = false;
      job.status = 'running';
      job.gen = (job.gen || 0) + 1;   // 新一代：上一轮的 worker 循环看到代变了就不动了
      job.finishedAt = null;
      job.lastError = null;
      job.startedAt = job.startedAt || Date.now();
      saveJobConfig(job);
      runVariants(job).catch(e => { job.status = 'failed'; job.lastError = String(e && e.message || e); });
      return send(res, 200, { id, status: 'running', done: job.done, total: job.total });
    }
    if (req.method === 'POST' && /^\/api\/job\/[^/]+\/cancel$/.test(u.pathname)) {
      const id = u.pathname.slice('/api/job/'.length, -'/cancel'.length);
      const job = jobs.get(id);
      if (!job) return send(res, 404, { error: 'job not found' });
      const r = cancelJob(job);
      if (!r.ok) return send(res, 409, r);
      return send(res, 200, { id, status: 'cancelled', killed: r.killed, done: r.done, total: r.total });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/job/')) {
      const id = u.pathname.slice('/api/job/'.length);
      const job = jobs.get(id);
      // 服务重启后内存里的 job 就没了：这里回 200 + status=gone，
      // 别再回 404——浏览器会把它记成「资源加载失败」，污染前端报错检查。
      if (!job) return send(res, 200, { id, status: 'gone', total: 0, done: 0, variants: [], message: '任务不存在（服务重启过）' });
      return send(res, 200, publicJob(job));
    }
    // 这台机器能开多少并行（前端拿它生成下拉选项，别人机器更好就自动给更多）
    if (req.method === 'GET' && u.pathname === '/api/caps') {
      return send(res, 200, {
        logicalCores: LOGICAL_CORES,
        physicalCores: PHYSICAL_CORES,
        maxConcurrency: MAX_CONCURRENCY,
        memoryBudget: concurrencyBudget(),
        freeMemGB: Number((os.freemem() / 1073741824).toFixed(1)),
        totalMemGB: Number((os.totalmem() / 1073741824).toFixed(1)),
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/diag') {
      try { return send(res, 200, diagnose()); }
      catch (e) { return send(res, 500, { ok: false, harness: HARNESS.how, problems: [{ code: 'diag-crash', msg: '自检本身出错了：' + String(e && e.message || e), fix: '' }] }); }
    }
    if (req.method === 'POST' && u.pathname === '/api/estimate') {
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const blocks = Array.isArray(body.blocks) ? body.blocks.filter(b => b && Array.isArray(b.rows) && b.rows.length) : [];
      if (!blocks.length && !rows.length) return send(res, 400, { error: '没有可写的数据' });
      if (!blocks.length) body.blocks = [{ key: 'base', title: '默认卡组', rows }];
      return send(res, 200, saveEstimate(body));
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/estimate/')) {
      const name = path.basename(decodeURIComponent(u.pathname.slice('/api/estimate/'.length)));
      const file = path.join(EST_DIR, name);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(file), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && u.pathname === '/api/ping') {
      return send(res, 200, { ok: true, app: 'sts2-ui', pid: process.pid, port: PORT, version: 2, diag: true, dread: true, db: !!store });
    }
    if (req.method === 'GET' && u.pathname === '/api/jobs') {
      return send(res, 200, Array.from(jobs.values()).map(j => ({ id: j.id, mode: j.mode, status: j.status, total: j.total, done: j.done })).slice(-20));
    }

    /* ---------- /api/db/*：结果数据库（导入 / 查询 / 聚合 / 导出） ---------- */
    if (u.pathname.startsWith('/api/db/')) {
      if (!store) return send(res, 500, { error: '数据库打不开：' + storeError });
      const q = Object.fromEntries(u.searchParams.entries());
      const p = u.pathname;

      if (req.method === 'GET' && p === '/api/db/stats') {
        return send(res, 200, {
          ...store.stats(), db: DB_PATH,
          autoRecord: store.getSetting('autoRecord') !== '0',
        });
      }
      if (req.method === 'GET' && p === '/api/db/jobs') return send(res, 200, store.listJobs(q));
      // 结果文件夹：给 8766 的「测试前选文件夹」用（和 8770 同一个库、同一套 folders 表）
      if (req.method === 'GET' && p === '/api/db/folders') return send(res, 200, store.folders());
      if (req.method === 'POST' && p === '/api/db/folders') {
        const body = await readBody(req);
        const path = String(body.path || '').trim().replace(/^\/+|\/+$/g, '');
        if (!path) return send(res, 400, { error: '缺 path' });
        store.addFolder(path);
        return send(res, 200, { ok: true, path, folders: store.folders() });
      }
      // 把已有记录挪进某个文件夹（归类）
      if (req.method === 'POST' && p === '/api/db/label') {
        const body = await readBody(req);
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(Boolean).slice(0, 500);
        if (!ids.length) return send(res, 400, { error: '缺 ids' });
        const label = String(body.label || '').trim().slice(0, 240);
        const n = store.setJobLabel(ids, label);
        return send(res, 200, { ok: true, moved: n, label });
      }
      if (req.method === 'GET' && p === '/api/db/encounters') return send(res, 200, { rows: store.encounters(q) });
      if (req.method === 'GET' && p === '/api/db/cards') return send(res, 200, store.cards(q));
      if (req.method === 'GET' && p === '/api/db/trend') return send(res, 200, { rows: store.trend(q) });

      if (req.method === 'GET' && p.startsWith('/api/db/job/')) {
        const rest = p.slice('/api/db/job/'.length);
        const id = decodeURIComponent(rest.replace(/\/samples\.csv$/, ''));
        if (rest.endsWith('/samples.csv')) {
          const rows = store.db.prepare(`SELECT j.created_at, j.mode, j.encounter_name, j.character, j.ascension,
              v.key AS variant, v.label, v.card_id, s.seed, s.won, s.hp_lost, s.deficit, s.turns, s.sec,
              s.plays_total, s.energy_waste, s.potions_used
            FROM samples s JOIN jobs j ON j.id = s.job_id LEFT JOIN variants v ON v.id = s.variant_id
            WHERE s.job_id = ? ORDER BY s.id`).all(id);
          const head = ['created_at', 'mode', 'encounter', 'character', 'ascension', 'variant', 'label', 'card_id',
            'seed', 'won', 'hp_lost', 'deficit', 'turns', 'sec', 'plays_total', 'energy_waste', 'potions_used'];
          const lines = [head.join(',')];
          for (const r of rows) lines.push(head.map(k => {
            const v = r[k];
            return v == null ? '' : (/[,"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
          }).join(','));
          const buf = Buffer.from(lines.join('\n'), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length,
            'Content-Disposition': `attachment; filename="${String(id).replace(/[^\w.-]/g, '_')}-samples.csv"`,
            'Cache-Control': 'no-store',
          });
          return res.end(buf);
        }
        const d = store.jobDetail(id, { sampleLimit: Number(q.sampleLimit) || 500 });
        if (!d) return send(res, 404, { error: '库里没有这次测算：' + id });
        return send(res, 200, d);
      }

      if (req.method === 'GET' && p.startsWith('/api/db/card/') && p.endsWith('/encounters')) {
        const cid = decodeURIComponent(p.slice('/api/db/card/'.length, -'/encounters'.length));
        const cb = store.cardByEncounter(cid);
        return send(res, 200, { cardId: cid, rows: cb.rows, totals: cb.totals });
      }

      if (req.method === 'POST' && p === '/api/db/import') {
        const body = await readBody(req).catch(() => ({}));
        const r = store.importRuns(RUNS, { encounters: encounterIndex(), force: !!body.force });
        return send(res, 200, { ...r, stats: store.stats() });
      }
      if (req.method === 'POST' && p === '/api/db/import-csv') {
        const body = await readBody(req);
        const text = body.text || (body.file ? fs.readFileSync(body.file, 'utf8') : '');
        if (!text) return send(res, 400, { error: '没给 CSV 内容' });
        const enc = body.encounter && encounterIndex()[body.encounter];
        const r = store.importCsv(text, {
          label: body.label, file: body.file || null,
          encounter: body.encounter || null, encounterMeta: enc || null,
          character: body.character || null, ascension: body.ascension || null,
        });
        return send(res, 200, { ...r, stats: store.stats() });
      }
      if (req.method === 'POST' && p === '/api/db/record') {
        const body = await readBody(req);
        if (!body.job || !body.job.id) return send(res, 400, { error: '缺 job' });
        const created = store.recordJob(body.job, {
          source: 'manual', createdAt: body.createdAt || new Date().toISOString(),
          encounter: encounterIndex()[body.job.encounter] || null,
        });
        return send(res, 200, { id: body.job.id, created });
      }
      if (req.method === 'POST' && p === '/api/db/setting') {
        const body = await readBody(req);
        if (!body.k) return send(res, 400, { error: '缺 k' });
        store.setSetting(body.k, body.v);
        return send(res, 200, { ok: true, [body.k]: store.getSetting(body.k) });
      }
      if (req.method === 'DELETE' && p.startsWith('/api/db/job/')) {
        const id = decodeURIComponent(p.slice('/api/db/job/'.length));
        store.deleteJob(id);
        // 同时把内存里的任务和 runs/<id> 清掉，不然「没跑完可以续接」还挂着这条已经删掉的测试任务
        const jj = jobs.get(id);
        if (jj) jobs.delete(id);
        try {
          const dir = (jj && jj.dir) || path.join(RUNS, id);
          if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch { }
        return send(res, 200, { ok: true, id, stats: store.stats() });
      }
      if (req.method === 'POST' && p === '/api/db/clear') {
        const body = await readBody(req).catch(() => ({}));
        if (body.confirm !== 'CLEAR') return send(res, 400, { error: '要清空得带 confirm:"CLEAR"' });
        store.clearAll();
        return send(res, 200, { ok: true, stats: store.stats() });
      }
      return send(res, 404, { error: 'unknown db route: ' + p });
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, (e && e.status) || 500, { error: String(e && e.message || e) });
  }
});

const restored = loadHistory();
const unfinished = rebuildUnfinished();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sts2-ui server: http://127.0.0.1:${PORT}（恢复历史结果 ${restored} 条）`);
  if (unfinished) console.log(`有 ${unfinished} 个没跑完的任务可以续接（界面右上角会提示）`);
  console.log(`结果库：${store ? DB_PATH : '打不开（' + storeError + '）'}`);
});