/**
 * ui-compare-check.mjs —— 验证「自选对比 1–10 张」+「药水最多 10 瓶」：
 *   1) 切到自选对比，一开始 3 个空槽，标题写着 1–10 张
 *   2) 点卡池能一直加到 10 张，第 11 张被拦
 *   3) 真的跑一次 10 张候选的对比：结果 11 张卡（基线 + 10），没报错
 *   4) 选药水弹窗能加 10 瓶，第 11 瓶被拦
 *   5) 真的跑一局带 10 瓶药水的单场测算（证明模拟器吃得下，不只 UI 放开）
 *   6) 全程没有 JS 报错
 * 用法：node tools/ui-compare-check.mjs [url]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9342;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-cmp');
const SHOT = path.join(DIR, '_cmp.png');

const fails = [];
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails.push(msg);
};

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' });

let ws = null;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!ver) throw new Error('Chrome 没起来（CDP 端口不通）');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    const missingArt = t => /\/assets\/(cards|relics)\//.test(t);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'
      && !(missingArt(m.params.entry.url || '') || missingArt(m.params.entry.text || ''))) {
      consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(200);
    }
    return false;
  };
  const pageReady = () => evaluate("document.readyState==='complete' && typeof DeckLogic==='object' && document.querySelectorAll('.deck-item').length>0").catch(() => false);

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: URL });
  await sleep(800);
  for (let i = 0; i < 60 && !(await pageReady()); i++) await sleep(250);
  // 清掉上次的状态，从干净的开始
  await evaluate("try { localStorage.removeItem('sts2-ui.v1'); } catch (e) {}");
  await send('Page.reload', { ignoreCache: true });
  await sleep(600);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { ready = await pageReady(); if (!ready) await sleep(250); }
  ok(ready, '页面起来、卡组渲染出来了');

  // ---------- 1) 切到自选对比 ----------
  const initial = await evaluate(`(() => {
    document.querySelector('[data-mode=compare]').click();
    return {
      title: document.querySelector('#modeCompare .panel-head h3').textContent,
      slots: document.querySelectorAll('#cmpSlots .slot').length,
      empty: document.querySelectorAll('#cmpSlots .slot.empty').length,
      hint: document.querySelector('#modeCompare .hint-line').textContent,
    };
  })()`);
  ok(initial.title.includes('1–10'), '候选卡标题写的是 1–10 张', initial.title);
  ok(initial.slots === 3 && initial.empty === 3, '一开始摆 3 个空槽', `${initial.slots} 槽 / ${initial.empty} 空`);

  // ---------- 2) 加到 10 张，第 11 张被拦 ----------
  const added = await evaluate(`(async () => {
    const pool = document.querySelector('#cmpPool');
    const ids = [...pool.querySelectorAll('.card-item')].map(el => el.dataset.id);
    const alertMsgs = [];
    const origAlert = window.alert; window.alert = m => alertMsgs.push(String(m));
    for (let i = 0; i < 10; i++) pool.querySelector('.card-item[data-id="' + ids[i] + '"]').click();
    const at10 = { cards: state.cmpCards.length, slots: document.querySelectorAll('#cmpSlots .slot').length, empty: document.querySelectorAll('#cmpSlots .slot.empty').length };
    const extraIds = ids.slice(10);
    let blocked = false;
    if (extraIds.length) { pool.querySelector('.card-item[data-id="' + extraIds[0] + '"]').click(); blocked = state.cmpCards.length === 10; }
    window.alert = origAlert;
    return { at10, blocked, alertMsgs, ids: ids.slice(0, 6) };
  })()`);
  ok(added.at10.cards === 10 && added.at10.slots === 10 && added.at10.empty === 0, '能加到 10 张（槽数跟着长、没有空槽）', JSON.stringify(added.at10));
  ok(added.blocked && added.alertMsgs.some(m => m.includes('10')), '第 11 张被拦下', added.alertMsgs.join(' / '));

  // ---------- 3) 真跑一次 10 张候选的对比 ----------
  await evaluate(`(() => {
    document.querySelector('#count').value = '3';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#cmpBudget').value = '3000';
  })()`);
  const cmpJob = await evaluate(`(async () => {
    document.querySelector('#cmpRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) {
        const j = await (await fetch('/api/job/' + id)).json();
        if (j.status !== 'running') return { status: j.status, total: j.total, variants: j.variants ? j.variants.length : 0, err: j.error || '' };
      }
      await new Promise(r => setTimeout(r, 700));
    }
    return { status: 'timeout' };
  })()`);
  ok(cmpJob.status === 'done' && cmpJob.variants === 11, '10 张候选真的跑完（基线 + 10）', `status=${cmpJob.status} variants=${cmpJob.variants} total=${cmpJob.total}`);
  await sleep(600);
  const rendered = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#cmpResult .cmp-card')];
    const deltas = cards.slice(1).map(c => (c.querySelector('.delta') || {}).textContent || '');
    return { cards: cards.length, baselineDelta: (cards[0] && cards[0].querySelector('.delta') || {}).textContent || '', delta: deltas[0] || '', texts: cards.slice(0, 3).map(c => (c.querySelector('.who') || {}).textContent) };
  })()`);
  ok(rendered.cards === 11, '结果区画出 11 张卡', `${rendered.cards} 张`);
  ok(/基线（不放牌）/.test(rendered.baselineDelta), '基线卡写的是「基线（不放牌）」', rendered.baselineDelta);
  ok(/比不放/.test(rendered.delta), '每张卡都写了「比不放 ±x.xpp」', rendered.delta);

  // ---------- 4) 药水加到 10 瓶，第 11 瓶被拦 ----------
  const potions = await evaluate(`(() => {
    document.querySelector('[data-mode=single]').click();
    document.querySelector('#addPotion').click();
    const grid = document.querySelector('#potionGrid');
    const opts = [...grid.querySelectorAll('.potion-opt')].map(el => el.dataset.id);
    for (let i = 0; i < 10; i++) grid.querySelector('.potion-opt[data-id="' + opts[i] + '"]').click();
    const at10 = { chips: document.querySelectorAll('#potionList .chip').length, count: state.potions.length, label: document.querySelector('#potionDlgCount').textContent };
    let blocked = false, msg = '';
    if (opts.length > 10) {
      grid.querySelector('.potion-opt[data-id="' + opts[10] + '"]').click();
      blocked = state.potions.length === 10;
      msg = document.querySelector('#potionDlgCount').textContent;
    }
    document.querySelector('#potionDlgClose').click();
    return { at10, blocked, msg, ids: opts.slice(0, 10) };
  })()`);
  ok(potions.at10.count === 10 && potions.at10.chips === 10, '药水能加到 10 瓶', `chips=${potions.at10.chips} 标签=${potions.at10.label}`);
  ok(potions.blocked && /10/.test(potions.msg), '第 11 瓶被拦下', potions.msg);

  // ---------- 5) 带 10 瓶药水真跑一局 ----------
  const potionRun = await evaluate(`(async () => {
    document.querySelector('#count').value = '2';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#run').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) {
        const j = await (await fetch('/api/job/' + id)).json();
        if (j.status !== 'running') return { status: j.status, done: j.done, total: j.total, err: j.error || '', winrate: j.variants && j.variants[0] && j.variants[0].summary ? j.variants[0].summary.winrate : null };
      }
      await new Promise(r => setTimeout(r, 700));
    }
    return { status: 'timeout' };
  })()`);
  ok(potionRun.status === 'done', '带 10 瓶药水的单场测算能跑完（模拟器上限 12 瓶，没被拒）', `status=${potionRun.status} ${potionRun.done}/${potionRun.total} 胜率=${potionRun.winrate} ${potionRun.err || ''}`);

  // ---------- 6) 截图 + 无 JS 报错 ----------
  await evaluate(`document.querySelector('[data-mode=compare]').click()`);
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const fs = await import('node:fs');
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  }
  ok(consoleErrors.length === 0, '页面没有 JS 报错', consoleErrors.slice(0, 3).join(' | '));
  console.log(`\n截图：${SHOT}`);
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  if (fails.length) {
    console.log(`\n结果：${fails.length} 项没过`);
    process.exitCode = 1;
  } else {
    console.log('\n结果：全部通过');
  }
}
