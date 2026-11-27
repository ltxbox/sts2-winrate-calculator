/**
 * ui-range-check.mjs —— 实跑一局，然后把结果区截下来，确认「预估掉血 x–y」真的显示出来。
 * 用法：node tools/ui-range-check.mjs
 * 产出：_range.png + 控制台打印结果区文字
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8766';
const PORT = 9334;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-range');
const SHOT = path.join(DIR, '_range.png');

const deck = [
  { cardId: 'DEFEND_SILENT', count: 3, upgradeLevels: 0, enchCount: 0 },
  { cardId: 'DEFEND_SILENT', count: 1, upgradeLevels: 0, enchantmentId: 'SPIRAL', enchCount: 1 },
  { cardId: 'NEUTRALIZE', count: 1, upgradeLevels: 1 },
  { cardId: 'STRIKE_SILENT', count: 3, upgradeLevels: 0 },
  { cardId: 'SURVIVOR', count: 1, upgradeLevels: 0 },
  { cardId: 'ASCENDERS_BANE', count: 1, upgradeLevels: 0 },
  { cardId: 'SLICE', count: 1, upgradeLevels: 1 },
  { cardId: 'CLOAK_AND_DAGGER', count: 1, upgradeLevels: 1 },
];
const body = {
  deck, relics: [], potions: [], encounter: 'SKULKING_COLONY_ELITE', character: 'SILENT',
  ascension: 10, actIndex: 0, hp: 40, maxHp: 70, count: 6, prefix: 'RANGE',
  potionPolicy: 'Smart', concurrency: 3, profile: 'VeryHigh', beam: 60, nodes: 20000, budget: 2500,
};

const sub = await (await fetch(`${BASE}/api/solve`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();
console.log('job =', sub.id);

let job = null;
for (let i = 0; i < 60; i++) {
  job = await (await fetch(`${BASE}/api/job/${sub.id}`)).json();
  if (job.status === 'done' || job.status === 'failed') break;
  await sleep(1000);
}
const v = (job.variants || [])[0] || {};
const s = v.summary || {};
console.log('服务端 summary:', JSON.stringify({ runs: s.runs, wins: s.wins, avg: s.avgHpLost, min: s.minHpLost, max: s.maxHpLost }));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1500,1000',
  'about:blank',
], { stdio: 'ignore' });

let ws = null;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!ver) throw new Error('Chrome 没起来');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState==='complete' && typeof renderResults==='function'").catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('页面没起来');

  const stats = await evaluate(`(async () => {
    const j = await (await fetch('/api/job/${sub.id}')).json();
    state.lastJob = { id: j.id, mode: 'single' };
    renderResults(j);
    return document.querySelector('#resultStats').innerText;
  })()`);
  console.log('结果区文字:\n' + stats);
  const rowsDump = await evaluate("Array.from(document.querySelectorAll('#resultList > *')).map(e => e.className + ' | ' + e.innerText.replace(/\\n/g,' / '))");
  console.log('行数', rowsDump.length);
  for (const r of rowsDump) console.log('  ', r);

  const hasRange = /预估掉血\s*\d+(–\d+)?/.test(stats);
  console.log(hasRange ? '✔ 有「预估掉血 区间」' : '✘ 没看到区间');
  const ok = (s.minHpLost != null && s.maxHpLost != null && stats.includes(String(s.minHpLost)) && stats.includes(String(s.maxHpLost)));
  console.log(ok ? '✔ 区间端点和服务端 min/max 一致' : `✘ 区间端点对不上（min=${s.minHpLost} max=${s.maxHpLost}）`);

  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', SHOT);
  if (!hasRange || !ok) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
