// Sprite tooling. Run from anywhere:
//   node tools/sprites.mjs check [group...]   validate + write PNG contact sheets to assets/preview/
//   node tools/sprites.mjs preview            validate all + write assets/preview.html (SMIL-animated)
//   node tools/sprites.mjs build              write hooks/sprites.gen.ts (valid sprites only) for the mod
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'assets')
const OUT = join(ASSETS, 'preview')
const palette = JSON.parse(readFileSync(join(ASSETS, 'palette.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
const HEX = Object.fromEntries(Object.entries(palette.colors).map(([k, v]) => [k, v.hex]))
const N = manifest.size

function load(group) {
  const file = join(ASSETS, 'sprites', `${group}.json`)
  if (!existsSync(file)) return { error: `missing file assets/sprites/${group}.json` }
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (err) {
    return { error: `invalid JSON: ${err.message}` }
  }
}

function lastRow(grid) {
  for (let y = N - 1; y >= 0; y--) if (/[^.]/.test(grid[y])) return y
  return -1
}

// Returns a list of problems; empty = pass.
function check(group) {
  const spec = manifest.groups[group]
  const { data, error } = load(group)
  if (error) return [error]
  const problems = []
  const sprites = data.sprites ?? {}
  for (const name of Object.keys(sprites)) {
    if (!(name in spec.sprites)) problems.push(`${name}: not in manifest (extra sprite)`)
  }
  for (const [name, want] of Object.entries(spec.sprites)) {
    const s = sprites[name]
    if (!s) { problems.push(`${name}: missing`); continue }
    const frames = s.frames
    if (!Array.isArray(frames) || frames.length !== want) {
      problems.push(`${name}: needs ${want} frame(s), has ${Array.isArray(frames) ? frames.length : 'none'}`)
      continue
    }
    frames.forEach((grid, f) => {
      const at = `${name} frame ${f}`
      if (!Array.isArray(grid) || grid.length !== N) return problems.push(`${at}: needs ${N} rows, has ${grid?.length}`)
      grid.forEach((row, y) => {
        if (typeof row !== 'string' || row.length !== N) problems.push(`${at} row ${y}: needs ${N} chars, has ${row?.length}`)
        else for (const ch of row) if (ch !== '.' && !HEX[ch]) problems.push(`${at} row ${y}: '${ch}' not in palette`)
      })
      const flat = grid.join('')
      const colors = new Set(flat.replace(/\./g, ''))
      const isProp = (spec.props ?? []).includes(name)
      if (spec.kind === 'tile' && !isProp && flat.includes('.')) problems.push(`${at}: tiles must be fully opaque (no '.')`)
      if (spec.kind === 'actor') {
        if (!flat.includes('k')) problems.push(`${at}: actors need a 'k' outline`)
        if (lastRow(grid) < 14 && !name.startsWith('bat')) problems.push(`${at}: actors stand on the floor (lowest pixel row must be 14 or 15)`)
      }
      if (colors.size < 3) problems.push(`${at}: uses only ${colors.size} color(s); need >= 3 for shading`)
    })
    if (frames.length > 1 && new Set(frames.map(g => g.join(''))).size < frames.length) {
      problems.push(`${name}: animation frames are identical`)
    }
  }
  return problems
}

// --- PNG writing (contact sheets for visual self-review) ---

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 4) }
  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.px.set([r, g, b, 255], (y * this.w + x) * 4)
  }
  checker(x0, y0, w, h, cell = 4) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      this.set(x0 + x, y0 + y, ((x / cell | 0) + (y / cell | 0)) % 2 ? [58, 58, 64] : [44, 44, 50])
    }
  }
  sprite(grid, x0, y0, scale) {
    grid.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.' || !HEX[ch]) return
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) this.set(x0 + x * scale + dx, y0 + y * scale + dy, rgb(HEX[ch]))
    }))
  }
  save(file) { writeFileSync(file, png(this.w, this.h, this.px)) }
}

