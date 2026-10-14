import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Fighter, Flavor, ItemId, Loot, LootKind, Meta, Mode, Purse, Quest, Rest, Run, Shop, Spell, View, Weapon } from '../types'
import {
  FAMILIAR_DAMAGE,
  QUEST_GOLD,
  QUEST_XP,
  RIVAL_EVERY,
  SPELL_SWINGS,
  WEAPONS,
  allyDamage,
  darkness,
  fighterFor,
  isMcp,
  newlyDone,
  quake,
  todoBoard,
  turnEnd,
  weaponFor,
} from './claude'
import { NO_META, ambush, attack, newRun, readMsFor, strike, swingDamage } from './combat'
import { dayOf, flavorPrompt, readLine, roomOf, tableLine } from './flavor'
import { BIOME_NAME, LOOT_NAME, SCALE, SCENE_H, SCENE_W, questsSvg, sceneSvg, shopSvg } from './scene'
import { WARES, diceShop, ownedOf, priceOf, readPick, shopPrompt, shopText } from './shop'

const PANE = 'depths'
const TITLE = "Claude's Depths"

// Energy per turn past this goes to XP instead.
export const ENERGY_CAP = 20
// A turn with no tool call by then is a Q&A turn: the hero farms.
export const FARM_AFTER_MS = 3000
export const DROP_EVERY_MS = 4000
export const LOOT_MS = 7000
// After a turn ends: drift this long and the torch burns out, the monster ambushes once.
export const TORCH_MS = 5 * 60_000
// Energy for coming back after reading the reply, before the torch burns out.
export const MOMENTUM_ENERGY = 3
// Haiku gets this long to stock the shop before dice do it.
export const SHOP_TIMEOUT_MS = 8000
// A room's line waits this long for Haiku before the table answers.
export const FLAVOR_TIMEOUT_MS = 4000
// Haiku calls a day (UTC), shop and flavor together; past it the table answers.
export const HAIKU_DAILY_CAP = 200

// The base drops, plus the ones the shop unlocked.
function lootKinds(m: Meta): LootKind[] {
  return ['coin', 'coin', 'gem_xp', 'potion_red', ...(m.potion_blue ? ['potion_blue' as const] : []), ...(m.loot_bag ? ['loot_bag' as const] : [])]
}

const run = atom({ plugin: 'delve', key: 'run' } as const, newRun())
const purse = atom({ plugin: 'delve', key: 'purse' } as const, { energy: 0, xp: 0, gained: 0 })
const mode = atom({ plugin: 'delve', key: 'mode' } as const, 'idle' as Mode)
const loot = atom({ plugin: 'delve', key: 'loot' } as const, [] as Loot[])
const rest = atom({ plugin: 'delve', key: 'rest' } as const, null as Rest | null)
const meta = atom({ plugin: 'delve', key: 'meta' } as const, NO_META)
const flavor = atom({ plugin: 'delve', key: 'flavor' } as const, null as Flavor | null)
const shop = atom({ plugin: 'delve', key: 'shop' } as const, null as Shop | null)
const view = atom({ plugin: 'delve', key: 'view' } as const, 'scene' as View)
const weapon = atom({ plugin: 'delve', key: 'weapon' } as const, 'fists' as Weapon)
const fighters = atom({ plugin: 'delve', key: 'fighters' } as const, [] as Fighter[])
const tally = atom({ plugin: 'delve', key: 'tally' } as const, {} as Record<string, number>)
const spell = atom({ plugin: 'delve', key: 'spell' } as const, null as Spell | null)
const quests = atom({ plugin: 'delve', key: 'quests' } as const, [] as Quest[])
const context = atom({ plugin: 'delve', key: 'context' } as const, null as number | null)

// The running turn's farm timers and the pause's torch timers; a hot reload cancels
// them with the module, and session.start arms the torch again from `rest`.
let farmTimers: Timer[] = []
let torchTimers: Timer[] = []

function stopFarm() {
  farmTimers.forEach(t => t.cancel())
  farmTimers = []
}

