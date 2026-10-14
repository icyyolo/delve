# Claude's Depths — PLAN

Pixel-art roguelite dungeon crawl in a Claude Code desktop pane. Goal: keep attention on
Claude Code (fun first, focus later). Plugin name: `delve` (plugin names may not start with `claude-`).

## Locked spec

**Surface / look**
- Desktop app only. Pane auto-opens on `session.start`; `/delve` reopens, `/delve off` disables.
- Pixel art via `Svg`: per-color `<path>` runs, animated with SMIL inside `isInteractive` Svg.
  **No clock-driven redraws** (they flip the cursor between text/click mode). Pane redraws only on
  game events (hit, loot, turn end). One-shot effects = new Svg source with SMIL `begin=0`.
- 16×16 sprites, palette-indexed JSON grids, shared 16-color palette, frames for animation.
- No sound (dropped by user 2026-10-13).
- Pane UI (step 12): the game is drawn, not written. Scene Svg holds a HUD (top: up to 5 hearts + HP
  number, gold; bottom: weapon icon, spell stars, floor tag, torch %), HP bars over monster and
  doppelganger, and SMIL one-shots: slash arc, damage numbers (white, yellow heavy, red taken, green
  heal), heavy-hit flash + shake, kill burst, coin flying to the HUD, FLOOR banner. Turn end = frozen
  room (desaturated, idles still, YOUR MOVE board, 5-min torch fuse bar). Dead = YOU FELL board.
  `<title>` tooltips on hero, monster, ally, rival, loot, HUD parts. 3x5 pixel font + mini icons are
  in `hooks/scene.ts`. Text = one line (event note, else Haiku line). Buttons have hotkeys: A attack,
  1-3 grab / buy, S shop, N new run, B back. Quests = parchment Svg; shop = counter Svg with
  shopkeeper, wares, prices (red when short), owned row. Every Svg alt carries the full text.

**Game loop**
- Tool turns = combat. Energy from tool calls; soft cap 20/turn, overflow → XP. Energy + XP show in
  the status line (`$.ui.status`), not the pane, so tool calls never redraw the pane.
- Q&A turns (no tools) = AFK farm: no tool call 3 s into a turn → hero farms; a loot drop every 5 s
  (coin = gold, XP gem = +3 XP, potion = +2 HP), each a Grab button for 3 s.
- Turn end: current action resolves, then freeze. Momentum bonus only if read gate passes
  (time on reply, scaled by its length).
- Torch timer after turn end: drift > 5 min → one ambush (free monster hit), torch then "out".
  Status line: `Depths · energy E · XP X · torch Nm` (updates once a minute while frozen).
- Freeze: turn end locks Attack/Grab, clears loot; turn start unlocks. Read gate: read time =
  words ÷ 250 wpm ÷ 2, clamped 3 s–2 min; next prompt after it and before torch out → +3 energy.

**Combat** (`hooks/combat.ts`, pure)
- Attack button costs 1 energy (none → toast). Hit 1, crit 2 (20%). Survivor hits back 50% for its atk.
- Kill: +gold, +1 HP, next floor, new monster from the floor's pool (slime/bat 1+, skeleton 3+,
  wraith 5+, mimic 6+, golem 8+; HP +1 per 2 floors). Biome flips every 5 floors.
- HP 0 → dead pose + "New run" button. Last blow plays once via SMIL (swing, flinch, counter).

**Progression**
- One class: Warrior.
- Roguelite: run persists across sessions until death.
- Meta shop (`hooks/shop.ts`): XP buys permanent wares via `/delve shop` (list) and `/delve buy <id>`.
  Upgrades (price base × (level+1)): Vitality +2 max HP (5 lv, 10), Whetstone +10% crit (3 lv, 15),
  Shield -10% counter (3 lv, 15). Unlocks: blue potion loot +2 energy (20), loot bag 5-8 gold (20),
  Heap Caverns biome (40; locked = crypt forever), Deep dwellers mimic + golem (50; locked = absent).
  RNG stock: Haiku picks 3 for-sale wares + a pitch at each New run (first `/delve shop` if none),
  8 s timeout; reply held to the list, gaps/failure filled by dice + pitch table. Bought ware leaves
  the shelf until next run. Vitality also lifts the living hero at once.
