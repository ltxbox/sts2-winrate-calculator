// 单卡战损预估：名单压缩（全部弱怪/全部普通怪/全部精英/全部Boss）→ 排队 → 数据图文件
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const PORT = 9357, BASE = process.argv[2] || 'http://127.0.0.1:8766/';
const SHOT = 'D:/tts-server/sts2-ui/_estimate.png';
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/tts-server/sts2-ui/_chrome-est', '--window-size=1600,1050', 'about:blank',
], { stdio: 'ignore' });
const out = [];
const ok = (cond, name, extra = '') => out.push({ cond, name, extra });
let ws;
try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  for (let i = 0; i < 60; i++) { if (await ev("!!(window.state && state.meta && state.meta.encounters && state.meta.encounters.length)")) break; await sleep(300); }
  await sleep(700);

  // 选密林地图 → 看四组压缩行
  const groups = await ev(`(async () => {
    document.querySelector('[data-mode=single]').click();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#encMapTabs button[data-map="密林"]').click();
    await new Promise(r => setTimeout(r, 250));
    return [...document.querySelectorAll('#encList .enc-item.group')].map(x => x.textContent.trim().replace(/\\s+/g, ' '));
  })()`);
  ok(groups.length === 4, '密林里有四个「全部…」压缩行', groups.join(' | '));
  ok(/全部弱怪.*5 只/.test(groups[0]) && /全部普通怪.*13 只/.test(groups[1]) && /全部精英.*3 只/.test(groups[2]) && /全部Boss.*3 只/.test(groups[3]), '四行各自带着数量', groups.join(' | '));

  // 多选两组 → 队列里两行
  const multi = await ev(`(async () => {
    state.encGroups = []; renderEncLists();
    await new Promise(r => setTimeout(r, 200));
    document.querySelectorAll('#encList .enc-item.group')[0].click();
    await new Promise(r => setTimeout(r, 200));
    document.querySelectorAll('#encList .enc-item.group')[1].click();
    await new Promise(r => setTimeout(r, 250));
    const active = document.querySelectorAll('#encList .enc-item.group.active').length;
    document.querySelector('#qAdd').click();
    await new Promise(r => setTimeout(r, 250));
    return { active, items: [...document.querySelectorAll('#qList .q-item')].map(x => x.textContent.trim().replace(/\\s+/g, ' ')) };
  })()`);
  ok(multi.active === 2, '「全部弱怪」和「全部普通怪」能同时选', `${multi.active} 组`);
  ok(multi.items.length === 18 && /小啃兽/.test(multi.items[0]) && /全部弱怪/.test(multi.items[0]) && /全部普通怪/.test(multi.items[17]), '两组=5+13 只，每只各排一行', `${multi.items.length} 行：${multi.items.slice(0, 2).join(' | ')} … ${multi.items[multi.items.length - 1]}`);

  // 只留弱怪那组，点「开始测算」→ 该组自动跑（测试里样本数设 1，省时间）
  const run = await ev(`(async () => {
    document.querySelector('#qClear').click();
    await new Promise(r => setTimeout(r, 200));
    state.encGroups = ['weak'];
    renderEncLists(); renderQueueAll();
    document.querySelector('#count').value = '1';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#run').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 900000) {
      const rows = document.querySelectorAll('#qResult .q-table tbody tr').length;
      const rep = document.querySelector('#qResult .q-report-link');
      if (rows >= 1 && rep) break;
      await new Promise(r => setTimeout(r, 800));
    }
    const rep = document.querySelector('#qResult .q-report-link');
    return {
      rows: [...document.querySelectorAll('#qResult .q-table tbody tr')].map(r => r.textContent.trim().replace(/\\s+/g, ' ')),
      href: rep ? rep.getAttribute('href') : null,
      reports: [...document.querySelectorAll('#qResult .q-reports a')].map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim() })),
      stopped: state.runningJob ? true : false,
    };
  })()`);
  ok(run.href && /^\/api\/estimate\//.test(run.href), '跑完给了数据图链接', String(run.href));
  ok(run.rows.length === 5, '排队表里 5 只怪各一行', `${run.rows.length} 行：${run.rows.join(' / ').slice(0, 160)}`);

  // 数据图文件本身：能打开、里面有每只怪的名字和战损
  const repUrl = new URL(run.href, BASE).toString();
  const html = await (await fetch(repUrl)).text();
  const names = ['小啃兽', '史莱姆', '毛绒伏地虫', '缩小甲虫', '飞蝇菌子'];
  ok(html.includes('单卡战损预估') && html.includes('<svg'), '数据图是自带的 HTML+SVG，不依赖外部文件', `${(html.length / 1024).toFixed(0)}KB`);
  ok(/平均战损/.test(html) && /胜率/.test(html), '数据图里有摘要和表头', '');
  ok(names.filter(n => html.includes(n)).length >= 4, '数据图列出每只怪', `${names.filter(n => html.includes(n)).length}/${names.length} 只命中`);

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
