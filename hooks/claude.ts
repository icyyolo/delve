// How Claude's own work shows in the depths, pure: the weapon each tool forges, the side a
// subagent takes, and what a turn's end, a compaction, the context's fill and the todo
// list do to the run.

import type { Fighter, Meta, MonsterKind, Quest, Run, Weapon } from '../types'
import { NO_META, biomeFor, spawn } from './combat'
import type { Edge, Roll } from './combat'

export const WEAPONS: Record<Weapon, { name: string; does: string; edge: Edge }> = {
  fists: { name: 'Fists', does: 'plain swings', edge: {} },
  sword: { name: 'Sword', does: '+1 damage: Claude edited a file', edge: { bonus: 1 } },
  hammer: { name: 'Hammer', does: 'every swing crits: a command ran clean', edge: { isSure: true } },
  bow: { name: 'Bow', does: 'no hit back: Claude read the code', edge: { isRanged: true } },
  portal: { name: 'Portal', does: 'each swing pulls loot through: Claude searched the web', edge: {} },
}

const FORGE: Record<string, Weapon> = {
  Edit: 'sword',
  Write: 'sword',
  NotebookEdit: 'sword',
  Read: 'bow',
  Grep: 'bow',
  Glob: 'bow',
  WebFetch: 'portal',
  WebSearch: 'portal',
}
const SHELLS = new Set(['Bash', 'PowerShell'])

// The weapon a tool call forges: a failed command drops the hammer, and any other tool
// leaves the weapon in hand (undefined).
export function weaponFor(tool: string, isOk: boolean): Weapon | undefined {
  if (SHELLS.has(tool)) return isOk ? 'hammer' : 'fists'
  return FORGE[tool]
}

// An MCP tool call summons a familiar that strikes the monster once.
export const isMcp = (tool: string) => tool.startsWith('mcp__')
export const FAMILIAR_DAMAGE = 1

// A subagent's kind of work picks the monster that fights beside the hero.
const ALLY_KIND: Record<string, MonsterKind> = { Explore: 'bat', Plan: 'wraith', 'general-purpose': 'skeleton' }
// A doppelganger strikes the hero once per this many of its tool calls.
export const RIVAL_EVERY = 4

type Spawned = { subagentType: string; description: string; fork: boolean }

// A doppelganger is as tough as the model it runs on.
export function rivalHp(model: string): number {
  return /opus/i.test(model) ? 10 : /sonnet/i.test(model) ? 7 : /haiku/i.test(model) ? 4 : 6
}

// Mixed sides: a fork of the conversation is a rival, every other subagent an ally.
export function fighterFor(agentId: string, spawned: Spawned, model: string): Fighter {
  const label = `${spawned.subagentType}: ${spawned.description}`.slice(0, 60)
  if (spawned.fork) {
    const hp = rivalHp(model)
    return { agentId, side: 'rival', kind: 'warrior', label, hp, maxHp: hp }
  }
  return { agentId, side: 'ally', kind: ALLY_KIND[spawned.subagentType] ?? 'mimic', label, hp: 0, maxHp: 0 }
}

// An ally's blow when its run ends: 1, +1 per 3 of its tool calls, at most 6.
export const allyDamage = (calls: number) => Math.min(6, 1 + Math.floor(calls / 3))

// How a turn ended, in the depths: Esc flees and drops a quarter of the gold, an error
// springs a trap (never fatal), a refusal lets the monster raise its guard (+2 HP).
export function turnEnd(r: Run, reason: string): Run {
  if (r.isDead) return r
  if (reason === 'aborted') {
    const lost = Math.ceil(r.gold / 4)
    const note = lost ? `You fled (Esc) and dropped ${lost} gold.` : 'You fled (Esc).'
    return { ...r, gold: r.gold - lost, last: { dealt: 0, took: 0, isEvent: true, note } }
  }
  if (reason === 'error') {
    const took = r.hp > 1 ? 1 : 0
    const note = `A trap sprang: the turn hit an error${took ? ', -1 HP' : ''}.`
    return { ...r, hp: r.hp - took, last: { dealt: 0, took, isEvent: true, note } }
  }
  if (reason === 'refusal') {
    const hp = Math.min(r.monster.maxHp, r.monster.hp + 2)
    const note = `Claude refused. The ${r.monster.kind} raised its guard: HP ${hp}.`
    return { ...r, monster: { ...r.monster, hp }, last: { dealt: 0, took: 0, isEvent: true, note } }
  }
  return r
}

// Compaction shakes the dungeon: the floor gives way and the hero drops a floor, no gold.
export function quake(r: Run, roll: Roll, meta: Meta = NO_META): Run {
  if (r.isDead) return r
  const floor = r.floor + 1
  const note = `Claude's memory compacted. The floor gave way: down to floor ${floor}.`
  return {
    ...r,
    floor,
    biome: biomeFor(floor, meta),
    monster: spawn(floor, roll, meta),
    last: { dealt: 0, took: 0, isEvent: true, isQuake: true, note },
  }
}

// The torch dims as the context fills: clear below half, up to 80% dark when full.
export function darkness(percent: number | null): number {
  if (percent === null || percent < 50) return 0
  return Math.min(0.8, ((percent - 50) / 50) * 0.8)
}

// A skill cast makes this many swings free.
export const SPELL_SWINGS = 3

// Each finished quest pays gold into the run and XP into the purse.
export const QUEST_GOLD = 5
export const QUEST_XP = 3

type Todo = { content: string; status: string }

// TodoWrite sends the whole list: the board is the new list.
export const todoBoard = (todos: readonly Todo[]): Quest[] =>
  todos.map((t, i) => ({ id: `todo-${i}`, text: t.content, isDone: t.status === 'completed' }))

// A todo is a finished quest the first time it reads completed.
export function newlyDone(old: readonly Todo[], now: readonly Todo[]): string[] {
  const was = new Set(old.filter(t => t.status === 'completed').map(t => t.content))
  return now.filter(t => t.status === 'completed' && !was.has(t.content)).map(t => t.content)
}
