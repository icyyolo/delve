import type { On, ToolCallInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Biome, Meta, MonsterKind, Run } from '../types'
import { NO_META, STATS, attack, biomeFor, newRun, spawn } from '../hooks/combat'
import { DROP_EVERY_MS, ENERGY_CAP, FARM_AFTER_MS, HAIKU_DAILY_CAP, LOOT_MS, MOMENTUM_ENERGY, TORCH_MS } from '../hooks/register'
import { TABLE, dayOf, readLine, tableLine } from '../hooks/flavor'
import { QUEST_GOLD, QUEST_XP, WEAPONS, allyDamage, darkness, weaponFor } from '../hooks/claude'
import { iconSvg, questsSvg, sceneSvg, shopSvg } from '../hooks/scene'
import { ICON, PITCHES, STOCK_SIZE, readPick } from '../hooks/shop'
import { SPRITES } from '../hooks/sprites.gen'

const PANE = {
  plugin: 'delve',
  component: 'Pane',
  requestId: 'depths',
  props: {
    title: "Claude's Depths",
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const SVG_LIMIT = 131072
// The pictures carry what the text used to say; their alt says it for readers (and tests).
type Mounted = { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }
const pictured = async (ui: Mounted, said: RegExp) => (await ui.findAll({ type: 'Svg' })).some(svg => said.test(String(svg.props.alt)))

describe('pane', () => {
  test('desktop draws the scene as one interactive Svg', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const scene = (await ui.findAll({ type: 'Svg' })).find(svg => /warrior faces a slime/.test(String(svg.props.alt)))
    expect(scene).toBeDefined()
    expect(scene?.props.isInteractive).toBe(true)
    expect(String(scene?.props.source).length).toBeLessThan(SVG_LIMIT)
    expect(await pictured(ui, /Floor 1\./)).toBe(true)
    await ui.unmount()
  })

  test('terminal says desktop only', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /desktop app only/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('/delve', () => {
  test('off stores the choice and closes the pane; on reopens', async ($, on) => {
    const writes: unknown[] = []
    const closed: string[] = []
    const opened: string[] = []
    on('store.set', (_$, e) => {
      writes.push(e.value)
      return { value: undefined }
    })
    on('ui.close', (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })

    const off = await $.command.run({ ...RUN, command: 'delve', args: 'off' })
    expect(off.text).toMatch(/off/)
    expect(writes).toEqual([false])
    expect(closed).toEqual(['depths'])

    const back = await $.command.run({ ...RUN, command: 'delve', args: '' })
    expect(back.text).toMatch(/depths/)
    expect(writes).toEqual([false, true])
    expect(opened).toEqual(['depths'])
  })

  test('unknown argument shows usage', async $ => {
    const res = await $.command.run({ ...RUN, command: 'delve', args: 'sideways' })
    expect(res.text).toMatch(/Usage/)
  })
})

test('every biome x monster scene fits the Svg limit', async () => {
  const biomes: Biome[] = ['crypt', 'caverns']
  const kinds: MonsterKind[] = ['slime', 'bat', 'skeleton', 'wraith', 'golem', 'mimic']
  for (const biome of biomes) {
    for (const kind of kinds) {
      const src = sceneSvg({ ...newRun(), biome, monster: { kind, hp: 1, maxHp: 1 } })
      expect(src.length).toBeLessThan(SVG_LIMIT)
    }
  }
})

// Stands in for the engine under the mod: turns, tools, the status line, toasts, a store
// (seeded with `saved`) and a held clock.
// The test engine has no $.state reads, so each value the mod writes is recorded by key.
// `answer` plays the tools: its reply is the call's result; without one, every tool is denied.
function world(on: On, saved: Record<string, unknown> = {}, answer?: (e: Record<string, unknown>) => object) {
  const state: Record<string, unknown> = {}
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  mock.store(on, saved)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('state.set', async (_$, e, next) => {
    state[e.key] = e.value
    return next(e)
  })
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => (answer?.(e as unknown as Record<string, unknown>) ?? { deny: 'the test engine runs no tools' }) as { deny: string })
  return { clock: mock.clock(on), state, status, toasts }
}

// One Bash call by id; typed loosely, since the full tool union is too deep for tsc here.
type Tools = { tool: { call: (input: ToolCallInput) => Promise<unknown> } }
const runTool = ($: unknown, id: string) => ($ as Tools).tool.call({ tool: 'Bash', command: 'true', tool_use_id: id })
const loot = (state: Record<string, unknown>) => (state.loot ?? []) as { id: string }[]

describe('energy', () => {
  test('each tool call adds energy, past the cap it goes to XP', async ($, on) => {
    const { state, status } = world(on)

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    for (let i = 0; i < ENERGY_CAP + 2; i++) await runTool($, `u${i}`)

    expect(state.purse).toEqual({ energy: ENERGY_CAP, xp: 2, gained: ENERGY_CAP + 2 })
    expect(state.mode).toBe('combat')
    expect(status.at(-1)).toMatch(/energy 20 · XP 2 · capped/)

    // A new turn resets the per-turn count, so energy rises again.
    await $.turn.start({ text: 'again', turnId: 't2' })
    await runTool($, 'u99')
    expect(state.purse).toEqual({ energy: ENERGY_CAP + 1, xp: 2, gained: 1 })
  })
})

describe('AFK farm', () => {
  test('a Q&A turn drops loot that can be grabbed and fades', async ($, on) => {
    const { clock, state } = world(on)

    await $.turn.start({ text: 'what is a monad?', turnId: 't1' })
    await clock.advance(FARM_AFTER_MS)
    expect(state.mode).toBe('farm')
    expect(loot(state)).toHaveLength(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Button', text: /Grab/ })).toBeDefined()
    await ui.press({ key: loot(state)[0]!.id })
    expect(loot(state)).toEqual([])

    // The next drop is not grabbed and fades on its own.
    await clock.advance(DROP_EVERY_MS)
    expect(loot(state)).toHaveLength(1)
    await clock.advance(LOOT_MS)
    expect(loot(state)).toEqual([])
    await ui.unmount()
  })

  test('a tool call before the farm delay means combat, no loot', async ($, on) => {
    const { clock, state } = world(on)

    await $.turn.start({ text: 'run the tests', turnId: 't1' })
    await runTool($, 'u1')
    await clock.advance(FARM_AFTER_MS + DROP_EVERY_MS)
    expect(state.mode).toBe('combat')
    expect(loot(state)).toEqual([])

    await $.turn.complete({ answer: 'done', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1' })
    expect(state.mode).toBe('idle')
  })
})

// Dice that always land on one value: 0 crits and gets hit back, 0.99 does neither.
const dice = (n: number) => () => n

describe('combat rules', () => {
  test('a slime takes four plain hits, then the next floor opens with gold and a heal', () => {
    let r: Run = { ...newRun(), hp: 5 }
    for (let i = 0; i < 3; i++) r = attack(r, dice(0.99))
    expect(r.monster.hp).toBe(1)
    expect(r.hp).toBe(5)
    r = attack(r, dice(0.99))
    expect(r.floor).toBe(2)
    expect(r.gold).toBe(STATS.slime.gold)
    expect(r.hp).toBe(6)
    expect(r.last).toEqual({ dealt: 1, took: 0, slain: 'slime' })
  })

  test('a counter at 1 HP kills the hero, and the dead swing no more', () => {
    const dead = attack({ ...newRun(), hp: 1 }, dice(0))
    expect(dead.isDead).toBe(true)
    expect(dead.monster.hp).toBe(2)
    expect(attack(dead, dice(0))).toBe(dead)
  })

  test('with the caverns bought, biomes alternate every five floors', () => {
    expect([1, 5, 6, 10, 11].map(f => biomeFor(f, { ...NO_META, caverns: 1 }))).toEqual(['crypt', 'crypt', 'caverns', 'caverns', 'crypt'])
  })
})

describe('Attack button', () => {
  test('with no energy it only toasts; with energy it spends one and hits', async ($, on) => {
    const { state, toasts } = world(on)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await ui.press({ key: 'attack' })
    expect(toasts.at(-1)).toMatch(/No energy/)
    expect(state.run).toBeUndefined()

    await runTool($, 'u1')
    await ui.press({ key: 'attack' })
    expect((state.purse as { energy: number }).energy).toBe(0)
    expect((state.run as Run).monster.hp).toBeLessThan(4)
    expect(await pictured(ui, /Hit the slime/)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Hit the slime/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', text: /Attack/ }))?.props.hotkey).toBe('a')
    await ui.unmount()
  })

  test('a dead hero shows New run, which starts over on floor 1', async ($, on) => {
    const fallen: Run = { ...newRun(), floor: 7, hp: 0, isDead: true, gold: 30 }
    const { state } = world(on, { run: fallen })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    expect(await ui.find({ type: 'Text', text: /fell on floor 7/ })).toBeDefined()
    await ui.press({ key: 'new-run' })
    expect(state.run).toEqual(newRun())
    await ui.unmount()
  })
})

test('a run saved in the store comes back at session start', async ($, on) => {
  const saved: Run = { ...newRun(), floor: 4, gold: 12, monster: { kind: 'skeleton', hp: 5, maxHp: 8 } }
  const { state, status } = world(on, { run: saved, purse: { energy: 9, xp: 3, gained: 0 } })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  expect(state.run).toEqual(saved)
  expect(status.at(-1)).toMatch(/energy 9 · XP 3/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pictured(ui, /Floor 4\./)).toBe(true)
  await ui.unmount()
})

// A reply of n words: 'w w w ...'.
const reply = (words: number) => Array.from({ length: words }, () => 'w').join(' ')
const end = (turnId: string, answer: string) => ({ answer, durationMs: 1, reason: 'answer', isAborted: false, turnId }) as const

describe('freeze and torch', () => {
  test('the turn end freezes the pane: no Attack, no loot, a frozen line', async ($, on) => {
    const { clock, state } = world(on)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await pictured(ui, /Frozen/)).toBe(true)

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await ui.find({ type: 'Button', text: /Attack/ })).toBeDefined()
    await clock.advance(FARM_AFTER_MS)
    expect(loot(state)).toHaveLength(1)

    await $.turn.complete(end('t1', 'hello'))
    expect(loot(state)).toEqual([])
    expect(await ui.find({ type: 'Button', text: /Attack|Grab/ })).toBeUndefined()
    expect(await pictured(ui, /Frozen/)).toBe(true)
    const frozen = String((await sceneOf(ui)).props.source)
    expect(frozen).toMatch(/filter="url\(#frozen\)"/)
    expect(frozen).toContain(`<animate attributeName="width" from="112" to="0" dur="${TORCH_MS / 1000}s"`)
    await ui.unmount()
  })

  test('the torch counts down on the status line, then the monster ambushes once', async ($, on) => {
    const { clock, state, status } = world(on)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete(end('t1', 'hello'))
    expect(status.at(-1)).toMatch(/torch 5m/)

    await clock.advance(60_000)
    expect(status.at(-1)).toMatch(/torch 4m/)

    await clock.advance(TORCH_MS - 60_000)
    const r = state.run as Run
    expect(r.hp).toBe(newRun().hp - STATS.slime.atk)
    expect(r.last).toEqual({ dealt: 0, took: STATS.slime.atk, isAmbush: true })
    expect(status.at(-1)).toMatch(/torch out/)

    // Once only: more drift costs nothing more.
    await clock.advance(TORCH_MS)
    expect((state.run as Run).hp).toBe(r.hp)
  })

  test('momentum only for a prompt after the read time and before the torch burns out', async ($, on) => {
    const { clock, state, toasts } = world(on)
    const energy = () => (state.purse as { energy: number } | undefined)?.energy ?? 0

    // 1000 words: two minutes to read. Back after 10 s: skimmed, no bonus.
    await $.turn.start({ text: 'a', turnId: 't1' })
    await $.turn.complete(end('t1', reply(1000)))
    await clock.advance(10_000)
    await $.turn.start({ text: 'b', turnId: 't2' })
    expect(energy()).toBe(0)

    // Back after 2.5 minutes: read, torch still lit.
    await $.turn.complete(end('t2', reply(1000)))
    await clock.advance(150_000)
    await $.turn.start({ text: 'c', turnId: 't3' })
    expect(energy()).toBe(MOMENTUM_ENERGY)
    expect(toasts.at(-1)).toMatch(/Momentum/)

    // Back after the torch burnt out: no bonus.
    await $.turn.complete(end('t3', reply(10)))
    await clock.advance(TORCH_MS + 1)
    await $.turn.start({ text: 'd', turnId: 't4' })
    expect(energy()).toBe(MOMENTUM_ENERGY)
  })
})

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const UNLOCKED: Meta = { ...NO_META, caverns: 1, deep: 1 }

describe('meta shop rules', () => {
  test('caverns, mimic and golem stay locked until bought', () => {
    expect([1, 6, 11].map(f => biomeFor(f))).toEqual(['crypt', 'crypt', 'crypt'])
    expect(spawn(8, dice(0.99)).kind).toBe('wraith')
    expect(spawn(8, dice(0.99), UNLOCKED).kind).toBe('golem')
  })

  test('upgrades raise max HP, crits and dodge', () => {
    const tough: Meta = { ...NO_META, vitality: 2, whetstone: 1, shield: 3 }
    expect(newRun(tough).maxHp).toBe(14)
    // 0.25 misses a base crit (0.2) but lands with a whetstone (0.3).
    expect(attack(newRun(), dice(0.25)).last?.dealt).toBe(1)
    expect(attack(newRun(), dice(0.25), tough).last?.dealt).toBe(2)
    // 0.25 is under the base counter (0.5) but over three shields' (0.2).
    expect(attack(newRun(tough), dice(0.25), tough).last?.took).toBe(0)
  })

  test("Haiku's pick is held to the wares for sale; junk falls to dice and the table", () => {
    const sold: Meta = { ...NO_META, caverns: 1 }
    const shop = readPick('Sure! {"stock": ["caverns", "shield", "shield", "dragon"], "pitch": "Mind the stairs."}', sold, dice(0))
    expect(shop.stock[0]).toBe('shield')
    expect(shop.stock).toHaveLength(STOCK_SIZE)
    expect(new Set(shop.stock).size).toBe(STOCK_SIZE)
    expect(shop.stock).not.toContain('caverns')
    expect(shop.pitch).toBe('Mind the stairs.')
    expect(PITCHES).toContain(readPick('no json here', NO_META, dice(0)).pitch)
  })
})

describe('/delve shop', () => {
  test('an upgrade bought with XP survives death', async ($, on) => {
    const fallen: Run = { ...newRun(), floor: 5, hp: 0, isDead: true }
    const { state } = world(on, { run: fallen, purse: { energy: 0, xp: 25, gained: 0 } })
    const asked: string[] = []
    on('model.complete', (_$, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true as const, text: '{"stock": ["vitality", "shield", "deep"], "pitch": "Bones are cheap today."}', usage: USAGE } }
    })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

    const shop = await $.command.run({ ...RUN, command: 'delve', args: 'shop' })
    expect(asked[0]).toMatch(/floor 5/)
    expect(shop.text).toMatch(/Bones are cheap today/)
    expect(shop.text).toMatch(/vitality: Vitality .*10 XP/)

    expect((await $.command.run({ ...RUN, command: 'delve', args: 'buy deep' })).text).toMatch(/costs 50 XP; you hold 25/)
    expect((await $.command.run({ ...RUN, command: 'delve', args: 'buy caverns' })).text).toMatch(/No "caverns"/)
    expect((await $.command.run({ ...RUN, command: 'delve', args: 'buy vitality' })).text).toMatch(/Vitality 1\/5.*15 XP left/)
    expect(state.meta).toEqual({ ...NO_META, vitality: 1 })
    expect((await $.command.run({ ...RUN, command: 'delve', args: 'shop' })).text).not.toMatch(/- vitality/)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'new-run' })
    expect(state.run).toEqual(newRun({ ...NO_META, vitality: 1 }))
    expect((state.run as Run).maxHp).toBe(12)
    await ui.unmount()
  })

  test('/delve shop turns the pane to the shop', async ($, on) => {
    const { state } = world(on, { flavor: SEEN, shop: { stock: ['shield'], pitch: 'Hi.' } })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.command.run({ ...RUN, command: 'delve', args: 'shop' })
    expect(state.view).toBe('shop')
  })

  test('Haiku failing stocks the shop by dice', async ($, on) => {
    world(on, { purse: { energy: 0, xp: 0, gained: 0 } })
    on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }))
    const text = (await $.command.run({ ...RUN, command: 'delve', args: 'shop' })).text ?? ''
    expect(PITCHES.some(p => text.includes(p))).toBe(true)
    expect(text.match(/^- /gm)).toHaveLength(STOCK_SIZE)
  })
})