function stopTorch() {
  torchTimers.forEach(t => t.cancel())
  torchTimers = []
}

// `/delve off` survives restarts, so it lives in the store, not session state.
async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get('enabled')) !== false
}

// `/delve haiku off` stops every model call (flavor and shop fall to their tables); stored like `off`.
async function isHaikuOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get('haikuOn')) !== false
}

// Run and purse live in session state for drawing, and in the store to survive restarts.
async function changeRun($: EngineInterface, fn: (r: Run) => Run): Promise<Run> {
  const r = await update($, run, fn)
  await $.store.set('run', r)
  return r
}

async function changePurse($: EngineInterface, fn: (p: Purse) => Purse): Promise<Purse> {
  const p = await update($, purse, fn)
  await $.store.set('purse', p)
  await showStatus($)
  return p
}

// A saved run from an older build may lack newer fields; the defaults fill them.
async function loadSaved($: EngineInterface) {
  const savedRun = await $.store.get('run')
  if (savedRun && typeof savedRun === 'object' && 'monster' in savedRun) {
    await update($, run, () => ({ ...newRun(), ...(savedRun as Partial<Run>) }))
  }
  const savedPurse = await $.store.get('purse')
  if (savedPurse && typeof savedPurse === 'object' && 'energy' in savedPurse) {
    await update($, purse, p => ({ ...p, ...(savedPurse as Partial<Purse>) }))
  }
  const savedMeta = await $.store.get('meta')
  if (savedMeta && typeof savedMeta === 'object') await update($, meta, m => ({ ...m, ...(savedMeta as Partial<Meta>) }))
  const savedFlavor = await $.store.get('flavor')
  if (savedFlavor && typeof savedFlavor === 'object' && 'room' in savedFlavor) await update($, flavor, () => savedFlavor as Flavor)
  const savedShop = await $.store.get('shop')
  if (savedShop && typeof savedShop === 'object' && Array.isArray((savedShop as Shop).stock)) await update($, shop, () => savedShop as Shop)
}

// The status line HUD: energy, XP, and the torch while Claude waits on the person.
async function showStatus($: EngineInterface) {
  const p = await read($, purse)
  const r = await read($, rest)
  const capped = p.gained >= ENERGY_CAP ? ' · capped, rest to XP' : ''
  let torch = ''
  if (r?.isOut) torch = ' · torch out'
  else if (r) torch = ` · torch ${Math.max(1, Math.ceil((TORCH_MS - ((await $.clock.now()) - r.endedAt)) / 60_000))}m`
  void $.ui.status(`Depths · energy ${p.energy} · XP ${p.xp}${capped}${torch}`)
}

// Counts the torch down on the status line, then lets the monster ambush once.
async function armTorch($: EngineInterface, r: Rest) {
  stopTorch()
  if (r.isOut) return
  const left = TORCH_MS - ((await $.clock.now()) - r.endedAt)
  torchTimers.push($.clock.every(60_000, () => void showStatus($)))
  torchTimers.push($.clock.after(Math.max(0, left), () => void burnOut($)))
}

async function burnOut($: EngineInterface) {
  stopTorch()
  await update($, rest, r => (r ? { ...r, isOut: true } : r))
  await changeRun($, ambush)
  await showStatus($)
}

// A new prompt ends the pause: momentum if the reply was read and the torch still burns.
async function endRest($: EngineInterface) {
  stopTorch()
  const r = await read($, rest)
  if (!r) return
  await update($, rest, () => null)
  if (r.isOut || (await $.clock.now()) - r.endedAt < r.readMs) return
  await changePurse($, p => ({ ...p, energy: p.energy + MOMENTUM_ENERGY }))
  void $.ui.toast(`Momentum: +${MOMENTUM_ENERGY} energy for reading the reply.`)
}

async function gainEnergy($: EngineInterface) {
  await changePurse($, was =>
    was.gained < ENERGY_CAP
      ? { ...was, energy: was.energy + 1, gained: was.gained + 1 }
      : { ...was, xp: was.xp + 1, gained: was.gained + 1 },
  )
}

