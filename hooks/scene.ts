// Builds the pane's SVG drawings from sprite grids. Animation is SMIL only:
// the pane never redraws on a clock (that made the desktop cursor flicker).

import type { ItemId, Loot, LootKind, Meta, MonsterKind, Quest, Run, Spell, Weapon } from '../types'
import { WEAPONS } from './claude'
import { STATS } from './combat'
import { GOODS, GOOD_IDS, ICON, WARES, priceOf } from './shop'
import { PALETTE, SPRITES } from './sprites.gen'

type Grid = readonly string[]

const T = 16
const ROOM_W = 7
const ROOM_H = 4
const FRAME_MS = 300

export const SCALE = 3
export const SCENE_W = ROOM_W * T
export const SCENE_H = ROOM_H * T

export const BIOME_NAME = { crypt: 'Stack Crypt', caverns: 'Heap Caverns' } as const
export const LOOT_NAME: Record<LootKind, string> = { coin: 'coin', gem_xp: 'XP gem', potion_red: 'potion', potion_blue: 'blue potion', loot_bag: 'loot bag' }

const hex = (key: string) => PALETTE[key] ?? '#000'
const INK = hex('k')

// Appends one grid's colour runs, offset by (ox, oy), to a colour -> path-data map.
function addRuns(layer: Map<string, string>, grid: Grid, ox: number, oy: number) {
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]!
      let n = 1
      while (row[x + n] === ch) n++
      const hex = PALETTE[ch]
      if (ch !== '.' && hex) layer.set(hex, (layer.get(hex) ?? '') + `M${ox + x} ${oy + y}h${n}v1h-${n}z`)
      x += n
    }
  })
}

function layerSvg(layer: Map<string, string>): string {
  return [...layer].map(([hex, d]) => `<path fill="${hex}" d="${d}"/>`).join('')
}

function staticSprite(grid: Grid, ox: number, oy: number): string {
  const layer = new Map<string, string>()
  addRuns(layer, grid, ox, oy)
  return layerSvg(layer)
}

// A sprite's frames as SMIL-toggled groups; one frame is drawn static.
export function animated(name: string, ox: number, oy: number, ms = FRAME_MS): string {
  const frames = SPRITES[name]
  if (!frames?.length) return ''
  if (frames.length === 1) return staticSprite(frames[0]!, ox, oy)
  const dur = (ms * frames.length) / 1000
  return frames
    .map((grid, i) => {
      const values = frames.map((_, j) => (i === j ? 'visible' : 'hidden')).join(';')
      return `<g visibility="${i === 0 ? 'visible' : 'hidden'}"><animate attributeName="visibility" values="${values}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>${staticSprite(grid, ox, oy)}</g>`
    })
    .join('')
}

// A sprite's first frame only: the frozen room holds still.
const firstFrame = (name: string, ox: number, oy: number) => staticSprite(SPRITES[name]?.[0] ?? [], ox, oy)

type Shot = { name: string; at: number }

// An idle loop with one-shot plays over it: each shot's frames show once from `at` seconds
// and the idle hides meanwhile. SMIL `display` sets, so the drawing never needs a redraw.
function actor(idle: string, shots: readonly Shot[], ox: number, oy: number, isStill = false): string {
  const sec = FRAME_MS / 1000
  const hides = shots
    .map(shot => `<set attributeName="display" to="none" begin="${shot.at}s" dur="${(SPRITES[shot.name]?.length ?? 0) * sec}s"/>`)
    .join('')
  const plays = shots.flatMap(shot =>
    (SPRITES[shot.name] ?? []).map(
      (grid, i) =>
        `<g display="none"><set attributeName="display" to="inline" begin="${shot.at + i * sec}s" dur="${sec}s"/>${staticSprite(grid, ox, oy)}</g>`,
    ),
  )
  return `<g>${hides}${isStill ? firstFrame(idle, ox, oy) : animated(idle, ox, oy)}</g>${plays.join('')}`
}

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * SCALE}" height="${h * SCALE}" shape-rendering="crispEdges">${body}</svg>`
}

