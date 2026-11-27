/**
 * ui-upgrade-check.mjs —— 验证「三选一升级」页：选三张 → 出四个方案（不升级 + 三张各升一级），一屏放得下。
 * 用法：先起服务（默认 8906），再 node tools/ui-upgrade-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.UP_BASE || 'http://127.0.0.1:8906';
const PORT = 9340;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-up');
const SHOT = path.join(DIR, '_upgrade3.png');
const VW = 1792, VH = 961;

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
  let dialogMsg = null;
  ws.addEventListener('message', ev2 => {
    const m = JSON.parse(ev2.data);
    if (m.method === 'Page.javascriptDialogOpening') { dialogMsg = m.params.message; send('Page.handleJavaScriptDialog', { accept: true }); }
  });
  const ev = async e => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate 超时 10s（页面被弹窗/死循环卡住）: ' + e.slice(0, 60))), 10000)),
    ]);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await ev("document.readyState==='complete' && typeof renderUpgradeAll==='function' && (state.dreadList||[]).length>0").catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('页面没起来');

  // 卡组：打击 2 张已升过 1 张（验证「升 1/2」的显示），防御 4 张都没升，切割 1 张（已经升满，应该点不动）
  await ev(`(() => {
    state.deck = [
      {cardId:'STRIKE_SILENT',count:2,upgradeLevels:1},
      {cardId:'DEFEND_SILENT',count:4,upgradeLevels:0},
      {cardId:'SLICE',count:1,upgradeLevels:1},
      {cardId:'SURVIVOR',count:1,upgradeLevels:0},
    ];
    state.hp = 52; state.maxHp = 66; state.ascension = 10;
    state.encounter = 'SKULKING_COLONY_ELITE';
    const b = document.querySelector('#modes button[data-mode="upgrade"]');
    if (b) b.click();
    document.querySelector('#count').value = '6'; state.count = 6;
    document.querySelector('#upBudget').value = '3000';
    renderUpgradeAll();
  })()`);
  await sleep(400);

  const view = await ev(`(() => {
    const items = Array.from(document.querySelectorAll('#upDeck .up-item'));
    return { n: items.length, texts: items.map(i => i.innerText.replace(/\\s+/g,' ').trim()), full: items.filter(i => i.classList.contains('full')).length, slots: document.querySelectorAll('#upSlots .slot').length };
  })()`);
  console.log('卡组列表:', view.texts.join(' | '));
  check(view.n === 4, '卡组条目都列出来了', `${view.n} 条`);
  check(view.texts.some(t => /升 1\/2/.test(t)), '显示「已升 1/2 张」');
  check(view.full === 1, '升满的那一行被标成不可选', `full=${view.full}`);
  check(view.slots === 3, '三个方案槽位', `${view.slots}`);

  // 点三张（打击、防御、幸存者）—— 每次都要重新取节点：点完会重绘
  await ev(`(async () => {
    window.alert = m => { window.__alerts = (window.__alerts || []).concat([String(m)]); };
    for (const i of [0, 1, 3]) {
      const it = document.querySelectorAll('#upDeck .up-item')[i];
      if (it) it.click();
      await new Promise(r => setTimeout(r, 60));
    }
  })()`);
  await sleep(200);
  const picked = await ev(`(() => ({
    picks: state.upPicks.slice(),
    slotNames: Array.from(document.querySelectorAll('#upSlots .slot')).map(s => s.innerText.replace(/\\s+/g,' ').trim()),
  }))()`);
  console.log('已选:', JSON.stringify(picked));
  check(picked.picks.length === 3, '选中三张', JSON.stringify(picked.picks));

  // 第四张点不动
  const fourth = await ev(`(() => { const it = document.querySelectorAll('#upDeck .up-item')[2]; it.click(); return state.upPicks.length; })()`);
  check(fourth === 3, '最多三张（点第四张不进去）', `现在是 ${fourth}`);

  // 升满的那张：服务端要明确拒绝
  const errMsg = await ev(`(async () => {
    const body = {
      deck: [{cardId:'SLICE',count:1,upgradeLevels:1},{cardId:'STRIKE_SILENT',count:2,upgradeLevels:0}],
      encounter: state.encounter, character: state.character, ascension: state.ascension,
      hp: state.hp, maxHp: state.maxHp, count: 2, budget: 2000, picks: [{index:0},{index:1}],
    };
    const r = await fetch('/api/upgrade3', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    return { status: r.status, err: j.error || '' };
  })()`);
  console.log('升满提交:', JSON.stringify(errMsg));
  check(errMsg.status === 400 && /已经没有可以升级的副本/.test(errMsg.err), '升满的行提交会被拒绝并说清原因', errMsg.err);

  // 正式跑
  await ev("document.querySelector('#upRun').click()");
  let done = false;
  for (let i = 0; i < 180 && !done; i++) {
    await sleep(1000);
    done = await ev("!!document.querySelector('#upResult .cmp-cards')");
  }
  if (!done) throw new Error('升级对比没出结果');

  const m = await ev(`(() => {
    const box = document.querySelector('#upResult');
    const cards = Array.from(document.querySelectorAll('#upResult .cmp-card'));
    const vh = window.innerHeight;
    return {
      vh, n: cards.length,
      names: cards.map(c => (c.querySelector('.who')?.innerText || '').trim()),
      rects: cards.map(c => { const r = c.getBoundingClientRect(); return { bottom: Math.round(r.bottom), w: Math.round(r.width) }; }),
      page: document.documentElement.scrollHeight,
      box: { sh: box.scrollHeight, ch: box.clientHeight },
      verdict: (document.querySelector('#upResult .verdict')?.innerText || '').trim(),
      pies: document.querySelectorAll('#upResult .cmp-mini .pie').length,
    };
  })()`);
  console.log('卡片:', JSON.stringify(m.names), JSON.stringify(m.rects));
  console.log('结论:', m.verdict);

  check(m.n === 4, '不升级 + 三个升级方案 = 4 张卡片', `${m.n} 张`);
  check(m.names[0].includes('不升级'), '第一张是「不升级」基线', m.names[0]);
  check(m.names.slice(1).every(n => n.startsWith('升级 ')), '其余三张是「升级 X」', m.names.slice(1).join(' / '));
  check(/^该升/.test(m.verdict), '结论是「该升 …」', m.verdict.slice(0, 40));
  check(m.page <= m.vh + 2, '整页不用滚', `${m.page} / ${m.vh}`);
  check(m.box.sh <= m.box.ch + 2, '结果区不用滚', `${m.box.sh} / ${m.box.ch}`);
  check(m.rects.every(r => r.bottom <= m.vh + 2), '四张卡都在一屏里');
  check(m.pies >= 2, '带归因图', `${m.pies} 个`);

  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', SHOT);

  // 真实卡组（19 张 / 11 行）能不能不滚就看完
  await ev(`(() => {
    state.deck = [
      {cardId:'STRIKE_SILENT',count:5,upgradeLevels:1},
      {cardId:'DEFEND_SILENT',count:5,upgradeLevels:0},
      {cardId:'SURVIVOR',count:1,upgradeLevels:0},
      {cardId:'NEUTRALIZE',count:1,upgradeLevels:1},
      {cardId:'ASCENDERS_BANE',count:1,upgradeLevels:0},
      {cardId:'SLICE',count:1,upgradeLevels:1},
      {cardId:'DAGGER_SPRAY',count:1,upgradeLevels:0},
      {cardId:'BLADE_DANCE',count:1,upgradeLevels:0},
      {cardId:'PREPARED',count:1,upgradeLevels:0},
      {cardId:'BACKFLIP',count:1,upgradeLevels:0},
      {cardId:'FOOTWORK',count:1,upgradeLevels:0},
    ];
    state.upPicks = [0, 1, 6]; renderUpgradeAll();
  })()`);
  await sleep(300);
  const big = await ev(`(() => {
    const deck = document.querySelector('#upDeck');
    const rail = document.querySelector('#modeUpgrade .side-rail');
    const items = Array.from(deck.querySelectorAll('.up-item'));
    const first = items[0].getBoundingClientRect(), last = items[items.length-1].getBoundingClientRect();
    const boxRect = deck.getBoundingClientRect();
    return {
      rows: items.length, h: Math.round(boxRect.height),
      sh: deck.scrollHeight, ch: deck.clientHeight,
      railScroll: rail.scrollHeight - rail.clientHeight,
      visibleRows: items.filter(i => { const r = i.getBoundingClientRect(); return r.bottom <= boxRect.bottom + 1 && r.top >= boxRect.top - 1; }).length,
      itemH: Math.round(first.height),
    };
  })()`);
  console.log('大卡组:', JSON.stringify(big));
  check(big.h >= 300, '卡组列表占了左栏大部分高度', `高 ${big.h}px`);
  check(big.visibleRows >= 10, '19 张的卡组能一次看到 10 行以上', `看到 ${big.visibleRows}/${big.rows} 行`);
  check(big.sh <= big.ch + big.itemH, '最多只需滚一行', `内容 ${big.sh} / 容器 ${big.ch}`);
  check(big.railScroll <= 2, '整个左栏不用滚', `溢出 ${big.railScroll}`);

  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT.replace('_upgrade3.png', '_upgrade3-bigdeck.png'), Buffer.from(shot3.result.data, 'base64'));
  console.log(fails.length ? `✘ ${fails.length} 项没过：${fails.join(' / ')}` : '✔ 全部通过');
  if (fails.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