- Shop GUI (in the Depths pane): a Shop button swaps the scene for the shop view (XP, pitch, one row per
  ware: sprite icon, name, next level/max, effect, Buy button dim when unaffordable; Owned line; Back).
  Icons reuse sprites: heart_full, sword, shield, potion_blue, loot_bag, caverns_wall_alt, mimic_idle.
  `/delve shop` turns the pane to the shop and still prints the text list. Buy result shows as a toast.
- Claude elements (`hooks/claude.ts`, step 11):
  - Subagents, mixed sides: a fork is a rival doppelganger (flipped warrior before the monster, HP by
    model: Opus 10, Sonnet 7, Haiku 4, else 6). It strikes the hero 1 per 4 of its tool calls, never
    below 1 HP. Attack hits it first; beating it pays gold + XP = its max HP. If its run ends first, it
    walks off. Any other subagent is an ally (Explore bat, Plan wraith, general-purpose skeleton, else
    mimic; flipped, behind the hero). When its run ends it strikes the monster for 1 + 1 per 3 of its
    calls (max 6). Subagent tool calls no longer give the hero energy.
  - Weapon = Claude's last tool: Edit/Write/NotebookEdit sword (+1 damage), Bash/PowerShell hammer (sure
    crit; a failed command drops to fists), Read/Grep/Glob bow (no hit back), WebFetch/WebSearch portal
    (each swing drops loot). Other tools keep the weapon. An MCP call summons a familiar: 1 free hit.
  - Compaction (main conversation, not `precompute`): quake, hero drops a floor, room shakes once.
  - Context fill, read at each turn end: torch dims past 50%, up to 80% dark at 100%.
  - Turn end: Esc = flee and drop a quarter of the gold; error = trap -1 HP (never fatal); refusal =
    monster +2 HP.
  - Skill (`skill.prompt`, typed or via the Skill tool) = spell: next 3 swings cost no energy.
  - Quest board = Claude's own todo list (TodoWrite, or TaskCreate/TaskUpdate); each item finished pays
    5 gold + 3 XP. Only shows where Claude has a todo tool.
- One active dungeon; other sessions feed energy/loot into it.

**Flavor text**
- Haiku (`$.model.complete({ model: "haiku" })`) line per room/monster, cap 200 calls/day (flavor + shop),
  hand-written table fallback on timeout/cap.
- Built (`hooks/flavor.ts`): room = floor + monster. Line asked on session start, each kill (new floor)
  and New run; 4 s timeout; first line of reply, quotes stripped, <= 120 chars, else table (3 lines per
  monster). Shown italic under the pane title; saved in store. Daily cap counts every Haiku call (flavor
  + shop) per UTC day in store `haiku`; past it, no call. Line for a room already left is dropped.
- Optional: Sonnet for rare boss/floor intros.

**Model routing (build time)**
- Sprite subagents: Sonnet. Review, integration, mod code: Opus (main session).

**Verification**
- Computer-use screenshots; fallback: user screenshots.
- Sprite preview page. `claude plugin validate`, `tsc -p`, `claude plugin test`.

## Checkpoints

| # | Step | Check | Status |
|---|---|---|---|
| 0 | Render test: animated sprite (paths vs PNG data-URI vs SMIL) in pane | User confirmed all 3 animate; clock redraws flicker cursor, so SMIL chosen | done |
| 1 | Palette + style brief; 4 Sonnet sprite subagents (hero, monsters, 2 biome tilesets, items/HUD); preview page | `node tools/sprites.mjs check` passes all groups; user approves `assets/preview.html` | done |
| 2 | Skeleton: auto-open, `/delve`, `/delve off`, state contract | validate + tsc pass; pane opens | built, awaiting pane screenshot |
| 3 | Event mapping, energy soft cap, AFK farm loot clicks | Energy rises live; stops at cap; loot clickable on Q&A turn | built, awaiting live check |
| 4 | Combat, death, run persistence | Kill monster; run survives restart; death → new run | built, awaiting live check |
| 5 | Freeze + read gate, torch timer, status-line HUD | Buttons lock at turn end; ambush after 5 min | built, awaiting live check |
| 6 | Meta shop: upgrades + unlocks | Upgrade survives death | built, awaiting live check |
| 7 | Haiku flavor, daily cap, table fallback | Line per room; forced timeout shows table line | built, awaiting live check |
| 8 | ~~SFX wired to events~~ | no sound | dropped |
| 10 | Shop GUI in the pane | Shop button opens wares with icons; Buy works; Back returns | built; 30 tests pass; layout mock shot; live pane shot pending (user) |
| 11 | Claude elements: subagent allies/doppelganger, tool weapons, compaction quake, context torch, turn-end events, skill spells, todo quests | Ally strikes on finish; fork duel won by Attack; each event changes the run as specced | built; 40 tests pass; scene gallery shot; live pane shot pending (user) |
| 12 | Pane UI overhaul: HUD + effects in the Svg, frozen overlay, tooltips, hotkey toolbar, quest parchment, shop shelf | Text cut to one line; tests read the Svg alt; gallery of each state | built; 40 tests pass; gallery shot; live pane shot pending (user) |
| 9 | Tests, validate, final screenshot pass | All pass; screenshots of each state | tests/validate/tsc/sprites pass; scene gallery shot; live pane screenshots pending (user) |

