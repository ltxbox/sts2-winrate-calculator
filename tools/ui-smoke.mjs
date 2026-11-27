/**
 * ui-smoke.mjs —— 用真 Chrome（headless）打开胜率计算器，把这次改的两件事点一遍。
 * 不需要 puppeteer：Node ≥22 自带 WebSocket，直接讲 CDP。
 *
 * 用法：node tools/ui-smoke.mjs [url]
 * 产出：控制台结论 + _smoke.png（页面截图）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9333;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-smoke');
const SHOT = path.join(DIR, '_smoke.png');

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
  // 等 CDP 端口
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
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

  // 等页面自己 boot 完（app.js 里 init 是 async：等 .deck-item 出来）
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState==='complete' && typeof DeckLogic==='object' && document.querySelectorAll('.deck-item').length>0").catch(() => false);
    if (!ready) await sleep(250);
  }
  ok(ready, '页面起来、DeckLogic 已加载、卡组渲染出来了');

  // ---- 修复 1：同名卡只附魔其中一张 ----
  const enchTest = await evaluate(`(() => {
    const id = (state.meta.cards.find(c => c.type === 1) || state.meta.cards[0]).id;
    const withEnch = state.meta.enchantments.find(e => e.id);
    state.deck = [{ cardId: id, count: 4, upCount: 0, enchCount: 1, enchantmentId: withEnch.id }];
    renderDeck();
    const row = document.querySelector('.deck-item');
    const tagText = (row.querySelector('.ench-tag') || {}).textContent || '';
    const numInput = row.querySelector('[data-op="enchn"]');
    const rows = deckForRequest();
    return {
      cardId: id, enchId: withEnch.id, tagText,
      hasNumInput: !!numInput, numValue: numInput ? numInput.value : null,
      rows, enchRows: rows.filter(r => r.enchantmentId).reduce((s, r) => s + r.count, 0),
      plainRows: rows.filter(r => !r.enchantmentId).reduce((s, r) => s + r.count, 0),
    };
  })()`);
  ok(enchTest.hasNumInput, '多张同名卡时出现「N张附魔」输入框');
  ok(enchTest.tagText.includes('1/4'), `卡名旁标出「附魔 1/4」`, enchTest.tagText.trim());
  ok(enchTest.enchRows === 1 && enchTest.plainRows === 3, '请求里只有 1 张带附魔、3 张不带', JSON.stringify(enchTest.rows));

  // 把张数调到 2，界面和请求要一起变
  const ench2 = await evaluate(`(() => {
    const inp = document.querySelector('[data-op="enchn"]');
    inp.value = '2';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = deckForRequest();
    return { rows, ench: rows.filter(r => r.enchantmentId).reduce((s, r) => s + r.count, 0), tag: document.querySelector('.ench-tag').textContent };
  })()`);
  ok(ench2.ench === 2, '改「附录 N张」后请求跟着变（2 张）', ench2.tag.trim());

  // ---- 修复 2：切角色连带切最大生命 ----
  const hpTest = await evaluate(`(() => {
    const sel = document.querySelector('#character');
    const before = { char: sel.value, maxHp: state.maxHp, hp: state.hp };
    sel.value = 'IRONCLAD';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const afterIron = { maxHp: state.maxHp, hp: state.hp, input: document.querySelector('#maxhp').value, char: state.character };
    sel.value = 'NECROBINDER';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const afterNecro = { maxHp: state.maxHp, hp: state.hp, input: document.querySelector('#maxhp').value };
    return { before, afterIron, afterNecro };
  })()`);
  ok(hpTest.afterIron.maxHp === 80 && hpTest.afterIron.input === '80', '切到铁甲战士：上限 80，输入框同步', JSON.stringify(hpTest.afterIron));
  ok(hpTest.afterNecro.maxHp === 66 && hpTest.afterNecro.input === '66', '切回亡灵契约师：上限 66', JSON.stringify(hpTest.afterNecro));

  // 收尾：把界面还原成初始角色 + 初始卡组，别把测试数据留在 localStorage 里
  await evaluate(`(() => { const sel = document.querySelector('#character'); sel.value = 'NECROBINDER'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  // 截图（把卡组临时改回一个能看出控件的样子再拍）
  await evaluate(`(() => {
    const id = (state.meta.cards.find(c => c.type === 1) || state.meta.cards[0]).id;
    const e = state.meta.enchantments[0];
    state.deck = [{ cardId: id, count: 4, upCount: 2, enchCount: 1, enchantmentId: e.id }];
    renderDeck();
    document.querySelector('#deckList').scrollIntoView();
    return true;
  })()`);
  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  // favicon 的 404 是页面本来就有的（没放图标），不算这页的错
  const realErrors = consoleErrors.filter(t => !/favicon/i.test(t));
  ok(realErrors.length === 0, '页面没有 JS 报错', realErrors.slice(0, 3).join(' | '));
  console.log(`\n截图：${SHOT}`);
  console.log(fails.length ? `\n结果：${fails.length} 项没过` : '\n结果：全部通过');
  process.exitCode = fails.length ? 1 : 0;
} catch (e) {
  console.error('冒烟测试挂了：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
}
