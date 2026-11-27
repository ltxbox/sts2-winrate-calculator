/**
 * ui-mid-check.mjs —— 验证「中间结果栏收放」：
 *   1) 有个 ⟨ 按钮；点一下收起，左栏真的变宽（不是只加个 class）
 *   2) 收起状态刷新页面还在（存本地）
 *   3) 点竖条能展开；Alt+M 也能来回切
 *   4) 开跑自动收、跑完自动展开（真跑一局 1 样本）
 *   5) 手动收起后跑完不会被强行展开
 * 用法：node tools/ui-mid-check.mjs [url]
 * 不需要 puppeteer：Node 自带的 WebSocket 直接讲 CDP。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9339;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-mid');
const SHOT = path.join(DIR, '_mid.png');

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

  // 先把上次的布局状态清掉，保证从「展开」开始（等页面真加载到站点上再动 localStorage，否则跨源会拒）
  await send('Page.navigate', { url: URL });
  await sleep(800);
  let ready0 = false;
  for (let i = 0; i < 60 && !ready0; i++) { ready0 = await pageReady(); if (!ready0) await sleep(250); }
  await evaluate("try { localStorage.removeItem('sts2-ui.v1'); } catch (e) {}");
  await send('Page.reload', { ignoreCache: true });
  await sleep(600);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { ready = await pageReady(); if (!ready) await sleep(250); }
  ok(ready, '页面起来、卡组渲染出来了');

  const init = await evaluate(`(() => {
    const mains = [...document.querySelectorAll('main.cols')];
    const visible = mains.find(m => !m.classList.contains('hidden'));
    const deck = document.querySelector('.deck-panel');
    return {
      mains: mains.length,
      toggles: document.querySelectorAll('.mid-toggle').length,
      strips: document.querySelectorAll('.mid-strip').length,
      stripShown: (() => { const s = visible.querySelector('.mid-strip'); return !!(s && s.offsetParent); })(),
      collapsed: visible.classList.contains('mid-collapsed'),
      deckW: Math.round(deck.getBoundingClientRect().width),
    };
  })()`);
  ok(init.toggles === 4 && init.strips === 4, `四个模式都有 ⟨ 按钮和竖条`, `mains=${init.mains} toggles=${init.toggles}`);
  ok(!init.collapsed && !init.stripShown, '一开始是展开的，竖条不显示', `deck=${init.deckW}px`);

  // ---------- 1) 手动收起：左栏要真的变宽 ----------
  const collapsed = await evaluate(`(async () => {
    const deck = document.querySelector('.deck-panel');
    const before = Math.round(deck.getBoundingClientRect().width);
    document.querySelector('#modeSingle .mid-toggle').click();
    await new Promise(r => setTimeout(r, 350));
    const mid = document.querySelector('#modeSingle .mid-panel');
    return {
      before, after: Math.round(deck.getBoundingClientRect().width),
      classed: document.querySelector('#modeSingle').classList.contains('mid-collapsed'),
      midW: Math.round(mid.getBoundingClientRect().width),
      stripShown: !!(mid.querySelector('.mid-strip') && mid.querySelector('.mid-strip').offsetParent),
      headHidden: !mid.querySelector('.panel-head').offsetParent,
      hasBtn: mid.querySelector('.mid-toggle').textContent.trim(),
    };
  })()`);
  ok(collapsed.classed && collapsed.stripShown && collapsed.headHidden, '点 ⟨ 收起：中间变成竖条（栏头藏起来）', `` + JSON.stringify({ midW: collapsed.midW, btn: collapsed.hasBtn }));
  ok(collapsed.after > collapsed.before + 30, '左栏真的变宽了（不只是加了个 class）', `${collapsed.before}px → ${collapsed.after}px`);
  ok(collapsed.midW <= 60, '中间只剩一条窄带', `${collapsed.midW}px`);

  // 收起后左栏变宽 → 卡组列表应该变成多列（不然一行横跨 1100px，中间全是空的）
  const grid = await evaluate(`(() => {
    const list = document.querySelector('#modeSingle .deck-list');
    const cs = getComputedStyle(list);
    const items = [...list.querySelectorAll('.deck-item')];
    const tops = items.map(i => Math.round(i.getBoundingClientRect().top));
    const firstRow = tops.filter(t => t === tops[0]).length;
    return { cols: (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length, firstRow, listH: Math.round(list.getBoundingClientRect().height) };
  })()`);
  ok(grid.cols >= 2 && grid.firstRow >= 2, '卡组列表摊成多列（一行不再横跨整个面板）', `${grid.cols} 列，第一行 ${grid.firstRow} 张，高 ${grid.listH}px`);

  // ---------- 2) 刷新后还是收起的 ----------
  await send('Page.reload', { ignoreCache: true });
  await sleep(600);
  ready = false;
  for (let i = 0; i < 60 && !ready; i++) { ready = await pageReady(); if (!ready) await sleep(250); }
  const persisted = await evaluate(`(() => {
    const m = document.querySelector('#modeSingle');
    const deck = document.querySelector('.deck-panel');
    return { collapsed: m.classList.contains('mid-collapsed'), deckW: Math.round(deck.getBoundingClientRect().width) };
  })()`);
  ok(persisted.collapsed, '刷新页面后仍然是收起的（存本地了）', `deck=${persisted.deckW}px`);

  // ---------- 3) 点竖条展开 ----------
  const expanded = await evaluate(`(async () => {
    document.querySelector('#modeSingle .mid-strip').click();
    await new Promise(r => setTimeout(r, 350));
    const m = document.querySelector('#modeSingle');
    return {
      collapsed: m.classList.contains('mid-collapsed'),
      deckW: Math.round(document.querySelector('.deck-panel').getBoundingClientRect().width),
      headShown: !!document.querySelector('#modeSingle .mid-panel .panel-head').offsetParent,
    };
  })()`);
  ok(!expanded.collapsed && expanded.headShown, '点竖条能展开回来', `deck=${expanded.deckW}px`);

  // ---------- 3.5) 卡组/卡池之间的分隔线能拖，双击回默认 ----------
  const spBox = await evaluate(`(() => { const r = document.querySelector('#deckSplit').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(document.querySelector('#deckList').getBoundingClientRect().height) }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spBox.x, y: spBox.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spBox.x, y: spBox.y + 40, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spBox.x, y: spBox.y + 120, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spBox.x, y: spBox.y + 120, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  const dragged = await evaluate(`(() => ({ h: Math.round(document.querySelector('#deckList').getBoundingClientRect().height), saved: state.deckListH, splitH: Math.round(document.querySelector('#deckSplit').getBoundingClientRect().height) }))()`);
  ok(dragged.h > spBox.h + 60 && dragged.saved > 0, '拖分隔线能把卡组拉高', `${spBox.h}px → ${dragged.h}px（存了 ${dragged.saved}）`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spBox.x, y: spBox.y + 120, button: 'left', buttons: 1, clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spBox.x, y: spBox.y + 120, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(250);
  const reset = await evaluate(`(() => ({ h: Math.round(document.querySelector('#deckList').getBoundingClientRect().height), saved: state.deckListH, inline: document.querySelector('#deckList').style.height }))()`);
  ok(!reset.inline && reset.h >= 80, '双击分隔线回到默认高度', `${reset.h}px`);

  // ---------- 4) Alt+M 手操 ----------
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: '' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
  await sleep(350);
  const k1 = await evaluate("document.querySelector('#modeSingle').classList.contains('mid-collapsed')");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: '' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
  await sleep(350);
  const k2 = await evaluate("document.querySelector('#modeSingle').classList.contains('mid-collapsed')");
  ok(k1 && !k2, 'Alt+M 能来回切', `按下=${k1 ? '收起' : '展开'} 再按=${k2 ? '收起' : '展开'}`);

  // ---------- 4.5) 三卡对比模式：左栏是 side-rail，收起也得变宽 ----------
  const cmp = await evaluate(`(async () => {
    document.querySelector('#modes [data-mode="compare"]').click();
    await new Promise(r => setTimeout(r, 350));
    const m = document.querySelector('#modeCompare');
    const rail = m.querySelector('.side-rail');
    const before = Math.round(rail.getBoundingClientRect().width);
    m.querySelector('.mid-toggle').click();
    await new Promise(r => setTimeout(r, 350));
    const afterW = Math.round(rail.getBoundingClientRect().width);
    const collapsed = m.classList.contains('mid-collapsed');
    setMidCollapsed(false);
    document.querySelector('#modes [data-mode="single"]').click();
    await new Promise(r => setTimeout(r, 350));
    return { before, afterW, collapsed };
  })()`);
  ok(cmp.collapsed && cmp.afterW > cmp.before + 30, '三卡对比模式收起也把左栏撑宽', `${cmp.before}px → ${cmp.afterW}px`);

  // ---------- 5) 开跑自动收、跑完自动展开（真跑一局 1 样本） ----------
  const started = await evaluate(`(() => {
    state.count = 1;
    run();
    return { collapsed: state.midCollapsed, stripProg: document.querySelector('#modeSingle .mid-prog').textContent };
  })()`);
  ok(started.collapsed, '点开始测算后，中间自动收起', `竖条进度=${JSON.stringify(started.stripProg)}`);

  const finished = await waitFor("['已完成','失败'].includes(document.querySelector('#progLabel').textContent)", 180000);
  const after = await evaluate(`(() => ({
    label: document.querySelector('#progLabel').textContent,
    collapsed: document.querySelector('#modeSingle').classList.contains('mid-collapsed'),
    deckW: Math.round(document.querySelector('.deck-panel').getBoundingClientRect().width),
    winrate: document.querySelector('#winrate').textContent,
    rows: document.querySelectorAll('#resultList .res-row').length,
  }))()`);
  ok(finished, '这一局真的跑完了', `${after.label} · 胜率 ${after.winrate} · ${after.rows} 行`);
  ok(!after.collapsed, '跑完中间自动展开回来', `deck=${after.deckW}px`);

  // ---------- 6) 手动收起 → 跑完不许被强行展开 ----------
  const manual = await evaluate(`(async () => {
    document.querySelector('#modeSingle .mid-toggle').click();
    await new Promise(r => setTimeout(r, 300));
    state.count = 1;
    run();
    const during = state.midCollapsed;
    return { during };
  })()`);
  const fin2 = await waitFor("['已完成','失败'].includes(document.querySelector('#progLabel').textContent) && document.querySelector('#run').disabled === false", 180000);
  const still = await evaluate("document.querySelector('#modeSingle').classList.contains('mid-collapsed')");
  ok(manual.during && fin2 && still, '手动收起时，跑完保持收起（只有自动收的才自动展开）');

  // 收起来拍一张，看左栏空出来的地方
  await evaluate("state.midCollapsed || document.querySelector('#modeSingle .mid-toggle').click()");
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  }

  const errs = consoleErrors.filter(t => !/DevTools|favicon/i.test(t));
  ok(errs.length === 0, '页面没有 JS 报错', errs.slice(0, 2).join(' | '));

  console.log(`\n截图：${SHOT}`);
  console.log(`\n结果：${fails.length ? `${fails.length} 项没过` : '全部通过'}`);
  if (fails.length) process.exitCode = 1;
} catch (e) {
  console.error('检查脚本自己挂了：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
}