// Mirrors one sprite slot at x = ox, so it faces the other way.
function flip(body: string, ox: number): string {
  return `<g transform="matrix(-1 0 0 1 ${2 * ox + T} 0)">${body}</g>`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A hover tooltip over whatever `body` paints.
const tip = (title: string, body: string) => `<g class="tip"><title>${esc(title)}</title>${body}</g>`

// --- 3x5 pixel font: each glyph is five rows of three bits ---

const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001011001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  ' ': '000000000000000', '/': '001001010100100', '%': '101001010100101', '-': '000000111000000',
  '+': '000010111010000', '!': '010010010000010', '.': '000000000000010', ',': '000000000010100',
  ':': '000010000010000', '?': '110001010000010', "'": '010010000000000', '#': '101111101111101',
  '(': '010100100100010', ')': '010001001001010', '&': '010101010101011', '_': '000000000000111',
  '=': '000111000111000', '"': '101101000000000', '*': '000101010101000', '<': '001010100010001',
  '>': '100010001010100',
}

export const textWidth = (text: string) => Math.max(0, text.length * 4 - 1)

function glyphRuns(text: string): string {
  let d = ''
  ;[...text.toUpperCase()].forEach((ch, i) => {
    const bits = GLYPHS[ch] ?? GLYPHS[' ']!
    for (let y = 0; y < 5; y++) {
      let x = 0
      while (x < 3) {
        if (bits[y * 3 + x] !== '1') {
          x++
          continue
        }
        let n = 1
        while (x + n < 3 && bits[y * 3 + x + n] === '1') n++
        d += `M${i * 4 + x} ${y}h${n}v1h-${n}z`
        x += n
      }
    }
  })
  return d
}

// Pixel text with its top-left at (x, y), `size` screen pixels per font pixel, and a
// 1-font-pixel dark drop shadow unless `isFlat`.
function say(text: string, x: number, y: number, color: string, size = 1, isFlat = false): string {
  const d = glyphRuns(text)
  const shadow = isFlat ? '' : `<path fill="${INK}" transform="translate(1 1)" d="${d}"/>`
  return `<g transform="translate(${x} ${y})${size === 1 ? '' : ` scale(${size})`}">${shadow}<path fill="${hex(color)}" d="${d}"/></g>`
}

// Pixel text centred on x.
const sayMid = (text: string, cx: number, y: number, color: string, size = 1) => say(text, Math.round(cx - (textWidth(text) * size) / 2), y, color, size)

// --- Mini icons for the HUD, in palette keys like the sprites ---

const MINI: Record<string, Grid> = {
  heart_full: ['.rr.rr.', 'rwrrrrr', 'rrrrrrr', '.rrrrp.', '..rrp..', '...p...'],
  heart_half: ['.rr.mm.', 'rwrrmmm', 'rrrrmmm', '.rrrmm.', '..rrm..', '...r...'],
  heart_empty: ['.mm.mm.', 'memmmmm', 'mmmmmmm', '.mmmmm.', '..mmm..', '...m...'],
  coin: ['.yyy.', 'ywyyo', 'yyyyo', 'yyyoo', '.ooo.'],
  star: ['..c..', '.ccc.', 'ccwcc', '.ccc.', '.c.c.'],
  torch: ['..y..', '.yoy.', '.oro.', '..o..', '.mmm.', '..m..', '..m..'],
  fists: ['.......', '.yyyy..', 'yyyyyo.', 'yyyyyo.', 'oyyyoo.', '.oooo..', '.......'],
  sword: ['......w', '.....e.', '....e..', '.y.e...', '..y....', '.o.y...', 'o......'],
  hammer: ['.eeeee.', '.emmme.', '.eeeee.', '...o...', '...o...', '...p...', '...p...'],
  bow: ['...oe..', '..o.e..', '.o..e..', '.wwwwww', '.o..e..', '..o.e..', '...oe..'],
  portal: ['..ccc..', '.cbbbc.', 'cbsssbc', 'cbswsbc', 'cbsssbc', '.cbbbc.', '..ccc..'],
}

