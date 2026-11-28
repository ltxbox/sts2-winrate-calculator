// 测算结果数据库（SQLite）。用 node 自带的 node:sqlite，不装任何第三方依赖。
//
// 存三层：
//   jobs      一次测算（= 界面里跑的那一下，runs\job-xxxx 目录）
//   variants  这次测算里的每个方案（默认卡组 / 每张候选卡 / 升级那几张）
//   samples   每局一行（种子 / 胜负 / 战损 / 回合 / 每张牌打了几次、打了多少伤害）
// 外加两张明细：card_stats（每个方案每张牌的出场与伤害）、damage_turns（每回合伤害）。
//
// 历史数据从 runs\<job>\summary.json 回填；以后每跑完一次由 server.mjs 自动写进来。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  mode TEXT,
  status TEXT,
  character TEXT,
  ascension INTEGER,
  game_mode TEXT,
  dread_boss TEXT,
  encounter_id TEXT,
  encounter_name TEXT,
  map TEXT,
  kind TEXT,
  total_runs INTEGER,
  elapsed_sec REAL,
  profile TEXT,
  hp INTEGER,
  max_hp INTEGER,
  relics TEXT,
  potions TEXT,
  deck TEXT,
  meta TEXT,
  source TEXT,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS jobs_enc ON jobs(encounter_id);
CREATE INDEX IF NOT EXISTS jobs_mode ON jobs(mode);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT,
  card_id TEXT,
  upgraded INTEGER,
  hp INTEGER,
  max_hp INTEGER,
  deck TEXT,
  runs INTEGER,
  wins INTEGER,
  winrate REAL,
  ci_lo REAL,
  ci_hi REAL,
  avg_hp_lost REAL,
  median_hp_lost REAL,
  min_hp_lost INTEGER,
  max_hp_lost INTEGER,
  avg_turns REAL,
  plays_per_run REAL,
  plays_per_turn REAL,
  damage_total REAL,
  energy_waste REAL,
  energy_waste_per_turn REAL,
  avg_potions REAL,
  avg_deficit REAL,
  delta_winrate_pp REAL,
  delta_hp_lost REAL,
  summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS variants_job_key ON variants(job_id, key);
CREATE INDEX IF NOT EXISTS variants_card ON variants(card_id);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  variant_key TEXT,
  seed TEXT,
  won INTEGER,
  hp_lost INTEGER,
  deficit REAL,
  turns INTEGER,
  sec REAL,
  status TEXT,
  plays_total INTEGER,
  energy_waste REAL,
  potions_used INTEGER,
  attr TEXT,
  plays TEXT
);
CREATE INDEX IF NOT EXISTS samples_job ON samples(job_id);
CREATE INDEX IF NOT EXISTS samples_variant ON samples(variant_id);

CREATE TABLE IF NOT EXISTS card_stats (
  variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  job_id TEXT,
  card_id TEXT,
  plays INTEGER,
  plays_per_run REAL,
  damage REAL,
  damage_per_play REAL
);
CREATE INDEX IF NOT EXISTS card_stats_card ON card_stats(card_id);
CREATE INDEX IF NOT EXISTS card_stats_job ON card_stats(job_id);

