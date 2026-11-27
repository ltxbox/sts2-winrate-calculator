/**
 * ui-pkg-check.mjs —— 验收分发包的网页：自检按钮、环境横幅、跑一局。
 * 用法：node tools/ui-pkg-check.mjs [url]
 * 产出：_pkg-shot.png + 控制台结论（失败 exitCode=1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8790/';
const PORT = 9335;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-pkg');
const SHOT = path.join(DIR, '_pkg-shot.png');

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
  if (!ver) throw new Error('Chrome 没起来');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const jsErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') jsErrors.push(m.params.entry.text);
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
  await send('Log.enable');
  await send('Page.enable');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState==='complete' && typeof renderResults==='function' && document.querySelectorAll('.deck-item').length>0").catch(() => false);
    if (!ready) await sleep(250);
  }
  ok(ready, '页面加载完成（卡组渲染出来）');
  if (!ready) throw new Error('页面没起来');

  ok(await evaluate("!!document.getElementById('selftest')"), '有「自检」按钮');
  await sleep(1200);
  const bannerShown = await evaluate("getComputedStyle(document.getElementById('diagBanner')).display !== 'none'");
  ok(bannerShown === false, '环境正常时顶部不挂报错横幅');
  ok(await evaluate("document.querySelectorAll('.asset-img, .card-img, img').length > 0") !== false, '卡图资源能取到');

  // 点自检，等它跑完
  await evaluate("document.getElementById('selftest').click()");
  let txt = '';
  for (let i = 0; i < 60; i++) {
    txt = await evaluate("document.getElementById('progressText').textContent");
    if (/自检通过|自检失败|自检没跑通/.test(txt)) break;
    await sleep(1000);
  }
  ok(/自检通过/.test(txt), '点「自检」真跑通了一局', txt);
  if (!/自检通过/.test(txt)) {
    const err = await evaluate("document.querySelector('#errBar .msg') ? document.querySelector('#errBar .msg').textContent : ''");
    ok(false, '自检失败时错误信息可见', err);
  }
  ok(jsErrors.length === 0, '页面没有 JS 报错', jsErrors.slice(0, 2).join(' / '));

  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', SHOT);
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(400);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(fails.length ? `\n结果：${fails.length} 项不合格` : '\n结果：全部通过');
  if (fails.length) process.exitCode = 1;
}