const mini = (name: string, x: number, y: number) => staticSprite(MINI[name] ?? [], x, y)

// A quarter-ring swipe, white edge over cyan, swung over the foe.
const SLASH: Grid = Array.from({ length: 12 }, (_, y) =>
  Array.from({ length: 12 }, (_, x) => {
    const r = Math.hypot(x + 0.5, 12 - y - 0.5)
    return r > 10.4 && r <= 11.8 ? 'w' : r > 9 && r <= 10.4 ? 'c' : '.'
  }).join(''),
)

// Up to five hearts; past ten HP each heart is a fifth of the max, so the row never widens.
function hearts(hp: number, maxHp: number, x: number, y: number): string {
  const n = Math.min(5, Math.ceil(maxHp / 2))
  const halves = maxHp <= 10 ? hp : hp > 0 ? Math.max(1, Math.round((hp / maxHp) * 10)) : 0
  let out = ''
  for (let i = 0; i < n; i++) {
    const left = halves - i * 2
    out += mini(left >= 2 ? 'heart_full' : left === 1 ? 'heart_half' : 'heart_empty', x + i * 8, y)
  }
  return out
}

// A foe's HP bar; `was` drains to `hp` as the blow lands.
function hpBar(x: number, y: number, hp: number, maxHp: number, was: number, color: string, at: number): string {
  const W = 14
  const width = (v: number) => Math.round((Math.max(0, Math.min(maxHp, v)) / maxHp) * W)
  const drain = was !== hp ? `<animate attributeName="width" from="${width(was)}" to="${width(hp)}" begin="${at}s" dur="0.3s" fill="freeze"/>` : ''
  return `<rect x="${x}" y="${y}" width="${W + 2}" height="4" fill="${INK}"/><rect x="${x + 1}" y="${y + 1}" width="${W}" height="2" fill="${hex('d')}"/><rect x="${x + 1}" y="${y + 1}" width="${width(was)}" height="2" fill="${hex(color)}">${drain}</rect>`
}

// A number that rises and fades once from (cx, y) at `at` seconds.
function popup(text: string, cx: number, y: number, color: string, at: number): string {
  return `<g opacity="0"><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.6;1" begin="${at}s" dur="1s" fill="freeze"/><animateTransform attributeName="transform" type="translate" from="0 0" to="0 -8" begin="${at}s" dur="1s" fill="freeze"/>${sayMid(text, cx, y, color)}</g>`
}

// A one-shot: `body` shows from `at` for `dur` seconds.
const flash = (body: string, at: number, dur: number) => `<g display="none"><set attributeName="display" to="inline" begin="${at}s" dur="${dur}s"/>${body}</g>`

// The slain foe bursts into specks.
function puff(cx: number, cy: number, at: number): string {
  const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1.4], [0, 1.4], [-1.4, 0], [1.4, 0]] as const
  const specks = dirs.map(
    ([dx, dy], i) =>
      `<rect x="${cx - 1}" y="${cy - 1}" width="2" height="2" fill="${hex(i % 2 ? 'e' : 'w')}" opacity="0"><animate attributeName="opacity" values="1;0" begin="${at}s" dur="0.5s" fill="freeze"/><animateTransform attributeName="transform" type="translate" from="0 0" to="${dx * 7} ${dy * 7}" begin="${at}s" dur="0.5s" fill="freeze"/></rect>`,
  )
  return flash(`<rect x="${cx - 4}" y="${cy - 4}" width="8" height="8" fill="${hex('w')}"/>`, at, 0.1) + specks.join('')
}

