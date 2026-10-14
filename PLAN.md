# Claude's Depths — PLAN

Pixel-art roguelite dungeon crawl in a Claude Code desktop pane. Goal: keep attention on
Claude Code (fun first, focus later). Mod folder: `dev-mods/<session>/delve/` (plugin names may not start with `claude-`). Canonical copy: this file. Vault mirror:
`Obsidian Vault Claude Scraping/Claude's Depths PLAN.md`.

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
  1-3 grab / buy, S shop, N new run, B back. Row 1 = Attack/New run + Shop, Grab buttons wrap below;
  a dim line under them says how to give the pane the keys. Quests = parchment Svg; shop = counter Svg with
  shopkeeper, wares, prices (red when short), owned row. Every Svg alt carries the full text.

**Game loop**
- Tool turns = combat. Energy from tool calls; soft cap 20/turn, overflow → XP. Energy + XP show in
  the status line (`$.ui.status`), not the pane, so tool calls never redraw the pane.
- AFK farm: 3 s with no tool call (Q&A turn, or a gap between calls; re-armed after every call) → hero
  farms; a loot drop every 4 s (coin = gold, XP gem = +3 XP, potion = +2 HP), each a Grab button for 7 s.
  Every kill also drops one.
- Turn end: current action resolves, then freeze. Momentum bonus only if read gate passes
  (time on reply, scaled by its length).
- Torch timer after turn end: drift > 5 min → one ambush (free monster hit), torch then "out".
  Status line: `Depths · energy E · XP X · torch Nm` (updates once a minute while frozen).
- Freeze: turn end locks Attack/Grab, clears loot (no drops while idle); turn start unlocks. With a recap to
  type the freeze is a typing duel: recap words still swing, the scene keeps colour and loops, no board, fuse
  only (time left drawn in 15 s steps so keystrokes redraw the same scene). Read gate: read time =
  words ÷ 250 wpm ÷ 2, clamped 3 s–2 min; next prompt after it and before torch out → +3 energy.

**Reply recap** (checkpoint 13, built)
- Main turn.complete (not subagents) builds a recap of `e.answer`: plain lines to type (≤20 words each, no code,
  no symbols; up to 3 summary lines, then the whole reply in order) + up to 3 key points, one short line each: questions to you, things you must do (a command,
  a restart), warnings/failures. Files changed come from this turn's Edit/Write/NotebookEdit tool calls
  (basenames, up to 3 + "N more"), not from the model.
- Haiku via askHaiku (same 200/day cap, `/delve haiku off`, timeout): reply trimmed to 4,000 chars, answers
  up to 3 `TYPE: ...` + up to 3 `KEY: ...` lines, sanitised (no backticks/code blocks, length caps). One call per
  turn, roughly 1.2k tokens in, ≤120 out; 0 tokens when off.
- Line order: Claude's own `TL;DR:` line when the reply has one (`/delve tldr on` asks for it through a
  prompt.compose section; no Haiku call then), else Haiku, else the fallback.
- Fallback (Haiku off, capped, timed out, unparseable): typed line = the best-scoring prose sentence
  (centrality, first/last paragraph, summary label or heading, done-words; minus code, paths, warnings,
  length; no questions or lead-ins; fragments join the next sentence), cut at a clause break past 20 words;
  key points = lines ending `?` or holding
  warning/error/failed/"you need to", max 3. Reply under 8 words → no typing round (key points still shown).
- Pane in the freeze and while Claude works: the line in a round-bordered card (border in the phase colour).
  Header: phase tag (SUMMARY n/3, REPLY n/m, PRACTICE n/all; bold, phase colour), one dot per line (green ≥90%,
  red short or skipped, hollow to come, the line here a bold dot in the phase colour; summary dots apart; at most 10
  dots, those near the line here, "…" for the rest, so a long reply never runs past the border), live "Y WPM · X% acc" on the right
  (finished words right; WPM after 2 s; read when a keystroke redraws, no clock). Body: the typer, a `Client`
  surface module (`hooks/typer.tsx`) that takes keys on the drawing thread and posts the whole text typed to a
  `ui.message` hook (posts for a line already left are dropped). Monkeytype rules: no input box, caret = inverse
  next letter in the line; a wrong letter stays red and the caret moves on; Backspace (Ctrl = whole word) mends
  only the current word, never a finished one; a space before a word starts does nothing; the line ends on its
  last word typed right, a space after it, or Enter (Enter on a line not started does nothing). Right letters
  bright, to come dim, extra letters dim red, a finished word with a slip underlined. Footer: what the line pays
  and "Skip line". Below the card: a ✓/✗ line for the last line's score and pay, then "Key points" in a dim
  round card (bullets as plain one-line Text, never code blocks).
  "summarising…" until the recap lands. Recap kept through the next turn (typeable mid-turn; the typer takes
  keys only once clicked, so the pane keys stay on the shop and loot) until the next reply's recap replaces it.