function sheet(group) {
  const { data } = load(group)
  if (!data?.sprites) return null
  const names = Object.keys(manifest.groups[group].sprites).filter(n => data.sprites[n]?.frames)
  const S = 6, CELL = N * S, GAP = 6
  const cols = Math.max(...names.map(n => data.sprites[n].frames.length))
  const c = new Canvas(GAP + cols * (CELL + GAP), GAP + names.length * (CELL + GAP))
  c.checker(0, 0, c.w, c.h, 8)
  names.forEach((name, row) => data.sprites[name].frames.forEach((grid, col) => {
    if (Array.isArray(grid)) c.sprite(grid.map(r => String(r).padEnd(N, '.').slice(0, N)), GAP + col * (CELL + GAP), GAP + row * (CELL + GAP), S)
  }))
  const file = join(OUT, `${group}.png`)
  c.save(file)
  return { file, names }
}

// A 7x4-tile room per biome: two wall rows, a floor row, with hero and slime if drawn.
function scene(biome) {
  const all = Object.fromEntries(Object.keys(manifest.groups).map(g => [g, load(g).data?.sprites ?? {}]))
  const t = name => all.tiles[`${biome}_${name}`]?.frames?.[0]
  if (!t('floor') || !t('wall')) return null
  const S = 4, T = N * S, W = 7, H = 4
  const c = new Canvas(W * T, H * T)
  const wallRow = ['wall', 'wall', 'wall', 'door', 'wall', 'wall_alt', 'stairs']
  for (let y = 0; y < 3; y++) for (let x = 0; x < W; x++) {
    const name = y === 2 ? wallRow[x] : x === 2 && y === 0 ? 'wall_alt' : 'wall'
    c.sprite(t(name) ?? t('wall'), x * T, y * T, S)
  }
  for (let x = 0; x < W; x++) c.sprite(t('floor'), x * T, 3 * T, S)
  if (t('torch')) { c.sprite(t('torch'), 1 * T, 1 * T, S); c.sprite(t('torch'), 5 * T, 1 * T, S) }
  if (t('chest_closed')) c.sprite(t('chest_closed'), 6 * T, 3 * T - 2 * S, S)
  const hero = all.hero.warrior_idle?.frames?.[0]
  const foe = all.monsters.slime_idle?.frames?.[0]
  if (hero) c.sprite(hero, 1 * T, 2 * T + 4 * S, S)
  if (foe) c.sprite(foe, 4 * T, 2 * T + 4 * S, S)
  const file = join(OUT, `scene_${biome}.png`)
  c.save(file)
  return file
}

// --- HTML preview (SMIL, same technique the mod uses) ---