async function dropLoot($: EngineInterface) {
  const kinds = lootKinds(await read($, meta))
  const kind = kinds[Math.floor(Math.random() * kinds.length)]!
  const one: Loot = { id: `${await $.clock.now()}-${Math.random().toString(36).slice(2, 6)}`, kind }
  await update($, loot, list => [...list, one].slice(-3))
  // Not a farm timer: a drop still fades on time after the turn ends.
  $.clock.after(LOOT_MS, () => void update($, loot, list => list.filter(l => l.id !== one.id)))
}

async function startFarm($: EngineInterface) {
  // Armed by turn start and after each tool call (the next call cancels it), so idle means the turn ended.
  const now = await update($, mode, m => (m === 'idle' ? m : 'farm'))
  if (now !== 'farm') return
  await dropLoot($)
  farmTimers.push($.clock.every(DROP_EVERY_MS, () => void dropLoot($)))
}

async function grab($: EngineInterface, one: Loot) {
  if ((await read($, mode)) === 'idle') return
  let isThere = false
  await update($, loot, list => {
    isThere = list.some(l => l.id === one.id)
    return list.filter(l => l.id !== one.id)
  })
  if (!isThere) return
  if (one.kind === 'gem_xp' || one.kind === 'potion_blue') {
    await changePurse($, p => (one.kind === 'gem_xp' ? { ...p, xp: p.xp + 3 } : { ...p, energy: p.energy + 2 }))
    return
  }
  await changeRun($, r =>
    one.kind === 'coin'
      ? { ...r, gold: r.gold + 1 + Math.floor(Math.random() * 3) }
      : one.kind === 'loot_bag'
        ? { ...r, gold: r.gold + 5 + Math.floor(Math.random() * 4) }
        : { ...r, hp: r.isDead ? r.hp : Math.min(r.maxHp, r.hp + 2) },
  )
}

// A spell's free swing first, else one energy; false when neither is left.
async function pay($: EngineInterface): Promise<boolean> {
  if (await read($, spell)) {
    await update($, spell, s => (s && s.swings > 1 ? { ...s, swings: s.swings - 1 } : null))
    return true
  }
  let isPaid = false
  await changePurse($, p => {
    isPaid = p.energy > 0
    return isPaid ? { ...p, energy: p.energy - 1 } : p
  })
  return isPaid
}

// One swing with the weapon in hand; a doppelganger in the way takes it first.
async function swing($: EngineInterface) {
  if ((await read($, run)).isDead || (await read($, mode)) === 'idle') return
  if (!(await pay($))) {
    void $.ui.toast("No energy. Claude's tool calls charge it.")
    return
  }
  const m = await read($, meta)
  const w = await read($, weapon)
  const foe = (await read($, fighters)).find(f => f.side === 'rival')
  if (foe) return hitRival($, foe, swingDamage(Math.random, m, WEAPONS[w].edge))
  const was = await read($, run)
  const now = await changeRun($, r => attack(r, Math.random, m, WEAPONS[w].edge))
  if (w === 'portal') await dropLoot($)
  if (now.floor !== was.floor) await slain($)
}

async function hitRival($: EngineInterface, foe: Fighter, dealt: number) {
  const hp = Math.max(0, foe.hp - dealt)
  if (hp > 0) {
    await update($, fighters, list => list.map(f => (f.agentId === foe.agentId ? { ...f, hp } : f)))
    await changeRun($, r => ({ ...r, last: { dealt, took: 0, atRival: true, note: `Hit your doppelganger for ${dealt}.` } }))
    return
  }
  const prize = foe.maxHp
  await update($, fighters, list => list.filter(f => f.agentId !== foe.agentId))
  await changePurse($, p => ({ ...p, xp: p.xp + prize }))
  const note = `You beat your doppelganger! +${prize} gold, +${prize} XP.`
  await changeRun($, r => ({ ...r, gold: r.gold + prize, last: { dealt, took: 0, atRival: true, note } }))
}

