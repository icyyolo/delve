import type { On, ToolCallInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Biome, Meta, MonsterKind, Recap, Run } from '../types'
import { NO_META, STATS, attack, biomeFor, counter, newRun, spawn } from '../hooks/combat'
import { DROP_EVERY_MS, ENERGY_CAP, FARM_AFTER_MS, HAIKU_DAILY_CAP, LOOT_MS, MOMENTUM_ENERGY, DOTS_SHOWN, RECAP_DONE_XP, RECAP_ENERGY, RECAP_ENERGY_MORE, RECAP_XP, REGEN_CAP, REGEN_MS, TORCH_MS } from '../hooks/register'
import { TLDR_ASK, fallbackKeys, fallbackLine, fileList, finishedWords, hasRound, liveScore, marks, readRecap, restLines, score, tldrOf, topLines } from '../hooks/recap'
import { TABLE, dayOf, readLine, tableLine } from '../hooks/flavor'
import { QUEST_GOLD, QUEST_XP, WEAPONS, allyDamage, darkness, weaponFor } from '../hooks/claude'
import { iconSvg, questsSvg, sceneSvg, shopSvg } from '../hooks/scene'
import { ICON, PITCHES, STOCK_SIZE, readPick } from '../hooks/shop'
import { SPRITES } from '../hooks/sprites.gen'

// The test runner's own timer, for waiting on work the mod does in the background.
declare const setTimeout: (fn: () => void, ms: number) => unknown

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
// Types into the recap typer key by key, as a person does once it is clicked: '\n' is Enter, '\b' Backspace.
type Keyed = { key: (k: { key: string; in?: string }) => Promise<void> }
const keys = async (ui: Keyed, text: string) => {
  for (const ch of text) await ui.key({ key: ch === '\n' ? 'return' : ch === '\b' ? 'backspace' : ch, in: 'typer' })
}

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

  test('mid-turn, regen adds one energy per tick up to its cap; idle adds none', async ($, on) => {
    const { clock, state } = world(on)
    const energy = () => (state.purse as { energy: number } | undefined)?.energy ?? 0
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await clock.advance(REGEN_MS)
    expect(energy()).toBe(0)

    await $.turn.start({ text: 'think hard', turnId: 't1' })
    await clock.advance(REGEN_MS)
    expect(state.purse).toEqual({ energy: 1, xp: 0, gained: 0 })
    await clock.advance(REGEN_MS * (REGEN_CAP + 2))
    expect(state.purse).toEqual({ energy: REGEN_CAP, xp: 0, gained: 0 })
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
    const missed = loot(state)[0]!.id
    await clock.advance(LOOT_MS)
    expect(loot(state).some(l => l.id === missed)).toBe(false)
    await ui.unmount()
  })

  test('each tool call restarts the farm delay; a quiet gap after one farms', async ($, on) => {
    const { clock, state } = world(on)

    await $.turn.start({ text: 'run the tests', turnId: 't1' })
    await clock.advance(FARM_AFTER_MS - 1)
    await runTool($, 'u1')
    await clock.advance(FARM_AFTER_MS - 1)
    expect(state.mode).toBe('combat')
    expect(loot(state)).toEqual([])

    await clock.advance(1)
    expect(state.mode).toBe('farm')
    expect(loot(state)).toHaveLength(1)
    await runTool($, 'u2')
    expect(state.mode).toBe('combat')

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

  test('a typo lets the monster hit back at its counter chance; the shield lowers it', () => {
    const hit = counter(newRun(), dice(0.4))
    expect(hit).toMatchObject({ hp: 9, last: { dealt: 0, took: 1, isEvent: true, note: 'Typo! The slime hit you for 1.' } })
    expect(counter(newRun(), dice(0.5))).toEqual(newRun())
    expect(counter(newRun(), dice(0.4), { ...NO_META, shield: 1 })).toEqual(newRun())
    expect(counter({ ...newRun(), hp: 1 }, dice(0)).isDead).toBe(true)
  })

  test('with the caverns bought, biomes alternate every five floors', () => {
    expect([1, 5, 6, 10, 11].map(f => biomeFor(f, { ...NO_META, caverns: 1 }))).toEqual(['crypt', 'crypt', 'caverns', 'caverns', 'crypt'])
  })
})