// A band across the room for `dur` seconds from `at`: a big line over a small one.
function banner(big: string, small: string, color: string, at: number, dur = 2): string {
  return `<g opacity="0"><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.8;1" begin="${at}s" dur="${dur}s" fill="freeze"/><animateTransform attributeName="transform" type="translate" from="-24 0" to="0 0" begin="${at}s" dur="0.25s" fill="freeze"/>${board(big, small, color)}</g>`
}

// The band itself, held: the frozen room's YOUR MOVE, the fallen hero's YOU FELL.
function board(big: string, small: string, color: string): string {
  return `<rect y="14" width="${SCENE_W}" height="${small ? 22 : 15}" fill="${INK}" opacity="0.78"/>${sayMid(big, SCENE_W / 2, 17, color, 2)}${small ? sayMid(small, SCENE_W / 2, 29, 'e') : ''}`
}

// Who else is in the room: an ally monster behind the hero, a doppelganger before the
// monster, and how dark the torch has grown (0-1).
// The rest feeds the HUD and tooltips: the weapon in hand, a spell's free swings, the
// context's fill, and the pause after a turn (time left on the torch, or burnt out).
export type Cast = {
  ally?: MonsterKind
  allyLabel?: string
  hasRival?: boolean
  rival?: { hp: number; maxHp: number; label: string }
  dark?: number
  weapon?: Weapon
  spell?: Spell | null
  context?: number | null
  // leftMs <= 0: no pause running (a fresh session), so no fuse. isFighting: a recap to type,
  // so the room fights on in colour with no board over it, only the fuse.
  frozen?: { leftMs: number; isOut: boolean; isFighting?: boolean }
}

const BACK_ROW = ['wall', 'wall', 'wall', 'door', 'wall', 'wall_alt', 'stairs'] as const
// Upper wall rows: plain wall except one variant tile, so the room does not look stamped.
const UPPER_ALT = new Set(['2,0'])
const HUD_H = 9