## Definition of done
- Session starts → pane opens by itself.
- Tool turn: hero + monster animate, energy rises and stops past cap, Attack kills monster,
  Haiku line appears.
- Q&A turn: loot drops clickable.
- Turn end: game freezes, torch timer starts.
- Hero death → new run, meta upgrades kept.
- Everything survives restart.
- validate + tests pass; screenshots show each state.

## Log
- 2026-10-13: Spec + DoD approved. Checkpoint 0 started.
- 2026-10-13: Mod renamed `delve` (validator reserves `claude-*`). Pane loads + renders. Issue: cursor flips text/click mode while pane open; suspect 4 fps clock redraws. Added pause-redraw toggle to confirm.
- 2026-10-13: Checkpoint 0 done. Pausing clock stopped flicker; paths, PNG-in-SVG and SMIL all animate. Chose SMIL + event-only redraws. Sound dropped from scope. Spike stripped to SMIL slime only.
- 2026-10-13: Checkpoint 1 started. Files: assets/palette.json (Sweetie 16), assets/manifest.json (required sprites + frame counts), assets/STYLE.md (brief), tools/sprites.mjs (check = validate + PNG contact sheets/scenes; preview = SMIL HTML). 4 Sonnet artists launched.
- 2026-10-13: Checkpoint 1 built. All 4 groups pass `sprites.mjs check` (49 sprites); `hooks/sprites.gen.ts` rebuilt; preview.html served on 127.0.0.1 and screenshotted. Artist doubts: warrior_dead thin, wraith blobby, mimic barely faces left, loot bag orange (no brown in palette).
- 2026-10-13: Checkpoint 2 built: validate + tsc pass, 5 tests pass; user ran `/delve on|off` live ("Into the depths." / off message).
- 2026-10-13: User chose order 3 then 4. Checkpoint 3 built: state split into run (pane), purse {energy, xp, gained} (status line only), mode idle/combat/farm, loot[]. Hooks: turn.start resets per-turn count + 3 s farm timer; tool.call (fail-open `.catch`) sets combat, +1 energy after the call; turn.complete (main loop) sets idle. Scene draws warrior_farm + loot sprites; HUD = hearts + coin. 8 tests pass (energy cap, farm drop/grab/fade, tool call blocks farm).
- 2026-10-13: Sprites approved by user; checkpoint 1 done.
- 2026-10-13: Checkpoint 4 built. combat.ts (stats, attack, spawn, biomeFor, newRun). Run + purse written to $.store on every change, loaded at session.start (old saves merged over newRun defaults). Scene: actor() one-shots via SMIL display sets; dead pose; blow log line. 14 tests pass (kill, death, biomes, Attack no-energy toast + hit, New run, store restore). Hit sequence checked frozen at 0.1/0.4/1.0/2.0 s in browser; biggest scene 54k chars < 131k. Checkpoint 3 still lacks live screenshots.
- 2026-10-13: Checkpoint 5 built. rest atom {endedAt, readMs, isOut} set at turn.complete; torch timers (every 60 s status, after 5 min ambush) re-armed on session.start after reload; turn.start ends rest (momentum check) and sets combat so Attack unlocks immediately. combat.ts: ambush(), readMsFor(). Scene: ambush plays hero flinch only. 17 tests pass (freeze, torch countdown + single ambush, momentum skim/read/burnt-out).
- 2026-10-13: Checkpoint 6 built. User chose XP currency, `/delve shop` + `/delve buy` commands, Haiku-picked RNG stock. meta atom + store; combat takes meta (crit, counter, max HP, caverns/deep locks). New run restocks. 22 tests pass (locks, upgrades, Haiku pick sanitising, buy + survive death, Haiku failure -> dice).
- 2026-10-13: Checkpoint 7 built. flavor.ts (table, roomOf, flavorPrompt, readLine, dayOf); askHaiku() shared by shop + flavor with UTC daily cap; flavor atom + store; pane line under title. Optional Sonnet boss intros skipped. 26 tests pass (reply parsing, Haiku line on kill, timeout -> table, cap -> no call).
- 2026-10-13: Checkpoint 9 pass 1. tsc clean, validate passed, sprites check passed, 27 tests pass (added restart test: meta, shop, flavor restored, no Haiku call). Scene gallery (7 states rendered by the mod's own sceneSvg/hudSvg) screenshotted in browser: combat, hit, kill, farm + shop loot, ambush, dead, caverns golem at Vitality 2. Open: HUD hearts widen with Vitality (14 HP = 432 px, 20 HP = 576 px) and may not fit the pane; spec item "one active dungeon, other sessions feed it" never had a checkpoint and is unbuilt (concurrent sessions last-write-wins on the store). Live desktop pane screenshots for 2-7 still needed from user.
- 2026-10-13: Checkpoint 10 (user ask: shop GUI). User chose: shop view inside Depths pane, reuse existing sprites as icons, `/delve shop` opens view + prints text. Added view + shop atoms (shop loaded from store at start), changeShop, openShop, buyFromPane (toast), iconSvg, ICON, ownedOf. Shop view alone reads purse, so tool calls redraw only while it is open. Tests: 30 pass (icons exist; Shop -> Buy -> Back; /delve shop sets view). Two older tests now press Back after /delve shop. tsc clean, validate passed. Layout mock (mod icon + shop code, HTML stand-in for Box/Button) screenshotted.
- 2026-10-13: Checkpoint 11 (user ask: Claude elements; chose mixed sides plus ideas 1, 2, 3, 4, 7, 8). New `hooks/claude.ts` (pure rules). combat.ts: Edge, swingDamage, strike (no counter), slay extracted. Blow gains isEvent/isQuake/atRival/note. Atoms: weapon, fighters, tally (pane never reads it), spell, quests, context. Hooks: tool.call splits on agentId; new agent.spawn, session.compact, skill.prompt (all fail-open `.catch`); turn.complete settles subagents, applies the turn-end reason, reads `$.session.usage()`. Scene: flipped ally/rival, quake shake, radial torch shade. 40 tests pass (3 runs). tsc clean, validate passed. Scene gallery (9 states) screenshotted; torch radius tightened after the first shot looked too faint. Desktop session check: Claude here exposes no TodoWrite/TaskCreate tool, so quests stay empty in this session.
- 2026-10-13: Checkpoint 12 (user ask: "UI has too many words, make it a 2D minigame"; user said implement all proposed). scene.ts: 3x5 pixel font, mini icons (hearts, coin, star, torch, 5 weapons), HUD rim, HP bars with drain, popups, slash, puff, coin fly, banners, frozen filter + fuse, YOU FELL, tooltips, hover brighten; questsSvg, shopSvg; hudSvg removed. BIOME_NAME + LOOT_NAME moved to scene.ts. register.tsx: pane = scene Svg, one text line (noteLine: notes, ambush, death; plain hits/kills now only drawn), hotkey Buttons, quests Svg, shop Svg + pitch + Buy buttons. Tests: moved-text checks now read Svg alt (`pictured`); added: plain hit leaves no text line, Attack hotkey "a", frozen filter + full 300 s fuse, fullest HUD/kill/frozen/quest/shop sizes under the limit (biggest scene 91k chars of 131k). 40 tests pass, tsc clean, validate passed. Gallery (13 states, SMIL paused at set times) screenshotted; empty hearts recoloured grey after the first shot (invisible on the HUD). Energy pips not drawn: the pane must not read the purse (tool calls would redraw it). Loot buttons over the sprites skipped: Box offsets are character cells, cannot line up with pixel sprites.
- 2026-10-14: Haiku daily cap lowered 10,000 -> 200 (user ask; normal play makes dozens of calls a day, past the cap the tables answer).
- 2026-10-14: Marketplace: `.claude-plugin/marketplace.json` in the GitHub repo (owner icyyolo, source "./"); README install is `/plugin install delve --marketplace icyyolo/delve`, source checkout kept as the dev path.
