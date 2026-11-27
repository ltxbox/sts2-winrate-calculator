// 验证：遗物计数器（钢笔尖 AttacksPlayed）传进 request.json 的 integerMembers 里，harness 认不认。
// 用法：node tools/relicprops-check.mjs [seed]
//      存档路径用环境变量 STS2_SAVE 指（不给就试 Steam 默认位置）
// 三个请求跑同一个种子：计数 0 / 计数 9 / 不带计数，比较掉血和是否胜利。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const HARNESS = path.join(ROOT, 'harness', 'OfflineSearchHarness.exe');
const STEAM = process.env.STEAM_ROOT || 'C:/Program Files (x86)/Steam';
const SAVE = process.env.STS2_SAVE || path.join(STEAM, 'userdata', process.env.STEAM_ID || '', '2868840',
  'remote', 'modded', 'profile1', 'saves', 'current_run.save');
if (!fs.existsSync(SAVE)) {
  console.error('找不到存档：请用环境变量 STS2_SAVE 指到 current_run.save（先玩一局、存在进行中的存档）');
  process.exit(2);
}
const OUT = path.join(ROOT, 'runs', '_propscheck');
const seed = process.argv[2] || 'PROPS-0001';

function buildCards(p) {
  const strip = (s, pre) => (s && String(s).toUpperCase().startsWith(pre) ? String(s).slice(pre.length) : s);
  const map = new Map();
  for (const c of p.deck || []) {
    const id = strip(c.id, 'CARD.');
    if (!id) continue;
    const key = id + '|' + (c.current_upgrade_level || 0);
    if (!map.has(key)) map.set(key, { cardId: id, pile: 'Deck', count: 0, up: c.current_upgrade_level || 0 });
    map.get(key).count++;
  }
  return [...map.values()].map(c => c.up ? { cardId: c.cardId, pile: 'Deck', count: c.count, upgradeLevels: c.up } : { cardId: c.cardId, pile: 'Deck', count: c.count });
}

function req(deck, hp, maxHp, encounter, relics, props) {
  const relicsOut = relics.map(r => {
    const o = { relicId: r, addWithoutObtainedEffects: true };
    const p = props && props[r];
    if (p) {
      // 源码 UnattendedRelicInjection：integerMembers / booleanMembers（反射写进 RelicModel 字段）
      if (p.ints) { o.integerMembers = {}; for (const it of p.ints) o.integerMembers[it.name] = it.value; }
      if (p.bools) { o.booleanMembers = {}; for (const it of p.bools) o.booleanMembers[it.name] = it.value; }
    }
    return o;
  });
  return {
    schemaVersion: 1, scenarioId: seed, characterId: 'NECROBINDER', encounterId: encounter, seed,
    ascension: 10, gameMode: 'Standard', actIndexForTest: 0, targetRoomType: 'Boss',
    preserveNativeCombatStateForTest: true, clearRunDeck: true,
    runCards: deck, cards: [], relics: relicsOut, potions: [],
    potionPolicyForTest: 'Disabled', preCombatPlayerCurrentHpOverride: null,
    fixedSearchBudget: true, searchBudgetOverrideMilliseconds: 4000,
    stopAfterInitialSolverResultAssertion: true, timeoutSeconds: 300,
  };
}

const j = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
const p = j.players[0];
const act = (j.acts || [])[j.current_act_index] || {};
const encounter = String((act.rooms && act.rooms.boss_id) || 'SOUL_FYSH_BOSS').replace(/^ENCOUNTER\./, '');
const deck = buildCards(p);
const baseRelics = ['PEN_NIB'];
console.log('save:', p.current_hp + '/' + p.max_hp, 'enc:', encounter, 'deck:', deck.reduce((s, c) => s + c.count, 0));

const cases = [
  { tag: 'props0', props: { PEN_NIB: { ints: [{ name: 'AttacksPlayed', value: 0 }] } } },
  { tag: 'props9', props: { PEN_NIB: { ints: [{ name: 'AttacksPlayed', value: 9 }] } } },
  { tag: 'noprops', props: {} },
  // 决定性实验：蜥蜴尾巴的 WasUsed（用过就没了那条命）。这个 bool 只要被认，结果一定不一样。
  { tag: 'tail-unused', hp: 8, relics: ['LIZARD_TAIL'], props: { LIZARD_TAIL: { bools: [{ name: 'WasUsed', value: false }] } } },
  { tag: 'tail-used', hp: 8, relics: ['LIZARD_TAIL'], props: { LIZARD_TAIL: { bools: [{ name: 'WasUsed', value: true }] } } },
];

fs.mkdirSync(OUT, { recursive: true });
for (const c of cases) {
  const dir = path.join(OUT, c.tag);
  fs.mkdirSync(dir, { recursive: true });
  const reqPath = path.join(dir, 'request.json');
  const hp = c.hp == null ? p.current_hp : c.hp;
  fs.writeFileSync(reqPath, JSON.stringify(req(deck, hp, p.max_hp, encounter, c.relics || baseRelics, c.props), null, 1), 'utf8');
  const t0 = Date.now();
  const r = spawnSync(HARNESS, ['--request', reqPath, '--label', seed, '--out', dir, '--profile', 'VeryHigh',
    '--beam', '135', '--nodes', '100000', '--potion-policy', 'Disabled',
    '--player-hp', String(hp), '--player-max-hp', String(p.max_hp)],
    { encoding: 'utf8', timeout: 300000, windowsHide: true });
  const sec = Math.round((Date.now() - t0) / 100) / 10;
  const res = fs.existsSync(path.join(dir, 'harness-result.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'harness-result.json'), 'utf8')) : null;
  const q = res && (res.comparisonQuality || res.ComparisonQuality) || {};
  const get = (o, k) => o && o[k] != null ? o[k] : (o && o[k[0].toUpperCase() + k.slice(1)]);
  console.log(`\n[${c.tag}] ${sec}s exit=${r.status}`);
  if (res) {
    console.log('  won:', get(q, 'won'), ' hpLost:', get(q, 'projectedBattleHpLost'), ' turn:', get(q, 'combatEndedTurn'), ' status:', get(res, 'status'));
  } else {
    console.log('  no result. stderr tail:', (r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' / '));
  }
}