CREATE TABLE IF NOT EXISTS damage_turns (
  variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  job_id TEXT,
  turn INTEGER,
  damage REAL
);
CREATE INDEX IF NOT EXISTS damage_turns_job ON damage_turns(job_id);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 文件夹（归类路径）。2026-11-27 21:46 他要「文件夹形式、能自己新建、能把数据拖进去」，
-- 所以空文件夹也要能存下来——光靠 jobs.label 存不下空目录。
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  created_at TEXT
);
`;

const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const int = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

/** 归类路径规范化：去空白、去首尾/重复斜杠，' 骨头 / 白卡 ' → '骨头/白卡'。 */
export function normalizePath(raw) {
  const parts = String(raw ?? '').split('/').map(s => s.trim()).filter(Boolean);
  return parts.join('/');
}

// 游戏里已经删掉、但历史数据里还在的遭遇（不然导入后名字是空的）
export const LEGACY_ENCOUNTERS = {
  FLYCONID_WEAK: { name: '飞蝇菌子', map: '密林', kind: 'weak' },
};

/** 用 assets\meta.json 的遭遇表 + 旧遭遇别名，拼一个 id → {name,map,kind} 的索引。 */
export function buildEncounterIndex(meta) {
  const idx = { ...LEGACY_ENCOUNTERS };
  for (const e of ((meta && meta.encounters) || [])) idx[e.id] = { name: e.name, map: e.map, kind: e.kind };
  return idx;
}

/** 打开（或建）一个库，返回一套读写接口。dbPath 不同就互不干扰——测试用临时的。 */
export function createStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // 迁移：给旧库补 label 列（每次测算的归类名，比如「密林弱怪数据测试」）
  try {
    const cols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
    if (!cols.includes('label')) db.exec('ALTER TABLE jobs ADD COLUMN label TEXT');
  } catch { }
  // 迁移：文件夹手动排序（2026-11-28 他说「文件夹不能改位置顺序」）
  try {
    const fcols = db.prepare('PRAGMA table_info(folders)').all().map(c => c.name);
    if (!fcols.includes('sort_order')) db.exec('ALTER TABLE folders ADD COLUMN sort_order INTEGER');
  } catch { }

  // 重复入库 = 先删后插，避免重复行。子表显式清（老库没外键也照样干净），新库靠级联。
  const delJob = db.prepare('DELETE FROM jobs WHERE id = ?');
  const delChildren = ['DELETE FROM card_stats WHERE job_id = ?', 'DELETE FROM damage_turns WHERE job_id = ?',
    'DELETE FROM samples WHERE job_id = ?', 'DELETE FROM variants WHERE job_id = ?'].map(sql => db.prepare(sql));
  const purgeJob = id => { for (const st of delChildren) st.run(id); delJob.run(id); };
  const insJob = db.prepare(`INSERT INTO jobs
    (id, created_at, mode, status, character, ascension, game_mode, dread_boss,
     encounter_id, encounter_name, map, kind, total_runs, elapsed_sec, profile,
     hp, max_hp, relics, potions, deck, meta, source, synced_at, label)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insVar = db.prepare(`INSERT INTO variants
    (job_id, key, label, card_id, upgraded, hp, max_hp, deck,
     runs, wins, winrate, ci_lo, ci_hi, avg_hp_lost, median_hp_lost, min_hp_lost, max_hp_lost,
     avg_turns, plays_per_run, plays_per_turn, damage_total, energy_waste, energy_waste_per_turn,
     avg_potions, avg_deficit, delta_winrate_pp, delta_hp_lost, summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSample = db.prepare(`INSERT INTO samples
    (job_id, variant_id, variant_key, seed, won, hp_lost, deficit, turns, sec, status,
     plays_total, energy_waste, potions_used, attr, plays)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insCard = db.prepare('INSERT INTO card_stats (variant_id, job_id, card_id, plays, plays_per_run, damage, damage_per_play) VALUES (?,?,?,?,?,?,?)');
  const insTurn = db.prepare('INSERT INTO damage_turns (variant_id, job_id, turn, damage) VALUES (?,?,?,?)');
  const getJob = db.prepare('SELECT id FROM jobs WHERE id = ?');

  const jsonOrNull = v => (v == null ? null : JSON.stringify(v));

  /** 把一个 job 对象（publicJob 的形状）整条写进库。返回是否新插入。 */
  function recordJob(job, opts = {}) {
    if (!job || !job.id) throw new Error('recordJob: 缺 id');
    const now = new Date().toISOString();
    const createdAt = opts.createdAt || now;
    const enc = opts.encounter || null;
    const variants = Array.isArray(job.variants) ? job.variants : [];
    const first = variants[0] || {};
    // 2026-11-28 他要「一次对比的 11 组拆成 11 条独立记录」：一个方案一条 jobs 行，
    // 基线（base）也是一条。老数据用 splitJobs() 一次性拆开。
    const rowIdOf = (v, i) => (variants.length <= 1 ? job.id : `${job.id}~${String(v.key || i || 'base')}`);
    const rowIds = variants.map(rowIdOf);
    const existing = rowIds.some(id => getJob.get(id));
    // 归类名（测试前选的结果文件夹）：重新入库时若这次没带，就保住原来的，别把手工归好的类抹掉
    const oldRow = db.prepare('SELECT label FROM jobs WHERE id IN (' + rowIds.map(() => '?').join(',') + ') LIMIT 1').get(...rowIds);
    const oldLabel = oldRow ? oldRow.label : null;
    const newLabel = String(opts.label || job.label || (job.meta && (job.meta.label || job.meta.title)) || '').trim() || null;
    const label = newLabel || oldLabel || null;

    db.exec('BEGIN');
    try {
      // 先清干净：这次要写的每一行，加上老的单行记录（以前是一个 job 一行）
      purgeJob(job.id);
      for (const id of rowIds) if (id !== job.id) purgeJob(id);
      variants.forEach((v, i) => {
        const rid = rowIds[i];
        const s = v.summary || {};
        const runs = int(s.runs) != null ? int(s.runs) : (Array.isArray(v.results) ? v.results.length : null);
        insJob.run(
          rid, createdAt, job.mode || null, job.status || null, job.character || null,
          int(job.ascension), job.gameMode || null, job.dreadBoss || null,
          job.encounter || null, enc ? enc.name || null : null, enc ? enc.map || null : null, enc ? enc.kind || null : null,
          runs != null ? runs : int(job.total), variants.length > 1 ? null : num(job.elapsedSec), job.profile || null,
          int(v.hp != null ? v.hp : job.hp), int(v.maxHp != null ? v.maxHp : job.maxHp),
          jsonOrNull(job.relics), jsonOrNull(job.potions), jsonOrNull(v.deck || first.deck), jsonOrNull(job.meta),
          opts.source || 'auto', now, label
        );
      });
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const rid = rowIds[i];
        const s = v.summary || {};
        const wins = int(s.wins);
        const runs = int(s.runs) != null ? int(s.runs) : (Array.isArray(v.results) ? v.results.length : null);
        const info = insVar.run(
          rid, String(v.key || 'base'), v.label || null,
          (v.card && v.card.cardId) || null, v.card ? 1 : 0,
          int(v.hp), int(v.maxHp), jsonOrNull(v.deck),
          runs, wins, num(s.winrate),
          s.winrateCI ? num(s.winrateCI.lo) : null, s.winrateCI ? num(s.winrateCI.hi) : null,
          num(s.avgHpLost), num(s.medianHpLost), int(s.minHpLost), int(s.maxHpLost),
          num(s.avgTurns), num(s.playsPerRun), num(s.playsPerTurn),
          num(s.damageTotal), num(s.energyWaste), num(s.energyWastePerTurn),
          num(s.avgPotionsUsed), num(s.avgDeficit),
          num(s.deltaWinratePp), num(s.deltaHpLost),
          jsonOrNull(s)
        );
        const vid = Number(info.lastInsertRowid);
        for (const r of (Array.isArray(v.results) ? v.results : [])) {
          insSample.run(
            rid, vid, String(v.key || 'base'), r.seed || null,
            r.won === true ? 1 : r.won === false ? 0 : null,
            int(r.hpLost), num(r.deficit), int(r.turns), num(r.sec), r.status || null,
            int(r.playsTotal), num(r.energyWaste), int(r.potionsUsed),
            jsonOrNull(r.attr), jsonOrNull(r.plays)
          );
        }
        for (const p of (Array.isArray(s.plays) ? s.plays : [])) {
          insCard.run(vid, rid, p.cardId || null, int(p.total), num(p.avg), num(p.damage), num(p.perPlay));
        }
        // 没算伤害的牌（纯防御牌）也要在 card_stats 里留一行，否则「打出次数」查不到它
        for (const a of (Array.isArray(s.attribution) ? s.attribution : [])) {
          if (!Array.isArray(s.plays) || !s.plays.some(p => p.cardId === a.cardId)) {
            insCard.run(vid, rid, a.cardId || null, null, null, num(a.damage), null);
          }
        }
        for (const t of (Array.isArray(s.damageByTurn) ? s.damageByTurn : [])) {
          insTurn.run(vid, rid, int(t.turn), num(t.damage));
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return !existing;
  }

  /**
   * 把「一个 job 多方案」的老记录按方案拆成一条条独立记录（2026-11-28 他要的）。
   * 变体行、每局样本、卡牌统计都跟着挪到新记录下；拆完删掉原来那条。可重复跑（拆过的不会再拆）。
   */
  function splitJobs() {
    const rows = db.prepare(`SELECT job_id, COUNT(*) n FROM variants GROUP BY job_id HAVING n > 1`).all();
    let split = 0, made = 0;
    for (const r of rows) {
      const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(r.job_id);
      if (!j) continue;
      const vars = db.prepare('SELECT * FROM variants WHERE job_id = ? ORDER BY (key = \'base\') DESC, id').all(r.job_id);
      db.exec('BEGIN');
      try {
        for (const v of vars) {
          const nid = `${j.id}~${String(v.key || 'base')}`;
          purgeJob(nid);
          insJob.run(
            nid, j.created_at, j.mode, j.status, j.character, j.ascension, j.game_mode, j.dread_boss,
            j.encounter_id, j.encounter_name, j.map, j.kind,
            v.runs != null ? v.runs : j.total_runs, null /* 拆开后的单条不带整次耗时，免得 11 条都显示同一个数 */, j.profile,
            v.hp != null ? v.hp : j.hp, v.max_hp != null ? v.max_hp : j.max_hp,
            j.relics, j.potions, v.deck, j.meta, j.source, j.synced_at, j.label
          );
          db.prepare('UPDATE variants SET job_id = ? WHERE id = ?').run(nid, v.id);
          db.prepare('UPDATE samples SET job_id = ? WHERE variant_id = ?').run(nid, v.id);
          db.prepare('UPDATE card_stats SET job_id = ? WHERE variant_id = ?').run(nid, v.id);
          db.prepare('UPDATE damage_turns SET job_id = ? WHERE variant_id = ?').run(nid, v.id);
          made++;
        }
        delJob.run(j.id);   // 变体已经挪走，这里只剩空壳
        db.exec('COMMIT');
        split++;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    return { jobs: split, records: made };
  }

  /** 扫 runs 目录里所有 job 目录下的 summary.json 回填。已入库的默认跳过（force=true 就重写）。 */
  function importRuns(runsDir, opts = {}) {
    const encIndex = opts.encounters || {};
    const out = { scanned: 0, imported: 0, skipped: 0, failed: 0, errors: [] };
    let dirs = [];
    try { dirs = fs.readdirSync(runsDir); } catch (e) { out.errors.push('读不到目录：' + e.message); return out; }
    for (const d of dirs) {
      if (!/^job/.test(d)) continue;
      const dir = path.join(runsDir, d);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const f = path.join(dir, 'summary.json');
      if (!fs.existsSync(f)) continue;
      out.scanned++;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { out.failed++; out.errors.push(d + '：' + e.message); continue; }
      const job = obj && obj.job ? obj.job : obj;
      if (!job || !job.id) { out.failed++; out.errors.push(d + '：没有 job.id'); continue; }
      // 拆成一条条独立记录后，原 id 不存在了，看有没有 jobId~* 的行
      const already = getJob.get(job.id) || db.prepare('SELECT 1 FROM jobs WHERE id LIKE ? LIMIT 1').get(job.id + '~%');
      if (!opts.force && already) { out.skipped++; continue; }
      try {
        recordJob(job, {
          source: 'import',
          createdAt: new Date(fs.statSync(f).mtime).toISOString(),
          encounter: encIndex[job.encounter] || (job.encounter ? { name: job.encounter, map: null, kind: null } : null),
        });
        out.imported++;
      } catch (e) {
        out.failed++;
        out.errors.push(d + '：' + e.message);
      }
    }
    return out;
  }

  /** 导入界面导出的 CSV（种子,won,hpLost,deficit,turns,status,sec + 掉血区间 + 打出次数块）。 */
  function importCsv(text, opts = {}) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
    if (!lines.length) throw new Error('CSV 是空的');
    const head = lines[0].split(',').map(s => s.trim());
    const hasHeader = /seed/i.test(head[0] || '');
    const col = name => head.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const iSeed = hasHeader ? col('seed') : 0;
    const iWon = hasHeader ? col('won') : 1;
    const iHp = hasHeader ? col('hpLost') : 2;
    const iDef = hasHeader ? col('deficit') : 3;
    const iTurns = hasHeader ? col('turns') : 4;
    const iStatus = hasHeader ? col('status') : 5;
    const iSec = hasHeader ? col('sec') : 6;
    const results = [];
    const plays = [];
    let section = 'rows';
    for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
      const raw = lines[i];
      const cells = raw.split(',');
      if (/^#/.test(raw.trim())) {
        if (/打出次数/.test(raw)) section = 'plays';
        else if (/掉血区间/.test(raw)) section = 'range';
        continue;
      }
      if (section === 'plays') {
        const total = Number(cells[2]);
        if (!cells[0]) continue;
        plays.push({ cardId: cells[0], name: cells[1], total: Number.isFinite(total) ? total : null, avg: num(cells[3]) });
        continue;
      }
      if (section === 'range') continue;
      results.push({
        seed: cells[iSeed] || null,
        won: /true|胜|1/i.test(cells[iWon] || ''),
        hpLost: num(cells[iHp]),
        deficit: num(cells[iDef]),
        turns: num(cells[iTurns]),
        status: cells[iStatus] || null,
        sec: num(cells[iSec]),
      });
    }
    if (!results.length) throw new Error('CSV 里没读到每局数据（第一行应该是 seed,won,hpLost,…）');
    const wins = results.filter(r => r.won).length;
    const hpLost = results.map(r => r.hpLost).filter(v => v != null);
    const turns = results.map(r => r.turns).filter(v => v != null);
    const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const sortedHp = hpLost.slice().sort((a, b) => a - b);
    const summary = {
      runs: results.length, wins, losses: results.length - wins, winrate: wins / results.length,
      avgHpLost: avg(hpLost), minHpLost: sortedHp.length ? sortedHp[0] : null,
      maxHpLost: sortedHp.length ? sortedHp[sortedHp.length - 1] : null,
      medianHpLost: sortedHp.length ? sortedHp[Math.floor(sortedHp.length / 2)] : null,
      avgTurns: avg(turns),
      plays: plays.map(p => ({ cardId: p.cardId, total: p.total, avg: p.avg })),
    };
    const jobId = 'csv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const job = {
      id: jobId, mode: 'csv', status: 'done', total: results.length,
      encounter: opts.encounter || null, character: opts.character || null, ascension: opts.ascension || null,
      variants: [{ key: 'base', label: opts.label || 'CSV 导入', deck: null, card: null, results, summary }],
      meta: { file: opts.file || null },
    };
    recordJob(job, { source: 'csv', encounter: opts.encounterMeta || null });
    return { id: jobId, runs: results.length, wins };
  }

  /* ---------- 查询 ---------- */

  function stats() {
    const j = db.prepare(`SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last, SUM(total_runs) total_runs FROM jobs`).get();
    const s = db.prepare('SELECT COUNT(*) n FROM samples').get();
    const v = db.prepare('SELECT COUNT(*) n FROM variants').get();
    const byMode = db.prepare('SELECT mode, COUNT(*) n FROM jobs GROUP BY mode ORDER BY n DESC').all();
    const byChar = db.prepare(`SELECT character, COUNT(*) jobs, SUM(total_runs) runs FROM jobs WHERE character IS NOT NULL GROUP BY character ORDER BY runs DESC`).all();
    const byLabel = db.prepare(`SELECT COALESCE(NULLIF(label,''),'（未归类）') label, COUNT(*) jobs, SUM(total_runs) runs, MIN(created_at) first, MAX(created_at) last
      FROM jobs GROUP BY 1 ORDER BY runs DESC`).all();
    const overall = db.prepare(`SELECT SUM(won) wins, COUNT(*) n, AVG(hp_lost) avg_hp, AVG(turns) avg_turns FROM samples WHERE won IS NOT NULL`).get();
    const encs = db.prepare('SELECT COUNT(DISTINCT encounter_id) n FROM jobs WHERE encounter_id IS NOT NULL').get();
    return {
      jobs: j.n || 0, variants: v.n || 0, samples: s.n || 0,
      totalRuns: j.total_runs || 0,
      first: j.first || null, last: j.last || null,
      encounters: encs.n || 0,
      winrate: overall && overall.n ? (overall.wins || 0) / overall.n : null,
      avgHpLost: overall ? overall.avg_hp : null,
      avgTurns: overall ? overall.avg_turns : null,
      byMode, byChar, byLabel,
    };
  }

  function listJobs(opts = {}) {
    const where = [];
    const args = [];
    if (opts.mode) { where.push('j.mode = ?'); args.push(opts.mode); }
    if (opts.character) { where.push('j.character = ?'); args.push(opts.character); }
    if (opts.encounterId) { where.push('j.encounter_id = ?'); args.push(opts.encounterId); }
    if (opts.since) { where.push('j.created_at >= ?'); args.push(opts.since); }
    if (opts.until) { where.push('j.created_at <= ?'); args.push(opts.until); }
    if (opts.cardId) {
      where.push('EXISTS (SELECT 1 FROM variants x WHERE x.job_id = j.id AND x.card_id = ?)');
      args.push(opts.cardId);
    }
    // label 支持「路径」：传 骨头 时，骨头 和 骨头/白卡测试 都算进去
    if (opts.label) { where.push('(j.label = ? OR j.label LIKE ?)'); args.push(opts.label, opts.label + '/%'); }
    // 未归类：一次都没拖进文件夹的
    if (opts.unlabeled) where.push("(j.label IS NULL OR j.label = '')");
    if (opts.q) {
      where.push('(j.encounter_name LIKE ? OR j.encounter_id LIKE ? OR j.id LIKE ? OR j.label LIKE ?)');
      const like = '%' + opts.q + '%';
      args.push(like, like, like, like);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM jobs j ${w}`).get(...args).n || 0;
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const rows = db.prepare(`SELECT j.*,
        (SELECT COUNT(*) FROM variants v WHERE v.job_id = j.id) variants,
        (SELECT v.card_id FROM variants v WHERE v.job_id = j.id ORDER BY (v.key = 'base') DESC LIMIT 1) card_id,
        (SELECT v.winrate FROM variants v WHERE v.job_id = j.id AND v.key = 'base' ORDER BY v.id LIMIT 1) base_winrate,
        (SELECT v.avg_hp_lost FROM variants v WHERE v.job_id = j.id AND v.key = 'base' ORDER BY v.id LIMIT 1) base_hp_lost
      FROM jobs j ${w} ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    // 2026-11-28 拆成一条条记录后，卡档自己不带基线：这里按「同一只怪的基线」补上，
    // 优先同文件夹里的基线，没有再退到任意文件夹（列表页的「相对基线」列就不空了）。
    const encs = [...new Set(rows.map(r => r.encounter_id).filter(Boolean))];
    if (encs.length) {
      const ph = encs.map(() => '?').join(',');
      const bases = db.prepare(`SELECT j.encounter_id enc, j.label, v.winrate wr, v.avg_hp_lost hp
        FROM variants v JOIN jobs j ON j.id = v.job_id
        WHERE v.key = 'base' AND j.encounter_id IN (${ph}) ORDER BY v.runs DESC`).all(...encs);
      const exact = new Map(), any = new Map();
      for (const b of bases) {
        if (!any.has(b.enc)) any.set(b.enc, b);
        if (!exact.has(b.enc + '|' + (b.label || ''))) exact.set(b.enc + '|' + (b.label || ''), b);
      }
      for (const r of rows) {
        if (r.base_winrate != null || !r.encounter_id) continue;
        const b = exact.get(r.encounter_id + '|' + (r.label || '')) || any.get(r.encounter_id);
        if (b) { r.base_winrate = b.wr; r.base_hp_lost = b.hp; }
      }
    }
    return { total, limit, offset, rows };
  }

  function jobDetail(id, opts = {}) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return null;
    const variants = db.prepare('SELECT * FROM variants WHERE job_id = ? ORDER BY (key = \'base\') DESC, id').all(id)
      .map(v => ({ ...v, summary: v.summary ? JSON.parse(v.summary) : null, deck: v.deck ? JSON.parse(v.deck) : null }));
    const limit = Math.max(1, Math.min(5000, Number(opts.sampleLimit) || 500));
    const samples = db.prepare('SELECT * FROM samples WHERE job_id = ? ORDER BY id LIMIT ?').all(id, limit)
      .map(s => ({ ...s, attr: s.attr ? JSON.parse(s.attr) : null, plays: s.plays ? JSON.parse(s.plays) : null }));
    const sampleCount = db.prepare('SELECT COUNT(*) n FROM samples WHERE job_id = ?').get(id).n;
    const cards = db.prepare(`SELECT card_id, SUM(plays) plays, SUM(damage) damage, COUNT(DISTINCT variant_id) n
      FROM card_stats WHERE job_id = ? GROUP BY card_id ORDER BY COALESCE(SUM(damage),0) DESC, COALESCE(SUM(plays),0) DESC`).all(id);
    return {
      job: { ...job, relics: job.relics ? JSON.parse(job.relics) : null, potions: job.potions ? JSON.parse(job.potions) : null },
      variants, samples, sampleCount, cards,
    };
  }

  function encounters(opts = {}) {
    const where = ['s.variant_key IS NOT NULL'];
    const args = [];
    if (opts.map) { where.push('j.map = ?'); args.push(opts.map); }
    if (opts.kind) { where.push('j.kind = ?'); args.push(opts.kind); }
    if (opts.q) { where.push('(j.encounter_name LIKE ? OR j.encounter_id LIKE ?)'); args.push('%' + opts.q + '%', '%' + opts.q + '%'); }
    const rows = db.prepare(`SELECT j.encounter_id, MAX(j.encounter_name) name, MAX(j.map) map, MAX(j.kind) kind,
        COUNT(DISTINCT j.id) jobs, COUNT(s.id) samples, SUM(s.won) wins,
        AVG(s.hp_lost) avg_hp, AVG(s.turns) avg_turns, MAX(j.created_at) last_run
      FROM samples s JOIN jobs j ON j.id = s.job_id
      WHERE ${where.join(' AND ')} AND j.encounter_id IS NOT NULL
      GROUP BY j.encounter_id
      ORDER BY (SUM(s.won) * 1.0 / COUNT(s.id)) ASC, COUNT(s.id) DESC`).all(...args);
    return rows.map(r => ({ ...r, winrate: r.samples ? (r.wins || 0) / r.samples : null }));
  }

  function cards(opts = {}) {
    const rows = db.prepare(`SELECT cs.card_id,
        COUNT(DISTINCT cs.variant_id) tested, SUM(cs.plays) plays, SUM(cs.damage) damage
      FROM card_stats cs WHERE cs.card_id IS NOT NULL GROUP BY cs.card_id`).all();
    // 候选卡的真实增益：跟「同一只怪的基线」比（2026-11-28 起基线是独立记录，
    // 不能再按同一条 job join），再按样本数加权平均。
    const baseEnc = new Map(db.prepare(`SELECT j.encounter_id enc, SUM(v.runs) runs, SUM(v.wins) wins
      FROM variants v JOIN jobs j ON j.id = v.job_id
      WHERE v.key = 'base' AND j.encounter_id IS NOT NULL GROUP BY 1`).all()
      .map(r => [r.enc, { runs: r.runs || 0, wr: r.runs ? (r.wins || 0) / r.runs : null }]));
    const cardVars = db.prepare(`SELECT v.card_id, v.runs, v.wins, v.winrate, j.encounter_id enc
      FROM variants v JOIN jobs j ON j.id = v.job_id WHERE v.card_id IS NOT NULL`).all();
    const acc = new Map();
    for (const v of cardVars) {
      const n = v.runs || 0;
      const o = acc.get(v.card_id) || { runs: 0, wins: 0, dw: 0, dn: 0, bw: 0, bn: 0 };
      acc.set(v.card_id, o);
      o.runs += n; o.wins += v.wins || 0;
      const b = baseEnc.get(v.enc);
      if (b && b.wr != null && v.winrate != null && n) {
        o.dw += (v.winrate - b.wr) * n; o.dn += n;
        o.bw += b.wr * n; o.bn += n;
      }
    }
    const perJob = [...acc.entries()].map(([cardId, o]) => ({ card_id: cardId, ...o }));
    const baseTot = [...baseEnc.values()].reduce((o, b) => {
      o.runs += b.runs || 0; o.wins += (b.wr || 0) * (b.runs || 0); return o;
    }, { runs: 0, wins: 0 });
    const baseWr = baseTot.runs ? baseTot.wins / baseTot.runs : null;
    const byCard = new Map();
    const ensure = id => { if (!byCard.has(id)) byCard.set(id, { cardId: id, tested: 0, plays: 0, damage: 0, runs: 0, wins: 0 }); return byCard.get(id); };
    for (const r of rows) {
      const o = ensure(r.card_id);
      o.tested = r.tested || 0; o.plays = r.plays || 0;
      // 伤害是 NULL = harness 没把伤害记到这张牌名下（比如鞭打），显示 0 会被当成"打了没伤害"
      o.damage = r.damage == null ? null : r.damage;
    }
    for (const r of perJob) {
      const o = ensure(r.card_id);
      o.runs = r.runs || 0; o.wins = r.wins || 0;
      o.deltaPp = r.dn ? (r.dw / r.dn) * 100 : null;
      o.baseWinrate = r.bn ? r.bw / r.bn : null;
    }
    let out = Array.from(byCard.values()).map(o => {
      const wr = o.runs ? o.wins / o.runs : null;
      return {
        ...o,
        winrate: wr,
        damagePerPlay: o.plays && o.damage ? o.damage / o.plays : null,
      };
    });
    if (opts.q) {
      const q = String(opts.q).toLowerCase();
      out = out.filter(o => String(o.cardId).toLowerCase().includes(q));
    }
    const order = opts.order || 'tested';
    out.sort((a, b) => {
      if (order === 'damage') return (b.damage || 0) - (a.damage || 0);
      if (order === 'plays') return (b.plays || 0) - (a.plays || 0);
      if (order === 'delta') return (b.deltaPp == null ? -1e9 : b.deltaPp) - (a.deltaPp == null ? -1e9 : a.deltaPp);
      return (b.tested || 0) - (a.tested || 0);
    });
    return { baseWinrate: baseWr, rows: out.slice(0, Math.max(1, Math.min(500, Number(opts.limit) || 200))) };
  }

  function trend(opts = {}) {
    const unit = opts.unit === 'month' ? 7 : 10;
    const rows = db.prepare(`SELECT substr(j.created_at, 1, ${unit}) bucket,
        COUNT(DISTINCT j.id) jobs, COUNT(s.id) samples, SUM(s.won) wins, AVG(s.hp_lost) avg_hp
      FROM jobs j LEFT JOIN samples s ON s.job_id = j.id
      WHERE j.created_at IS NOT NULL GROUP BY bucket ORDER BY bucket`).all();
    return rows.map(r => ({ ...r, winrate: r.samples ? (r.wins || 0) / r.samples : null }));
  }

  /**
   * 某张候选卡在各遭遇里的表现：**带这张** vs **同一场里不带（跳过）**，
   * 外加实际跑出来的打出次数 / 伤害合计。
   *
   * 2026-11-27 21:35 他指着页面说：「卡牌打开漏数据了，最下方只有运行记录的战损数据，
   * 我实际跑起来的那些打出数据等没了，还有和跳过对比的数据也没了」。
   * 原来这里只 SELECT 了 runs/wins/avg_hp——打出次数和伤害在 card_stats 里、
   * 跳过对比在同一次测算的 key='base' 方案里，都没查出来。
   */
  /**
   * 这张卡在哪些文件夹里被测过（2026-11-27 21:57 他要：点开卡先看文件夹，再点文件夹看统计）。
   * 按 jobs.label 分组；没归类的单独一条（path=''）。
   */
  function cardFolders(cardId) {
    const rows = db.prepare(`SELECT COALESCE(NULLIF(j.label,''),'') path,
        COUNT(DISTINCT j.id) jobs, SUM(v.runs) runs, SUM(v.wins) wins
      FROM variants v JOIN jobs j ON j.id = v.job_id
      WHERE v.card_id = ? GROUP BY 1 ORDER BY runs DESC`).all(cardId);
    return rows.map(r => ({ ...r, winrate: r.runs ? (r.wins || 0) / r.runs : null }));
  }

  function cardByEncounter(cardId, opts = {}) {
    const byFolder = String(opts.label ?? '').trim();
    const wLabel = byFolder ? 'AND (j.label = ? OR j.label LIKE ?)' : '';
    const aLabel = byFolder ? [byFolder, byFolder + '/%'] : [];

    const withCard = db.prepare(`SELECT j.encounter_id enc_id, MAX(j.encounter_name) name, MAX(j.kind) kind,
        COUNT(DISTINCT j.id) jobs, SUM(v.runs) runs, SUM(v.wins) wins,
        SUM(COALESCE(v.avg_hp_lost, 0) * v.runs)
          / NULLIF(SUM(CASE WHEN v.avg_hp_lost IS NOT NULL THEN v.runs ELSE 0 END), 0) avg_hp,
        SUM(COALESCE(v.avg_turns, 0) * v.runs)
          / NULLIF(SUM(CASE WHEN v.avg_turns IS NOT NULL THEN v.runs ELSE 0 END), 0) avg_turns
      FROM variants v JOIN jobs j ON j.id = v.job_id
      WHERE v.card_id = ? AND j.encounter_id IS NOT NULL ${wLabel}
      GROUP BY j.encounter_id`).all(cardId, ...aLabel);

    // 同一只怪的基线（2026-11-28 起基线是一条独立记录，按遭遇取，不再限定同一条 job）
    const base = db.prepare(`SELECT j.encounter_id enc_id, SUM(b.runs) runs, SUM(b.wins) wins,
        SUM(COALESCE(b.avg_hp_lost, 0) * b.runs)
          / NULLIF(SUM(CASE WHEN b.avg_hp_lost IS NOT NULL THEN b.runs ELSE 0 END), 0) avg_hp
      FROM variants b JOIN jobs j ON j.id = b.job_id
      WHERE b.key = 'base' AND j.encounter_id IS NOT NULL ${wLabel}
      GROUP BY j.encounter_id`).all(...aLabel);
    const baseBy = new Map(base.map(r => [r.enc_id, r]));

    // 这张卡真正打出去多少次、打了多少伤害。
    // ⚠️ card_stats 是「一个方案 × 整副牌的每张牌」各一行，不是只记候选卡：
    // 只按 v.card_id 过滤会把同方案里其他牌的打出次数一起算进来（实测放大到 6.7 倍）。
    const plays = db.prepare(`SELECT j.encounter_id enc_id, SUM(cs.plays) plays, SUM(cs.damage) damage
      FROM card_stats cs JOIN variants v ON v.id = cs.variant_id JOIN jobs j ON j.id = cs.job_id
      WHERE cs.card_id = ? AND v.card_id = ? AND j.encounter_id IS NOT NULL ${wLabel}
      GROUP BY j.encounter_id`).all(cardId, cardId, ...aLabel);
    const playBy = new Map(plays.map(r => [r.enc_id, r]));

    const rows = withCard.map(r => {
      const b = baseBy.get(r.enc_id) || {};
      const p = playBy.get(r.enc_id) || {};
      const wr = r.runs ? (r.wins || 0) / r.runs : null;
      const bwr = b.runs ? (b.wins || 0) / b.runs : null;
      return {
        encounter_id: r.enc_id, name: r.name, kind: r.kind, jobs: r.jobs,
        runs: r.runs || 0, wins: r.wins || 0, winrate: wr, avg_hp: r.avg_hp, avg_turns: r.avg_turns,
        base_runs: b.runs || 0, base_wins: b.wins || 0, base_winrate: bwr, base_avg_hp: b.avg_hp ?? null,
        deltaPp: wr != null && bwr != null ? (wr - bwr) * 100 : null,
        hpDelta: r.avg_hp != null && b.avg_hp != null ? r.avg_hp - b.avg_hp : null,
        // 伤害是 null 就是 harness 没把伤害记到这张牌名下（别显示成 0，0 会看成"打了但没伤害"）
        plays: p.plays || 0, damage: p.damage ?? null,
        damagePerPlay: p.plays && p.damage ? p.damage / p.plays : null,
        playsPerRun: r.runs ? (p.plays || 0) / r.runs : null,
      };
    }).sort((a, b) => b.runs - a.runs);

    // 合计：把各遭遇加起来（胜率按样本，战损按样本加权）
    const t = rows.reduce((o, r) => {
      o.runs += r.runs; o.wins += r.wins;
      o.base_runs += r.base_runs; o.base_wins += r.base_wins;
      o.plays += r.plays; o.damage += r.damage;
      if (r.avg_hp != null && r.runs) { o.hpSum += r.avg_hp * r.runs; o.hpN += r.runs; }
      if (r.base_avg_hp != null && r.base_runs) { o.bHpSum += r.base_avg_hp * r.base_runs; o.bHpN += r.base_runs; }
      if (r.deltaPp != null && r.runs) { o.dw += r.deltaPp * r.runs; o.dn += r.runs; }
      return o;
    }, { runs: 0, wins: 0, base_runs: 0, base_wins: 0, plays: 0, damage: 0, hpSum: 0, hpN: 0, bHpSum: 0, bHpN: 0, dw: 0, dn: 0 });
    const totals = {
      encounters: rows.length,
      jobs: rows.reduce((n, r) => n + (r.jobs || 0), 0),
      runs: t.runs, wins: t.wins, winrate: t.runs ? t.wins / t.runs : null,
      base_runs: t.base_runs, base_wins: t.base_wins, base_winrate: t.base_runs ? t.base_wins / t.base_runs : null,
      deltaPp: t.dn ? t.dw / t.dn : null,
      avg_hp: t.hpN ? t.hpSum / t.hpN : null, base_avg_hp: t.bHpN ? t.bHpSum / t.bHpN : null,
      // 战损差 = 带这张 − 跳过（负数就是省血），2026-11-27 21:42 他要的「战损差」
      hpDelta: t.hpN && t.bHpN ? t.hpSum / t.hpN - t.bHpSum / t.bHpN : null,
      plays: t.plays, damage: t.damage || null,
      damagePerPlay: t.plays && t.damage ? t.damage / t.plays : null,
      playsPerRun: t.runs ? t.plays / t.runs : null,
    };
    return { rows, totals };
  }

  /**
   * 卡图概览（2026-11-28 他要的）：一张卡一张图当文件夹，点进去看这张卡的数据；
   * 另外一份「初始卡组」（骨头头像）——每只怪下 key='base' 那一路（不放候选卡）的战损/胜率。
   * 一页要的东西一次给全：基线明细 + 每张候选卡相对同场基线的差。
   */
  function cardOverview(opts = {}) {
    const byLabel = String(opts.label ?? '').trim();
    const wLabel = byLabel ? 'AND (j.label = ? OR j.label LIKE ?)' : '';
    const aLabel = byLabel ? [byLabel, byLabel + '/%'] : [];

    const baselineRows = db.prepare(`SELECT j.encounter_id enc_id, MAX(j.encounter_name) name,
        MAX(j.map) map, MAX(j.kind) kind, COUNT(DISTINCT j.id) jobs,
        SUM(v.runs) runs, SUM(v.wins) wins,
        SUM(COALESCE(v.avg_hp_lost, 0) * v.runs)
          / NULLIF(SUM(CASE WHEN v.avg_hp_lost IS NOT NULL THEN v.runs ELSE 0 END), 0) avg_hp,
        SUM(COALESCE(v.avg_turns, 0) * v.runs)
          / NULLIF(SUM(CASE WHEN v.avg_turns IS NOT NULL THEN v.runs ELSE 0 END), 0) avg_turns
      FROM variants v JOIN jobs j ON j.id = v.job_id
      WHERE v.key = 'base' AND j.encounter_id IS NOT NULL ${wLabel}
      GROUP BY j.encounter_id ORDER BY map, name`).all(...aLabel)
      .map(r => ({ ...r, winrate: r.runs ? (r.wins || 0) / r.runs : null }));

    const bl = baselineRows.reduce((o, r) => {
      o.runs += r.runs || 0; o.wins += r.wins || 0;
      if (r.avg_hp != null && r.runs) { o.hpSum += r.avg_hp * r.runs; o.hpN += r.runs; }
      if (r.avg_turns != null && r.runs) { o.tSum += r.avg_turns * r.runs; o.tN += r.runs; }
      return o;
    }, { runs: 0, wins: 0, hpSum: 0, hpN: 0, tSum: 0, tN: 0 });

    // 2026-11-28 起一个方案一条记录：基线没法再按「同一条 job」join，
    // 改成「同一只怪的基线」（取当前范围内的 base 记录，按样本加权）。
    const baseByEnc = new Map(baselineRows.map(r => [r.enc_id, { hp: r.avg_hp, wr: r.winrate }]));

    const cardVars = db.prepare(`SELECT v.card_id card_id, v.job_id job_id, v.runs runs, v.wins wins,
        v.winrate winrate, v.avg_hp_lost avg_hp, v.avg_turns avg_turns, j.encounter_id enc
      FROM variants v JOIN jobs j ON j.id = v.job_id
      WHERE v.card_id IS NOT NULL ${wLabel}`).all(...aLabel);

    const agg = new Map();
    for (const v of cardVars) {
      const n = v.runs || 0;
      let o = agg.get(v.card_id);
      if (!o) {
        o = { cardId: v.card_id, runs: 0, wins: 0, hpSum: 0, hpN: 0, tSum: 0, tN: 0,
          baseHpSum: 0, baseHpN: 0, bwSum: 0, bwN: 0, dwSum: 0, dwN: 0,
          jobs: new Set(), encs: new Set() };
        agg.set(v.card_id, o);
      }
      o.runs += n; o.wins += v.wins || 0;
      o.jobs.add(v.job_id); o.encs.add(v.enc);
      if (v.avg_hp != null && n) { o.hpSum += v.avg_hp * n; o.hpN += n; }
      if (v.avg_turns != null && n) { o.tSum += v.avg_turns * n; o.tN += n; }
      const base = baseByEnc.get(v.enc);
      if (base && base.hp != null && v.avg_hp != null && n) { o.baseHpSum += base.hp * n; o.baseHpN += n; }
      if (base && base.wr != null && v.winrate != null && n) {
        o.bwSum += base.wr * n; o.bwN += n;
        o.dwSum += (v.winrate - base.wr) * n; o.dwN += n;
      }
    }

    // 打出次数/伤害：只算「候选卡就是这张」的那些方案（card_stats 是整副牌一行一行记的）
    const plays = db.prepare(`SELECT cs.card_id card_id, SUM(cs.plays) plays, SUM(cs.damage) damage
      FROM card_stats cs JOIN variants v ON v.id = cs.variant_id JOIN jobs j ON j.id = cs.job_id
      WHERE v.card_id IS NOT NULL AND cs.card_id = v.card_id ${wLabel}
      GROUP BY cs.card_id`).all(...aLabel);
    const playBy = new Map(plays.map(p => [p.card_id, p]));

    const cards = [...agg.values()].map(o => {
      const p = playBy.get(o.cardId) || {};
      const avgHp = o.hpN ? o.hpSum / o.hpN : null;
      const baseHp = o.baseHpN ? o.baseHpSum / o.baseHpN : null;
      return {
        cardId: o.cardId, jobs: o.jobs.size, encounters: o.encs.size,
        runs: o.runs, wins: o.wins, winrate: o.runs ? o.wins / o.runs : null,
        avg_hp: avgHp, avg_turns: o.tN ? o.tSum / o.tN : null,
        base_avg_hp: baseHp, baseWinrate: o.bwN ? o.bwSum / o.bwN : null,
        deltaPp: o.dwN ? (o.dwSum / o.dwN) * 100 : null,
        hpDelta: avgHp != null && baseHp != null ? avgHp - baseHp : null,
        plays: p.plays || 0, damage: p.damage ?? null,
        damagePerPlay: p.plays && p.damage ? p.damage / p.plays : null,
        playsPerRun: o.runs ? (p.plays || 0) / o.runs : null,
      };
    });

    return {
      label: byLabel || null,
      baseline: {
        rows: baselineRows,
        totals: {
          encounters: baselineRows.length,
          jobs: baselineRows.reduce((n, r) => n + (r.jobs || 0), 0),
          runs: bl.runs, wins: bl.wins, winrate: bl.runs ? bl.wins / bl.runs : null,
          avg_hp: bl.hpN ? bl.hpSum / bl.hpN : null,
          avg_turns: bl.tN ? bl.tSum / bl.tN : null,
        },
      },
      cards,
    };
  }

  /* ---------- 文件夹（归类路径） ---------- */

  const insFolder = db.prepare(`INSERT OR IGNORE INTO folders (path, sort_order, created_at)
    VALUES (?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM folders), ?)`);

  /** 建 path 和它的每一级上级（'a/b/c' → a、a/b、a/b/c）。 */
  function ensureFolder(raw) {
    const p = normalizePath(raw);
    if (!p) return '';
    let cur = '';
    for (const seg of p.split('/')) {
      cur = cur ? `${cur}/${seg}` : seg;
      insFolder.run(cur, new Date().toISOString());
    }
    return p;
  }

  /**
   * 文件夹树的数据。每个路径都带「里面有多少次 / 多少局」，子目录的算进上级
   * （和资源管理器一样）。空文件夹也要出现在树里，所以 folders 表单独存。
   */
  function folderTree() {
    const counts = new Map();
    const add = (p, runs) => {
      const o = counts.get(p) || { jobs: 0, runs: 0 };
      o.jobs += 1; o.runs += runs || 0;
      counts.set(p, o);
    };
    for (const r of db.prepare("SELECT label, COALESCE(total_runs,0) runs FROM jobs WHERE label IS NOT NULL AND label <> ''").all()) {
      const p = normalizePath(r.label);
      if (!p) continue;
      let cur = '';
      for (const seg of p.split('/')) { cur = cur ? `${cur}/${seg}` : seg; add(cur, r.runs); }
    }
    for (const f of db.prepare('SELECT path FROM folders').all()) {
      const p = normalizePath(f.path);
      if (p && !counts.has(p)) counts.set(p, { jobs: 0, runs: 0 });
    }
    const order = new Map(db.prepare('SELECT path, COALESCE(sort_order, 999999) s FROM folders').all().map(f => [f.path, f.s]));
    const un = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_runs),0) runs FROM jobs WHERE label IS NULL OR label = ''").get();
    const tot = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total_runs),0) runs FROM jobs').get();
    return {
      rows: [...counts.entries()]
        .map(([path, c]) => ({ path, jobs: c.jobs, runs: c.runs, order: order.has(path) ? order.get(path) : 999999 }))
        .sort((a, b) => (a.order - b.order) || a.path.localeCompare(b.path, 'zh')),
      unlabeled: { jobs: un.n || 0, runs: un.runs || 0 },
      total: { jobs: tot.n || 0, runs: tot.runs || 0 },
    };
  }

  /** 同级文件夹往上/往下挪一格（delta = -1 / +1），存进 folders.sort_order。 */
  function moveFolderOrder(rawPath, delta) {
    const p = normalizePath(rawPath);
    if (!p) return { ok: false, error: '没给路径' };
    if (!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(p)) return { ok: false, error: '这个文件夹不在表里' };
    const cut = p.lastIndexOf('/');
    const parent = cut >= 0 ? p.slice(0, cut) : '';
    let sibs;
    if (parent) sibs = db.prepare("SELECT path FROM folders WHERE path LIKE ? AND path NOT LIKE ?").all(parent + '/%', parent + '/%/%');
    else sibs = db.prepare("SELECT path FROM folders WHERE instr(path, '/') = 0").all();
    const rows = sibs.map(r => r.path)
      .map(path => ({ path, s: db.prepare('SELECT COALESCE(sort_order, 999999) s FROM folders WHERE path = ?').get(path).s }))
      .sort((a, b) => (a.s - b.s) || a.path.localeCompare(b.path, 'zh'));
    const i = rows.findIndex(r => r.path === p);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0) return { ok: false, error: '没找到这个文件夹' };
    if (j < 0 || j >= rows.length) return { ok: true, path: p, moved: false };
    const setOne = db.prepare('UPDATE folders SET sort_order = ? WHERE path = ?');
    db.exec('BEGIN');
    try {
      rows.forEach((r, k) => setOne.run(k + 1, r.path));
      const a = rows[i].path, b = rows[j].path;
      setOne.run(j + 1, a); setOne.run(i + 1, b);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true, path: p, moved: true };
  }

  function addFolder(raw) {
    const p = normalizePath(raw);
    if (!p) return { ok: false, error: '文件夹名不能是空的' };
    if (p.length > 120) return { ok: false, error: '名字太长了（最多 120 字）' };
    ensureFolder(p);
    return { ok: true, path: p };
  }

  function removeFolder(raw) {
    const p = normalizePath(raw);
    if (!p) return { ok: false, error: '没给路径' };
    const inside = db.prepare('SELECT COUNT(*) n FROM jobs WHERE label = ? OR label LIKE ?').get(p, p + '/%').n || 0;
    if (inside) return { ok: false, error: `这个文件夹里还有 ${inside} 次记录，先把它们拖走再删` };
    const sub = db.prepare('SELECT COUNT(*) n FROM folders WHERE path LIKE ?').get(p + '/%').n || 0;
    if (sub) return { ok: false, error: `里面还有 ${sub} 个子文件夹` };
    db.prepare('DELETE FROM folders WHERE path = ?').run(p);
    return { ok: true, path: p };
  }

  /** 改名 / 挪位置：自己和所有子路径、以及里面记录的 label 一起改。 */
  function renameFolder(rawFrom, rawTo) {
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    if (!from || !to) return { ok: false, error: '前后路径都不能空着' };
    if (from === to) return { ok: true, path: to };
    if (to.startsWith(from + '/')) return { ok: false, error: '不能把文件夹挪进它自己里面' };
    if (db.prepare('SELECT 1 FROM folders WHERE path = ?').get(to)) return { ok: false, error: '目标文件夹已经存在了' };
    db.exec('BEGIN');
    try {
      for (const r of db.prepare('SELECT path FROM folders WHERE path = ? OR path LIKE ?').all(from, from + '/%')) {
        const np = to + r.path.slice(from.length);
        db.prepare('DELETE FROM folders WHERE path = ?').run(r.path);
        ensureFolder(np);
      }
      for (const j of db.prepare('SELECT id, label FROM jobs WHERE label = ? OR label LIKE ?').all(from, from + '/%')) {
        db.prepare('UPDATE jobs SET label = ? WHERE id = ?').run(to + j.label.slice(from.length), j.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true, path: to };
  }

  // 给若干次测算打归类标签；label 传空字符串表示清掉
  function setJobLabel(ids, label) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return 0;
    const name = String(label == null ? '' : label).trim().slice(0, 60) || null;
    // 拖进文件夹 = 打 label；顺手把这一路的文件夹记下来（不然空目录下次就没了）
    if (name) ensureFolder(name);
    const stmt = db.prepare('UPDATE jobs SET label = ? WHERE id = ?');
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const id of list) n += stmt.run(name, id).changes;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return n;
  }

  function deleteJob(id) {
    db.exec('BEGIN');
    try { purgeJob(id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return true;
  }

  function clearAll() {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of ['card_stats', 'damage_turns', 'samples', 'variants', 'jobs']) db.exec('DELETE FROM ' + t);
    db.exec('PRAGMA foreign_keys = ON');
    return true;
  }

  const getSetting = k => {
    const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
    return r ? r.v : null;
  };
  const setSetting = (k, v) => {
    db.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
    return true;
  };

  return {
    path: dbPath, db,
    recordJob, splitJobs, importRuns, importCsv,
    stats, listJobs, jobDetail, encounters, cards, trend, cardByEncounter, cardFolders, cardOverview,
    folders: folderTree, addFolder, removeFolder, renameFolder, moveFolderOrder,
    deleteJob, clearAll, getSetting, setSetting, setJobLabel,
    close: () => { try { db.close(); } catch { } },
  };
}

export default { createStore };