// A blow the hero did not swing, from `who` (an ally, a familiar).
async function landBlow($: EngineInterface, dealt: number, who: string) {
  const m = await read($, meta)
  const was = await read($, run)
  if (was.isDead) return
  const now = await changeRun($, r => {
    const s = strike(r, dealt, Math.random, m)
    const note = s.last?.slain ? `${who} slew the ${s.last.slain}! Down to floor ${s.floor}.` : `${who} hit the ${r.monster.kind} for ${dealt}.`
    return { ...s, last: { dealt, took: 0, ...s.last, note } }
  })
  if (now.floor !== was.floor) await slain($)
}

// A kill drops one piece of loot, then the new room gets its line.
async function slain($: EngineInterface) {
  await dropLoot($)
  await describeRoom($)
}

// Claude's own tool call arms the hero: a weapon for the swings, or a familiar's strike.
async function forge($: EngineInterface, tool: string, result: ToolCallResult) {
  const isOk = !result.deny && !result.isError
  const w = weaponFor(tool, isOk)
  if (w && w !== (await read($, weapon))) await update($, weapon, () => w)
  if (isMcp(tool) && isOk) await landBlow($, FAMILIAR_DAMAGE, 'Your familiar')
}

type Todo = { content: string; status: string }

// Claude's todo list as a quest board: TodoWrite sends the whole list, the Task tools one
// task at a time. Each quest finished pays gold into the run and XP into the purse.
async function track($: EngineInterface, e: ToolCallInput, result: ToolCallResult) {
  if (result.deny || result.isError) return
  const out = (result.result ?? {}) as {
    oldTodos?: Todo[]
    newTodos?: Todo[]
    task?: { id: string; subject: string }
    statusChange?: { to: string }
  }
  let done: string[] = []
  if (e.tool === 'TodoWrite' && out.newTodos) {
    const now = out.newTodos
    await update($, quests, () => todoBoard(now))
    done = newlyDone(out.oldTodos ?? [], now)
  } else if (e.tool === 'TaskCreate' && out.task) {
    const task = out.task
    await update($, quests, q => [...q, { id: task.id, text: task.subject, isDone: false }])
  } else if (e.tool === 'TaskUpdate') {
    const ask = e as unknown as { taskId: string; status?: string; subject?: string }
    const was = (await read($, quests)).find(q => q.id === ask.taskId)
    await update($, quests, q =>
      ask.status === 'deleted'
        ? q.filter(x => x.id !== ask.taskId)
        : q.map(x => (x.id === ask.taskId ? { ...x, text: ask.subject ?? x.text, isDone: x.isDone || ask.status === 'completed' } : x)),
    )
    if (out.statusChange?.to === 'completed') done = [ask.subject ?? was?.text ?? 'a task']
  }
  if (!done.length) return
  await changeRun($, r => ({ ...r, gold: r.gold + QUEST_GOLD * done.length }))
  await changePurse($, p => ({ ...p, xp: p.xp + QUEST_XP * done.length }))
  void $.ui.toast(`Quest done: ${done.join('; ')}. +${QUEST_GOLD * done.length} gold, +${QUEST_XP * done.length} XP.`)
}

// A subagent's tool call counts toward its blow; a doppelganger strikes every few calls,
// never past 1 HP.
async function subagentCall($: EngineInterface, agentId: string) {
  const foe = (await read($, fighters)).find(f => f.agentId === agentId)
  if (!foe) return
  const calls = (await update($, tally, t => ({ ...t, [agentId]: (t[agentId] ?? 0) + 1 })))[agentId] ?? 0
  if (foe.side !== 'rival' || calls % RIVAL_EVERY !== 0) return
  await changeRun($, r => {
    if (r.isDead) return r
    const took = r.hp > 1 ? 1 : 0
    return { ...r, hp: r.hp - took, last: { dealt: 0, took, isEvent: true, note: `Your doppelganger struck you for ${took}.` } }
  })
}

