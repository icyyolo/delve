# Claude's Depths — sprite style brief

Shared by every sprite artist. Read it fully before drawing.

## The game
Pixel-art roguelite dungeon crawl that lives in a side pane of the Claude Code desktop app.
A lone **Warrior** fights programming-themed monsters (TypeError Slime, NullPtr Bat, Stack
Skeleton, ENOENT Wraith, Segfault Golem, Merge-Conflict Mimic) in two biomes:
**Stack Crypt** (cold grey-blue stone dungeon) and **Heap Caverns** (mossy green/teal cave,
earthy, roots and crystals). Tone: cute-but-dangerous, readable at a glance, classic 16-bit.

## Scene layout (side view, like a JRPG battle)
- Room = rows of 16×16 tiles: back wall rows, then one floor row along the bottom.
- Hero stands on the left **facing right**. Monsters stand on the right **facing left**.
- Actors are drawn standing on the floor line: feet / base on pixel row 14 or 15.
- Displayed at 5–6× scale, so every single pixel shows. No noise, no stray pixels.

## File format
One JSON file per group at `assets/sprites/<group>.json`:

```json
{
  "sprites": {
    "slime_idle": {
      "frames": [
        ["................", "...16 strings of 16 chars each..."],
        ["second frame ..."]
      ]
    }
  }
}
```

- Each frame: exactly **16 strings**, each exactly **16 characters**.
- Each character is one palette key from `assets/palette.json`, or `.` for transparent.
- Sprite names and frame counts must match `assets/manifest.json` exactly. No extras.

## Palette (Sweetie 16). Use only these keys
| key | hex | use |
|---|---|---|
| `k` | #1a1c2c | outline / near-black |
| `p` | #5d275d | deep purple, shadow of reds |
| `r` | #b13e53 | red, blood, hearts |
| `o` | #ef7d57 | orange, fire, skin shadow |
| `y` | #ffcd75 | yellow, gold, skin, flame core |
| `l` | #a7f070 | lime, highlight of greens |
| `g` | #38b764 | green |
| `t` | #257179 | teal, shadow of greens/cyans |
| `n` | #29366f | navy, deep shadow |
| `b` | #3b5dc9 | blue |
| `s` | #41a6f6 | sky blue |
| `c` | #73eff7 | cyan, magic, energy glow |
| `w` | #f4f4f4 | white, specular, bone highlight |
| `e` | #94b0c2 | light grey, steel, bone |
| `m` | #566c86 | mid grey, stone |
| `d` | #333c57 | dark slate, stone shadow |

## Rules
1. **Outline**: actors, props and icons get a 1-px `k` outline around the silhouette.
   Tiles do not need one.
2. **Light from the top-left.** Each material gets 2–4 shades: highlight, base, shadow,
   and optionally deep shadow. Example ramps: green `l > g > t > n`, stone `e > m > d > k`,
   gold `w > y > o > p`, red `o > r > p > k`.
3. No anti-aliasing, no dithering noise, no single orphan pixels. Clean clusters.
4. Silhouettes must read at 1× size. Exaggerate key features: big eyes, big weapon, chunky shapes.
5. **Animation**: 2-frame idles are a subtle bob, breath or flap. Shift 1 px or squash and
   stretch; do not redraw the whole thing. Keep the base or feet planted, except for the
   flying bat. `_hurt` = flinch pose plus a flash (lighter or white-tinted body, `w` highlights).
6. **Tiles** (floor, wall, wall_alt, door, stairs) are fully opaque (no `.`). They must tile
   seamlessly left-to-right with themselves and with each other. Wall and floor read clearly
   as different planes: floor brighter on its top edge, walls with brick/rock seams.
7. Props (torch, chest) are drawn over a wall or floor tile, so they use transparency.
8. Icons are centred, chunky and readable at 1×. They fill most of the 16×16.

## Reference: an acceptable slime (style level to match or beat)
```
................
................
................
................
................
......kkkk......
....kkggggkk....
...kglggggggk...
..kglwgggggggk..
..kggggggggggk..
.kggwnggggwnggk.
.kggnnggggnnggk.
.kggggggggggggk.
.kgggggkkgggggk.
..kkggggggggkk..
....kkkkkkkk....
```

## Self-check loop (required)
1. Write your JSON file.
2. Run `node tools/sprites.mjs check <group>` from the mod folder. Fix every problem it lists.
3. Open the contact-sheet PNG it prints (and the scene PNGs for tiles) with the Read tool
   and look at it critically. Is each sprite recognisable? Is it facing the right way?
   Is the shading consistent? Do the frames animate sensibly? Redraw anything weak.
4. Repeat until the check passes and you would be proud to ship it.
