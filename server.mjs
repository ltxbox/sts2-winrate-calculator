// StS2 求解器可视化 UI 的本地服务：静态文件 + /api/meta + /api/solve + /api/compare + /api/rest + /api/job/:id
// 只接 OfflineSearchHarness，不做任何前端模拟。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from './lib/shot.mjs';

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
  return { turn, hp: m ? Number(m[1]) : null, maxHp: m ? Number(m[2]) : null, hpSum: enemies.reduce((s, e) => s + e.hp, 0), enemies };
}

// 把一局的 planActions 变成 {回合: [牌]}，并附带牌面伤害（vars=Damage=N）
function parsePlayActions(actions) {
  const byTurn = new Map();
  for (const a of actions || []) {
    const m = /^(\d+):PlayCard:([A-Z0-9_]+):(.*)$/.exec(a);
    if (!m) continue;
    const turn = Number(m[1]);
    const vars = (/vars=([^|]*)/.exec(m[3]) || [])[1] || '';
    const dmg = Number((/Damage=(\d+)/.exec(vars) || [])[1] || 0);
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push({ cardId: m[2], face: dmg });
  }
  return byTurn;
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
  const frames = [];
  if (s.rootLiveStamp) frames.push(parseStamp(s.rootLiveStamp));
  for (const c of s.continuations || []) frames.push(parseStamp(c.StateText));
  const seen = new Set();
  const frames2 = frames.filter(f => f && !seen.has(f.turn) && seen.add(f.turn));
  frames2.sort((a, b) => a.turn - b.turn);
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

function runOne(job, variant, seed) {
  return new Promise(resolve => {
    const dir = path.join(job.dir, variant.key, String(seed).replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const reqPath = path.join(dir, 'request.json');
    fs.writeFileSync(reqPath, JSON.stringify(buildRequest(job, variant.deck, seed), null, 1), 'utf8');
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
      const sec = Math.round((Date.now() - started) / 100) / 10;
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
      if (attr) row.attr = attr.byCard;
      // 明细删掉，省磁盘（KEEP_RUNS=1 时保留，便于排查）
      if (!process.env.KEEP_RUNS) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
      resolve(row);
    });
  });
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
  const avgTurns = rows.filter(r => r.turns).length
    ? rows.filter(r => r.turns).reduce((s, r) => s + r.turns, 0) / rows.filter(r => r.turns).length : null;
  v.summary = {
    runs: rows.length, wins, losses: rows.length - wins,
    winrate: rows.length ? wins / rows.length : 0,
    avgHpLost: valid.length ? valid.reduce((s, r) => s + r.hpLost, 0) / valid.length : null,
    minHpLost: valid.length ? Math.min(...valid.map(r => r.hpLost)) : null,
    maxHpLost: valid.length ? Math.max(...valid.map(r => r.hpLost)) : null,
    avgTurns: avgTurns == null ? null : Math.round(avgTurns * 10) / 10,
    damageTotal: Math.round(totalDmg),
    attribution: attr,
  };
  return v.summary;
}