// A subagent's run ended: an ally lands its blow, a doppelganger still standing walks off.
async function settle($: EngineInterface, agentId: string) {
  const f = (await read($, fighters)).find(x => x.agentId === agentId)
  if (!f) return
  const calls = (await read($, tally))[agentId] ?? 0
  await update($, fighters, list => list.filter(x => x.agentId !== agentId))
  await update($, tally, t => Object.fromEntries(Object.entries(t).filter(([id]) => id !== agentId)))
  if (f.side === 'ally') return landBlow($, allyDamage(calls), `Your ${f.kind} ally`)
  await changeRun($, r => ({ ...r, last: { dealt: 0, took: 0, isEvent: true, note: 'Your doppelganger walked off, unbeaten.' } }))
}

// The context's fill dims the torch; read once a turn end, never on a clock.
async function measureTorch($: EngineInterface) {
  try {
    const { context: c } = await $.session.usage()
    await update($, context, () => c.percent ?? null)
  } catch {
    // No reading this turn: the torch keeps its last brightness.
  }
}

// One Haiku call within the daily cap: its reply's text, or undefined (switched off, capped,
// failed, timed out, or refused) so the caller falls back to its table.
async function askHaiku($: EngineInterface, prompt: string, maxTokens: number, timeoutMs: number): Promise<string | undefined> {
  if (!(await isHaikuOn($))) return undefined
  const day = dayOf(await $.clock.now())
  const saved = (await $.store.get('haiku')) as { day: string; count: number } | undefined
  const count = saved?.day === day ? saved.count : 0
  if (count >= HAIKU_DAILY_CAP) return undefined
  await $.store.set('haiku', { day, count: count + 1 })
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt, effort: 'low', maxTokens, timeoutMs })
    return reply.isAnswered ? reply.text : undefined
  } catch {
    return undefined
  }
}

// The current room's flavor line, written once per room; a line for a room the hero
// has already left is dropped.
async function describeRoom($: EngineInterface) {
  const r = await read($, run)
  const room = roomOf(r)
  if (r.isDead || (await read($, flavor))?.room === room) return
  const said = await askHaiku($, flavorPrompt(r, BIOME_NAME[r.biome]), 100, FLAVOR_TIMEOUT_MS)
  const line: Flavor = { room, text: (said && readLine(said)) ?? tableLine(r) }
  if (roomOf(await read($, run)) !== room) return
  await update($, flavor, () => line)
  await $.store.set('flavor', line)
}

// Haiku picks the wares from what is for sale; any failure or a bad pick falls to dice.
async function restock($: EngineInterface, floor: number): Promise<Shop> {
  const m = await read($, meta)
  const { xp } = await read($, purse)
  const said = await askHaiku($, shopPrompt(m, xp, floor), 200, SHOP_TIMEOUT_MS)
  return changeShop($, said === undefined ? diceShop(m, Math.random) : readPick(said, m, Math.random))
}

// The shop lives in session state for the shop view, and in the store to survive restarts.
async function changeShop($: EngineInterface, s: Shop): Promise<Shop> {
  await update($, shop, () => s)
  await $.store.set('shop', s)
  return s
}

// The loaded shop, or a fresh one the first time.
async function currentShop($: EngineInterface): Promise<Shop> {
  return (await read($, shop)) ?? restock($, (await read($, run)).floor)
}

// The pane shows the shop at once; a first visit stocks it meanwhile.
async function openShop($: EngineInterface) {
  await update($, view, () => 'shop')
  await currentShop($)
}

