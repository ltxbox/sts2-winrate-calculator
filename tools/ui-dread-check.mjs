/**
 * ui-dread-check.mjs —— 验证「恐惧模式」在界面上真的能选、能跑、结果上带模式和领域。
 * 用法：先起一个服务（默认 8901），再 node tools/ui-dread-check.mjs
 * 产出：_dread.png + 控制台结论
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.DREAD_BASE || 'http://127.0.0.1:8901';
const PORT = 9336;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-dread');
const SHOT = path.join(DIR, '_dread.png');

const fails = [];
const check = (cond, msg, extra) => {
  console.log((cond ? '✔ ' : '✘ ') + msg + (extra ? `  ${extra}` : ''));
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
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
  await send('Page.enable');

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate("document.readyState==='complete' && typeof renderResults==='function'").catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('页面没起来');

  // 等 /assets/dread.json 读完（init 里在 meta 之后才拿）
  for (let i = 0; i < 40; i++) {
    const n = await evaluate("(state.dreadList || []).length").catch(() => 0);
    if (n === 12) break;
    await sleep(250);
  }

  // 清掉上次留下的模式，回到标准
  await evaluate("(() => { try { localStorage.removeItem('sts2ui.v1'); } catch {} state.gameMode='Standard'; state.dreadBoss=''; state.dreadList = state.dreadList || []; })()");
  const before = await evaluate(`(() => {
    const s = document.querySelector('#gameMode'); if (s) s.value = 'Standard';
    state.gameMode = 'Standard';
    if (typeof renderDread === 'function') renderDread();
    return {
      hasSelect: !!document.querySelector('#gameMode'),
      wrap: getComputedStyle(document.querySelector('#dreadWrap')).display,
      ascDisabled: document.querySelector('#ascension').disabled,
      dredList: (state.dreadList || []).length,
    };
  })()`);
  check(before.hasSelect, '界面有「模式」下拉');
  check(before.wrap === 'none', '标准模式下不显示恐惧首领', `display=${before.wrap}`);
  check(!before.ascDisabled, '标准模式下飞升可改');
  check(before.dredList === 12, '恐惧首领清单 12 个', `实际 ${before.dredList}`);

  // 老服务端（没重启过）不该假装能算恐惧：ping 里没有 dread 时把「模式」禁掉
  const legacy = await evaluate(`(() => {
    state.serverCaps = { diag: true, dread: false }; renderDread();
    const off = document.querySelector('#gameMode').disabled;
    state.serverCaps = { diag: true, dread: true }; renderDread();
    return { off, on: document.querySelector('#gameMode').disabled };
  })()`);
  check(legacy.off === true && legacy.on === false, '旧服务端禁用「模式」，新服务端放开', JSON.stringify(legacy));

  // 切到恐惧
  const dread = await evaluate(`(() => {
    const s = document.querySelector('#gameMode');
    s.value = 'Dread'; s.dispatchEvent(new Event('change'));
    const sel = document.querySelector('#dreadBoss');
    return {
      mode: state.gameMode,
      wrap: getComputedStyle(document.querySelector('#dreadWrap')).display,
      opts: sel.options.length,
      disabled: sel.querySelectorAll('option[disabled]').length,
      boss: sel.value,
      asc: document.querySelector('#ascension').value,
      ascDisabled: document.querySelector('#ascension').disabled,
      title: sel.title,
    };
  })()`);
  check(dread.mode === 'Dread', '切到恐惧模式');
  check(dread.wrap !== 'none', '显示「恐惧首领」下拉', `display=${dread.wrap}`);
  check(dread.opts === 12, '首领下拉有 12 项', `实际 ${dread.opts}`);
  check(dread.disabled === 1, '知识恶魔被标成不可选', `disabled=${dread.disabled}`);
  check(dread.asc === '10' && dread.ascDisabled, '恐惧模式飞升锁在 10', `value=${dread.asc} disabled=${dread.ascDisabled}`);
  check(/领域：/.test(dread.title || ''), '首领下拉带领域说明', (dread.title || '').slice(0, 30));

  // 选女王，跑 1 局
  const picked = await evaluate(`(() => {
    const sel = document.querySelector('#dreadBoss');
    sel.value = 'QUEEN_BOSS'; sel.dispatchEvent(new Event('change'));
    document.querySelector('#count').value = '1'; state.count = 1;
    document.querySelector('#prefix').value = 'DRCHECK'; state.prefix = 'DRCHECK';
    document.querySelector('#run').click();
    return { boss: state.dreadBoss };
  })()`);
  check(picked.boss === 'QUEEN_BOSS', '选中女王', picked.boss);

  let stats = '';
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    stats = await evaluate("(document.querySelector('#resultStats')?.innerText || '')");
    const prog = await evaluate("(document.querySelector('#progressText')?.textContent || '')");
    const ran = await evaluate("(document.querySelector('#resultStats')?.innerText || '').match(/已跑\\s*(\\d+)\\/(\\d+)/)");
    if (ran && ran[1] === ran[2] && Number(ran[1]) > 0) break;   // 跑完了
    if (/失败|错误/.test(stats) || /失败/.test(prog)) break;
  }
  console.log('--- 结果区 ---\n' + stats + '\n---');
  check(/模式\s*恐惧/.test(stats), '结果区写了「模式 恐惧」');
  check(/领域\s*女王/.test(stats), '结果区写了「领域 女王」');
  check(/预估掉血/.test(stats), '结果区仍显示预估掉血');

  // 切回标准：飞升解冻
  const back = await evaluate(`(() => {
    const s = document.querySelector('#gameMode');
    s.value = 'Standard'; s.dispatchEvent(new Event('change'));
    return { wrap: getComputedStyle(document.querySelector('#dreadWrap')).display, ascDisabled: document.querySelector('#ascension').disabled };
  })()`);
  check(back.wrap === 'none' && !back.ascDisabled, '切回标准后飞升解冻、首领隐藏');

  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', SHOT);
  console.log(fails.length ? `✘ ${fails.length} 项没过：${fails.join(' / ')}` : '✔ 全部通过');
  if (fails.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