function paths(grid) {
  const by = new Map()
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x]; let n = 1
      while (row[x + n] === ch) n++
      if (ch !== '.' && HEX[ch]) by.set(ch, (by.get(ch) ?? '') + `M${x} ${y}h${n}v1h-${n}z`)
      x += n
    }
  })
  return [...by].map(([ch, d]) => `<path fill="${HEX[ch]}" d="${d}"/>`).join('')
}
function svg(frames, px, ms = 300) {
  const groups = frames.map((g, i) => frames.length === 1 ? paths(g)
    : `<g visibility="${i ? 'hidden' : 'visible'}"><animate attributeName="visibility" values="${frames.map((_, j) => (i === j ? 'visible' : 'hidden')).join(';')}" dur="${(ms * frames.length) / 1000}s" calcMode="discrete" repeatCount="indefinite"/>${paths(g)}</g>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N * px}" height="${N * px}" shape-rendering="crispEdges">${groups}</svg>`
}

function preview() {
  const parts = []
  for (const group of Object.keys(manifest.groups)) {
    const { data } = load(group)
    const problems = check(group)
    parts.push(`<h2>${group} <small class="${problems.length ? 'bad' : 'ok'}">${problems.length ? `${problems.length} problem(s)` : 'valid'}</small></h2>`)
    if (problems.length) parts.push(`<pre class="bad">${problems.slice(0, 20).join('\n')}</pre>`)
    if (!data?.sprites) continue
    parts.push('<div class="grid">')
    for (const name of Object.keys(manifest.groups[group].sprites)) {
      const frames = data.sprites[name]?.frames
      if (!Array.isArray(frames)) continue
      parts.push(`<figure>${svg(frames, 5)}<figcaption>${name}</figcaption></figure>`)
    }
    parts.push('</div>')
  }
  const scenes = ['crypt', 'caverns'].map(b => [b, scene(b)]).filter(([, f]) => f)
  if (scenes.length) {
    parts.push('<h2>scenes</h2><div class="grid">')
    for (const [b] of scenes) parts.push(`<figure><img src="preview/scene_${b}.png" style="image-rendering:pixelated"><figcaption>${b}</figcaption></figure>`)
    parts.push('</div>')
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Depths sprites</title>
<style>body{background:#16171d;color:#e8e8ee;font:14px system-ui;margin:24px}h2{margin:28px 0 8px}small{font-size:12px;font-weight:400}
.ok{color:#a7f070}.bad{color:#ef7d57}.grid{display:flex;flex-wrap:wrap;gap:14px}figure{margin:0;background:repeating-conic-gradient(#2c2c32 0 25%,#3a3a40 0 50%) 0 0/16px 16px;padding:8px;border-radius:6px}
figcaption{font-size:11px;text-align:center;margin-top:4px;color:#c8c8d0}pre{white-space:pre-wrap}</style>
<h1>Claude's Depths: sprites</h1>${parts.join('\n')}`
  writeFileSync(join(ASSETS, 'preview.html'), html)
  console.log('wrote', join(ASSETS, 'preview.html'))
}

// The mod cannot import JSON, so sprites ship as a generated module.
function build() {
  const sprites = {}
  for (const group of Object.keys(manifest.groups)) {
    const problems = check(group)
    if (problems.length) console.log(`[${group}] ${problems.length} problem(s); building what is valid`)
    const s = load(group).data?.sprites ?? {}
    for (const name of Object.keys(manifest.groups[group].sprites)) {
      const frames = s[name]?.frames
      const ok = Array.isArray(frames) && frames.every(g => Array.isArray(g) && g.length === N && g.every(r => typeof r === 'string' && r.length === N && [...r].every(ch => ch === '.' || HEX[ch])))
      if (ok) sprites[name] = frames
    }
  }
  const file = join(ROOT, 'hooks', 'sprites.gen.ts')
  writeFileSync(file, `// GENERATED by \`node tools/sprites.mjs build\` from assets/. Do not edit.

export const PALETTE: Readonly<Record<string, string>> = ${JSON.stringify(HEX)}

export const SPRITES: Readonly<Record<string, readonly (readonly string[])[]>> = ${JSON.stringify(sprites)}
`)
  console.log(`wrote ${file} (${Object.keys(sprites).length} sprites)`)
}

mkdirSync(OUT, { recursive: true })
const [cmd = 'check', ...args] = process.argv.slice(2)
if (cmd === 'preview') preview()
else if (cmd === 'build') build()
else {
  const groups = args.length ? args : Object.keys(manifest.groups)
  let failed = false
  for (const group of groups) {
    if (!manifest.groups[group]) { console.log(`unknown group ${group}`); failed = true; continue }
    const problems = check(group)
    const made = sheet(group)
    console.log(`\n[${group}] ${problems.length ? `FAIL (${problems.length})` : 'PASS'}`)
    for (const p of problems.slice(0, 40)) console.log('  - ' + p)
    if (made) console.log(`  contact sheet: ${made.file}\n  rows top to bottom: ${made.names.join(', ')}`)
    if (group === 'tiles') for (const b of ['crypt', 'caverns']) { const f = scene(b); if (f) console.log(`  scene: ${f}`) }
    failed ||= problems.length > 0
  }
  process.exit(failed ? 1 : 0)
}
