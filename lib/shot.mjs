// STS2 截图导入：OCR 文本 -> 卡组
// 依赖 data/ocr-lines.ps1（Windows 自带 OCR + 坐标）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'meta.json'), 'utf8'));
const CARDS = META.cards || [];
const CHARS = ['DEFECT', 'FOOL', 'IRONCLAD', 'NECROBINDER', 'REGENT', 'SILENT'];
const UP = ['+', '＋'];
const PUNCT = '。，、！？；：…';
const CHAR_NAME_TO_ID = {};
for (const c of META.characters || []) if (c.name) CHAR_NAME_TO_ID[c.name] = c.id;

let hpCache = null;
function charHp() {
  if (hpCache) return hpCache;
  try { hpCache = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'character_hp.json'), 'utf8')); }
  catch { hpCache = {}; }
  return hpCache;
}

export const squash = s => String(s || '').replace(/[\s\u3000]+/g, '');

function normNoUp(s) {
  let t = squash(s);
  while (t && UP.includes(t[t.length - 1])) t = t.slice(0, -1);
  return t;
}

function levenshtein(a, b) {
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

function ratio(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export function nameScore(query, name) {
  const q = normNoUp(query);
  const n = squash(name);
  if (!q || !n) return 0;
  const q2 = q.replace(/^[0-9]?[xX×]?/, '');
  let best = 0;
  for (const cand of [q, q2]) {
    if (!cand) continue;
    if (cand === n) best = Math.max(best, 1);
    else if (cand.includes(n)) best = Math.max(best, 0.85 + 0.15 * Math.min(1, n.length / cand.length));
    else if (n.includes(cand) && cand.length >= 2) best = Math.max(best, 0.8 + 0.15 * cand.length / n.length);
    else best = Math.max(best, ratio(n, cand));
  }
  return best;
}

function descScore(query, desc) {
  const q = squash(query);
  const d = squash(desc);
  if (!q || !d || q.length < 4) return 0;
  return ratio(d, q);
}

const UI_WORDS = ['获得顺序', '类型', '耗能', '拼音顺序', '移除费用', '查看升级', '你在战斗中',
  '分享', '单人游戏', '种子', '图例', '未知', '商人', '宝箱', '休息', '敌人', '精英', 'MODDED', 'HASH'];
const TYPE_WORDS = new Set(['攻击', '技能', '能力', '诅咒', '状态', '虚无', '永恒', '保留']);

const isUi = t => {
  const s = squash(t);
  if (!s) return true;
  if (UI_WORDS.some(w => s.includes(w))) return true;
  return /^[0-9Vv:.%/\-| ]+$/.test(s);
};
const isDesc = t => PUNCT.split('').some(p => (t || '').includes(p));
const isTypeLabel = t => TYPE_WORDS.has(squash(t));

const COUNT_RE = /^\s*(\d{1,2})\s*[xX×*]\s*(.+)$/s;

/** 清洗 OCR 卡名块；返回 {name, count}，不像卡名返回 null */
export function cleanName(t) {
  const base = squash(t);
  const variants = [base];
  if (/^[A-Za-z]/.test(base)) variants.push(base.slice(1));
  for (const v of variants) {
    let s = v;
    let count = 1;
    const m = COUNT_RE.exec(s);
    if (m) { count = Math.max(1, Math.min(20, Number(m[1]))); s = m[2]; }
    s = s.replace(/^[0-9]{1,2}[xX×]/, '');
    s = s.replace(/^[0-9]/, '');
    if (!/^[\u4e00-\u9fa5A-Za-z+\-]{1,8}$/.test(s)) continue;
    if (isTypeLabel(s)) continue;
    return { name: s, count };
  }
  return null;
}

export function inferRole(allText) {
  const hp = charHp();
  for (const [nm, cid] of Object.entries(CHAR_NAME_TO_ID)) {
    if (nm && allText.includes(nm) && CHARS.includes(cid)) return { role: cid, why: '角色名' };
  }
  const byVal = new Map();
  for (const [k, v] of Object.entries(hp)) {
    if (!byVal.has(Number(v))) byVal.set(Number(v), []);
    byVal.get(Number(v)).push(k);
  }
  const re = /(\d{1,3})\s*\/\s*(\d{2,3})/g;
  let m;
  while ((m = re.exec(allText))) {
    const mx = Number(m[2]);
    const hits = byVal.get(mx) || [];
    if (hits.length === 1 && CHARS.includes(hits[0])) return { role: hits[0], why: `血量上限 ${mx}` };
  }
  return { role: null, why: null };
}

function scoreCards(nameText, descText, role) {
  const up = !!nameText && UP.includes(nameText[nameText.length - 1]);
  const res = [];
  for (const c of CARDS) {
    const ns = nameText ? nameScore(nameText, c.name) : 0;
    const ds = descText ? descScore(descText, c.desc) : 0;
    let sc;
    if (nameText && descText && ds >= 0.35) sc = 0.55 * ns + 0.45 * ds;
    else if (nameText) sc = ns;
    else sc = ds;
    if (!nameText && ds < 0.5) continue;
    if (nameText && ns < 0.45) continue;
    if (role) {
      const suf = String(c.id || '').split('_').pop();
      if (suf === role) sc = Math.min(1, sc * 1.12);
      else if (CHARS.includes(suf)) sc *= 0.55;
    }
    res.push({ sc, ns, ds, c });
  }
  res.sort((a, b) => b.sc - a.sc);
  const seen = new Set();
  const out = [];
  for (const r of res) {
    if (seen.has(r.c.id)) continue;
    seen.add(r.c.id);
    out.push(r);
    if (out.length >= 5) break;
  }
  return { top: out, up };
}

function groupRows(lines, tol = 16) {
  const rows = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = null;
    for (const r of rows) if (Math.abs(r.cy - l.cy) <= tol) { row = r; break; }
    if (row) {
      row.lines.push(l);
      row.cy = row.lines.reduce((s, x) => s + x.cy, 0) / row.lines.length;
    } else rows.push({ cy: l.cy, lines: [l] });
  }
  for (const r of rows) r.lines.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => a.cy - b.cy);
}

