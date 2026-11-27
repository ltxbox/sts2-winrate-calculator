/**
 * ui-analysis-check.mjs —— 验证「数据分析」里新加的几项：
 *   1) 打出次数块：跑完一局后每张牌都有「几次 · 每局几次」，总数和单局记录对得上
 *   2) 每回合伤害块：有第 1 回合起的一串
 *   3) 顶部统计多出「每局打出 X 张」「中位数」
 *   4) CSV 里带上了打出次数
 *   5) 没有 JS 报错
 * 用法：node tools/ui-analysis-check.mjs [url]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9343;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-ana');
const SHOT = path.join(DIR, '_ana.png');

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
  const pageReady = () => evaluate("document.readyState==='complete' && typeof DeckLogic==='object' && document.querySelectorAll('.deck-item').length>0").catch(() => false);

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(800);
  for (let i = 0; i < 60 && !(await pageReady()); i++) await sleep(250);
  await evaluate("try { localStorage.removeItem('sts2-ui.v1'); } catch (e) {}");
  await send('Page.reload', { ignoreCache: true });
  await sleep(600);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { ready = await pageReady(); if (!ready) await sleep(250); }
  ok(ready, '页面起来');

  // 跑一局带药水的（药水用量那一栏才有意义）
  const run = await evaluate(`(async () => {
    document.querySelector('[data-mode=single]').click();
    state.potions = (state.meta.potions || []).slice(0, 2).map(p => p.id);
    renderPotionChips();
    document.querySelector('#count').value = '4';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#run').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) {
        const j = await (await fetch('/api/job/' + id)).json();
        if (j.status !== 'running') return { status: j.status, runs: j.variants[0].summary.runs, summary: j.variants[0].summary, rows: j.variants[0].results.map(r => ({ playsTotal: r.playsTotal, turns: r.turns })) };
      }
      await new Promise(r => setTimeout(r, 700));
    }
    return { status: 'timeout' };
  })()`);
  ok(run.status === 'done', '真跑完一局（4 样本）', `status=${run.status}`);
  const s = run.summary || {};
  ok(s.playsPerRun > 0 && s.plays && s.plays.length > 0, 'summary 里带上了打出次数', `每局 ${s.playsPerRun} 张 · ${s.plays.length} 种牌`);
  ok(s.damageByTurn && s.damageByTurn.length >= 2, 'summary 里带上了每回合伤害', s.damageByTurn ? `T1..T${s.damageByTurn.length}` : '无');
  ok(s.winrateCI && s.winrateCI.half > 0, 'summary 里带上了胜率置信区间', s.winrateCI ? `±${(s.winrateCI.half * 100).toFixed(1)}%` : '无');
  ok(s.turnsHist && s.turnsHist.length >= 1, 'summary 里带上了结束回合分布', s.turnsHist ? s.turnsHist.map(x => x.turns + '回合×' + x.runs).join(' ') : '无');
  ok(s.energyWastePerTurn != null, 'summary 里带上了能量浪费（估算）', `每回合剩 ${s.energyWastePerTurn}`);
  ok((s.plays || []).some(p => p.perPlay != null && p.perPlay > 0), '每张牌算了「每次打出多少伤害」', (s.plays || []).slice(0, 3).map(p => p.cardId + ':' + p.perPlay).join(' '));
  // 单局记录加起来应该等于 summary 的总数（检查统计口径没漏）
  const sumRows = (run.rows || []).reduce((a, r) => a + (r.playsTotal || 0), 0);
  ok(sumRows === s.playsTotal, '单局记录之和 = summary 总数', `${sumRows} vs ${s.playsTotal}`);

  await sleep(500);
  const ui = await evaluate(`(() => {
    const playsRows = [...document.querySelectorAll('#singlePlays .bar-row')];
    const turnsRows = [...document.querySelectorAll('#singleTurns .bar-row')];
    const first = playsRows[0];
    const stats = document.querySelector('#resultStats').textContent;
    return {
      plays: playsRows.length,
      firstText: first ? first.textContent.replace(/\\s+/g, ' ').trim() : '',
      turns: turnsRows.length,
      hasPerRun: /每局打出/.test(stats),
      hasMedian: /中位数/.test(stats),
      playsTitle: (document.querySelector('#singlePlays .attr-title') || {}).textContent || '',
      histRows: document.querySelectorAll('#singleTurnHist .bar-row').length,
      hasCI: /胜率 ±/.test(stats),
      hasEnergy: /剩能量/.test(stats),
      perPlayText: first ? /每次 [\\d.]+ 伤害/.test(first.textContent) : false,
    };
  })()`);
  ok(ui.plays > 0 && /次 · 每局/.test(ui.firstText), '打出次数块列出来了', `${ui.plays} 行 · 首行「${ui.firstText}」`);
  ok(ui.turns >= 2, '每回合伤害块列出来了', `${ui.turns} 回合`);
  ok(ui.hasPerRun && ui.hasMedian, '顶部统计多了「每局打出」「中位数」');
  ok(ui.histRows >= 1, '结束回合分布块列出来了', ui.histRows + ' 行');
  ok(ui.hasCI && ui.hasEnergy, '顶部统计多了「胜率区间」「剩能量」');
  ok(ui.perPlayText, '打出次数那行带上了「每次 X 伤害」');

  // CSV 里也要有
  const csv = await evaluate(`(() => {
    let text = '';
    const orig = Blob;
    window.Blob = function (parts, opts) { text = parts.join('\\n'); return new orig(parts, opts); };
    document.querySelector('#csv').click();
    window.Blob = orig;
    return { hasSection: /# 打出次数/.test(text), hasCardId: /cardId,卡名,次数,每局平均/.test(text), len: text.length };
  })()`);
  ok(csv.hasSection && csv.hasCardId, 'CSV 里也有打出次数', `长度 ${csv.len}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) { const fs = await import('node:fs'); fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64')); }
  ok(consoleErrors.length === 0, '页面没有 JS 报错', consoleErrors.slice(0, 3).join(' | '));
  console.log(`\n截图：${SHOT}`);
} finally {
  try { ws?.close(); } catch { }
  chrome.kill();
  if (fails.length) { console.log(`\n结果：${fails.length} 项没过`); process.exitCode = 1; }
  else console.log('\n结果：全部通过');
}