- Live lines mid-turn: with no reply lines left that pay (none yet, as in a session's first turn, or only
  practice), the typer turns LIVE: Claude's words between its tool calls (each `turn.step` of the main loop that
  calls a tool; the reply's own step, with no tool, is left to the recap), split as the reply's lines are. Words
  heard while the last reply's lines still pay wait in `heard` and come up once those are done. With nothing
  said, a LORE line from the room flavor table fills in; new words take an untouched lore line's place. Live and
  lore lines fight like recap lines but pay no energy or XP; lore leaves the Attack button up beside it. The live
  recap never runs out (no practice) and ends with the turn, before the reply's recap lands.
- Graded when the line ends, once per line, then the next line; "Skip line" moves on scoring 0. Accuracy = matched
  words ÷ target words; WPM from first keystroke to the line's end. Summary line 1 ≥90% → +2 energy (≥60 WPM → +1 XP too);
  lines 2–3 ≥90% → +1 energy. Whole-reply lines pay nothing alone; leaving the last with ≥90% average (skips 0)
  → +1 XP once. After that the lines cycle unpaid, best WPM shown. Skipping costs nothing. Adds on top of the +3 read-gate
  momentum (user choice). Reward told by toast: the pane still never reads the purse.

**Combat** (`hooks/combat.ts`, pure)
- Attack button costs 1 energy (none → weak swing: 1 dmg, no crit, no weapon; mid-turn regen +1/15 s up to 3). Hit 1, crit 2 (20%). Survivor hits back 50% for its atk.
- Typing is the attack: each recap word finished right (space, or the line's end for the last word) = one swing
  (spell/energy power, else weak 1) with no hit back; each word finished wrong = the monster's counter chance
  (50%, -10%/Shield level) for its atk, "Typo!" note. Words past the line's end count for nothing. Practice
  lines never fight (no swing, no counter), so retyping them farms nothing. The Attack button shows only mid-turn
  with no recap lines to fight with, none or only practice left (hint drops "A attack" while typing fights).
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
- Run goods + cash-out (`hooks/shop.ts` GOODS): the run's gold buys goods on a gold shelf under the XP
  wares, always stocked, used at once, gone with the run: Red potion +3 HP (6 gold; not sold at full HP),
  Scroll 3 free swings (10; stacks onto a spell), Key past the monster to the next floor, no gold or heal
  (12). Keys 4-6 in the shop, or `/delve buy potion|scroll|key`. The fallen buy nothing; New run turns the
  fallen run's gold to XP, 5 gold = 1 XP, with a toast. Icons reuse potion_red, scroll, key.
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
- Haiku (`$.model.complete({ model: "haiku" })`) line per room/monster, cap 200 calls/day (flavor + shop), `/delve haiku off` stops them,
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
| 13 | Reply recap typing round + key points | Freeze shows recap + key points; Haiku off → fallback line; ≥90% typed → +2 energy | built; 51 tests pass; live pane check pending (user) |
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
- 2026-10-14: `/delve haiku [on|off]` (user ask: toggle so the game spends no tokens). Bare `/delve haiku` flips; stored as `haikuOn` (default on) like `enabled`; askHaiku returns undefined first when off, so flavor uses the table and the shop rolls dice. Tests: toggle flips/stores, off = no model call on kill or shop (42 pass).
- 2026-10-14: Loot more often (user ask: drops were rare). Farm timer re-armed after every tool call, so any 3 s gap farms (was: only before the first call); drop every 4 s (was 5); drops last 7 s (was 3); every kill (hero or ally blow) drops one. Tests: farm-gap test replaces "tool call means no loot", kill-drop test, fade test checks the missed drop by id (43 pass).
- 2026-10-14: Weak swing + regen (user: running out of energy made the game unplayable). At 0 energy Attack still swings weak: 1 dmg, no crit, no weapon edge (Edge.isWeak in combat.ts), with a "Weak swing, no energy" note; no toast. Mid-turn (mode not idle) energy below 3 regens +1 per 15 s (REGEN_MS/REGEN_CAP, clock.every armed at session.start, not counted in `gained`). Attack label drops the energy cost (pane must not read the purse); shows (free) under a spell. Tests: weak-swing Attack test replaces the no-energy toast test, regen tick + cap + idle, weak portal swing pulls no loot.
- 2026-10-14: Button rows + key hint (user ask). Row 1 = Attack/New run + Shop (Box key "actions"); Grab buttons wrap in their own row below (Box key "loot", only with drops). Dim hint line from e.props.isFocused: unfocused "click the pane or press ctrl+x tab", focused "Keys on ... Esc back to the prompt" (hotkeys never fire from the prompt). Test: row contents + both hint states (46 pass).
- 2026-10-14: Reply recap planned, not built (user idea: Monkeytype-style typing of a summary of Claude's reply so the person knows what Claude said). User decisions: no code in the typed line; key points (questions to you, things you must do, warnings/failures, files changed) shown read-only in the pane; typing reward adds on top of momentum; plan only for now. Spec under "Reply recap", checkpoint 13.
- 2026-10-14: Reply recap plan: Haiku-off fallback skips lead-in sentences (ending in `:`, or under 4 words like "Done.") before picking the typed line (user ask).
- 2026-10-14: Checkpoint 13 built: reply recap (user ask). hooks/recap.ts (pure: hasRound, fallbackLine with lead-in skip and code-free preference, fallbackKeys, recapPrompt, readRecap, editedPath, fileList, score, marks). recap + edited atoms; tool.call notes Edit/Write/NotebookEdit paths; turn.complete runs summarise in the background (.catch: a failure shows none; a recap for a turn already replaced is dropped); turn.start clears both. Pane in the freeze: line drawn word by word (right green, wrong red, current word letter by letter), Input "recap-input" (autoFocus), key points + files changed; hint line adds "type the recap". Enter scores once: ≥90% +2 energy, ≥60 WPM +1 XP, toast either way. /delve haiku texts mention recaps. Fixed a pre-existing flaky test (weapon test seeded an 8-HP slime but never ran session.start, so a sword crit + familiar killed the default 4-HP slime ~20% of runs). 51 pass (8 runs in a row), tsc clean, validate passed. Live pane check pending (user).
- 2026-10-14: Recap fallback rework (user: the first-sentence fallback did not capture the reply). Line order now: Claude's own TL;DR line (tldrOf; `/delve tldr [on|off]`, stored `tldrOn`, default off, adds a `delve:tldr` session section via prompt.compose; no Haiku call when found) → Haiku → fallbackLine, now a scored pick: centrality (shared content words, weighted in only from 3+ sentences), first/last paragraph, summary label or heading, done-words cue, mid length; minus code/paths, warnings, >30 words; questions and lead-ins excluded, terse fragments join the next sentence, long picks cut at a clause break. TL;DR lines stay out of key points; `;` now typeable. Checked on three real replies from this session: picks are reasonable, not true summaries (README says so). Tests: scorer on realistic replies + fragment, TL;DR parse/keys, TL;DR reply skips Haiku, /delve tldr + compose section (55 pass).
- 2026-10-14: Recap typeable while Claude works too (user ask). turn.start no longer clears the recap; it stays (scored or not) until the next turn.complete's recap replaces it. Pane draws it in every mode; mid-turn the Input has no autoFocus (else the pane's A/S/1-9 keys would type into it), hint says "click the field to type the recap". An unfinished round is dropped when the new reply lands. Tests: the Haiku-off test now checks the scored recap survives the next prompt; new test types the last reply's line mid-turn (energy paid), then the new reply replaces it with autoFocus back. 56 pass (3 runs), tsc clean.
- 2026-10-14: Recap became a running game (user ask). Recap now holds `lines` (up to 3 summary lines = `top`, then restLines: the whole reply one sentence a line in reading order, long ones split at clause breaks via chunks/shorten, sentences that lose ≥1/3 to code/paths or <4 words skipped, summary lines not repeated), `at`, `accuracies`, `last`, `best`. Summary lines: TL;DR line / Haiku's up to 3 TYPE lines (prompt asks for 3, maxTokens 150→220), filled by rankedLines (the old fallback scorer, now returning every candidate best-first). Enter scores and advances; Skip line advances scoring 0. Pay: line 1 ≥90% +2 energy (+1 XP ≥60 WPM), lines 2–3 +1 energy each, leaving the last line with ≥90% average over the rest +1 XP once; then lines cycle unpaid with best WPM. Input now gets `value` (cleared on each new line). Checked on a real reply: queue reads in order, broken sentences dropped. Tests: topLines/restLines (gutted sentence skip, link kept, clause split, dedupe), readRecap multi-TYPE, full run-through test (pay, skip, XP bonus, unpaid cycle); existing recap tests moved to the new toasts. 58 pass (3 runs), tsc clean.
- 2026-10-14: Typing UI pass (user ask: suggestions 1, 2, 3, 5, 6, 7, and the field must always show the word being typed; it scrolled out of sight on long lines). recap.ts: marks now per letter (extra letters, missing letters in done words, caret part, a space caret once the word is typed); liveScore (finished-word accuracy, WPM after 2 s); wordNow/withWord (field holds one word; typed = done words + field). register.tsx: typeRecap/checkRecap join the field onto the done words; pane draws phaseOf tag + per-line dots + pay note, letter marks with inverse caret and struck extras, "So far" live line, Input value = current word, resultOf ✓/✗ line under Skip. Toasts unchanged. Tests: letter marks, field join, live score, a word-by-word pane test (field value per word, live stats, red letters, caret, dots, result line); recap tests moved to the new texts. 60 pass, tsc clean, validate passed. Live pane check pending (user): whether the desktop field takes the cleared value at each space is only proven in the test harness.
- 2026-10-14: Typing is the fight (user ask: auto attack on each word typed right instead of the Attack button; user said build). recap.ts: finishedWords (words finished between two typings, right or not, none past the line). combat.ts: counter (a typo: monster hits back at counter chance, shield lowers it). register.tsx: typeRecap and checkRecap (Enter finishes the field word) feed fight(): right word = swing($, isWord) (allowed in the freeze, no weak-swing note, isRanged so no hit back), wrong = counter. dropLoot skips while idle. Attack button and "A attack" hint only with no recap lines. Freeze scene with a recap: isFighting (colour, loops, no board or grey, fuse kept); fuse leftMs rounded up to 15 s steps so keystrokes between swings redraw an identical Svg source (no blow replay). Monster HP unchanged: tune after live play. Tests: finishedWords, counter, a pane fight test (weak swings 4>3>2, no hit back, wrong word no swing, Enter swings, identical scene across a keystroke 2 s later, no loot in freeze; it fails with the unrounded fuse), three recap tests moved (energy now spent by the words, no Attack mid-turn with a recap). 63 pass (3 runs), tsc clean, validate passed. Fighting-freeze scene screenshotted (colour, no board, fuse). Live pane check pending (user).
- 2026-10-14: UI revamp + Monkeytype typer (user ask: nicer UI; a wrong character must not move the cursor back, like Monkeytype). User picks: Monkeytype default Backspace (current word only); revamp everything below the scene (scene and shop art unchanged). New hooks/typer.tsx `Client` surface module: keys handled on the drawing thread (no round trip, no stale Input `value` resets), posts {id, typed, isDone} to a `ui.message` hook that runs typeRecap/checkRecap with the full text (id = recap id:at, stale posts dropped, data shape checked, 1000 chars max). Input field, withWord and wordNow removed. Pane: typer card (round border in phase colour; header tag + dots + live WPM/acc; footer pays + Skip), result line, Key points card, then the action/loot rows and a shorter hint ("click the words and type to attack"). Words now swing as they are typed, before the line pays (freeze test: 1 energy left, was 0). Tests: new Monkeytype test (space before a word ignored, Backspace cannot reopen a finished word, Ctrl+Backspace clears the word, a wrong letter stays, Backspace mends, red + underlined slip, caret, Enter on a line not started skips nothing); the typing tests drive the typer key by key via `ui.key`. 63 pass (6 runs), tsc clean, validate passed (surface modules: hooks/typer.tsx). Drawn tree dumped and checked. Live pane check pending (user): typer focus by click, paint of borders and caret.
- 2026-10-14: Recap card dots fix (user report: on a long reply the dots ran outside the round border). Cause: one dot per line, unbounded for the reply phase, in a row that cannot wrap. User pick: show only the dots near the line here + two glyphs only. Now at most DOTS_SHOWN = 10 dots (the line here 5th once past the start), dim "…" either side for the rest, the tag keeps the full count; the line here is ● bold in the phase colour (◉ dropped, a third glyph may draw wider); the dots row wraps as a safety net. New test: a 16-sentence reply shows ten dots and "…", then after six skips "…" both sides with the line here fifth. 64 pass (3 runs), tsc clean, validate passed. Live pane check pending (user).
- 2026-10-14: Practice exploit closed (user pick from "what next": practice words don't swing). Before: practice lines came round forever and each word typed right was a swing, a free weak one with no energy, so retyping practice farmed kills, gold and floors with Claude idle. Now isPractice (at >= lines.length) skips the fight in typeRecap and checkRecap (no swing, no counter); the pane treats practice as not typing (Attack button back mid-turn, no "type to attack" hint, frozen scene not fighting). Run-through test extended: practice right and wrong words leave the run unchanged, the hint is gone, mid-turn Attack is back; fails on the old code. 64 pass (3 runs), tsc clean, validate passed.
- 2026-10-14: Live lines + lore (user picks 1 and 4 from "a huge first prompt leaves 10 min with nothing to type"). The recap came only from a finished reply, so a session's first turn had nothing to type. New turn.step hook (main loop, steps that call a tool) runs the step's text through restLines into a live recap (tag LIVE, isLive) via hear(); goLive() at turn.start and when the last reply's lines run out mid-turn; withLore() appends a room flavor line (tag LORE, lore indices) when the live lines run out, replaced by new words while untouched. Lore keeps the Attack button; live hides it. turn.complete drops a live recap. No pay for live lines (payLine guard). Types: Recap.isLive, Recap.lore, state heard. Tests: two new (live words and lore, subagent and reply steps ignored, turn end clears; the last reply's lines first, heard words after); run-through test now sees LORE after practice; all three fail on the old code. 66 pass (3 runs), tsc clean, validate passed. Not checked: turn.step cost on a live stream (passthrough generator, work after the step ends).
- 2026-10-14: Gold shelf + cash-out (user: "do both, shelf with potion, scroll, key"). Gold had no use: XP bought everything and a run's gold was lost at New run. shop.ts: GOODS, isGood, unlock (key: next floor, no kill pay), POTION_HP, GOLD_PER_XP. buy() sends goods to buyGood (dead / short of gold / potion at full HP refused). startOver cashes out before the restock. Shop view: gold row in shopSvg (GOLD + amount, three icons, keys 4-6, price red when short), Buy buttons for goods, alt text lists them; /delve shop text lists them with the gold held. Layout checked in a rendered shot (gold row moved 6 px down off the XP prices). Tests: three new (goods by command, shop view shelf + refusals, cash-out); all fail on the old code; the dice-stock test now counts only XP lines. 69 pass (3 runs), tsc clean, validate passed. Not checked: the live pane.
- 2026-10-14: Recap lost at turn end (user screenshot: frozen pane, no typer). Cause: turn.complete ran summarise fire-and-forget; while the mod is being edited the session hot-reloads it as the turn ends, and the reload drops the old environment's work still running, so the recap was never written; the live-recap clear added earlier meant nothing was left on screen. Fix: turn.complete awaits summarise's first write (TL;DR or fallback lines, or the pending card); only the Haiku call stays in the background. Installed copies do not hot-reload, so this hit dev sessions only; a reload while Haiku is still answering can still leave the pending card (not fixed). Test: world() records the recap as the engine's own turn end finds it; the new test fails on the fire-and-forget code (recap undefined) and passes now. 70 pass (3 runs), tsc clean, validate passed.
- 2026-10-14: Typer still missing after a turn with no edits, so the reload theory was not the whole story. The skill's folder changed (a1545327 to 270d70b0), so the Claude Code process restarted: it loaded the mod once and stopped watching until the skill loaded again; the pane likely ran code from the restart. Skill reloaded to restart the watch. Added `/delve debug` (build tag, mode, recap id/lines/top/at/pending/live/lore, heard count) so the live check can tell which build runs and what the recap holds; asserted in the recap test. 70 pass, tsc clean, validate passed. Live check pending.
