/**
 * ui-shot-check.mjs —— 截图导入的浏览器冒烟测试（真 Chrome headless + CDP）
 * 用法：node tools/ui-shot-check.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8907/';
const IMG = process.argv[3] || 'deck-view.png';
const PORT = 9334;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT = path.join(DIR, '_shot-import.png');
const fails = [];
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${msg}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails.push(msg);
};

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, `--user-data-dir=${path.join(DIR, '_chrome-shot')}`,
  '--window-size=1820,980', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval error');
  return r.result && r.result.value;
}

try {
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { }
    await sleep(250);
  }
  if (!target) throw new Error('连不上 Chrome');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1820, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  ok(await evaluate('!!document.querySelector("#shotImport")'), '卡组标题栏有「截图导入」按钮');
  ok(await evaluate('!!document.querySelector("#shotDlg")'), '有导入对话框');

  await evaluate('document.querySelector("#shotImport").click()');
  await sleep(400);
  ok(await evaluate('document.querySelector("#shotDlg").open === true'), '点按钮能打开对话框');

  // 用同一张样图喂进去（页面内 fetch，避免把 1.5MB base64 塞进 CDP 消息）
  const t0 = Date.now();
  await evaluate(`(async () => {
    const r = await fetch('/_shot/${IMG}');
    const b = await r.blob();
    const url = URL.createObjectURL(b);
    await new Promise((res, rej) => { const i = new Image(); i.onload = () => { window.__img = i; res(); }; i.onerror = rej; i.src = url; });
    await window.shotTakeImage(window.__img);
  })()`, true);
  const ms = Date.now() - t0;
  await sleep(300);

  const cardRows = await evaluate('document.querySelectorAll("#shotCardList .shot-card").length');
  const relicRows = await evaluate('document.querySelectorAll("#shotRelicList .shot-relic").length');
  const lowRows = await evaluate('document.querySelectorAll("#shotCardList .shot-card.low").length');
  const info = await evaluate('document.querySelector("#shotInfo").textContent');
  ok(cardRows >= 8, '识别出卡牌行（≥8）', `rows=${cardRows} 用时${ms}ms`);
  ok(/张卡/.test(info), '汇总信息有张数', info);
  console.log(`  低置信行 ${lowRows} 条，遗物 ${relicRows} 件`);

  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64')));
  // 滚到遗物区再拍一张
  await evaluate('document.querySelector("#shotDlg .shot-body").scrollTop = 99999');
  await sleep(300);
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(SHOT.replace('.png', '-relics.png'), Buffer.from(r.data, 'base64')));

  // 点「应用」后卡组应该被替换
  await evaluate('document.querySelector("#shotApply").click()');
  await sleep(500);
  const deckItems = await evaluate('document.querySelectorAll("#deckList .deck-item").length');
  const deckCount = await evaluate('document.querySelector("#deckCount").textContent');
  ok(deckItems >= 8, '应用后卡组列表被替换', `items=${deckItems} ${deckCount}`);
} catch (e) {
  console.log('✗ 测试本身出错：' + (e && e.message || e));
  fails.push('exception');
} finally {
  try { chrome.kill(); } catch { }
  console.log(fails.length ? `\n失败 ${fails.length} 项：${fails.join(' / ')}` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
}
