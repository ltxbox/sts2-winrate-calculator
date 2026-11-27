// 地图分类（密林/暗巷/巢穴/荣耀）+ 「选中那张牌每局打出」——回归用
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const PORT = 9351, URL_BASE = process.argv[2] || 'http://127.0.0.1:8766/';
const SHOT = 'D:/tts-server/sts2-ui/_maps.png';
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/tts-server/sts2-ui/_chrome-c4', '--window-size=1600,1050', 'about:blank',
], { stdio: 'ignore' });

const out = [];
const ok = (cond, name, extra = '') => { out.push({ cond, name, extra }); };

let ws, chromePid;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_BASE)}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_BASE });
  for (let i = 0; i < 60; i++) { if (await ev("!!(window.state && state.meta && state.meta.encounters && state.meta.encounters.length)")) break; await sleep(300); }
  await sleep(600);

  // ---- 地图分类 ----
  const maps = await ev(`(async () => {
    document.querySelector('[data-mode=single]').click();
    await new Promise(r => setTimeout(r, 300));
    const tabs = [...document.querySelectorAll('#encMapTabs button')].map(b => b.dataset.map);
    const counts = {};
    for (const m of tabs) {
      document.querySelector('#encMapTabs button[data-map="' + m + '"]').click();
      await new Promise(r => setTimeout(r, 150));
      const per = {};
      for (const k of ['weak','normal','elite','boss','event']) {
        document.querySelector('#encTabs button[data-kind="' + k + '"]').click();
        await new Promise(r => setTimeout(r, 120));
        per[k] = document.querySelectorAll('#encList .enc-item').length;
      }
      counts[m] = per;
    }
    document.querySelector('#encMapTabs button[data-map="全部"]').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#encTabs button[data-kind="boss"]').click();
    await new Promise(r => setTimeout(r, 120));
    return { tabs, counts, bossTotal: document.querySelectorAll('#encList .enc-item').length,
             firstBoss: (document.querySelector('#encList .enc-item') || {}).textContent };
  })()`);
  ok(JSON.stringify(maps.tabs) === JSON.stringify(['全部', '密林', '暗巷', '巢穴', '荣耀', '事件']), '地图标签是 全部/密林/暗巷/巢穴/荣耀/事件', maps.tabs.join(' '));
  ok(maps.counts['密林'].boss === 3 && maps.counts['暗巷'].boss === 3 && maps.counts['巢穴'].boss === 3 && maps.counts['荣耀'].boss === 3, '四张地图各有 3 个 Boss', JSON.stringify(maps.counts));
  ok(maps.counts['密林'].normal === 13 && maps.counts['密林'].weak === 5 && maps.counts['密林'].elite === 3, '密林里 普通13 / 弱怪5 / 精英3', JSON.stringify(maps.counts['密林']));
  ok(maps.bossTotal === 12, '选「全部」+ Boss 时还是 12 个', String(maps.bossTotal));

  // ---- 选中那张牌每局打出（自选对比）----
  const cmp = await ev(`(async () => {
    document.querySelector('[data-mode=compare]').click();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#count').value = '3';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#cmpBudget').value = '2500';
    state.cmpCards = [{ cardId: 'STRIKE_IRONCLAD', upgradeLevels: 0 }, { cardId: 'DEFEND_IRONCLAD', upgradeLevels: 0 }];
    renderCmpSlots();
    document.querySelector('#cmpRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      if (document.querySelectorAll('#cmpResult .cmp-card').length >= 3) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const cards = [...document.querySelectorAll('#cmpResult .cmp-card')].map(c => ({
      who: (c.querySelector('.who') || {}).textContent,
      plays: (c.querySelector('.cardplays') || {}).textContent || '',
    }));
    return { n: cards.length, cards };
  })()`);
  ok(cmp.n === 3, '对比结果画出 基线+2 张', String(cmp.n));
  ok(cmp.cards.slice(1).every(c => /每局打出 [\d.]+ 次/.test(c.plays)), '每张候选卡都写「这张牌每局打出 X 次」', JSON.stringify(cmp.cards.map(c => c.plays)));

  // ---- 升级：升级后 vs 不升级 的打出次数 ----
  const up = await ev(`(async () => {
    document.querySelector('[data-mode=upgrade]').click();
    await new Promise(r => setTimeout(r, 400));
    state.upPicks = [0];
    renderUpSlots();
    document.querySelector('#upBudget') && (document.querySelector('#upBudget').value = '2500');
    document.querySelector('#upRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      if (document.querySelectorAll('#upResult .cmp-card').length >= 2) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return [...document.querySelectorAll('#upResult .cmp-card')].map(c => ({
      who: (c.querySelector('.who') || {}).textContent,
      plays: (c.querySelector('.cardplays') || {}).textContent || '',
    }));
  })()`);
  ok(up.length >= 2 && up.some(c => /比不升级/.test(c.plays)), '升级结果写「比不升级 +X 次」', JSON.stringify(up.map(c => c.plays)));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  ok(errors.length === 0, '页面没有 JS 报错', errors.slice(0, 2).join(' | '));
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
}

for (const o of out) console.log(`${o.cond ? '✔' : '✘'} ${o.name}${o.extra ? ' — ' + o.extra : ''}`);
const bad = out.filter(o => !o.cond).length;
console.log(`结果：${bad ? bad + ' 项没过' : '全部通过'}（截图 ${SHOT}）`);
process.exit(bad ? 1 : 0);
