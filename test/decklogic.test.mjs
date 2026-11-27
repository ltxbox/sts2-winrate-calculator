import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const L = require('../public/decklogic.js')

const total = rows => rows.reduce((s, r) => s + r.count, 0)
const sum = (rows, pred) => rows.filter(pred).reduce((s, r) => s + r.count, 0)

test('4 张同名卡里只有 1 张附魔：拆成 3 张无附魔 + 1 张带附魔', () => {
  const rows = L.expandDeck([{ cardId: 'STRIKE', count: 4, enchCount: 1, enchantmentId: 'ADROIT' }])
  assert.equal(total(rows), 4)
  assert.equal(sum(rows, r => !r.enchantmentId), 3)
  assert.equal(sum(rows, r => r.enchantmentId === 'ADROIT'), 1)
  assert.equal(sum(rows, r => r.upgradeLevels === 1), 0)
})

test('升级 2 张 + 附魔 3 张（共 4 张）：交集 1 张算「升级且附魔」，总数仍是 4', () => {
  const rows = L.expandDeck([{ cardId: 'STRIKE', count: 4, upCount: 2, enchCount: 3, enchantmentId: 'VIGOROUS' }])
  assert.equal(total(rows), 4)
  assert.equal(sum(rows, r => r.upgradeLevels === 1 && r.enchantmentId === 'VIGOROUS'), 1)
  assert.equal(sum(rows, r => r.upgradeLevels === 1 && !r.enchantmentId), 1)
  assert.equal(sum(rows, r => r.upgradeLevels === 0 && r.enchantmentId === 'VIGOROUS'), 2)
  assert.equal(sum(rows, r => !r.upgradeLevels && !r.enchantmentId), 0)
})

test('选了附魔但没给张数（老存档/老预设）→ 还是整组附魔，不会把附魔丢了', () => {
  const rows = L.expandDeck([{ cardId: 'BASH', count: 2, enchantmentId: 'ADROIT' }])
  assert.equal(total(rows), 2)
  assert.equal(sum(rows, r => r.enchantmentId === 'ADROIT'), 2)
})

test('附魔 0 张 = 明确不附（不能因为选了附魔就又整组带上）', () => {
  const rows = L.expandDeck([{ cardId: 'BASH', count: 2, enchantmentId: 'ADROIT', enchCount: 0 }])
  assert.equal(total(rows), 2)
  assert.equal(sum(rows, r => r.enchantmentId), 0)
})

test('附魔张数超过总张数会被夹住（不会造出 5 张打击）', () => {
  const rows = L.expandDeck([{ cardId: 'STRIKE', count: 2, enchCount: 9, enchantmentId: 'ADROIT' }])
  assert.equal(total(rows), 2)
  assert.equal(sum(rows, r => r.enchantmentId === 'ADROIT'), 2)
})

test('导入：存档里同一种卡的多条（普通/升级/附魔）合并成一行', () => {
  const { deck, warnings } = L.mergeImported([
    { cardId: 'STRIKE', count: 2, upgradeLevels: 0 },
    { cardId: 'STRIKE', count: 1, upgradeLevels: 1 },
    { cardId: 'STRIKE', count: 1, upgradeLevels: 0, enchantmentId: 'ADROIT', enchantmentAmount: 0 },
  ])
  assert.equal(deck.length, 1)
  assert.equal(deck[0].count, 4)
  assert.equal(deck[0].upCount, 1)
  assert.equal(deck[0].enchantmentId, 'ADROIT')
  assert.equal(deck[0].enchCount, 1, '只有 1 张是附魔的，合并后也得是 1 张')
  assert.equal(warnings.length, 0)
})

test('导入：同一种卡有两种附魔时，保留张数最多的那种，并明确警告（不悄悄丢）', () => {
  const { deck, warnings } = L.mergeImported([
    { cardId: 'STRIKE', count: 2, upgradeLevels: 0, enchantmentId: 'ADROIT' },
    { cardId: 'STRIKE', count: 1, upgradeLevels: 0, enchantmentId: 'GOOPY' },
    { cardId: 'STRIKE', count: 1, upgradeLevels: 0 },
  ])
  assert.equal(deck[0].count, 4, '总张数不能少')
  assert.equal(deck[0].enchantmentId, 'ADROIT')
  assert.equal(deck[0].enchCount, 2)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /STRIKE/)
})