// The room: three wall rows, one floor row, torches, the hero left, the monster right,
// and up to three loot drops on the floor between them. The last blow plays once:
// the hero swings, the monster (or doppelganger) flinches unless slain, then the hero
// flinches if hit back. A quake shakes the room once; the dark closes in on the hero.
// A HUD rims the room (hearts and gold on top; weapon, spells, floor and torch below),
// damage pops up over whoever took it, a kill bursts and pays its gold into the HUD, a new
// floor wipes in its banner, and a frozen room greys and holds still while the torch fuse burns
// (unless a recap is there to type: then the room fights on under the fuse).
export function sceneSvg(run: Run, isFarming = false, drops: readonly Loot[] = [], cast: Cast = {}): string {
  const tiles = new Map<string, string>()
  const tile = (name: string) => SPRITES[`${run.biome}_${name}`]?.[0] ?? SPRITES[`${run.biome}_wall`]?.[0]
  for (let y = 0; y < ROOM_H; y++) {
    for (let x = 0; x < ROOM_W; x++) {
      const name = y === ROOM_H - 1 ? 'floor' : y === ROOM_H - 2 ? BACK_ROW[x]! : UPPER_ALT.has(`${x},${y}`) ? 'wall_alt' : 'wall'
      const grid = tile(name)
      if (grid) addRuns(tiles, grid, x * T, y * T)
    }
  }
  const isStill = !!cast.frozen && !cast.frozen.isFighting
  const loop = (name: string, ox: number, oy: number) => (isStill ? firstFrame(name, ox, oy) : animated(name, ox, oy))
  const standY = (ROOM_H - 2) * T + 4
  const monX = 4 * T + 8
  const rivalX = 3 * T + 8
  const blow = run.last
  const swung = blow && !blow.isAmbush && !blow.isEvent
  const hitAt = swung ? 0.3 : 0
  const heroShots: Shot[] = swung ? [{ name: 'warrior_attack', at: 0 }] : []
  if (blow && blow.took > 0) heroShots.push({ name: 'warrior_hurt', at: swung ? 0.9 : 0 })
  const isHurt = blow && blow.dealt > 0 && !blow.slain
  const flinch = (name: string, isThem: boolean): Shot[] => (isHurt && isThem ? [{ name, at: hitAt }] : [])
  const rival = cast.rival ?? (cast.hasRival ? { hp: 0, maxHp: 0, label: 'doppelganger' } : undefined)
  const mon = run.monster
  const monWas = blow && !blow.atRival && !blow.slain ? mon.hp + blow.dealt : mon.hp
  const monster = tip(
    `${mon.kind} · HP ${mon.hp}/${mon.maxHp}`,
    `<g class="foe">${actor(`${mon.kind}_idle`, flinch(`${mon.kind}_hurt`, !blow?.atRival), monX, standY, isStill)}${hpBar(monX + 1, standY - 3, mon.hp, mon.maxHp, monWas, 'r', hitAt)}</g>`,
  )
  // A kill: the slain foe flinches, bursts, and the next one fades in where it stood.
  const slain = blow?.slain
  const goneAt = hitAt + 0.45
  const monsterSlot = slain
    ? `<g><set attributeName="display" to="none" begin="${hitAt}s"/>${firstFrame(`${slain}_idle`, monX, standY)}</g>` +
      flash(firstFrame(`${slain}_hurt`, monX, standY), hitAt, 0.45) +
      `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${goneAt + 0.4}s" dur="0.3s" fill="freeze"/>${monster}</g>`
    : monster
  const room = [
    `<rect width="${SCENE_W}" height="${SCENE_H}" fill="${INK}"/>`,
    layerSvg(tiles),
    loop(`${run.biome}_torch`, 1 * T, 1 * T),
    loop(`${run.biome}_torch`, 5 * T, 1 * T),
    cast.ally ? tip(`${cast.ally} ally${cast.allyLabel ? ` · ${cast.allyLabel}` : ''}`, flip(loop(`${cast.ally}_idle`, 0, standY), 0)) : '',
    run.isDead
      ? firstFrame('warrior_dead', 1 * T, standY)
      : tip(`You · HP ${run.hp}/${run.maxHp}`, actor(isFarming ? 'warrior_farm' : 'warrior_idle', heroShots, 1 * T, standY, isStill)),
    ...drops.map((one, i) => {
      const x = 2 * T + 2 + i * 11
      return tip(`${LOOT_NAME[one.kind]} · press ${i + 1} to grab`, loop(one.kind, x, standY) + sayMid(String(i + 1), x + 8, standY + 1, 'w'))
    }),
    run.isDead ? '' : monsterSlot,
    rival
      ? tip(
          `doppelganger · HP ${rival.hp}/${rival.maxHp}${rival.label !== 'doppelganger' ? ` · ${rival.label}` : ''}`,
          flip(actor('warrior_idle', flinch('warrior_hurt', !!blow?.atRival), rivalX, standY, isStill), rivalX) +
            (rival.maxHp ? hpBar(rivalX + 1, standY - 3, rival.hp, rival.maxHp, blow?.atRival ? rival.hp + blow.dealt : rival.hp, 'o', hitAt) : ''),
        )
      : '',
  ].join('')
  const isHeavy = swung && (blow?.dealt ?? 0) >= 2
  const shake = blow?.isQuake
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;-2 1;2 -1;-1 1;1 0;0 0" dur="0.6s" fill="freeze"/>`
    : isHeavy
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;-1 1;1 0;0 0" begin="${hitAt}s" dur="0.25s" fill="freeze"/>`
      : ''
  const shaken = `<g${isStill ? ' filter="url(#frozen)"' : ''}>${shake}${room}</g>`
  const dark = cast.dark ?? 0
  const shade = dark
    ? `<rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#torch)"/>`
    : ''
  const defs = [
    dark
      ? `<radialGradient id="torch" cx="${1 * T + 8}" cy="${standY + 8}" r="${SCENE_W * 0.6}" gradientUnits="userSpaceOnUse"><stop offset="0.25" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${dark.toFixed(2)}"/></radialGradient>`
      : '',
    isStill ? `<filter id="frozen"><feColorMatrix type="saturate" values="0.15"/></filter>` : '',
  ].join('')
  // Where the blow lands: the doppelganger or the monster, and the hero for a hit back.
  const foeX = (blow?.atRival ? rivalX : monX) + 8
  const fx: string[] = []
  if (blow && !run.isDead) {
    if (swung) fx.push(flash(staticSprite(SLASH, foeX - 7, standY + 2), Math.max(0, hitAt - 0.1), 0.25))
    if (blow.dealt > 0) fx.push(popup(`-${blow.dealt}`, foeX, standY - 9, isHeavy ? 'y' : 'w', hitAt))
    if (blow.took > 0) fx.push(popup(`-${blow.took}`, 1 * T + 8, standY - 6, 'r', swung ? 0.9 : 0))
    if (isHeavy) fx.push(flash(`<rect width="${SCENE_W}" height="${SCENE_H}" fill="${hex('w')}" opacity="0.35"/>`, hitAt, 0.08))
    if (slain) {
      fx.push(puff(monX + 8, standY + 9, goneAt))
      if (run.hp < run.maxHp) fx.push(popup('+1', 1 * T + 8, standY - 6, 'l', goneAt + 0.3))
    }
  }
  // HUD: hearts and HP left, gold right on top; weapon, spell charges, floor, torch below.
  const gold = String(run.gold)
  const coinX = SCENE_W - 2 - textWidth(gold) - 7
  const heartsW = Math.min(5, Math.ceil(run.maxHp / 2)) * 8
  const top =
    `<rect width="${SCENE_W}" height="${HUD_H}" fill="${INK}" opacity="0.7"/>` +
    tip(`HP ${run.hp}/${run.maxHp}`, hearts(run.hp, run.maxHp, 2, 2) + say(`${run.hp}/${run.maxHp}`, heartsW + 3, 2, 'w')) +
    tip(`${run.gold} gold`, mini('coin', coinX, 2) + say(gold, SCENE_W - 2 - textWidth(gold), 2, 'y'))
  const w = cast.weapon ?? 'fists'
  const sp = cast.spell
  const floorTag = `F${run.floor} ${run.biome === 'crypt' ? 'CRYPT' : 'CAVERNS'}`
  const pct = cast.context
  const pctText = pct === null || pct === undefined ? '' : `${Math.round(pct)}%`
  const torchX = SCENE_W - 2 - textWidth(pctText) - 7
  const by = SCENE_H - HUD_H
  const bottom =
    `<rect y="${by}" width="${SCENE_W}" height="${HUD_H}" fill="${INK}" opacity="0.7"/>` +
    tip(`${WEAPONS[w].name}: ${WEAPONS[w].does}`, mini(w, 2, by + 1)) +
    (sp ? tip(`Spell /${sp.skill}: ${sp.swings} free swing${sp.swings > 1 ? 's' : ''}`, Array.from({ length: sp.swings }, (_, i) => mini('star', 11 + i * 6, by + 2)).join('')) : '') +
    tip(`Floor ${run.floor} · ${BIOME_NAME[run.biome]}`, sayMid(floorTag, SCENE_W / 2, by + 2, 'e')) +
    (pctText ? tip(`Torch: context ${pctText} full`, mini('torch', torchX, by + 1) + say(pctText, SCENE_W - 2 - textWidth(pctText), by + 2, (pct ?? 0) >= 80 ? 'r' : (pct ?? 0) >= 50 ? 'o' : 'y')) : '')
  // Over it all: the kill's gold flying to the HUD, a new floor's banner, the frozen or fallen board.
  const over: string[] = []
  if (slain && !run.isDead) {
    const flyAt = goneAt + 0.1
    over.push(
      `<g opacity="0"><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" begin="${flyAt}s" dur="0.6s" fill="freeze"/><animateTransform attributeName="transform" type="translate" from="0 0" to="${coinX - monX - 6} ${2 - standY - 6}" begin="${flyAt}s" dur="0.6s" fill="freeze"/>${mini('coin', monX + 6, standY + 6)}</g>`,
      popup(`+${STATS[slain].gold}`, SCENE_W - 8, HUD_H + 2, 'y', flyAt + 0.6),
    )
  }
  if ((slain || blow?.isQuake) && !run.isDead) {
    over.push(banner(`FLOOR ${run.floor}`, BIOME_NAME[run.biome].toUpperCase(), 'y', slain ? goneAt + 0.3 : 0.6))
  }
  if (run.isDead) {
    over.push(`<rect width="${SCENE_W}" height="${SCENE_H}" fill="${INK}" opacity="0.45"/>`, board('YOU FELL', `FLOOR ${run.floor} · ${run.gold} GOLD`, 'r'))
  } else if (cast.frozen) {
    const { leftMs, isOut, isFighting } = cast.frozen
    if (!isFighting) over.push(`<rect width="${SCENE_W}" height="${SCENE_H}" fill="${INK}" opacity="${isOut ? 0.4 : 0.2}"/>`)
    if (isOut) over.push(isFighting ? '' : board('TORCH OUT', 'TYPE A PROMPT TO RELIGHT', 'r'))
    else if (leftMs <= 0) over.push(isFighting ? '' : board('YOUR MOVE', 'SEND A PROMPT', 'y'))
    else {
      const w0 = Math.round((Math.max(0, leftMs) / (5 * 60_000)) * SCENE_W)
      const dur = `${Math.max(0.1, leftMs / 1000)}s`
      over.push(
        isFighting ? '' : board('YOUR MOVE', 'READ THE REPLY', 'y'),
        tip(
          `The torch burns out in ${Math.max(1, Math.ceil(leftMs / 60_000))} min`,
          `<rect y="${HUD_H}" width="${w0}" height="2" fill="${hex('o')}"><animate attributeName="width" from="${w0}" to="0" dur="${dur}" fill="freeze"/></rect><rect x="${w0 - 1}" y="${HUD_H - 1}" width="2" height="4" fill="${hex('y')}"><animate attributeName="x" from="${w0 - 1}" to="-2" dur="${dur}" fill="freeze"/></rect>`,
        ),
      )
    }
  }
  const style = `<style>.foe:hover{filter:brightness(1.35)}</style>`
  return svg(SCENE_W, SCENE_H, `${style}${defs ? `<defs>${defs}</defs>` : ''}${shaken}${shade}${fx.join('')}${top}${bottom}${over.join('')}`)
}

