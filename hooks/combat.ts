// Combat rules, pure so tests can fix the dice. `roll` returns a number in [0, 1).

import type { Biome, Meta, Monster, MonsterKind, Run } from '../types'

export type Roll = () => number

type Stats = { hp: number; atk: number; gold: number; fromFloor: number }

export const STATS: Record<MonsterKind, Stats> = {
  slime: { hp: 4, atk: 1, gold: 2, fromFloor: 1 },
  bat: { hp: 5, atk: 1, gold: 2, fromFloor: 1 },
  skeleton: { hp: 7, atk: 2, gold: 4, fromFloor: 3 },
  wraith: { hp: 8, atk: 2, gold: 5, fromFloor: 5 },
  mimic: { hp: 9, atk: 2, gold: 8, fromFloor: 6 },
  golem: { hp: 12, atk: 3, gold: 8, fromFloor: 8 },
}

export const CRIT_CHANCE = 0.2
export const COUNTER_CHANCE = 0.5
export const BASE_HP = 10

// A hero with nothing bought: caverns, mimic and golem locked, no upgrades.
export const NO_META: Meta = { vitality: 0, whetstone: 0, shield: 0, potion_blue: 0, loot_bag: 0, caverns: 0, deep: 0 }
const DEEP: readonly MonsterKind[] = ['mimic', 'golem']

// The shop's upgrades: +2 max HP, +10% crit, -10% counter per level.
export const maxHpFor = (meta: Meta) => BASE_HP + 2 * meta.vitality
const critFor = (meta: Meta) => CRIT_CHANCE + 0.1 * meta.whetstone
const counterFor = (meta: Meta) => COUNTER_CHANCE - 0.1 * meta.shield

// Five floors per biome, alternating once the caverns are unlocked; the crypt until then.
export function biomeFor(floor: number, meta: Meta = NO_META): Biome {
  return meta.caverns && Math.floor((floor - 1) / 5) % 2 === 1 ? 'caverns' : 'crypt'
}

export function spawn(floor: number, roll: Roll, meta: Meta = NO_META): Monster {
  const pool = (Object.keys(STATS) as MonsterKind[]).filter(
    kind => STATS[kind].fromFloor <= floor && (meta.deep || !DEEP.includes(kind)),
  )
  const kind = pool[Math.floor(roll() * pool.length)] ?? 'slime'
  const hp = STATS[kind].hp + Math.floor((floor - 1) / 2)
  return { kind, hp, maxHp: hp }
}

export function newRun(meta: Meta = NO_META): Run {
  const hp = maxHpFor(meta)
  return { biome: 'crypt', floor: 1, hp, maxHp: hp, gold: 0, isDead: false, monster: { kind: 'slime', hp: 4, maxHp: 4 } }
}

// What the weapon adds to a swing: extra damage, a sure crit, or range (no hit back).
// A weak swing (no energy) gets none of it and cannot crit.
export type Edge = { bonus?: number; isSure?: boolean; isRanged?: boolean; isWeak?: boolean }

// One swing's damage: a crit doubles, then the weapon's bonus; a weak swing deals 1.
export function swingDamage(roll: Roll, meta: Meta = NO_META, edge: Edge = {}): number {
  if (edge.isWeak) return 1
  return (edge.isSure || roll() < critFor(meta) ? 2 : 1) + (edge.bonus ?? 0)
}

// The monster falls: gold, a heal of 1, and the next floor.
function slay(r: Run, dealt: number, roll: Roll, meta: Meta, isEvent?: boolean): Run {
  const floor = r.floor + 1
  return {
    ...r,
    floor,
    biome: biomeFor(floor, meta),
    hp: Math.min(r.maxHp, r.hp + 1),
    gold: r.gold + STATS[r.monster.kind].gold,
    monster: spawn(floor, roll, meta),
    last: { dealt, took: 0, slain: r.monster.kind, ...(isEvent && { isEvent }) },
  }
}

// One swing: the hero hits (crit doubles), a survivor may hit back, a kill heals 1 and
// opens the next floor.
export function attack(r: Run, roll: Roll, meta: Meta = NO_META, edge: Edge = {}): Run {
  if (r.isDead) return r
  const dealt = swingDamage(roll, meta, edge)
  const left = Math.max(0, r.monster.hp - dealt)
  if (left === 0) return slay(r, dealt, roll, meta)
  const took = !edge.isRanged && roll() < counterFor(meta) ? STATS[r.monster.kind].atk : 0
  const hp = Math.max(0, r.hp - took)
  return { ...r, hp, isDead: hp === 0, monster: { ...r.monster, hp: left }, last: { dealt, took } }
}

// A blow the hero did not swing (an ally, a familiar): nobody hits back.
export function strike(r: Run, dealt: number, roll: Roll, meta: Meta = NO_META): Run {
  if (r.isDead) return r
  const left = Math.max(0, r.monster.hp - dealt)
  if (left === 0) return slay(r, dealt, roll, meta, true)
  return { ...r, monster: { ...r.monster, hp: left }, last: { dealt, took: 0, isEvent: true } }
}

// The torch burnt out while the person drifted: the monster gets one free hit.
export function ambush(r: Run): Run {
  if (r.isDead) return r
  const took = STATS[r.monster.kind].atk
  const hp = Math.max(0, r.hp - took)
  return { ...r, hp, isDead: hp === 0, last: { dealt: 0, took, isAmbush: true } }
}

// How long a reply takes to read: half of it at 250 words a minute, 3 s to 2 min.
export function readMsFor(answer: string): number {
  const words = answer.split(/\s+/).filter(Boolean).length
  return Math.min(120_000, Math.max(3_000, Math.round(((words / 250) * 60_000) / 2)))
}