// Floor 1 already has its line, so session start asks Haiku nothing in the background.
const SEEN = { room: '1:slime', text: 'A slime.' }

describe('shop view', () => {
  test('every ware has a sprite icon', () => {
    for (const id of Object.keys(ICON) as (keyof typeof ICON)[]) {
      expect(SPRITES[ICON[id]]).toBeDefined()
      expect(iconSvg(ICON[id])).toMatch(/<path /)
    }
  })

  test('Shop opens the wares with icons; Buy buys, Back returns', async ($, on) => {
    const { state, toasts } = world(on, { flavor: SEEN, purse: { energy: 0, xp: 30, gained: 0 }, shop: { stock: ['vitality', 'deep'], pitch: 'Step right up.' } })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    await ui.press({ key: 'shop' })
    expect(await pictured(ui, /^Shop · 30 XP/)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Step right up/ })).toBeDefined()
    expect(await pictured(ui, /Vitality 1\/5: \+2 max HP, 10 XP/)).toBe(true)
    expect(await ui.find({ type: 'Button', text: /Buy Vitality · 10 XP/ })).toBeDefined()

    await ui.press({ key: 'buy-deep' })
    expect(toasts.at(-1)).toMatch(/costs 50 XP; you hold 30/)
    await ui.press({ key: 'buy-vitality' })
    expect(toasts.at(-1)).toMatch(/Bought Vitality 1\/5.*20 XP left/)
    expect(state.meta).toEqual({ ...NO_META, vitality: 1 })
    expect(await pictured(ui, /^Shop · 20 XP/)).toBe(true)
    expect(await ui.find({ type: 'Button', text: /Buy Vitality · 10 XP/ })).toBeUndefined()

    await ui.press({ key: 'back' })
    expect(await pictured(ui, /Floor 1\./)).toBe(true)
    await ui.unmount()
  })
})