// One sprite's first frame as a still tile: the shop's ware icons.
export function iconSvg(name: string): string {
  return svg(T, T, staticSprite(SPRITES[name]?.[0] ?? [], 0, 0))
}

// Claude's todo list on a parchment: a tick box per quest, finished ones struck through.
export function questsSvg(board: readonly Quest[]): string {
  const rows = board.slice(0, 6)
  const h = 14 + rows.length * 8
  const maxChars = Math.floor((SCENE_W - 15) / 4)
  const done = board.filter(q => q.isDone).length
  const body = [
    `<rect width="${SCENE_W}" height="${h}" fill="${INK}"/><rect x="1" y="1" width="${SCENE_W - 2}" height="${h - 2}" fill="${hex('y')}"/>`,
    `<rect x="1" y="1" width="${SCENE_W - 2}" height="2" fill="${hex('o')}"/><rect x="1" y="${h - 3}" width="${SCENE_W - 2}" height="2" fill="${hex('o')}"/>`,
    say('QUESTS', 4, 5, 'p', 1, true),
    say(`${done}/${board.length}`, SCENE_W - 4 - textWidth(`${done}/${board.length}`), 5, 'p', 1, true),
    ...rows.map((q, i) => {
      const y = 12 + i * 8
      const text = q.text.length > maxChars ? `${q.text.slice(0, maxChars - 1)}.` : q.text
      const box = `<rect x="4" y="${y}" width="5" height="5" fill="${INK}"/><rect x="5" y="${y + 1}" width="3" height="3" fill="${hex(q.isDone ? 'g' : 'y')}"/>`
      const strike = q.isDone ? `<rect x="11" y="${y + 2}" width="${textWidth(text) + 2}" height="1" fill="${hex('m')}"/>` : ''
      return tip(q.text, box + say(text, 12, y, q.isDone ? 'm' : 'k', 1, true) + strike)
    }),
  ]
  return svg(SCENE_W, h, body.join(''))
}

