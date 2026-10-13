// Meta shop rules, pure: the wares, their prices, what Haiku is asked and how its pick is read.

import type { ItemId, Meta, Shop } from '../types'
import type { Roll } from './combat'

type Ware = { name: string; does: string; max: number; base: number }

// Upgrades stack to `max`; unlocks have max 1. A level costs base × (level + 1) XP.
export const WARES: Record<ItemId, Ware> = {
  vitality: { name: 'Vitality', does: '+2 max HP', max: 5, base: 10 },
  whetstone: { name: 'Whetstone', does: '+10% crit chance', max: 3, base: 15 },
  shield: { name: 'Shield', does: '-10% chance to be hit back', max: 3, base: 15 },
  potion_blue: { name: 'Blue potion', does: 'blue potions drop while farming, +2 energy each', max: 1, base: 20 },
  loot_bag: { name: 'Loot bag', does: 'loot bags drop while farming, 5-8 gold each', max: 1, base: 20 },
  caverns: { name: 'Heap Caverns', does: 'every other 5 floors become the caverns', max: 1, base: 40 },
  deep: { name: 'Deep dwellers', does: 'mimics and golems roam, the richest monsters', max: 1, base: 50 },
}

// Each ware's icon in the shop view: a sprite already drawn for the game.
export const ICON: Record<ItemId, string> = {
  vitality: 'heart_full',
  whetstone: 'sword',
  shield: 'shield',
  potion_blue: 'potion_blue',
  loot_bag: 'loot_bag',
  caverns: 'caverns_wall_alt',
  deep: 'mimic_idle',
}

export const STOCK_SIZE = 3
export const PITCHES = [
  'Fresh from the stack, barely used.',
  'Everything must go. Mostly.',
  'No refunds. The last hero asked.',
  'Coins? No. I deal in experience.',
]

export const priceOf = (id: ItemId, meta: Meta) => WARES[id].base * (meta[id] + 1)

// Wares not yet bought to their max.
export const forSale = (meta: Meta) => (Object.keys(WARES) as ItemId[]).filter(id => meta[id] < WARES[id].max)

function draw(from: readonly ItemId[], n: number, roll: Roll): ItemId[] {
  const left = [...from]
  const out: ItemId[] = []
  while (out.length < n && left.length) out.push(left.splice(Math.floor(roll() * left.length), 1)[0]!)
  return out
}

export function diceShop(meta: Meta, roll: Roll): Shop {
  return { stock: draw(forSale(meta), STOCK_SIZE, roll), pitch: PITCHES[Math.floor(roll() * PITCHES.length)]! }
}

export function shopPrompt(meta: Meta, xp: number, floor: number): string {
  const lines = forSale(meta).map(id => `${id}: ${WARES[id].name}, ${WARES[id].does}, ${priceOf(id, meta)} XP`)
  return [
    "You keep the shop in Claude's Depths, a pixel-art dungeon crawl. A warrior just started a new run.",
    `They hold ${xp} XP and their last run ended on floor ${floor}.`,
    `Pick ${STOCK_SIZE} wares to stock from this list (id: name, effect, price):`,
    ...lines,
    'Reply with JSON only: {"stock": ["id", ...], "pitch": "one short in-character line, under 80 characters"}',
  ].join('\n')
}

// Haiku's reply, held to the list: unknown or doubled ids drop out, dice fill the gaps,
// and a missing or long pitch falls back to the table.
export function readPick(text: string, meta: Meta, roll: Roll): Shop {
  const fallback = diceShop(meta, roll)
  let said: { stock?: unknown; pitch?: unknown } = {}
  try {
    said = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return fallback
  }
  const open = forSale(meta)
  const picked = Array.isArray(said.stock) ? [...new Set(said.stock)].filter((id): id is ItemId => open.includes(id as ItemId)) : []
  const stock = [...picked.slice(0, STOCK_SIZE), ...draw(open.filter(id => !picked.includes(id)), STOCK_SIZE - picked.length, roll)]
  const pitch = typeof said.pitch === 'string' && said.pitch.trim() && said.pitch.length <= 120 ? said.pitch.trim() : fallback.pitch
  return { stock, pitch }
}

// What the shop sold so far, as "Name level/max".
export const ownedOf = (meta: Meta) =>
  (Object.keys(WARES) as ItemId[]).filter(id => meta[id] > 0).map(id => `${WARES[id].name} ${meta[id]}/${WARES[id].max}`)

export function shopText(shop: Shop, meta: Meta, xp: number): string {
  const owned = ownedOf(meta)
  return [
    `Shopkeeper: "${shop.pitch}"`,
    `You hold ${xp} XP.`,
    ...(shop.stock.length
      ? shop.stock.map(id => `- ${id}: ${WARES[id].name} (${WARES[id].does}), ${priceOf(id, meta)} XP`)
      : ['Sold out. New wares arrive with the next run.']),
    ...(owned.length ? [`Owned: ${owned.join(', ')}`] : []),
    'Buy with /delve buy <id>.',
  ].join('\n')
}