describe('flavor lines', () => {
  test("Haiku's reply is read as one short line", () => {
    expect(readLine('\n  "A bat hangs from the call stack."\nMore text')).toBe('A bat hangs from the call stack.')
    expect(readLine('x'.repeat(200))).toBeUndefined()
    expect(TABLE.slime).toContain(tableLine(newRun()))
  })

  // A hero one hit from clearing floor 1, with energy for the swing.
  const nearKill = { run: { ...newRun(), monster: { kind: 'slime', hp: 1, maxHp: 4 } }, purse: { energy: 5, xp: 0, gained: 0 } }
  const kill = async ($: Engine) => {
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'attack' })
    return ui
  }
  const flavorOf = (state: Record<string, unknown>) => state.flavor as { room: string; text: string } | undefined

  test('a kill opens a room with a Haiku line', async ($, on) => {
    const { state } = world(on, nearKill)
    on('model.complete', () => ({ value: { isAnswered: true as const, text: '"Bats nest in the call stack."', usage: USAGE } }))
    const ui = await kill($)

    const r = state.run as Run
    expect(r.floor).toBe(2)
    expect(flavorOf(state)).toEqual({ room: `2:${r.monster.kind}`, text: 'Bats nest in the call stack.' })
    expect(await ui.find({ type: 'Text', text: /Bats nest/ })).toBeDefined()
    await ui.unmount()
  })

  test('a timed-out Haiku call shows a table line', async ($, on) => {
    const { state } = world(on, nearKill)
    on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }))
    const ui = await kill($)

    const r = state.run as Run
    expect(TABLE[r.monster.kind]).toContain(flavorOf(state)?.text)
    expect(await ui.find({ type: 'Text', text: flavorOf(state)!.text })).toBeDefined()
    await ui.unmount()
  })

  test('past the daily cap Haiku is not asked', async ($, on) => {
    // The test clock starts at 0.
    const day = dayOf(0)
    const { state } = world(on, { ...nearKill, haiku: { day, count: HAIKU_DAILY_CAP } })
    let asked = 0
    on('model.complete', () => {
      asked++
      return { value: { isAnswered: true as const, text: 'never shown', usage: USAGE } }
    })
    const ui = await kill($)

    expect(asked).toBe(0)
    expect(TABLE[(state.run as Run).monster.kind]).toContain(flavorOf(state)?.text)
    await ui.unmount()
  })

  test('/delve haiku flips the switch and stores it; on and off set it', async ($, on) => {
    const stored: Record<string, unknown> = {}
    const writes: unknown[] = []
    on('store.get', (_$, e) => ({ value: stored[e.key] }))
    on('store.set', (_$, e) => {
      stored[e.key] = e.value
      writes.push(e.value)
      return { value: undefined }
    })
    const haiku = async (args: string) => (await $.command.run({ ...RUN, command: 'delve', args })).text
    expect(await haiku('haiku')).toMatch(/Haiku lines off/)
    expect(await haiku('haiku')).toMatch(/Haiku lines on/)
    expect(await haiku('haiku off')).toMatch(/off/)
    expect(await haiku('haiku off')).toMatch(/off/)
    expect(await haiku('haiku sideways')).toMatch(/Usage/)
    expect(writes).toEqual([false, true, false, false])
  })

  test('with Haiku off, a kill and a shop restock ask no model', async ($, on) => {
    const { state } = world(on, { ...nearKill, haikuOn: false })
    let asked = 0
    on('model.complete', () => {
      asked++
      return { value: { isAnswered: true as const, text: 'never shown', usage: USAGE } }
    })
    const ui = await kill($)
    const shop = (await $.command.run({ ...RUN, command: 'delve', args: 'shop' })).text ?? ''

    expect(asked).toBe(0)
    expect(TABLE[(state.run as Run).monster.kind]).toContain(flavorOf(state)?.text)
    expect(PITCHES.some(p => shop.includes(p))).toBe(true)
    await ui.unmount()
  })
})