describe('Attack button', () => {
  test('with no energy it swings weak for 1; with energy it spends one and swings full', async ($, on) => {
    const { state, toasts } = world(on)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await ui.press({ key: 'attack' })
    expect(toasts).toEqual([])
    expect((state.run as Run).monster.hp).toBe(3)
    expect(state.purse).toEqual({ energy: 0, xp: 0, gained: 0 })
    expect(await ui.find({ type: 'Text', text: /Weak swing, no energy: Hit the slime for 1/ })).toBeDefined()

    await runTool($, 'u1')
    await ui.press({ key: 'attack' })
    expect((state.purse as { energy: number }).energy).toBe(0)
    expect((state.run as Run).monster.hp).toBeLessThan(3)
    expect(await pictured(ui, /Hit the slime/)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Hit the slime/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', text: /Attack/ }))?.props.hotkey).toBe('a')
    await ui.unmount()
  })

  test('Attack and Shop share the first row, loot grabs the next; a hint says how to get the keys', async ($, on) => {
    const { clock } = world(on)
    await $.turn.start({ text: 'what is this?', turnId: 't1' })
    await clock.advance(FARM_AFTER_MS)
    const keysOf = (box: { children: unknown[] } | undefined) => (box?.children ?? []).map(c => (c as { props: { key?: string } }).props.key)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(keysOf(await ui.find({ type: 'Box', key: 'actions' }))).toEqual(['attack', 'shop'])
    const grabs = keysOf(await ui.find({ type: 'Box', key: 'loot' }))
    expect(grabs).toHaveLength(1)
    expect(grabs[0]).not.toBe('attack')
    expect(await ui.find({ type: 'Text', text: /click the pane or press ctrl\+x tab/ })).toBeDefined()
    await ui.unmount()

    const focused = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, isFocused: true } })
    expect(await focused.find({ type: 'Text', text: /Keys on: A attack/ })).toBeDefined()
    await focused.unmount()
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

  test('a kill drops one piece of loot at once', async ($, on) => {
    const { state } = world(on, { ...nearKill, haikuOn: false })
    const ui = await kill($)

    expect((state.run as Run).floor).toBe(2)
    expect(loot(state)).toHaveLength(1)
    expect(await ui.find({ type: 'Button', text: /Grab/ })).toBeDefined()
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
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
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

  test('a weak swing gets no weapon: the portal pulls loot only on a power swing', async ($, on) => {
    const { state } = world(on, { flavor: SEEN, run: { ...newRun(), monster: { kind: 'slime', hp: 8, maxHp: 8 } } }, tools)
    await $.turn.start({ text: 'look it up', turnId: 't1' })
    await callTool($, { tool: 'WebSearch', query: 'x', tool_use_id: 'u1' })
    expect(state.weapon).toBe('portal')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    await ui.press({ key: 'attack' })
    expect(loot(state)).toHaveLength(1)
    await ui.press({ key: 'attack' })
    expect(loot(state)).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /Weak swing, no energy/ })).toBeDefined()
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

// A reply with a lead-in, code, a warning and a question.
const LONG = [
  'Here is what I changed:',
  '',
  'I fixed the login bug so that expired tokens are now refused by the server. I also added a regression test for it.',
  '',
  '```ts',
  'expect(refused).toBe(true)',
  '```',
  '',
  'Warning: two tests are still skipped.',
  'Should I push now?',
].join('\n')
const FALLBACK = 'I fixed the login bug so that expired tokens are now refused by the server.'
const LINE = 'Fixed the login bug and added a test for expired tokens.'
// The recap is written in the background after the turn ends; wait for it to land.
async function landed(state: Record<string, unknown>, after?: Recap): Promise<Recap> {
  for (let i = 0; i < 200; i++) {
    const r = state.recap as Recap | null | undefined
    if (r && !r.isPending && r.id !== after?.id) return r
    await new Promise<void>(done => setTimeout(done, 5))
  }
  throw new Error('the recap never landed')
}

describe('reply recap', () => {
  test('without Haiku the line skips lead-ins and code; key points are questions and warnings', () => {
    expect(fallbackLine(LONG)).toBe(FALLBACK)
    expect(fallbackLine('Done.\n\nI updated `auth.ts` and src/a.ts today.\nThe build now passes on every platform.')).toBe('The build now passes on every platform.')
    expect(fallbackKeys(LONG)).toEqual(['Warning: two tests are still skipped.', 'Should I push now?'])
    expect(hasRound('Done.')).toBe(false)
    expect(hasRound(LONG)).toBe(true)
  })

  test('without Haiku the line is the sentence that best stands for the reply', () => {
    // A summary label at the end beats the opening detail.
    const labelled = [
      'I looked through the auth module and the session store.',
      '',
      'The token check compared timestamps in seconds against milliseconds.',
      'I changed the comparison and added a regression test.',
      '',
      'In short: expired tokens are now rejected and the new test passes.',
    ].join('\n')
    expect(fallbackLine(labelled)).toBe('Expired tokens are now rejected and the new test passes.')

    // A Summary heading marks the sentence under it; code-laden bullets lose.
    const headed = ['## Changes', '- Renamed the helper in `utils.ts`.', '- Moved the config loader.', '', '## Summary', 'The build is green again after the config loader moved out of the hot path.'].join('\n')
    expect(fallbackLine(headed)).toBe('The build is green again after the config loader moved out of the hot path.')

    // A status reply: the opening result line, not the bullets or the test count.
    const status = [
      'Recap built and tested, but not seen in the live pane yet.',
      '',
      '**What it does:**',
      '- When a turn ends, the freeze shows a line to type.',
      '- Enter scores the round once per turn.',
      '',
      'All tests pass and validate passes.',
    ].join('\n')
    expect(fallbackLine(status)).toBe('Recap built and tested, but not seen in the live pane yet.')

    // In a long reply, the sentence the rest keeps coming back to.
    const long = [
      'The cache layer was serving stale prices to the checkout page.',
      'Prices are cached for ten minutes per product.',
      'The checkout page read prices from the cache without checking the product version.',
      'When a price changed, the old cached price stayed until it expired.',
      'Weather data uses the same cache but never had this problem.',
      'The fix keys each cached price by product version, so a price change misses the cache at once.',
      'Logs from staging look clean.',
      'Deploy whenever you like.',
    ].join(' ')
    expect(fallbackLine(long)).toBe('The fix keys each cached price by product version, so a price change misses the cache at once.')

    // A terse fragment rides with the sentence after it instead of dropping out.
    expect(fallbackLine('Recap built. Hot-reloads when this turn ends.\n\nNot committed, not pushed yet.')).toBe('Recap built. Hot-reloads when this turn ends.')

    // Too long: cut at a clause break, not mid-thought.
    const rambling = 'I went through every handler in the request pipeline, checked each one for the missing await on the session lookup, and found two more places where it was skipped.'
    expect(fallbackLine(rambling)).toBe('I went through every handler in the request pipeline, checked each one for the missing await on the session lookup.')
  })

  test("Claude's TL;DR line wins as written, and stays out of the key points", () => {
    const reply = ['I changed three files.', '', 'Warning: the old cache is still on disk.', '', '**TL;DR:** Fixed the `auth` token bug; tests pass now.'].join('\n')
    expect(tldrOf(reply)).toBe('Fixed the token bug; tests pass now.')
    expect(tldrOf('TL;DR - Moved the loader out of the hot path.')).toBe('Moved the loader out of the hot path.')
    expect(tldrOf(LONG)).toBeNull()
    expect(fallbackKeys(`${reply}\nTL;DR: did it fail? no`)).toEqual(['Warning: the old cache is still on disk.'])
    expect(TLDR_ASK).toMatch(/TL;DR: <one plain sentence of at most 20 words/)
  })

  test('three summary lines, then the whole reply in order, nothing typed twice', () => {
    expect(topLines(LONG, [])).toEqual([FALLBACK, 'I also added a regression test for it.', 'Warning two tests are still skipped.'])
    expect(topLines(LONG, ['Custom first.', null])).toEqual(['Custom first.', FALLBACK, 'I also added a regression test for it.'])
    expect(restLines(LONG, topLines(LONG, []))).toEqual(['Here is what I changed', 'Should I push now?'])

    // A sentence code and paths gut is skipped; a link keeps its words; a long one splits at clause breaks.
    const reply = [
      'I edited `src/auth.ts` at line `42`.',
      'See [the docs](https://example.com/tokens) for the full token rules.',
      'I went through every handler in the request pipeline, checked each one for the missing await on the session lookup, and found two more places where it was skipped.',
    ].join('\n')
    expect(restLines(reply, [])).toEqual([
      'See the docs for the full token rules.',
      'I went through every handler in the request pipeline, checked each one for the missing await on the session lookup.',
      'And found two more places where it was skipped.',
    ])
    expect(restLines(reply, ['See the docs for the full token rules'])).toHaveLength(2)
  })

  test("Haiku's recap is held to plain words; files, score and marks", () => {
    expect(readRecap('TYPE: Fixed `auth.ts` login — now with tests!\nKEY: Run `npm test`\nKEY: none')).toEqual({ lines: ['Fixed login - now with tests!'], keys: ['Run npm test'] })
    expect(readRecap('TYPE: One.\nTYPE: Two.\nTYPE: One.\nTYPE: Three.\nTYPE: Four.')?.lines).toEqual(['One.', 'Two.', 'Three.'])
    expect(readRecap('Sure, here is a summary.')).toBeUndefined()
    expect(fileList(['/x/a.ts', 'C:\\y\\b.ts', '/x/a.ts', 'c.ts', 'd.ts', 'e.ts'])).toEqual(['a.ts', 'b.ts', 'c.ts', '+2 more'])
    expect(score('a b c d', 'a B x d', 60_000)).toEqual({ accuracy: 0.75, wpm: 1 })
    // Letter by letter: a done word typed wrong shows which letters; the caret sits on the next one.
    expect(marks('fix the bug', 'fix tha b')).toEqual([
      [{ text: 'fix', mark: 'right' }],
      [{ text: 'th', mark: 'right' }, { text: 'e', mark: 'wrong' }],
      [{ text: 'b', mark: 'right' }, { text: 'u', mark: 'caret' }, { text: 'g', mark: 'here' }],
    ])
    // One slip mid-word marks that letter alone, not the rest of the word.
    expect(marks('fix the bug', 'fix the bxg')[2]).toEqual([
      { text: 'b', mark: 'right' },
      { text: 'u', mark: 'wrong' },
      { text: 'g', mark: 'right' },
      { text: ' ', mark: 'caret' },
    ])
    // Letters typed past a word's end show as extra; missing ones in a done word as wrong.
    expect(marks('fix the bug', 'fixes th bugg')).toEqual([
      [{ text: 'fix', mark: 'right' }, { text: 'es', mark: 'extra' }],
      [{ text: 'th', mark: 'right' }, { text: 'e', mark: 'wrong' }],
      [{ text: 'bug', mark: 'right' }, { text: 'g', mark: 'extra' }, { text: ' ', mark: 'caret' }],
    ])
    expect(marks('fix the bug', '')[0]).toEqual([{ text: 'f', mark: 'caret' }, { text: 'ix', mark: 'here' }])
    expect(marks('fix the bug', 'fix ')[1]![0]).toEqual({ text: 't', mark: 'caret' })
  })

  test('live accuracy and WPM as it is typed', () => {
    expect(liveScore('fix the bug', 'fix', 500)).toEqual({ accuracy: null, wpm: null })
    expect(liveScore('fix the bug', 'fix tha b', 6000)).toEqual({ accuracy: 0.5, wpm: 18 })
  })

  test('each word finished is right or wrong once; words past the line count for nothing', () => {
    expect(finishedWords('fix the bug', '', 'fi')).toEqual([])
    expect(finishedWords('fix the bug', 'fi', 'Fix ')).toEqual([true])
    expect(finishedWords('fix the bug', 'fix ', 'fix tha ')).toEqual([false])
    // A paste finishes several at once; nothing finished twice.
    expect(finishedWords('fix the bug', '', 'fix the bug ')).toEqual([true, true, true])
    expect(finishedWords('fix the bug', 'fix the bug ', 'fix the bug more ')).toEqual([])
  })

  test("the freeze shows Haiku's line and the key points; typing it well pays energy and XP", async ($, on) => {
    const { clock, state, toasts } = world(on, { flavor: SEEN }, tools)
    const asked: string[] = []
    on('model.complete', (_$, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true as const, text: `TYPE: ${LINE}\nKEY: Asks you: push now?\nKEY: Run \`npm test\``, usage: USAGE } }
    })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await callTool($, { tool: 'Edit', file_path: 'src/auth.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' })
    await callTool($, { tool: 'Write', file_path: 'tests/auth.test.ts', content: 'x', tool_use_id: 'u2' })
    await $.turn.complete(end('t1', LONG))
    await landed(state)
    expect(asked.at(-1)).toMatch(/TYPE:[\s\S]*I fixed the login bug/)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /SUMMARY 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /90% pays \+2 energy, 60\+ WPM \+1 XP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Asks you: push now\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Run npm test/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Files changed: auth\.ts, auth\.test\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /click the words and type to attack/ })).toBeDefined()

    await keys(ui, 'F')
    await clock.advance(10_000)
    // The last word typed right ends the line, Monkeytype's way: no Enter.
    await keys(ui, LINE.slice(1))
    expect(toasts.at(-1)).toBe('Line 1 typed: 100% at 67 WPM. +2 energy, +1 XP.')
    // The words swung as they were typed: the 2 energy on hand went on the first two, the
    // rest swung weak; the line's +2 came as it ended, and its last word spent one.
    expect(state.purse).toEqual({ energy: 1, xp: RECAP_XP, gained: 2 })
    expect((state.run as Run).floor).toBeGreaterThan(1)
    // The game goes on: line 2, a summary line the reply's best sentences filled in.
    expect(await ui.find({ type: 'Text', text: /✓ Line 1: 100% · 67 WPM · \+2 energy, \+1 XP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /SUMMARY 2\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /90% pays \+1 energy$/ })).toBeDefined()
    expect((state.recap as Recap).lines.slice(0, 3)).toEqual([LINE, FALLBACK, 'I also added a regression test for it.'])
    expect(await ui.find({ type: 'Client', key: 'typer' })).toBeDefined()
    await ui.unmount()
  })

  test('the game runs through the whole reply: summary lines pay energy, the rest XP once, then unpaid speed', async ($, on) => {
    const { state, toasts } = world(on, { flavor: SEEN, haikuOn: false })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await $.turn.complete(end('t1', LONG))
    const r = await landed(state)
    expect(r.top).toBe(3)
    expect(r.lines.slice(3)).toEqual(['Here is what I changed', 'Should I push now?'])
    const purse = () => (state.purse as { energy: number; xp: number } | undefined) ?? { energy: 0, xp: 0 }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const type = (text: string) => keys(ui, text)
    await type(r.lines[0]!)
    await type(r.lines[1]!)
    expect(toasts.at(-1)).toBe('Line 2 typed: 100% at 0 WPM. +1 energy.')
    // Each word swings as it is typed, the last one after its line pays: the pay goes on the next swings.
    expect(purse().energy).toBe(0)
    const floor = (state.run as Run).floor
    expect(floor).toBeGreaterThan(1)
    // Skip pays nothing, swings nothing, and moves on.
    await ui.press({ key: 'skip' })
    expect((state.run as Run).floor).toBe(floor)
    expect(await ui.find({ type: 'Text', text: /✗ Line 3 skipped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /REPLY 1\/2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /90% on average to the end pays \+1 XP/ })).toBeDefined()
    await type(r.lines[3]!)
    expect(purse().xp).toBe(0)
    await type(r.lines[4]!)
    expect(toasts.at(-1)).toBe('Reply typed through: 100% on average. +1 XP.')
    expect(purse().xp).toBe(RECAP_DONE_XP)

    // Done: the lines come round again, unpaid, for speed.
    expect(await ui.find({ type: 'Text', text: /✓ Line 5: 100% · 0 WPM · reply 100% on average · \+1 XP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PRACTICE 1\/5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unpaid, for speed · reply 100% on average/ })).toBeDefined()
    // Practice never fights: a right word swings nothing, a wrong one draws no hit back.
    expect(await ui.find({ type: 'Text', text: /type to attack/ })).toBeUndefined()
    const before = state.run as Run
    await type(r.lines[0]!)
    expect(purse()).toMatchObject({ energy: 0, xp: RECAP_DONE_XP })
    expect((state.recap as Recap).at).toBe(6)
    await type('zz qq ww\n')
    expect((state.recap as Recap).at).toBe(7)
    expect(state.run).toEqual(before)
    // Mid-turn, with only practice to type, the Attack button is back.
    await $.turn.start({ text: 'next', turnId: 't2' })
    expect(await ui.find({ type: 'Button', text: /Attack/ })).toBeDefined()
    await ui.unmount()
  })

  test("with Haiku off the reply's own sentences make the line; a sloppy round pays nothing", async ($, on) => {
    const { state, toasts } = world(on, { flavor: SEEN, haikuOn: false })
    let asked = 0
    on('model.complete', () => {
      asked++
      return { value: { isAnswered: true as const, text: 'never shown', usage: USAGE } }
    })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await $.turn.complete(end('t1', LONG))
    expect((await landed(state)).lines[0]).toBe(FALLBACK)
    expect(asked).toBe(0)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Warning: two tests are still skipped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Should I push now\?/ })).toBeDefined()
    await keys(ui, 'I fixed something else entirely\n')
    expect(toasts.at(-1)).toBe('Line 1 typed: 13% at 0 WPM. 90% earns +2 energy.')
    expect((state.purse as { energy: number } | undefined)?.energy ?? 0).toBe(0)

    // The next prompt keeps it up, mid-game, while Claude works.
    await $.turn.start({ text: 'next', turnId: 't2' })
    expect(await ui.find({ type: 'Text', text: /✗ Line 1: 13% · 0 WPM · 90% pays \+2 energy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Key points/ })).toBeDefined()
    await ui.unmount()
  })

  test("while Claude works the last reply's recap stays typeable; the new reply's replaces it", async ($, on) => {
    const { clock, state, toasts } = world(on, { flavor: SEEN, haikuOn: false })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await $.turn.complete(end('t1', LONG))
    const last = await landed(state)
    await $.turn.start({ text: 'now the docs', turnId: 't2' })
    expect(state.mode).toBe('combat')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // Typing is the attack while there is a recap: no Attack button, the hint points at the field.
    expect(await ui.find({ type: 'Button', text: /Attack/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /90% pays \+2 energy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /click the words and type to attack/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /A attack/ })).toBeUndefined()
    await keys(ui, FALLBACK)
    expect(toasts.at(-1)).toMatch(/^Line 1 typed: 100% at \d+ WPM\. \+2 energy/)
    expect((state.run as Run).floor).toBeGreaterThan(1)

    await clock.advance(10_000)
    await $.turn.complete(end('t2', `${LONG}\n\nTL;DR: Rewrote the setup guide for new users.`))
    const next = await landed(state, last)
    expect(next.lines[0]).toBe('Rewrote the setup guide for new users.')
    expect(next.at).toBe(0)
    expect((await ui.find({ type: 'Client', key: 'typer' }))?.props.props).toMatchObject({ line: 'Rewrote the setup guide for new users.', typed: '' })
    await ui.unmount()
  })

  test('Monkeytype typing: a slip stays and the caret moves on; Backspace mends only the word you are on', async ($, on) => {
    const { clock, state } = world(on, { flavor: SEEN, haikuOn: false })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await $.turn.complete(end('t1', LONG))
    const r = await landed(state)
    expect(r.lines[0]).toBe(FALLBACK)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const typed = () => (state.recap as Recap).typed

    // One dot per line, the summary three apart from the rest; the first one is here, in the phase colour.
    const first = (await ui.findAll({ type: 'Text' })).filter(t => /^ ?[●○]$/.test(t.text))
    expect(first.map(t => t.text)).toEqual(['●', '○', '○', ' ○', '○'])
    expect(first[0]!.props).toMatchObject({ color: 'suggestion', bold: true })

    // A space before a word starts does nothing; Backspace cannot reopen a finished word.
    await keys(ui, ' I ')
    expect(typed()).toBe('I ')
    await keys(ui, '\b')
    expect(typed()).toBe('I ')
    await keys(ui, 'fixed ')
    await clock.advance(6000)
    // A wrong letter stays where it fell; the caret moves on past it.
    // Ctrl+Backspace clears the word you are on, no further.
    await keys(ui, 'xx')
    await ui.key({ key: 'backspace', ctrl: true, in: 'typer' })
    expect(typed()).toBe('I fixed ')
    await keys(ui, 'tz')
    expect(typed()).toBe('I fixed tz')
    // Backspace mends the word you are on.
    await keys(ui, '\b')
    expect(typed()).toBe('I fixed t')
    await keys(ui, 'eh ')
    expect(typed()).toBe('I fixed teh ')
    // Two of three words right; "I fixed teh " is 12 characters in 6 s.
    expect(await ui.find({ type: 'Text', text: /24 WPM · 67% acc/ })).toBeDefined()
    // The slip shows in red on the letters that differ, the word underlined; the caret sits on the next word's first letter.
    const texts = await ui.findAll({ type: 'Text', in: 'typer' })
    expect(texts.filter(t => t.props.color === 'error').map(t => t.text)).toContain('he')
    expect(texts.filter(t => t.props.color === 'error').every(t => t.props.underline === true)).toBe(true)
    expect(texts.filter(t => t.props.inverse === true).map(t => t.text)).toEqual(['l'])

    // Enter checks the words typed, the one in progress finished too.
    await keys(ui, 'login\n')
    expect((state.recap as Recap).at).toBe(1)
    expect(typed()).toBe('')
    expect(await ui.find({ type: 'Text', text: /✗ Line 1: 20% · \d+ WPM · 90% pays \+2 energy/ })).toBeDefined()
    const dots = (await ui.findAll({ type: 'Text' })).filter(t => /^ ?[●○]$/.test(t.text))
    expect(dots[0]).toMatchObject({ text: '●', props: { color: 'error' } })
    expect(dots[1]).toMatchObject({ text: '●', props: { color: 'suggestion', bold: true } })
    // An Enter on a line not started skips nothing.
    await keys(ui, '\n')
    expect((state.recap as Recap).at).toBe(1)
    await ui.unmount()
  })

  test('a long reply shows only the dots near the line here, so the card never overflows', async ($, on) => {
    const { state } = world(on, { flavor: SEEN, haikuOn: false })
    const said = ['login', 'tokens', 'server', 'cache', 'router', 'schema', 'parser', 'logger', 'worker', 'queue', 'mailer', 'billing', 'search', 'upload', 'export', 'import']
    await $.turn.start({ text: 'fix everything', turnId: 't1' })
    await $.turn.complete(end('t1', said.map(w => `I rewrote the ${w} module to be faster.`).join(' ')))
    const r = await landed(state)
    expect(r.lines.length).toBeGreaterThan(DOTS_SHOWN + 2)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const dots = async () => (await ui.findAll({ type: 'Text' })).filter(t => /^ ?[●○]$/.test(t.text) || t.text === '…')
    const shown = async () => (await dots()).map(t => t.text.trim())

    // At the start: the first ten, then "…" for the rest; the tag still counts them all.
    expect(await shown()).toEqual(['●', ...Array(DOTS_SHOWN - 1).fill('○'), '…'])
    expect(await ui.find({ type: 'Text', text: new RegExp(`^SUMMARY 1/${r.top}$`) })).toBeDefined()

    // Further in: "…" on both sides, the line here fifth, still ten dots.
    for (let i = 0; i < 6; i++) await ui.press({ key: 'skip' })
    expect((state.recap as Recap).at).toBe(6)
    const mid = await shown()
    expect(mid[0]).toBe('…')
    expect(mid.filter(t => t !== '…')).toHaveLength(DOTS_SHOWN)
    expect((await dots())[5]).toMatchObject({ props: { color: 'claude', bold: true } })
    await ui.unmount()
  })

  test('typing is the fight: a right word swings, a wrong one does not, and the frozen room fights on', async ($, on) => {
    const { clock, state } = world(on, { flavor: SEEN, haikuOn: false })
    await $.turn.start({ text: 'fix login', turnId: 't1' })
    await $.turn.complete(end('t1', LONG))
    expect((await landed(state)).lines[0]).toBe(FALLBACK)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const type = (text: string) => keys(ui, text)
    const slime = () => (state.run as Run).monster.hp
    const scene = async () => String((await ui.findAll({ type: 'Svg' }))[0]?.props.source)

    // In the freeze with a recap up, the room keeps its colour and no board covers the fight.
    expect(await scene()).not.toContain('url(#frozen)')
    // No energy: each right word swings weak for 1, and draws no hit back.
    await type('I ')
    expect(slime()).toBe(3)
    await type('fixed ')
    expect(slime()).toBe(2)
    expect((state.run as Run).hp).toBe(10)
    // Letters between swings redraw the same scene, so its last blow does not play again.
    const was = await scene()
    await clock.advance(2000)
    await type('t')
    expect(await scene()).toBe(was)
    // A wrong word swings nothing (the slime may hit back).
    await type('eh ')
    expect(slime()).toBe(2)
    expect((state.run as Run).hp).toBeGreaterThanOrEqual(9)
    // Enter finishes the word being typed too.
    await type('login\n')
    expect(slime()).toBe(1)
    // Nothing drops in the freeze: nothing could be grabbed.
    expect(state.loot).toEqual([])
    await ui.unmount()
  })

  test('a short reply gets no round and asks no model', async ($, on) => {
    const { state } = world(on, { flavor: SEEN })
    let asked = 0
    on('model.complete', () => {
      asked++
      return { value: { isAnswered: true as const, text: 'never shown', usage: USAGE } }
    })
    await $.turn.start({ text: 'thanks', turnId: 't1' })
    await $.turn.complete(end('t1', 'Done.'))
    expect((await landed(state)).lines).toEqual([])
    expect(asked).toBe(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Client', key: 'typer' })).toBeUndefined()
    await ui.unmount()
  })

  test('a reply with a TL;DR line types it and asks Haiku nothing', async ($, on) => {
    const { state } = world(on, { flavor: SEEN })
    let asked = 0
    on('model.complete', () => {
      asked++
      return { value: { isAnswered: true as const, text: 'TYPE: never shown', usage: USAGE } }
    })
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.complete(end('t1', `${LONG}\n\nTL;DR: Fixed the login bug and added a regression test.`))
    expect((await landed(state)).lines[0]).toBe('Fixed the login bug and added a regression test.')
    expect(asked).toBe(0)
  })

  const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as const
  test('/delve tldr flips the TL;DR ask, which joins the system prompt only while on', async ($, on) => {
    const stored: Record<string, unknown> = {}
    on('store.get', (_$, e) => ({ value: stored[e.key] }))
    on('store.set', (_$, e) => {
      stored[e.key] = e.value
      return { value: undefined }
    })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
    const ids = async () => (await $.prompt.compose(COMPOSE)).sections.map(x => x.id)
    const tldr = async (args: string) => (await $.command.run({ ...RUN, command: 'delve', args })).text
    expect(await ids()).toEqual(['intro'])
    expect(await tldr('tldr')).toMatch(/^TL;DR on/)
    expect(await ids()).toEqual(['intro', 'delve:tldr'])
    expect((await $.prompt.compose(COMPOSE)).sections.at(-1)).toEqual({ id: 'delve:tldr', text: TLDR_ASK, scope: 'session' })
    expect(await tldr('tldr off')).toMatch(/^TL;DR off/)
    expect(await ids()).toEqual(['intro'])
    expect(await tldr('tldr sideways')).toMatch(/Usage/)
  })
})
