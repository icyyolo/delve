export type Biome = 'crypt' | 'caverns'

export type MonsterKind = 'slime' | 'bat' | 'skeleton' | 'wraith' | 'golem' | 'mimic'

export type Monster = { kind: MonsterKind; hp: number; maxHp: number }

// The last exchange of blows, drawn once as an animation and a log line.
// An ambush is the monster's free hit after the torch burns out. An event is a blow the
// hero did not swing (an ally, a familiar, a trap, a quake); `note` is its log line.
// `atRival`: the hero's swing went to the doppelganger, not the monster.
export type Blow = {
  dealt: number
  took: number
  slain?: MonsterKind
  isAmbush?: boolean
  isEvent?: boolean
  isQuake?: boolean
  atRival?: boolean
  note?: string
}

// The pause after a turn: when it ended, how long its reply takes to read, and whether
// the torch has burnt out (the ambush happened).
export type Rest = { endedAt: number; readMs: number; isOut: boolean }

// Kept in $.store too, so a run survives restarts until the hero dies.
export type Run = {
  biome: Biome
  floor: number
  hp: number
  maxHp: number
  gold: number
  isDead: boolean
  monster: Monster
  last?: Blow
}

// Changes on every tool call, so the pane never reads it; the status line shows it.
export type Purse = { energy: number; xp: number; gained: number }

// idle: no turn running. combat: a turn that called a tool. farm: a turn with no tool call yet.
export type Mode = 'idle' | 'combat' | 'farm'

export type LootKind = 'coin' | 'gem_xp' | 'potion_red' | 'potion_blue' | 'loot_bag'

export type Loot = { id: string; kind: LootKind }

// Meta shop wares: stat upgrades with levels, and one-time unlocks (level 0 or 1).
export type ItemId = 'vitality' | 'whetstone' | 'shield' | 'potion_blue' | 'loot_bag' | 'caverns' | 'deep'

// What the shop sold for good: each ware's level. Kept in $.store; survives death.
export type Meta = Record<ItemId, number>

// The shop's current wares, picked by Haiku (or dice) when a run starts, and its pitch.
export type Shop = { stock: ItemId[]; pitch: string }

// The current room's flavor line, Haiku's or the table's; room is "floor:monster".
export type Flavor = { room: string; text: string }

// What the pane shows: the dungeon, or the shop over it.
export type View = 'scene' | 'shop'

// What Claude's last tool forged for the hero's swings.
export type Weapon = 'fists' | 'sword' | 'hammer' | 'bow' | 'portal'

// A subagent in the room. An ally fights the monster when its run ends; a fork is a rival
// doppelganger that strikes the hero while it runs and takes the hero's swings.
export type Fighter = {
  agentId: string
  side: 'ally' | 'rival'
  kind: MonsterKind | 'warrior'
  label: string
  hp: number
  maxHp: number
}

// A skill cast: this many swings cost no energy.
export type Spell = { skill: string; swings: number }

// One item of Claude's todo list, shown as a quest.
export type Quest = { id: string; text: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    delve: {
      run: Run
      purse: Purse
      mode: Mode
      loot: Loot[]
      rest: Rest | null
      meta: Meta
      flavor: Flavor | null
      shop: Shop | null
      view: View
      weapon: Weapon
      fighters: Fighter[]
      // Each running subagent's tool calls so far; the pane never reads it.
      tally: Record<string, number>
      spell: Spell | null
      quests: Quest[]
      // The context window's fill at the last turn end, 0-100; the torch dims with it.
      context: number | null
    }
  }
}