function clusterBlocks(blocks, xtol = 120, ytol = 110) {
  const groups = [];
  for (const b of [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let g = null;
    for (const x of groups) if (Math.abs(x.cx - b.cx) < xtol && Math.abs(x.cy - b.cy) < ytol) { g = x; break; }
    if (g) {
      g.blocks.push(b);
      g.cx = g.blocks.reduce((s, t) => s + t.cx, 0) / g.blocks.length;
      g.cy = g.blocks.reduce((s, t) => s + t.cy, 0) / g.blocks.length;
    } else groups.push({ cx: b.cx, cy: b.cy, blocks: [b] });
  }
  for (const g of groups) g.text = g.blocks.sort((a, b) => a.y - b.y).map(b => squash(b.text)).join('');
  return groups;
}

function lineBoxes(ocr) {
  const out = [];
  for (const ln of (ocr.lines || [])) {
    const ws = ln.words || [];
    if (!ws.length) continue;
    const x = Math.min(...ws.map(w => w.x));
    const y = Math.min(...ws.map(w => w.y));
    const x2 = Math.max(...ws.map(w => w.x + w.w));
    const y2 = Math.max(...ws.map(w => w.y + w.h));
    out.push({ text: ln.text, x, y, x2, y2, cx: (x + x2) / 2, cy: (y + y2) / 2 });
  }
  return out;
}

/** ocr = {scale, lines:[{text, words:[{t,x,y,w,h}]}]} 或 {boxes:[...]}（已算好的行） */
export function analyzeOcr(ocr) {
  const lines = ocr.boxes || lineBoxes(ocr);
  const kept = lines.filter(l => squash(l.text) && !isUi(l.text));
  const rows = groupRows(kept);

  const nameRows = [];
  for (const r of rows) {
    const blks = r.lines.filter(b => !isDesc(b.text) && !isTypeLabel(b.text));
    if (blks.length >= 1 && Math.max(...blks.map(b => squash(b.text).length)) <= 8) nameRows.push(r);
  }
  const nameRowSet = new Set(nameRows);
  const nameBlocks = nameRows.flatMap(r => r.lines.filter(b => !isDesc(b.text) && !isTypeLabel(b.text)));
  const descBlocks = rows.filter(r => !nameRowSet.has(r)).flatMap(r => r.lines)
    .filter(b => !isTypeLabel(b.text) && !isUi(b.text));

  const allText = kept.map(l => squash(l.text)).join('');
  const { role, why } = inferRole(allText);
  const groups = clusterBlocks(descBlocks);
  const used = new Set();
  const cards = [];
  const warnings = [];

  for (const n of nameBlocks) {
    const raw = squash(n.text);
    const cn = cleanName(n.text);
    if (!cn) continue;
    const txt = cn.name;
    const count = cn.count;
    const near = groups
      .filter(g => !used.has(g) && g.cy > n.y + 10 && g.cy < n.y + 320 && Math.abs(g.cx - n.cx) < 140)
      .sort((a, b) => a.cy - b.cy);
    near.forEach(g => used.add(g));
    const desc = near.map(g => g.text).join('');
    const { top, up } = scoreCards(txt, desc, role);
    if (!top.length) {
      cards.push({ cardId: null, name: null, up, count, conf: 0, raw, alts: [] });
      continue;
    }
    const best = top[0];
    cards.push({
      cardId: best.c.id, name: best.c.name, up, count,
      conf: Math.round(best.sc * 1000) / 1000,
      raw, desc: desc.slice(0, 80),
      alts: top.slice(1, 4).map(t => ({ id: t.c.id, name: t.c.name, score: Math.round(t.sc * 1000) / 1000 })),
    });
    if (best.sc < 0.7) warnings.push(`「${raw}」不太确定（${Math.round(best.sc * 100)}%）`);
  }

  for (const g of groups) {
    if (used.has(g) || g.text.length < 4) continue;
    const { top } = scoreCards('', g.text, role);
    if (!top.length || top[0].sc < 0.62) continue;
    const best = top[0];
    cards.push({
      cardId: best.c.id, name: best.c.name, up: false, count: 1,
      conf: Math.round(best.sc * 1000) / 1000, raw: '', desc: g.text.slice(0, 80), onlyDesc: true,
      alts: top.slice(1, 4).map(t => ({ id: t.c.id, name: t.c.name, score: Math.round(t.sc * 1000) / 1000 })),
    });
    warnings.push(`有一张只认出描述、没认出名字：「${best.c.name}」（请核对）`);
  }

  const merged = new Map();
  for (const c of cards) {
    if (!c.cardId) continue;
    // 低置信度的行不并进同名卡：它更可能是认错了，单独列出来让用户确认/删掉
    const k = `${c.cardId}|${c.up ? 1 : 0}|${c.conf < 0.8 ? '?' : ''}`;
    if (!merged.has(k)) merged.set(k, { ...c, count: 0 });
    const m = merged.get(k);
    m.count += c.count || 1;
    m.conf = Math.min(m.conf, c.conf);
    if (c.raw && c.raw !== m.raw) m.raws = [...(m.raws || [m.raw]), c.raw];
  }
  const deck = [...merged.values()].sort((a, b) => (a.conf < b.conf ? -1 : 1));
  const unknown = cards.filter(c => !c.cardId);
  // 卡组浏览页每张卡都有 1–3 行描述（几十块）；结算页只有零星噪声块（个位数）。
  const kind = descBlocks.length >= 15 ? 'deck' : 'history';
  return { role, roleWhy: why, kind, cards: deck, unknown, warnings, lineCount: kept.length };
}

export function ocrLines(file) {
  const ps = path.join(ROOT, 'data', 'ocr-lines.ps1');
  const out = file + '.json';
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps,
    '-ImagePath', file, '-OutJson', out, '-Lang', 'zh-Hans-CN', '-Scale', '2'],
    { timeout: 120000, windowsHide: true, stdio: 'pipe' });
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  try { fs.unlinkSync(out); } catch { }
  return data;
}