test('meta, shop and flavor come back at session start without asking Haiku', async ($, on) => {
  const bought: Meta = { ...NO_META, vitality: 2, caverns: 1 }
  const line = { room: '1:slime', text: 'A slime remembers you.' }
  const { state } = world(on, { meta: bought, shop: { stock: ['shield'], pitch: 'Back again?' }, flavor: line })
  let asked = 0
  on('model.complete', () => {
    asked++
    return { value: { isAnswered: true as const, text: 'never shown', usage: USAGE } }
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  expect(state.meta).toEqual(bought)
  expect(state.flavor).toEqual(line)
  expect((await $.command.run({ ...RUN, command: 'delve', args: 'shop' })).text).toMatch(/Back again\?[\s\S]*- shield/)
  expect(asked).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /remembers you/ })).toBeDefined()
  await ui.unmount()
})

// Any tool call by input, typed loosely like runTool.
const callTool = ($: unknown, input: Record<string, unknown>) => ($ as Tools).tool.call(input as unknown as ToolCallInput)
// Tools that answer: a Bash `false` fails, the rest succeed with an empty result.
const tools = (e: Record<string, unknown>) =>
  e.tool === 'Bash' && e.command === 'false' ? { result: {}, text: 'exit 1', isError: true } : { result: {}, text: 'ok' }