async function buy($: EngineInterface, id: string): Promise<string> {
  const stocked = await currentShop($)
  const ware = stocked.stock.find(s => s === id)
  if (!ware) return `No "${id}" on the shelf. /delve shop lists the wares.`
  const price = priceOf(ware, await read($, meta))
  let held = 0
  await changePurse($, p => {
    held = p.xp
    return p.xp >= price ? { ...p, xp: p.xp - price } : p
  })
  if (held < price) return `${WARES[ware].name} costs ${price} XP; you hold ${held}.`
  const m = await update($, meta, was => ({ ...was, [ware]: was[ware] + 1 }))
  await $.store.set('meta', m)
  await changeShop($, { ...stocked, stock: stocked.stock.filter(s => s !== ware) })
  // Vitality lifts the living hero now; every new run starts with it.
  if (ware === 'vitality') await changeRun($, r => (r.isDead ? r : { ...r, maxHp: r.maxHp + 2, hp: r.hp + 2 }))
  return `Bought ${WARES[ware].name} ${m[ware]}/${WARES[ware].max}: ${WARES[ware].does}. ${held - price} XP left.`
}

// The shop view's Buy: the same purchase as /delve buy, its message as a toast.
async function buyFromPane($: EngineInterface, id: ItemId) {
  void $.ui.toast(await buy($, id))
}

// New run: the hero starts with what the shop sold, and the shop restocks.
async function startOver($: EngineInterface) {
  const fallen = await read($, run)
  const m = await read($, meta)
  await changeRun($, () => newRun(m))
  await describeRoom($)
  await restock($, fallen.floor)
}

function blowLine(r: Run): string | undefined {
  const blow = r.last
  if (r.isDead) return `The warrior fell on floor ${r.floor} with ${r.gold} gold.`
  if (!blow) return undefined
  if (blow.note) return blow.note
  if (blow.isAmbush) return `The torch burnt out. The ${r.monster.kind} ambushed you for ${blow.took}.`
  if (blow.slain) return `Slew the ${blow.slain}! Down to floor ${r.floor}.`
  const took = blow.took > 0 ? `, took ${blow.took}` : ''
  return `Hit the ${r.monster.kind} for ${blow.dealt}${took}.`
}