/** 卡组浏览页：把四行卡名的窄条裁出来各自放大 3 倍再 OCR。
 *  整图 OCR 在卡变小后会整行漏掉 2 字短名（打击/防御），裁条能稳定读出来。 */
export function ocrNameRows(file) {
  const ps = path.join(ROOT, 'data', 'ocr-namerows.ps1');
  const out = file + '.rows.json';
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps,
    '-ImagePath', file, '-OutJson', out, '-Lang', 'zh-Hans-CN', '-Zoom', '3'],
    { timeout: 180000, windowsHide: true, stdio: 'pipe' });
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  try { fs.unlinkSync(out); } catch { }
  const lines = [];
  for (const row of data.rows || []) for (const ln of row.lines || []) lines.push(ln);
  return { scale: data.scale, lines };
}

/** 截图导入入口：整图 OCR → 若是卡组浏览页，再补一遍卡名条 OCR 并合并。 */
export function analyzeImage(file) {
  const ocr = ocrLines(file);
  const first = analyzeOcr(ocr);
  if (first.kind !== 'deck') return first;
  let extra;
  try { extra = ocrNameRows(file); } catch { return first; }
  const base = lineBoxes(ocr);
  const key = l => squash(l.text) + '@' + Math.round(l.cx / 10) + ',' + Math.round(l.cy / 10);
  const seen = new Set(base.map(key));
  const boxes = base.slice();
  for (const l of lineBoxes(extra)) {
    const k = key(l);
    if (seen.has(k)) continue;
    seen.add(k);
    boxes.push(l);
  }
  const r = analyzeOcr({ boxes });
  r.nameRows = true;
  r.linesAdded = boxes.length - base.length;
  return r;
}