async function runVariants(job) {
  const tasks = [];
  for (const v of job.variants) for (const s of job.seeds) tasks.push({ v, s });
  job.total = tasks.length;
  const workers = Math.max(1, Math.min(job.concurrency, tasks.length));
  let idx = 0;
  job.startedAt = Date.now();
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      const row = await runOne(job, t.v, t.s);
      t.v.results.push(row);
      job.done = (job.done || 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  job.finishedAt = Date.now();
  job.status = 'done';
  for (const v of job.variants) summarizeVariant(v);
  const base = job.variants[0].summary;
  for (const v of job.variants) {
    v.summary.deltaWinratePp = base ? (v.summary.winrate - base.winrate) * 100 : null;
    v.summary.deltaHpLost = (base && v.summary.avgHpLost != null && base.avgHpLost != null) ? v.summary.avgHpLost - base.avgHpLost : null;
    v.summary.relWinrate = base && base.winrate > 0 ? (v.summary.winrate - base.winrate) / base.winrate : null;
  }
  job.elapsedSec = Math.round((job.finishedAt - job.startedAt) / 100) / 10;
  try {
    fs.writeFileSync(path.join(job.dir, 'summary.json'), JSON.stringify({ job: publicJob(job) }, null, 1), 'utf8');
  } catch { }
}

function publicVariant(v) {
  return {
    key: v.key, label: v.label, hp: v.hp, maxHp: v.maxHp,
    deck: v.deck, card: v.card || null,
    results: v.results, summary: v.summary || null,
  };
}

function publicJob(job) {
  return {
    id: job.id, mode: job.mode, status: job.status, total: job.total, done: job.done,
    seeds: job.seeds, encounter: job.encounter, character: job.character, ascension: job.ascension,
    profile: job.profile, beam: job.beam, nodes: job.nodes, concurrency: job.concurrency,
    potionPolicy: job.potionPolicy, budget: job.budget, relics: job.relics, potions: job.potions,
    variants: job.variants.map(publicVariant),
    meta: job.meta || null,
    gameMode: job.gameMode || 'Standard',
    dreadBoss: job.dreadBoss || '',
    lastError: job.lastError || null,
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
    relics: body.relics || [], relicProps: body.relicProps || {}, potions: body.potions || [], encounter: body.encounter,
    character: body.character || 'NECROBINDER',
    ascension: modeSel.gameMode === 'Dread' ? 10 : (Number(body.ascension) || 0),
    gameMode: modeSel.gameMode, dreadBoss: modeSel.dreadBoss,
    profile: body.profile || 'VeryHigh', beam: Number(body.beam) || 135, nodes: Number(body.nodes) || 100000,
    concurrency: Math.max(1, Math.min(12, Number(body.concurrency) || 4)),
    potionPolicy: body.potionPolicy || 'Disabled', budget: Number(body.budget) || 5000,
    actIndex: Number(body.actIndex) || 0,
    dir: path.join(RUNS, id), lastError: null, startedAt: Date.now(),
  };
  fs.mkdirSync(job.dir, { recursive: true });
  jobs.set(id, job);
  runVariants(job).catch(e => { job.status = 'failed'; job.lastError = String(e && e.message || e); });
  return job;
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

function normDeck(deck) {
  return (deck || []).map(d => ({
    cardId: d.cardId, count: Number(d.count) || 1,
    upgradeLevels: Number(d.upgradeLevels) || 0,
    enchantmentId: d.enchantmentId || null, enchantmentAmount: Number(d.enchantmentAmount) || 0,
  }));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const u = new URL(url, 'http://localhost');
  try {
    if (req.method === 'POST' && u.pathname === '/api/solve') {
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!body.encounter) return send(res, 400, { error: '必须选一个遭遇' });
      const deck = normDeck(body.deck);
      const v = { key: 'base', label: '当前卡组', deck, hp: Number(body.hp) || 0, maxHp: Number(body.maxHp) || 0, results: [], summary: null };
      const job = newJob(body, 'single', [v]);
      return send(res, 200, { id: job.id, total: 0, variants: 1 });
    }

    if (req.method === 'POST' && u.pathname === '/api/compare') {
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!body.encounter) return send(res, 400, { error: '必须选一个遭遇' });
      const cands = (body.candidates || []).filter(c => c && c.cardId);
      if (!cands.length) return send(res, 400, { error: '至少给一张候选卡' });
      if (cands.length > 3) return send(res, 400, { error: '最多三张候选卡' });
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
      // 三选一升级：基线 = 卡组不动；每个方案 = 只把某一条的「已升级张数」+1，其余不变
      const body = await readBody(req);
      if (!body.deck || !body.deck.length) return send(res, 400, { error: '卡组不能为空' });
      if (!body.encounter) return send(res, 400, { error: '必须选一个遭遇' });
      const deck = normDeck(body.deck);
      const idxs = [...new Set((body.picks || [])
        .map(p => Number(p && p.index))
        .filter(i => Number.isInteger(i) && i >= 0 && i < deck.length))];
      if (idxs.length < 2) return send(res, 400, { error: '至少选两张不同的牌' });
      if (idxs.length > 3) return send(res, 400, { error: '最多三张' });
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
      if (!body.encounter) return send(res, 400, { error: '必须选一个遭遇' });
      if (!body.targetCardId) return send(res, 400, { error: '要选一张要升级的卡' });
      const deck = normDeck(body.deck);
      const hp = Number(body.hp) || 0, maxHp = Number(body.maxHp) || 0;
      const opts = body.rest || {};
      const pillow = !!opts.pillow, furnace = !!opts.furnace;
      const pct = Number(opts.healPercent ?? 30) / 100;
      const base = opts.base === 'current' ? hp : maxHp;

      // 升级：只有一张，其余不变，血量不变
      const upDeck = deck.map(d => (d.cardId === body.targetCardId ? { ...d, upgradeLevels: (d.upgradeLevels || 0) + 1 } : d));

      // 睡觉：不回血牌，加血（+上限）
      const heal = Math.round(base * pct) + (pillow ? 15 : 0);
      const restMax = maxHp + (furnace ? 5 : 0);
      const restHp = Math.min(restMax, hp + heal + (furnace ? 5 : 0));

      const variants = [
        { key: 'upgrade', label: '升级 ' + body.targetCardId, deck: upDeck, hp, maxHp, results: [], summary: null },
        { key: 'rest', label: '睡觉回血', deck, hp: restHp, maxHp: restMax, results: [], summary: null },
      ];
      const job = newJob(body, 'rest', variants, {
        targetCardId: body.targetCardId,
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
    if (req.method === 'GET' && u.pathname.startsWith('/api/job/')) {
      const id = u.pathname.slice('/api/job/'.length);
      const job = jobs.get(id);
      if (!job) return send(res, 404, { error: 'job not found' });
      return send(res, 200, publicJob(job));
    }
    if (req.method === 'GET' && u.pathname === '/api/diag') {
      try { return send(res, 200, diagnose()); }
      catch (e) { return send(res, 500, { ok: false, harness: HARNESS.how, problems: [{ code: 'diag-crash', msg: '自检本身出错了：' + String(e && e.message || e), fix: '' }] }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/ping') {
      return send(res, 200, { ok: true, app: 'sts2-ui', pid: process.pid, port: PORT, version: 2, diag: true, dread: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/jobs') {
      return send(res, 200, Array.from(jobs.values()).map(j => ({ id: j.id, mode: j.mode, status: j.status, total: j.total, done: j.done })).slice(-20));
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, (e && e.status) || 500, { error: String(e && e.message || e) });
  }
});

const restored = loadHistory();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sts2-ui server: http://127.0.0.1:${PORT}（恢复历史结果 ${restored} 条）`);
});