// The shop as a counter: the shopkeeper, each ware on the shelf with its level above and
// its price below (red when the XP falls short), the run goods on a gold shelf below it,
// and what was bought for good underneath.
export function shopSvg(stock: readonly ItemId[] | null, meta: Meta, xp: number, gold: number): string {
  const owned = (Object.keys(WARES) as ItemId[]).filter(id => meta[id] > 0)
  const h = 88 + (owned.length ? 24 : 0)
  const goods = GOOD_IDS.map((id, i) => {
    const x = 24 + i * 32
    const { name, does, price, icon } = GOODS[id]
    return tip(
      `${name}: ${does}. ${price} gold, this run only`,
      firstFrame(icon, x, 64) + say(String(i + 4), x - 3, 65, 'w') + sayMid(`${price}G`, x + 8, 80, gold >= price ? 'y' : 'r'),
    )
  })
  const wall = new Map<string, string>()
  for (let y = 0; y < 2; y++) for (let x = 0; x < ROOM_W; x++) addRuns(wall, SPRITES['crypt_wall']?.[0] ?? [], x * T, 10 + y * T)
  const shelf = (stock ?? []).map((id, i) => {
    const x = 24 + i * 32
    const price = priceOf(id, meta)
    const lv = `${meta[id] + 1}/${WARES[id].max}`
    return tip(
      `${WARES[id].name} ${lv}: ${WARES[id].does}. ${price} XP`,
      sayMid(lv, x + 8, 19, 'e') + firstFrame(ICON[id], x, 26) + say(String(i + 1), x - 3, 27, 'w') + sayMid(`${price}XP`, x + 8, 49, xp >= price ? 'y' : 'r'),
    )
  })
  const body = [
    `<rect width="${SCENE_W}" height="${h}" fill="${INK}"/>`,
    layerSvg(wall),
    `<rect width="${SCENE_W}" height="10" fill="${INK}"/>`,
    say('SHOP', 3, 3, 'y'),
    tip(`${xp} XP to spend`, say(`${xp} XP`, SCENE_W - 3 - textWidth(`${xp} XP`), 3, 'c')),
    tip('The shopkeeper', flip(animated('skeleton_idle', 0, 26), 0)),
    `<rect y="42" width="${SCENE_W}" height="4" fill="${hex('o')}"/><rect y="42" width="${SCENE_W}" height="1" fill="${hex('y')}"/><rect y="45" width="${SCENE_W}" height="1" fill="${hex('p')}"/>`,
    stock === null ? sayMid('STOCKING...', 64, 32, 'e') : stock.length === 0 ? sayMid('SOLD OUT', 64, 32, 'r') : shelf.join(''),
    tip(`${gold} gold to spend this run`, say('GOLD', 3, 64, 'e') + say(String(gold), 3, 72, 'y')),
    goods.join(''),
    owned.length
      ? say('OWNED', 3, 90, 'e') +
        owned.map((id, i) => tip(`${WARES[id].name} ${meta[id]}/${WARES[id].max}: ${WARES[id].does}`, firstFrame(ICON[id], i * 16, 96) + say(String(meta[id]), i * 16 + 12, 107, 'w'))).join('')
      : '',
  ]
  return svg(SCENE_W, h, body.join(''))
}
