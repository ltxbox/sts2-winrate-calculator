/**
 * ui-queue-check.mjs —— 验证这一轮新加的几样：
 *   1) 遭遇列表每行都有「资料 ↗」外链，指向 Spire Codex 的中文遭遇页
 *   2) 排队：同一只怪能重复加、能 × 掉、能连着算完、结果表格出得来
 *   3) 终止按钮：没任务时隐藏，点下去能把正在跑的任务停掉（status=cancelled 且 done < total）
 *   4) 升级模式能选 5 张（不再限制三张），跑完是基线 + 5
 *   5) 升级 vs 睡觉：同一个卡名两行时选第二行，服务端拿到的是 targetIndex=1（只升那一行）
 *   6) 没有 JS 报错
 * 用法：node tools/ui-queue-check.mjs [url]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const PORT = 9345;
const DIR = 'D:/tts-server/sts2-ui';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(DIR, '_chrome-queue');
const SHOT = path.join(DIR, '_queue.png');

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

  // ---------- 1) 外链 ----------
  const links = await evaluate(`(() => {
    const items = [...document.querySelectorAll('#encList .enc-item[data-id]')];
    const ext = items.map(it => ({ name: (it.querySelector('span')||{}).textContent || '', href: (it.querySelector('.enc-ext')||{}).href || '', id: it.dataset.id }));
    return { n: items.length, links: ext.slice(0, 4), withLink: ext.filter(x => x.href).length, all: ext.map(x => x.href).filter(Boolean) };
  })()`);
  ok(links.n > 0 && links.withLink === links.n, '每个遭遇都有「资料 ↗」外链', `${links.withLink}/${links.n}`);
  ok(links.all.every(h => h.startsWith('https://spire-codex.com/zhs/beta/encounters/')), '外链指向 Spire Codex 中文遭遇页', links.links[0] && links.links[0].href);
  const expected = await evaluate(`(() => {
    const e = [...document.querySelectorAll('#encList .enc-item')].find(x => x.dataset.id === 'LAGAVULIN_MATRIARCH_BOSS');
    return e ? e.querySelector('.enc-ext').href : '';
  })()`);
  ok(expected === 'https://spire-codex.com/zhs/beta/encounters/lagavulin_matriarch_boss', 'id 小写后正好对上 Codex 的地址', expected);

  // ---------- 2) 排队 ----------
  const add = await evaluate(`(() => {
    state.encounter = 'LAGAVULIN_MATRIARCH_BOSS'; renderEncLists();
    document.querySelector('#qAdd').click();
    document.querySelector('#qAdd').click();
    const a = document.querySelectorAll('#qList .q-item').length;
    state.encounter = 'CEREMONIAL_BEAST_BOSS'; renderEncLists();
    document.querySelector('#qAdd').click();
    const b = document.querySelectorAll('#qList .q-item').length;
    return { afterDup: a, afterThird: b, names: [...document.querySelectorAll('#qList .q-name')].map(x => x.textContent.trim()) };
  })()`);
  ok(add.afterDup === 2, '同一只怪能重复加（加两次 → 2 项）', `${add.afterDup} 项`);
  ok(add.afterThird === 3, '不同怪接着加 → 3 项', add.names.join(' / '));

  const del = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('#qList [data-qdel]')];
    btns[1].click();
    return { n: document.querySelectorAll('#qList .q-item').length, names: [...document.querySelectorAll('#qList .q-name')].map(x => x.textContent.trim()) };
  })()`);
  ok(del.n === 2, '没开始算的能从队列里 × 掉', `剩 ${del.n} 项：${del.names.join(' / ')}`);

  const qrun = await evaluate(`(async () => {
    document.querySelector('#count').value = '2';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#qRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 420000) {
      const rows = document.querySelectorAll('#qResult .q-table tbody tr').length;
      const doneN = (state.queue || []).filter(it => it.done).length;
      if (rows >= 2 && doneN >= 2) break;
      await new Promise(r => setTimeout(r, 600));
    }
    return {
      rows: document.querySelectorAll('#qResult .q-table tbody tr').length,
      cells: [...document.querySelectorAll('#qResult .q-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()).join(' | ')),
      doneN: (state.queue || []).filter(it => it.done).length,
      statuses: [...document.querySelectorAll('#qList .q-st')].map(x => x.textContent.trim()),
    };
  })()`);
  ok(qrun.rows === 2, '排队把两只都算完了，表格两行', `${qrun.rows} 行 · ${qrun.statuses.join(',')}`);
  ok(/^\d+\.\d%/.test(((qrun.cells[0] || '').split('|')[1] || '').trim()), '表格里带胜率', qrun.cells[0]);

  // ---------- 3) 终止 ----------
  const hidden0 = await evaluate(`getComputedStyle(document.querySelector('#stopRun')).display === 'none'`);
  ok(hidden0, '没任务时「终止」是隐藏的');
  const stopped = await evaluate(`(async () => {
    document.querySelector('#count').value = '30';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#run').click();
    await new Promise(r => setTimeout(r, 2500));
    const shown = getComputedStyle(document.querySelector('#stopRun')).display !== 'none';
    document.querySelector('#stopRun').click();
    const t0 = Date.now();
    let job = null;
    while (Date.now() - t0 < 60000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) { job = await (await fetch('/api/job/' + id)).json(); if (job.status !== 'running') break; }
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 1800));
    return { shown, status: job && job.status, done: job && job.done, total: job && job.total,
      btnHidden: getComputedStyle(document.querySelector('#stopRun')).display === 'none' };
  })()`);
  ok(stopped.shown, '跑起来后「终止」出现');
  ok(stopped.status === 'cancelled', '点终止后任务状态是 cancelled', `${stopped.status} ${stopped.done}/${stopped.total}`);
  ok(stopped.done < stopped.total, '终止之后剩下的样本没有再算', `done ${stopped.done} < total ${stopped.total}`);
  ok(stopped.btnHidden, '停完「终止」又隐藏了');

  // ---------- 4) 升级任意张 ----------
  const up = await evaluate(`(async () => {
    document.querySelector('[data-mode=upgrade]').click();
    await new Promise(r => setTimeout(r, 400));
    for (let k = 0; k < 5; k++) {
      const it = document.querySelector('#upDeck .up-item:not(.on):not(.full)');
      if (!it) break;
      it.click();
      await new Promise(r => setTimeout(r, 60));
    }
    const slots = document.querySelectorAll('#upSlots .slot').length;
    const filled = document.querySelectorAll('#upSlots .slot:not(.empty)').length;
    document.querySelector('#upBudget').value = '3000';
    const prevId = state.lastJob && state.lastJob.id;
    document.querySelector('#upRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && (!state.lastJob || state.lastJob.id === prevId)) await new Promise(r => setTimeout(r, 200));
    let job = null;
    while (Date.now() - t0 < 420000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) {
        job = await (await fetch('/api/job/' + id)).json();
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') break;
      }
      await new Promise(r => setTimeout(r, 700));
    }
    let cards = 0;
    for (let k = 0; k < 40; k++) {
      cards = document.querySelectorAll('#upResult .cmp-card').length;
      if (cards >= 6) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return { slots, filled, picks: state.upPicks.length, variants: job && job.variants && job.variants.length,
      status: job && job.status, cards, err: job && job.lastError };
  })()`);
  ok(up.picks === 5 && up.filled === 5, '升级能选 5 张（不再卡三张）', `picks=${up.picks} 槽=${up.filled}/${up.slots}`);
  ok(up.variants === 6, '跑完是「基线 + 5 张」共 6 组', `variants=${up.variants} status=${up.status}`);
  ok(up.cards === 6, '升级结果区画出 6 张卡', `${up.cards} 张`);

  // ---------- 5) 睡觉：同名两行只升选中的那行 ----------
  const rest = await evaluate(`(async () => {
    document.querySelector('[data-mode=rest]').click();
    await new Promise(r => setTimeout(r, 300));
    // 造两行同名的「打击」：一行没升、一行升过
    state.deck = [
      { cardId: 'STRIKE_NECROBINDER', count: 2, upgradeLevels: 0 },
      { cardId: 'STRIKE_NECROBINDER', count: 2, upgradeLevels: 1 },
      { cardId: 'DEFEND_NECROBINDER', count: 2, upgradeLevels: 0 },
    ];
    renderDeck(); renderRestPanel();
    const opts = [...document.querySelectorAll('#restCard option')].map(o => o.textContent.trim());
    const sel = document.querySelector('#restCard');
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#count').value = '1';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#restBudget').value = '3000';
    const prevId = state.lastJob && state.lastJob.id;
    document.querySelector('#restRun').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && (!state.lastJob || state.lastJob.id === prevId)) await new Promise(r => setTimeout(r, 200));
    let job = null;
    while (Date.now() - t0 < 240000) {
      const id = state.lastJob && state.lastJob.id;
      if (id) { job = await (await fetch('/api/job/' + id)).json(); if (job.status !== 'running') break; }
      await new Promise(r => setTimeout(r, 600));
    }
    return { opts, targetIndex: job && job.meta && job.meta.targetIndex, label: job && job.variants && job.variants[0] && job.variants[0].label, status: job && job.status };
  })()`);
  ok(rest.opts.filter(t => t.includes('打击')).length === 2, '同名两行在下拉里是两条、带「第 N 行」', rest.opts.join(' / '));
  ok(rest.targetIndex === 1, '选第二行时服务端收到 targetIndex=1（不是按卡名整组升）', `targetIndex=${rest.targetIndex} label=${rest.label}`);

  // ---------- 6) 自选对比 / 多选一升级 也有同一套遭遇面板 + 排队 ----------
  const cmpPanel = await evaluate(`(async () => {
    document.querySelector('[data-mode=compare]').click();
    await new Promise(r => setTimeout(r, 400));
    const items = document.querySelectorAll('#cmpEncList .enc-item[data-id]').length;
    const links = document.querySelectorAll('#cmpEncList .enc-ext').length;
    const tabs = document.querySelectorAll('#cmpEncTabs button').length;
    document.querySelector('#cmpQAdd').click();
    const q = document.querySelectorAll('#cmpQList .q-item').length;
    return { items, links, tabs, q };
  })()`);
  ok(cmpPanel.items > 0 && cmpPanel.links === cmpPanel.items, '自选对比里有和单场一样的遭遇列表（带资料链接）', `${cmpPanel.links}/${cmpPanel.items} 条 · ${cmpPanel.tabs} 个分类`);
  ok(cmpPanel.q === 1, '自选对比能加进自己的排队', `${cmpPanel.q} 项`);

  const upPanel = await evaluate(`(async () => {
    document.querySelector('[data-mode=upgrade]').click();
    await new Promise(r => setTimeout(r, 400));
    const items = document.querySelectorAll('#upEncList .enc-item[data-id]').length;
    const links = document.querySelectorAll('#upEncList .enc-ext').length;
    document.querySelector('#upQAdd').click();
    const q = document.querySelectorAll('#upQList .q-item').length;
    return { items, links, q };
  })()`);
  ok(upPanel.items > 0 && upPanel.links === upPanel.items, '多选一升级里也是同一套遭遇列表', `${upPanel.links}/${upPanel.items} 条`);
  ok(upPanel.q === 1, '多选一升级能加进自己的排队', `${upPanel.q} 项`);

  const cmpQueue = await evaluate(`(async () => {
    document.querySelector('[data-mode=compare]').click();
    await new Promise(r => setTimeout(r, 300));
    const card = (state.meta.cards || []).find(c => c.type === 1) || (state.meta.cards || [])[0];
    state.cmpCards = [{ cardId: card.id, upgradeLevels: 0 }];
    document.querySelector('#count').value = '2';
    document.querySelector('#count').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#cmpBudget').value = '3000';
    document.querySelector('#cmpQRun').click();
    const t0 = Date.now();
    let rows = 0;
    while (Date.now() - t0 < 300000) {
      rows = document.querySelectorAll('#cmpQResult .q-table tbody tr').length;
      if (rows >= 1) break;
      await new Promise(r => setTimeout(r, 600));
    }
    return { rows, head: [...document.querySelectorAll('#cmpQResult th')].map(x => x.textContent.trim()),
      first: (document.querySelector('#cmpQResult tbody tr') || {}).textContent || '' };
  })()`);
  ok(cmpQueue.rows === 1, '对比模式的排队真跑完了并出了表', `${cmpQueue.rows} 行`);
  ok(cmpQueue.head.includes('胜率（用这张后）') && cmpQueue.head.includes('最好的'), '对比排队表多列「基线胜率 / 最好的」', cmpQueue.head.join(' / '));

  const restLabel = await evaluate(`(() => {
    document.querySelector('[data-mode=rest]').click();
    return [...document.querySelectorAll('#restCard option')].map(o => o.textContent.trim());
  })()`);
  ok(restLabel.every(t => !/×\d/.test(t) && !/已升 \d/.test(t)), '睡觉下拉里不再有「×张数」「已升 N」', restLabel.slice(0, 3).join(' / '));
  await send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
    if (r.result?.data) {
      const fs = await import('node:fs');
      fs.writeFileSync(SHOT, Buffer.from(r.result.data, 'base64'));
    }
  });
  ok(consoleErrors.length === 0, '页面没有 JS 报错', consoleErrors.slice(0, 2).join(' | '));
} catch (e) {
  ok(false, '脚本本身出错', String(e && e.message || e));
} finally {
  try { ws && ws.close(); } catch { }
  try { chrome.kill(); } catch { }
}
console.log(fails.length ? `\n结果：${fails.length} 项没过\n` : '\n结果：全部通过\n');
process.exit(fails.length ? 1 : 0);