test('导入的行能直接进 expandDeck：合并后再拆条，张数守恒', () => {
  const { deck } = L.mergeImported([
    { cardId: 'DEFEND', count: 3, upgradeLevels: 0 },
    { cardId: 'DEFEND', count: 1, upgradeLevels: 0, enchantmentId: 'ADROIT' },
  ])
  const rows = L.expandDeck(deck)
  assert.equal(total(rows), 4)
  assert.equal(sum(rows, r => r.enchantmentId === 'ADROIT'), 1)
})

test('角色血量表与从 sts2.dll 导出的 character_hp.json 一致（不许手改代码里的数）', () => {
  const file = path.join(__dirname, '..', 'assets', 'character_hp.json')
  const truth = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [id, hp] of Object.entries(truth)) {
    assert.equal(L.CHARACTER_HP[id], hp, `${id} 的初始生命和 dll 里导出的不一致`)
  }
  assert.equal(L.CHARACTER_HP.NECROBINDER, 66, '亡灵契约师 66 是游戏本体里的值')
})

test('切换角色时能取到该角色的上限；随机/轮换这种没有真实血量', () => {
  assert.equal(L.maxHpOf('IRONCLAD'), 80)
  assert.equal(L.maxHpOf('SILENT'), 70)
  assert.equal(L.maxHpOf('DEFECT'), 75)
  assert.equal(L.maxHpOf('REGENT'), 75)
  assert.equal(L.maxHpOf('FOOL'), 77)
  assert.equal(L.maxHpOf('RANDOM_CHARACTER'), null)
})

/* ---- 文字描述导入（2026-11-27 主人：「绿护卫，白致死汲取，删一打」这种，在初始卡组上改） ---- */
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'meta.json'), 'utf8'))
const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'starting_decks.json'), 'utf8'))
const row = (deck, id) => deck.find(d => d.cardId === id)

test('文字导入：主人那句原话的打法——加绿护卫、加白能量汲取、删一打', () => {
  const r = L.parseTextDelta('绿护卫，白能量汲取，删一打', meta.cards, starter.NECROBINDER, { character: 'NECROBINDER' })
  const guard = row(r.deck, 'BODYGUARD')
  assert.equal(guard.count, 2, '初始 1 张护卫 + 新加 1 张')
  assert.equal(guard.upCount, 1, '新加的那张是升级态')
  assert.equal(row(r.deck, 'STRIKE_NECROBINDER').count, 3, '初始 4 张打击删掉 1 张')
  assert.equal(r.rows.filter(x => x.op === 'del').length, 1)
  const drain = r.rows.find(x => x.name.includes('汲取'))
  assert.ok(drain, '能量汲取要认出来')
  assert.equal(drain.op, 'add')
  assert.equal(drain.up, false, '白 = 未升级')
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched))
})

test('文字导入：数量、升级写法、删优先删没升级的那几张', () => {
  const r = L.parseTextDelta('2绿打击，防御+，删四防', meta.cards, starter.NECROBINDER, { character: 'NECROBINDER' })
  const strike = row(r.deck, 'STRIKE_NECROBINDER')
  assert.equal(strike.count, 6, '4 张打击 + 2 张升级打击')
  assert.equal(strike.upCount, 2)
  const def = row(r.deck, 'DEFEND_NECROBINDER')
  assert.equal(def.count, 1, '加了 1 张升级防御、再删 4 张：先删 4 张没升级的')
  assert.equal(def.upCount, 1, '剩下的是那张升级的')
  assert.equal(r.total, r.deck.reduce((s, d) => s + d.count, 0))
})

test('文字导入：认不出来的短语单独列出来，不悄悄吞掉', () => {
  const r = L.parseTextDelta('绿护卫，胡说八道的东西', meta.cards, starter.NECROBINDER, { character: 'NECROBINDER' })
  assert.equal(r.unmatched.length, 1)
  assert.match(r.unmatched[0], /胡说八道/)
  assert.equal(row(r.deck, 'BODYGUARD').count, 2, '认出来的那一条照样生效')
})

test('文字导入：空话不动卡组（空字符串 = 还是初始卡组）', () => {
  const base = L.mergeImported(starter.SILENT.map(d => ({ ...d }))).deck
  const r = L.parseTextDelta('   ', meta.cards, starter.SILENT, { character: 'SILENT' })
  assert.equal(r.deck.length, base.length)
  assert.equal(r.total, base.reduce((s, d) => s + d.count, 0))
})
