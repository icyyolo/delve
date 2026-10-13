// Flavor lines, pure: one per room (a floor and its monster). Haiku writes them; this
// hand-written table stands in on a timeout, a failure or the daily cap.

import type { MonsterKind, Run } from '../types'

export const TABLE: Record<MonsterKind, readonly string[]> = {
  slime: [
    'A slime oozes out of a leaked allocation.',
    'Something green and unreferenced wobbles toward you.',
    'The slime absorbs a stray semicolon and grows bolder.',
  ],
  bat: [
    'A bat shrieks at a frequency only race conditions hear.',
    'Wings flutter in the dark between two stack frames.',
    'A bat circles, polling you every few milliseconds.',
  ],
  skeleton: [
    'A skeleton rises, rattling like an unhandled exception.',
    'Old bones, still holding a lock nobody released.',
    'The skeleton salutes. It was a hero once, too.',
  ],
  wraith: [
    'A wraith drifts by, a process that never got reaped.',
    'Cold air. Something here was freed twice.',
    'The wraith whispers a stack trace in a dead language.',
  ],
  mimic: [
    'That chest has teeth. Never trust unvalidated input.',
    'The treasure blinks. Treasure should not blink.',
    'A mimic yawns, pretending to be a perfectly fine object.',
  ],
  golem: [
    'A golem of compiled stone blocks the stairs.',
    'The floor shakes. Something heavy was never garbage collected.',
    'A golem grinds awake, slow but very, very thorough.',
  ],
}

// A room: one floor of one run and the monster in it.
export const roomOf = (r: Run) => `${r.floor}:${r.monster.kind}`

export function tableLine(r: Run): string {
  const lines = TABLE[r.monster.kind]
  return lines[r.floor % lines.length]!
}

export function flavorPrompt(r: Run, biome: string): string {
  return [
    "Write one line of flavor text for Claude's Depths, a pixel-art dungeon crawl themed on programming.",
    `Floor ${r.floor} of the ${biome}. The warrior (${r.hp}/${r.maxHp} HP) meets a ${r.monster.kind}.`,
    'Under 90 characters, present tense, no quotes, no preamble. Reply with the line only.',
  ].join('\n')
}

// Haiku's reply as a line: its first non-empty line, quotes stripped; too long means none.
export function readLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map(l => l.trim().replace(/^["'“]+|["'”]+$/g, '').trim())
    .find(Boolean)
  return line && line.length <= 120 ? line : undefined
}

// The cap's day, in UTC.
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