// The line under the scene: only what the pictures cannot say (an event, the fall);
// plain hits and kills show as damage numbers and banners instead.
function noteLine(r: Run): string | undefined {
  return r.isDead || r.last?.note || r.last?.isAmbush ? blowLine(r) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'delve', description: "Claude's Depths: /delve opens the pane, /delve off turns it off, /delve shop spends XP, /delve haiku toggles Haiku lines" })
    await loadSaved($)
    const pause = await read($, rest)
    if (pause) await armTorch($, pause)
    if (await isEnabled($)) {
      void $.ui.open({ id: PANE, title: TITLE })
      await showStatus($)
      void describeRoom($)
    }

    return next(e)
  })

  on('command.run', { command: 'delve' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [verb, item] = arg.split(/\s+/)
    if (verb === 'shop') {
      // The pane turns to the shop too; the text stays for surfaces that draw no pane.
      if (await isEnabled($)) {
        await update($, view, () => 'shop')
        void $.ui.open({ id: PANE, title: TITLE })
      }
      return { text: shopText(await currentShop($), await read($, meta), (await read($, purse)).xp) }
    }
    if (verb === 'buy' && item) return { text: await buy($, item) }
    if (verb === 'haiku' && (item === undefined || item === 'on' || item === 'off')) {
      const isOn = item === undefined ? !(await isHaikuOn($)) : item === 'on'
      await $.store.set('haikuOn', isOn)
      return {
        text: isOn
          ? 'Haiku lines on: flavor and shop picks use Claude Haiku (capped per day).'
          : 'Haiku lines off: no model calls, flavor and shop use the built-in tables. /delve haiku turns them back on.',
      }
    }
    if (arg === 'off') {
      await $.store.set('enabled', false)
      await $.ui.close({ id: PANE })
      void $.ui.status(undefined)
      return { text: "Claude's Depths is off. /delve turns it back on." }
    }
    if (arg !== '' && arg !== 'on') return { text: 'Usage: /delve [on|off|shop|buy <id>|haiku [on|off]]' }
    await $.store.set('enabled', true)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await showStatus($)

    return { text: opened.isPlaced ? 'Into the depths.' : 'Depths pane opened, but no surface draws it here.' }
  })

  // A subagent's run raises no turn.start, so this is the main loop's turn.
  on('turn.start', async ($, e, next) => {
    stopFarm()
    await endRest($)
    await update($, purse, p => ({ ...p, gained: 0 }))
    await update($, mode, () => 'combat')
    await showStatus($)
    farmTimers.push($.clock.after(FARM_AFTER_MS, () => void startFarm($)))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A subagent's calls are its own fight, not the hero's energy.
    if (e.agentId) {
      const result = await next(e)
      await subagentCall($, e.agentId)
      return result
    }
    stopFarm()
    await update($, mode, () => 'combat')
    const result = await next(e)
    await gainEnergy($)
    await forge($, e.tool, result)
    await track($, e, result)
    // A quiet gap before the next call (Claude thinking or writing) farms too.
    farmTimers.push($.clock.after(FARM_AFTER_MS, () => void startFarm($)))

    return result
  }).catch(($, e, next) => next(e)) // never gate a tool on game bookkeeping

  // Mixed sides: a fork steps out as a rival doppelganger, any other subagent joins as an ally.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('agentId' in started && started.agentId) {
      const f = fighterFor(started.agentId, e, started.model)
      await update($, fighters, list => [...list, f])
    }
    return started
  }).catch(($, e, next) => next(e))

  // Compaction quakes the dungeon (the main conversation's, when it happened).
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || e.trigger === 'precompute' || done.skip) return done
    const m = await read($, meta)
    await changeRun($, r => quake(r, Math.random, m))
    void describeRoom($)
    return done
  }).catch(($, e, next) => next(e))

  // A skill is a spell: the next few swings cost no energy.
  on('skill.prompt', async ($, e, next) => {
    const said = await next(e)
    await update($, spell, () => ({ skill: e.skill, swings: SPELL_SWINGS }))
    return said
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await settle($, e.agentId)
      return next(e)
    }
    // Freeze: the game waits while the person reads the reply.
    stopFarm()
    await update($, mode, () => 'idle')
    await update($, loot, () => [])
    const pause: Rest = { endedAt: await $.clock.now(), readMs: readMsFor(e.answer), isOut: false }
    await update($, rest, () => pause)
    await armTorch($, pause)
    if (e.reason !== 'answer') await changeRun($, r => turnEnd(r, e.reason))
    await measureTorch($)
    await showStatus($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Claude's Depths draws on the desktop app only.</Text>
    }
    const { Box, Button, Text, Svg } = $.ui.resolve(e)
    if ((await read($, view)) === 'shop') {
      // Only the shop view reads the purse, so tool calls redraw the scene no more than before.
      const { xp } = await read($, purse)
      const stocked = await read($, shop)
      const m = await read($, meta)
      const owned = ownedOf(m)
      const wares = stocked
        ? stocked.stock.map(id => `${WARES[id].name} ${m[id] + 1}/${WARES[id].max}: ${WARES[id].does}, ${priceOf(id, m)} XP`).join('; ') || 'Sold out'
        : 'Stocking the shelves'
      return (
        <Box flexDirection="column" gap={1}>
          <Svg
            source={shopSvg(stocked?.stock ?? null, m, xp)}
            alt={`Shop · ${xp} XP. ${wares}.${owned.length ? ` Owned: ${owned.join(', ')}.` : ''}`}
            width={SCENE_W * SCALE}
            isInteractive
          />
          {stocked && (
            <Text italic dimColor>
              "{stocked.pitch}"
            </Text>
          )}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {stocked?.stock.map((id, i) => {
              const price = priceOf(id, m)
              return (
                <Button
                  key={`buy-${id}`}
                  hotkey={String(i + 1)}
                  label={`Buy ${WARES[id].name} · ${price} XP [${i + 1}]`}
                  variant={xp >= price ? 'primary' : undefined}
                  dimColor={xp < price}
                  onPress={() => void buyFromPane($, id)}
                />
              )
            })}
            <Button key="back" hotkey="b" label="Back [B]" onPress={() => void update($, view, () => 'scene')} />
          </Box>
        </Box>
      )
    }
    const r = await read($, run)
    const m = await read($, mode)
    const drops = await read($, loot)
    const f = await read($, flavor)
    const w = await read($, weapon)
    const cast = await read($, fighters)
    const ally = cast.find(one => one.side === 'ally')
    const rival = cast.find(one => one.side === 'rival')
    const sp = await read($, spell)
    const board = await read($, quests)
    const pct = await read($, context)
    const dark = darkness(pct)
    const pause = await read($, rest)
    const frozen =
      m === 'idle' && !r.isDead
        ? { leftMs: pause && !pause.isOut ? TORCH_MS - ((await $.clock.now()) - pause.endedAt) : 0, isOut: !!pause?.isOut }
        : undefined
    const where = BIOME_NAME[r.biome]
    // One line of words: an event worth saying, else the room's Haiku line.
    const note = noteLine(r)
    const said = note ?? (!r.isDead && f?.room === roomOf(r) ? f.text : undefined)
    // Everything the pictures show, said for readers that cannot see them.
    const alt = [
      (r.isDead
        ? `The warrior lies fallen in the ${where}`
        : m === 'farm'
          ? `The warrior farms the ${where} while Claude answers`
          : `The warrior faces a ${r.monster.kind} in the ${where}`) +
        (ally ? `, a ${ally.kind} ally at its side` : '') +
        (rival ? ', its doppelganger in the way' : '') +
        '.',
      `Floor ${r.floor}. HP ${r.hp}/${r.maxHp}, ${r.gold} gold.`,
      !r.isDead && `${r.monster.kind} HP ${r.monster.hp}/${r.monster.maxHp}.`,
      rival && `Doppelganger HP ${rival.hp}/${rival.maxHp}.`,
      `${WEAPONS[w].name}: ${WEAPONS[w].does}.`,
      sp && `Spell /${sp.skill}: ${sp.swings} free swing${sp.swings > 1 ? 's' : ''}.`,
      dark > 0 && `The torch dims: context ${pct}% full.`,
      blowLine(r),
      frozen && (frozen.isOut ? 'Frozen: the torch is out.' : 'Frozen: Claude waits on you. Read the reply; the torch burns out in 5 min.'),
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <Box flexDirection="column" gap={1}>
        <Svg
          source={sceneSvg(r, m === 'farm', drops, {
            ally: ally && ally.kind !== 'warrior' ? ally.kind : undefined,
            allyLabel: ally?.label,
            rival: rival && { hp: rival.hp, maxHp: rival.maxHp, label: rival.label },
            dark,
            weapon: w,
            spell: sp,
            context: pct,
            frozen,
          })}
          alt={alt}
          width={SCENE_W * SCALE}
          height={SCENE_H * SCALE}
          isInteractive
        />
        {said && (
          <Text italic={!note} dimColor={!note}>
            {said}
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {r.isDead ? (
            <Button key="new-run" variant="primary" hotkey="n" label="New run [N]" onPress={() => void startOver($)} />
          ) : (
            m !== 'idle' && (
              <Button
                key="attack"
                variant="primary"
                hotkey="a"
                label={`⚔ Attack${rival ? ' doppelganger' : ''} (${sp ? 'free' : '1 energy'}) [A]`}
                onPress={() => void swing($)}
              />
            )
          )}
          {!r.isDead &&
            m !== 'idle' &&
            drops.map((one, i) => (
              <Button key={one.id} hotkey={String(i + 1)} label={`Grab ${LOOT_NAME[one.kind]} [${i + 1}]`} onPress={() => void grab($, one)} />
            ))}
          <Button key="shop" hotkey="s" label="Shop [S]" dimColor onPress={() => void openShop($)} />
        </Box>
        {board.some(q => !q.isDone) && (
          <Svg
            source={questsSvg(board)}
            alt={`Quests: ${board
              .slice(0, 6)
              .map(q => `${q.isDone ? '[x]' : '[ ]'} ${q.text}`)
              .join('; ')}`}
            width={SCENE_W * SCALE}
            isInteractive
          />
        )}
      </Box>
    )
  })
}