const sceneOf = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Svg' })).find(svg => /^The warrior/.test(String(svg.props.alt)))!
const ended = (turnId: string, rest: object = {}) => ({ answer: 'done', durationMs: 1, reason: 'answer', isAborted: false, turnId, ...rest }) as const
const spawnArgs = (subagentType: string, fork: boolean) => ({
  tool_use_id: 'agent-call',
  prompt: 'Look around.',
  description: 'look around',
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork,
})

// What a compaction leaves: one summary message.
const SUMMARY = [{ role: 'user' as const, text: 'Summary so far.', toolUses: [] }]

describe("Claude's own work", () => {
  test('tools forge weapons, and each weapon changes the swing', () => {
    expect(['Edit', 'Bash', 'Grep', 'WebSearch', 'TodoWrite'].map(t => weaponFor(t, true))).toEqual(['sword', 'hammer', 'bow', 'portal', undefined])
    expect(weaponFor('Bash', false)).toBe('fists')
    const r = newRun()
    expect(attack(r, dice(0.99), NO_META, WEAPONS.sword.edge).last).toEqual({ dealt: 2, took: 0 })
    expect(attack(r, dice(0.99), NO_META, WEAPONS.hammer.edge).last).toEqual({ dealt: 2, took: 0 })
    // dice(0) crits and is hit back, unless the bow keeps the monster at range.
    expect(attack(r, dice(0), NO_META).last).toEqual({ dealt: 2, took: 1 })
    expect(attack(r, dice(0), NO_META, WEAPONS.bow.edge).last).toEqual({ dealt: 2, took: 0 })
  })

  test("Claude's tool picks the weapon; a failed command drops it; MCP calls a familiar", async ($, on) => {
    // An 8-HP slime survives a sword crit, so the familiar's hit never slays it.
    const { state } = world(on, { flavor: SEEN, run: { ...newRun(), monster: { kind: 'slime', hp: 8, maxHp: 8 } } }, tools)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await callTool($, { tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' })
    expect(state.weapon).toBe('sword')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await pictured(ui, /Sword: \+1 damage/)).toBe(true)
    await ui.press({ key: 'attack' })
    expect((state.run as Run).last?.dealt).toBeGreaterThanOrEqual(2)

    await callTool($, { tool: 'Bash', command: 'true', tool_use_id: 'u2' })
    expect(state.weapon).toBe('hammer')
    await callTool($, { tool: 'Bash', command: 'false', tool_use_id: 'u3' })
    expect(state.weapon).toBe('fists')
    await callTool($, { tool: 'TodoWrite', todos: [], tool_use_id: 'u4' })
    expect(state.weapon).toBe('fists')

    const hp = (state.run as Run).monster.hp
    await callTool($, { tool: 'mcp__notes__ping', tool_use_id: 'u5' })
    expect((state.run as Run).monster.hp).toBe(hp - 1)
    expect(await ui.find({ type: 'Text', text: /Your familiar hit the slime for 1/ })).toBeDefined()
    await ui.unmount()
  })

  test("an ally subagent's calls are its own, and it strikes when its run ends", async ($, on) => {
    const { state } = world(on, { flavor: SEEN }, tools)
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
    await $.turn.start({ text: 'explore', turnId: 't1' })
    await $.agent.spawn(spawnArgs('Explore', false))
    expect(state.fighters).toEqual([{ agentId: 'a1', side: 'ally', kind: 'bat', label: 'Explore: look around', hp: 0, maxHp: 0 }])
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(String((await sceneOf(ui)).props.alt)).toMatch(/a bat ally at its side/)

    for (let i = 0; i < 6; i++) await callTool($, { tool: 'Read', file_path: 'x', tool_use_id: `s${i}`, agentId: 'a1' })
    expect(state.purse).toEqual({ energy: 0, xp: 0, gained: 0 })
    expect(state.weapon).toBeUndefined()

    await $.turn.complete(ended('sub', { agentId: 'a1' }))
    expect((state.run as Run).monster.hp).toBe(4 - allyDamage(6))
    expect(state.fighters).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Your bat ally hit the slime for 3/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fork is a doppelganger: it strikes as it works, takes the swings, pays when beaten', async ($, on) => {
    const { state } = world(on, { flavor: SEEN, purse: { energy: 20, xp: 0, gained: 0 } }, tools)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `f${++n}` }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'fork it', turnId: 't1' })
    await $.agent.spawn(spawnArgs('fork', true))
    expect(state.fighters).toEqual([{ agentId: 'f1', side: 'rival', kind: 'warrior', label: 'fork: look around', hp: 7, maxHp: 7 }])

    for (let i = 0; i < 4; i++) await callTool($, { tool: 'Grep', pattern: 'x', tool_use_id: `s${i}`, agentId: 'f1' })
    expect((state.run as Run).hp).toBe(9)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Button', text: /Attack doppelganger/ })).toBeDefined()

    for (let i = 0; i < 7 && (state.fighters as unknown[]).length; i++) await ui.press({ key: 'attack' })
    expect(state.fighters).toEqual([])
    expect((state.run as Run).monster.hp).toBe(4)
    expect((state.run as Run).gold).toBe(7)
    expect((state.purse as { xp: number }).xp).toBe(7)
    expect(await ui.find({ type: 'Text', text: /You beat your doppelganger/ })).toBeDefined()

    // One left standing when its run ends just walks off.
    await $.agent.spawn(spawnArgs('fork', true))
    await $.turn.complete(ended('sub', { agentId: 'f2' }))
    expect(state.fighters).toEqual([])
    expect(await ui.find({ type: 'Text', text: /walked off/ })).toBeDefined()
    await ui.unmount()
  })

  test('compaction quakes the hero down a floor and shakes the room', async ($, on) => {
    const { state } = world(on, { flavor: SEEN })
    on('session.compact', (_$, e) => ({ messages: e.messages }))
    on('model.complete', () => ({ value: { isAnswered: true as const, text: 'Rubble.', usage: USAGE } }))
    await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
    expect(state.run).toBeUndefined()

    await $.session.compact({ trigger: 'auto', messages: SUMMARY })
    expect((state.run as Run).floor).toBe(2)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /memory compacted/ })).toBeDefined()
    expect(String((await sceneOf(ui)).props.source)).toMatch(/animateTransform/)
    await ui.unmount()
  })

  test('how a turn ends: Esc flees, an error springs a trap, a refusal raises the guard', async ($, on) => {
    const { state } = world(on, { flavor: SEEN, run: { ...newRun(), gold: 8, monster: { kind: 'slime', hp: 2, maxHp: 4 } } })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.turn.complete(ended('t1', { reason: 'aborted', isAborted: true }))
    expect((state.run as Run).gold).toBe(6)
    await $.turn.complete(ended('t2', { reason: 'error' }))
    expect((state.run as Run).hp).toBe(9)
    await $.turn.complete({ ...ended('t3'), reason: 'refusal', refusal: { category: null, explanation: null } })
    expect((state.run as Run).monster.hp).toBe(4)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Claude refused. The slime raised its guard/ })).toBeDefined()
    await ui.unmount()
  })

  test('the torch dims as the context fills', async ($, on) => {
    const { state } = world(on)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 90 }, rateLimits: [] } }))
    expect([0, 40, 50, 100].map(darkness)).toEqual([0, 0, 0, 0.8])
    await $.turn.complete(ended('t1'))
    expect(state.context).toBe(90)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await pictured(ui, /context 90% full/)).toBe(true)
    expect(String((await sceneOf(ui)).props.source)).toMatch(/radialGradient/)
    await ui.unmount()
  })

  test('a skill is a spell: three free swings', async ($, on) => {
    const { state, toasts } = world(on)
    on('skill.prompt', (_$, e) => ({ text: e.text }))
    await $.skill.prompt({ skill: 'commit', text: 'Commit the work.' })
    await $.turn.start({ text: 'commit', turnId: 't1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Button', text: /Attack \(free\)/ })).toBeDefined()
    expect(await pictured(ui, /Spell \/commit: 3 free swings/)).toBe(true)

    await ui.press({ key: 'attack' })
    expect(toasts).toEqual([])
    expect((state.run as Run).monster.hp).toBeLessThan(4)
    expect(state.spell).toEqual({ skill: 'commit', swings: 2 })
    await ui.unmount()
  })

  test("Claude's todo list is a quest board; a finished quest pays", async ($, on) => {
    let list: unknown[] = []
    const { state, toasts } = world(on, { flavor: SEEN }, e => {
      if (e.tool === 'TodoWrite') {
        const result = { oldTodos: list, newTodos: e.todos }
        list = e.todos as unknown[]
        return { result, text: 'ok' }
      }
      if (e.tool === 'TaskCreate') return { result: { task: { id: '7', subject: e.subject } }, text: 'ok' }
      if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'], statusChange: { from: 'pending', to: e.status } }, text: 'ok' }
      return { result: {}, text: 'ok' }
    })
    const todo = (content: string, status: string) => ({ content, status, activeForm: content })
    await $.turn.start({ text: 'plan it', turnId: 't1' })
    await callTool($, { tool: 'TodoWrite', todos: [todo('Write tests', 'in_progress'), todo('Ship', 'pending')], tool_use_id: 'u1' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await pictured(ui, /^Quests: \[ \] Write tests/)).toBe(true)

    await callTool($, { tool: 'TodoWrite', todos: [todo('Write tests', 'completed'), todo('Ship', 'in_progress')], tool_use_id: 'u2' })
    expect(toasts.at(-1)).toBe(`Quest done: Write tests. +${QUEST_GOLD} gold, +${QUEST_XP} XP.`)
    expect((state.run as Run).gold).toBe(QUEST_GOLD)
    expect(await pictured(ui, /^Quests: \[x\] Write tests/)).toBe(true)

    await callTool($, { tool: 'TaskCreate', subject: 'Deploy', description: 'Deploy it', tool_use_id: 'u3' })
    await callTool($, { tool: 'TaskUpdate', taskId: '7', status: 'completed', tool_use_id: 'u4' })
    expect(toasts.at(-1)).toMatch(/^Quest done: Deploy\./)
    expect((state.purse as { xp: number }).xp).toBe(2 * QUEST_XP)
    await ui.unmount()
  })

  test('the fullest scene still fits the Svg limit', () => {
    const r: Run = { ...newRun(), biome: 'caverns', monster: { kind: 'golem', hp: 9, maxHp: 12 }, last: { dealt: 2, took: 1, atRival: true } }
    const drops = (['coin', 'loot_bag', 'potion_blue'] as const).map((kind, i) => ({ id: `${i}`, kind }))
    const src = sceneSvg({ ...r, last: { dealt: 0, took: 0, isEvent: true, isQuake: true } }, true, drops, { ally: 'golem', hasRival: true, dark: 0.8 })
    expect(src.length).toBeLessThan(SVG_LIMIT)
    expect(sceneSvg(r, false, drops, { ally: 'mimic', hasRival: true }).length).toBeLessThan(SVG_LIMIT)
    const hud = { allyLabel: 'Explore: look around', rival: { hp: 3, maxHp: 10, label: 'fork: x' }, dark: 0.8, weapon: 'portal', spell: { skill: 'commit', swings: 3 }, context: 99 } as const
    const kill: Run = { ...r, maxHp: 20, hp: 7, gold: 999, floor: 99, last: { dealt: 3, took: 0, slain: 'golem' } }
    expect(sceneSvg(kill, true, drops, { ...hud, ally: 'golem' }).length).toBeLessThan(SVG_LIMIT)
    expect(sceneSvg(kill, false, drops, { ...hud, ally: 'golem', frozen: { leftMs: 60_000, isOut: false } }).length).toBeLessThan(SVG_LIMIT)
    const board = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, text: 'A long quest line that runs past the edge of the parchment', isDone: i % 2 === 0 }))
    expect(questsSvg(board).length).toBeLessThan(SVG_LIMIT)
    expect(shopSvg(['vitality', 'deep', 'caverns'], { ...NO_META, vitality: 4, whetstone: 3, shield: 3, potion_blue: 1, loot_bag: 1 }, 5).length).toBeLessThan(SVG_LIMIT)
  })
})
