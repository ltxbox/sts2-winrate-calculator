/**
 * ui-compare-check.mjs —— 验证「三卡对比」在 1920×1030 窗口（视口 1792×961）里一屏放得下、不用滚。
 * 用法：先起一个服务（默认 8906），再 node tools/ui-compare-check.mjs
 * 产出：_compare.png + 控制台结论
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.CMP_BASE || 'http://127.0.0.1:8906';
const PORT = 9338;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-cmp');
const SHOT = path.join(DIR, '_compare.png');
const VW = 1792, VH = 961;
const CARDS = ['DRAIN_POWER', 'DELAY', 'INVOKE'];

const fails = [];
const check = (ok, msg, extra) => {
  console.log((ok ? '✔ ' : '✘ ') + msg + (extra ? `  ${extra}` : ''));
  if (!ok) fails.push(msg);
};

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--window-size=${VW},${VH}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws = null;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
  if (!ver) throw new Error('Chrome 没起来');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await ev("document.readyState==='complete' && typeof renderCompare==='function' && (state.dreadList||[]).length>0").catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('页面没起来');

  // 造一份 12 张牌的小卡组（和用户截图里的情形接近），切到对比页
  await ev(`(() => {
    state.deck = [
      {cardId:'DEFEND_SILENT',count:4,upgradeLevels:0},
      {cardId:'STRIKE_SILENT',count:4,upgradeLevels:0},
      {cardId:'SURVIVOR',count:1,upgradeLevels:0},
      {cardId:'NEUTRALIZE',count:1,upgradeLevels:1},
      {cardId:'ASCENDERS_BANE',count:1,upgradeLevels:0},
      {cardId:'SLICE',count:1,upgradeLevels:1},
    ];
    state.hp = 52; state.maxHp = 66; state.ascension = 10;
    state.encounter = 'SKULKING_COLONY_ELITE';
    state.cmpCards = ${JSON.stringify(CARDS.map(id => ({ cardId: id, upgradeLevels: 0 })))};
    const btn = Array.from(document.querySelectorAll('.modes button')).find(b => /三卡对比/.test(b.textContent));
    if (btn) btn.click();
    renderCmpSlots(); renderCmpState();
    document.querySelector('#cmpBudget').value = '3000';
    document.querySelector('#count').value = '6'; state.count = 6;
  })()`);
  await sleep(300);

  const layoutBefore = await ev(`(() => {
    const r = document.querySelector('#cmpResult');
    return { cats: document.querySelector('#modeCompare')?.className, cols: getComputedStyle(document.querySelector('#modeCompare')).gridTemplateColumns };
  })()`);
  console.log('对比页列宽:', layoutBefore.cols);

  await ev("document.querySelector('#cmpRun').click()");
  let done = false;
  for (let i = 0; i < 180 && !done; i++) {
    await sleep(1000);
    done = await ev("!!document.querySelector('#cmpResult .cmp-cards')");
  }
  if (!done) throw new Error('对比没出结果（看服务端日志）');

  const m = await ev(`(() => {
    const box = document.querySelector('#cmpResult');
    const cards = Array.from(document.querySelectorAll('#cmpResult .cmp-card'));
    const vh = window.innerHeight;
    const rects = cards.map(c => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) }; });
    return {
      vh,
      pageScroll: document.documentElement.scrollHeight,
      boxScroll: { sh: box.scrollHeight, ch: box.clientHeight },
      cards: cards.length,
      rects,
      verdict: document.querySelector('#cmpResult .verdict')?.innerText || '',
      cols: getComputedStyle(document.querySelector('#cmpResult .cmp-cards')).gridTemplateColumns,
      pies: document.querySelectorAll('#cmpResult .cmp-mini .pie').length,
    };
  })()`);
  console.log('卡片位置:', JSON.stringify(m.rects));
  console.log('卡片列数:', m.cols);
  console.log('结论:', m.verdict.trim());

  check(m.cards === 4, '基线 + 3 张候选都渲染出来了', `${m.cards} 张`);
  check(m.pageScroll <= m.vh + 2, '整页不用滚', `页面高 ${m.pageScroll} / 视口 ${m.vh}`);
  check(m.boxScroll.sh <= m.boxScroll.ch + 2, '结果区不用滚', `内容 ${m.boxScroll.sh} / 容器 ${m.boxScroll.ch}`);
  check(m.rects.every(r => r.bottom <= m.vh + 2), '四张卡片都在一屏里', JSON.stringify(m.rects.map(r => r.bottom)));
  check(m.rects.every(r => r.w >= 280), '卡片没有被挤扁', m.rects.map(r => r.w).join('/'));
  check(m.pies >= 1, '基线卡片带归因图', `${m.pies} 个`);
  const hs = m.rects.map(r => r.bottom - r.top);
  check(Math.max(...hs) - Math.min(...hs) <= 2, '四张卡片高度对齐', hs.join('/'));
  check(/最稳的是/.test(m.verdict), '结论句还在');

  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', SHOT);

  // ---- 升级 vs 睡觉：同样的「一屏」要求 ----
  await ev(`(() => {
    const btn = Array.from(document.querySelectorAll('.modes button')).find(b => /升级/.test(b.textContent));
    if (btn) btn.click();
    const sel = document.querySelector('#restCard');
    if (sel && sel.options.length) sel.selectedIndex = 1;
    document.querySelector('#restBudget').value = '3000';
    renderRestPanel(); renderRestState();
  })()`);
  await sleep(300);
  await ev("document.querySelector('#restRun').click()");
  let restDone = false;
  for (let i = 0; i < 180 && !restDone; i++) {
    await sleep(1000);
    restDone = await ev("!!document.querySelector('#restResult .cmp-cards')");
  }
  if (!restDone) throw new Error('升级/睡觉对比没出结果');
  const r = await ev(`(() => {
    const box = document.querySelector('#restResult');
    const cards = Array.from(document.querySelectorAll('#restResult .cmp-card'));
    const vh = window.innerHeight;
    return {
      vh, cards: cards.length,
      rects: cards.map(c => { const b = c.getBoundingClientRect(); return { bottom: Math.round(b.bottom), w: Math.round(b.width) }; }),
      page: document.documentElement.scrollHeight,
      box: { sh: box.scrollHeight, ch: box.clientHeight },
    };
  })()`);
  console.log('升级/睡觉卡片:', JSON.stringify(r.rects));
  check(r.cards === 2, '升级 vs 睡觉 两张卡片都在', `${r.cards} 张`);
  check(r.page <= r.vh + 2, '升级页整页不用滚', `${r.page} / ${r.vh}`);
  check(r.box.sh <= r.box.ch + 2, '升级页结果区不用滚', `${r.box.sh} / ${r.box.ch}`);
  check(r.rects.every(x => x.bottom <= r.vh + 2), '升级页卡片在一屏里');

  await sleep(300);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT.replace('_compare.png', '_compare-rest.png'), Buffer.from(shot2.result.data, 'base64'));

  console.log(fails.length ? `✘ ${fails.length} 项没过：${fails.join(' / ')}` : '✔ 全部通过');
  if (fails.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
