/**
 * ui-features-check.mjs —— 点一遍 2026-11-27 新加的四个功能：
 *   1) 文字导入（在初始卡组上改）
 *   2) 药水自定义
 *   3) 遗物计数显示 / 修改
 *   4) 导出结算图（canvas 能画出来、能触发下载）
 * 用法：node tools/ui-features-check.mjs [url]
 * 不需要 puppeteer：Node 自带的 WebSocket 直接讲 CDP。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9337;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-feat');
const SHOT = path.join(DIR, '_features.png');

const fails = [];
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✔' : '✘'} ${msg}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails.push(msg);
};

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
    // 没有游戏素材的仓库里，卡图/遗物图本来就读不到；这种 404 不算页面报错（有「无图」占位兜底）
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

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState==='complete' && typeof DeckLogic==='object' && document.querySelectorAll('.deck-item').length>0").catch(() => false);
    if (!ready) await sleep(250);
  }
  ok(ready, '页面起来、DeckLogic 已加载、卡组渲染出来了');

  // ---------- 1) 文字导入：在初始卡组上改 ----------
  const textImport = await evaluate(`(async () => {
    document.querySelector('#textImport').click();
    const dlg = document.querySelector('#textDlg');
    const opened = dlg.open;
    const input = document.querySelector('#textInput');
    input.value = '绿护卫，白能量汲取，删一打';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('#textPreview .tp-row')].map(r => r.textContent.trim());
    const applyDisabled = document.querySelector('#textApply').disabled;
    const before = state.deck.reduce((s, d) => s + d.count, 0);
    document.querySelector('#textApply').click();
    const after = state.deck.reduce((s, d) => s + d.count, 0);
    const strike = state.deck.find(d => d.cardId === 'STRIKE_NECROBINDER');
    const guard = state.deck.find(d => d.cardId === 'BODYGUARD');
    return { opened, rows, applyDisabled, closed: !dlg.open, before, after, strike, guard };
  })()`);
  ok(textImport.opened, '「文字导入」点开弹窗');
  ok(textImport.rows.length >= 3, '预览列出了三处改动', textImport.rows.join(' / '));
  ok(!textImport.applyDisabled, '认出改动后「用到卡组」可点');
  ok(textImport.closed, '点完自动关窗');
  ok(textImport.after === textImport.before + 1, `改完张数对（${textImport.before} → ${textImport.after}：+护卫 +汲取 −打击）`);
  ok(textImport.guard && textImport.guard.upCount === 1, '绿护卫 = 升级的护卫', JSON.stringify(textImport.guard));
  ok(textImport.strike && textImport.strike.count === 3, '删一打 = 打击从 4 张变 3 张', JSON.stringify(textImport.strike));

  // 认不出来的短语：只警告、不应用那一句
  const textBad = await evaluate(`(() => {
    document.querySelector('#textImport').click();
    const input = document.querySelector('#textInput');
    input.value = '胡说八道的东西';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const warn = document.querySelector('#textPreview .tp-warn');
    const disabled = document.querySelector('#textApply').disabled;
    document.querySelector('#textDlgClose').click();
    return { warnText: warn ? warn.textContent.trim() : '', disabled };
  })()`);
  ok(textBad.warnText.includes('胡说八道') && textBad.disabled, '认不出的短语单独提示、且不能应用', textBad.warnText);

  // ---------- 2) 药水自定义 ----------
  const potions = await evaluate(`(() => {
    state.potions = [];
    renderPotionChips();
    document.querySelector('#addPotion').click();
    const dlg = document.querySelector('#potionDlg');
    const opened = dlg.open;
    const first = document.querySelector('#potionGrid .potion-opt');
    const name = first.querySelector('.rn').textContent;
    first.click();
    const inState = state.potions.length;
    const chips = [...document.querySelectorAll('#potionList .chip')].map(c => c.textContent.replace('×', '').trim());
    // 再点三次同一瓶：每点一次网格会重画，所以要重新查一次（和真人点一样）
    for (let i = 0; i < 3; i++) document.querySelector('#potionGrid .potion-opt').click();
    const capped = state.potions.length;
    document.querySelector('#potionDlgClose').click();
    const del = document.querySelector('#potionList .chip .x');
    del.click();
    const afterDel = state.potions.length;
    return { opened, name, inState, chips, capped, afterDel };
  })()`);
  ok(potions.opened, '「+ 选药水」点开弹窗');
  ok(potions.inState === 1 && potions.chips.length === 1, '点一瓶就加进卡组栏', JSON.stringify(potions.chips));
  ok(potions.capped === 3, '最多 3 瓶（点第 4 次被挡）', String(potions.capped));
  ok(potions.afterDel === 2, '点 × 能删一瓶', String(potions.afterDel));

  // ---------- 3) 遗物计数显示 / 修改 ----------
  const counters = await evaluate(`(() => {
    state.relics = ['PEN_NIB', 'TOXIC_EGG'];
    state.relicProps = { PEN_NIB: { ints: [{ name: 'AttacksPlayed', value: 7 }], bools: [] } };
    renderRelicChips();
    const chip = document.querySelector('#relicList .chip[data-id="PEN_NIB"]');
    const inp = chip.querySelector('input[type=number]');
    const shown = { has: !!inp, value: inp ? inp.value : null, label: chip.textContent.trim() };
    inp.value = '9';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const reqProps = relicPropsForRequest();
    return { shown, stored: state.relicProps.PEN_NIB.ints[0].value, reqProps };
  })()`);
  ok(counters.shown.has && counters.shown.value === '7', '钢笔尖显示出存档里的攻击数 7', JSON.stringify(counters.shown));
  ok(counters.stored === 9, '改成 9 之后状态更新');
  ok(counters.reqProps.PEN_NIB && counters.reqProps.PEN_NIB.ints[0].value === 9, '请求里的 relicProps 带上 9', JSON.stringify(counters.reqProps));

  // ---------- 4) 导出结算图 ----------
  const exportShot = await evaluate(`(async () => {
    // 用存档里的真卡组导出，拍出来才知道实际长什么样
    try {
      const j = await (await fetch('/api/import')).json();
      if (j && j.deck) {
        state.deck = j.deck; state.relics = j.relics || []; state.potions = (j.potions || []).slice(0, 3);
        if (j.relicProps) state.relicProps = j.relicProps;
      }
    } catch { }
    renderRelicChips(); renderPotionChips();
    let clicked = false, blobSize = 0, blobType = '';
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked = true; };
    const origCreate = document.createElement.bind(document);
    let canvas = null;
    document.createElement = (tag) => { const el = origCreate(tag); if (String(tag).toLowerCase() === 'canvas') canvas = el; return el; };
    try {
      await exportSummary();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
      document.createElement = origCreate;
    }
    return { clicked, w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0, label: document.querySelector('#exportSummary').textContent, png: canvas ? canvas.toDataURL('image/png') : '' };
  })()`);
  ok(exportShot.clicked, '导出结算图触发了下载');
  ok(exportShot.w > 1000 && exportShot.h > 300, '画出来的图有内容（不是空白小图）', `${exportShot.w}×${exportShot.h}`);
  if (exportShot.png && exportShot.png.startsWith('data:image/png;base64,')) {
    fs.writeFileSync(path.join(DIR, '_summary.png'), Buffer.from(exportShot.png.split(',')[1], 'base64'));
  }

  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  const realErrors = consoleErrors.filter(t => !/favicon/i.test(t));
  ok(realErrors.length === 0, '页面没有 JS 报错', realErrors.slice(0, 3).join(' | '));
  console.log(`\n截图：${SHOT}`);
  console.log(fails.length ? `\n结果：${fails.length} 项没过` : '\n结果：全部通过');
  process.exitCode = fails.length ? 1 : 0;
} catch (e) {
  console.error('功能检查挂了：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
}
