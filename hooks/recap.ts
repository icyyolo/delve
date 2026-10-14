// The reply recap, pure: plain lines of Claude's reply to type, the key points worth
// knowing, and the score. Up to three summary lines come first: Claude's own TL;DR line when
// it wrote one, Haiku's lines, the reply's best sentences. Then the whole reply, in order.

// The typed line's length, the summary lines, the shortest reply worth a round, the key points shown.
export const RECAP_WORDS = 20
export const TOP_LINES = 3
export const MIN_WORDS = 8
export const MAX_KEYS = 3
const KEY_CHARS = 80
// How much of the reply Haiku reads.
export const REPLY_CHARS = 4000

// Lines that are worth a key point: a question to the person, something to do, a failure.
const KEY_WORDS = /\b(warning|warnings|error|errors|failed|fails|failing|failure|you need to|you must|you'll need to)\b/i

const stripFences = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, '\n')

// A path or file name: a slash in it, or a name with an extension.
const PATH = /\S*[\\/]\S*|\b\w+\.[A-Za-z]\w{0,4}\b/g

// Typeable words only: no inline code, links, paths or symbols, straight quotes and dashes.
function plain(text: string): string {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(PATH, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^A-Za-z0-9 .,;'?!-]/g, ' ')
    .replace(/\s+([.,;?!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const wordsOf = (text: string) => text.split(' ').filter(Boolean)
const cut = (text: string, n: number) => wordsOf(text).slice(0, n).join(' ')

// Prose lines: no table rows or rules, list and heading marks dropped.
function proseLines(text: string): string[] {
  return stripFences(text)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('|') && !/^[-*_=]{3,}$/.test(l))
    .map(l => l.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '').replace(/\*\*|__/g, ''))
}

// Too short a reply ("Done.") gets no typing round and no Haiku call.
export const hasRound = (answer: string) => wordsOf(plain(stripFences(answer))).length >= MIN_WORDS

// `/delve tldr on` asks Claude for this line; the recap types it as written.
export const TLDR_ASK =
  'End every reply to the user that runs past two sentences with one final line in exactly this form: ' +
  '"TL;DR: <one plain sentence of at most 20 words saying what you did or found>". ' +
  'Plain words only in that line: no code, file names, paths, commands or symbols.'
const TLDR_LINE = /^\s*(?:\*\*|__)?\s*TL;?\s?DR\s*(?:\*\*|__)?\s*[:\-–—]\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/i

// Claude's own TL;DR line (its last one), as a line to type.
export function tldrOf(answer: string): string | null {
  const found = stripFences(answer)
    .split('\n')
    .map(l => TLDR_LINE.exec(l)?.[1])
    .filter(Boolean)
    .pop()
  return (found && shorten(capital(plain(found)))) || null
}

// A label that says the sentence is the summary, and a heading over one.
const SUMMARY = /^(summary|tl;?\s?dr|in short|in summary|bottom line|result|outcome)\b/i
// Words a sentence about what got done tends to hold.
const CUE = /\b(fixed|added|changed|removed|updated|built|tested|implemented|renamed|moved|now|because|so|result|works|passes|pass|done|found|cause)\b/i
const STOP = new Set(
  ('the and for that this with you your are was were has have had not but all can its into from they them then than ' +
    'there their what when which will would could should also just only very more most some any each been being does did ' +
    'done here how out our over under about after before again once both few other same such own too off why who whom ' +
    'one two let get got use used using make made like need needs').split(' '),
)

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Content words, roughly stemmed, for telling what a reply keeps talking about.
const contentOf = (s: string) =>
  wordsOf(plain(s).toLowerCase().replace(/[^a-z0-9' ]/g, ' '))
    .map(w => w.replace(/'s$/, '').replace(/(ing|ed|s)$/, ''))
    .filter(w => w.length > 2 && !STOP.has(w))

// Over RECAP_WORDS: cut at the last clause break that keeps 6 words, else at the limit.
function shorten(line: string): string {
  const w = wordsOf(line)
  if (w.length <= RECAP_WORDS) return line
  for (let i = RECAP_WORDS; i >= 6; i--) {
    if (/[,;]$/.test(w[i - 1]!)) return `${w.slice(0, i).join(' ').replace(/[,;]$/, '')}.`
    if (/^(and|but|so|which|while|because)$/i.test(w[i] ?? '')) return `${w.slice(0, i).join(' ')}.`
  }
  return cut(line, RECAP_WORDS)
}

type Sentence = { raw: string; para: number; isBold: boolean; isSummary: boolean }

// The reply's prose as sentences, each with its paragraph and whether a summary heading,
// a summary label or bold marks it. Headings, tables, rules and TL;DR lines are left out.
function sentencesOf(answer: string): Sentence[] {
  const out: Sentence[] = []
  let para = 0
  let isGap = true
  let underSummary = false
  for (const line of stripFences(answer).split('\n').map(l => l.trim())) {
    if (!line) {
      if (!isGap) para++
      isGap = true
      continue
    }
    isGap = false
    if (line.startsWith('|') || /^[-*_=]{3,}$/.test(line) || TLDR_LINE.test(line)) continue
    const bare = line.replace(/^([-*+>]|\d+[.)])\s+/, '')
    if (/^#+\s/.test(line) || /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(bare)) {
      underSummary = SUMMARY.test(bare.replace(/^#+\s+|\*\*|__/g, ''))
      continue
    }
    const isBold = /^(\*\*|__)/.test(bare)
    // A terse fragment ("Recap built.") joins the sentence after it on the same line.
    const parts = bare.replace(/\*\*|__/g, '').split(/(?<=[.!?])\s+/)
    for (let i = 0; i < parts.length; i++) {
      let raw = parts[i]!
      while (wordsOf(plain(raw)).length < 4 && i + 1 < parts.length) raw = `${raw} ${parts[++i]}`
      out.push({ raw, para, isBold, isSummary: underSummary || SUMMARY.test(raw) })
    }
  }
  return out
}

// Without Haiku: the sentence that best stands for the reply. Each one scores for how many
// of its words the rest of the reply repeats (only once there are enough sentences for that
// to mean something), for sitting first or last, for a summary label or heading, for words
// about what got done; it loses for code or paths (they drop out and break the grammar),
// for naming a warning (that is a key point), and for running long. Questions, lead-ins
// ("Here's what I changed:") and fragments never count. Ties go to the earlier sentence.
export function fallbackLine(answer: string): string | null {
  return rankedLines(answer)[0] ?? null
}

// Every sentence that could stand for the reply, as lines, best first.
function rankedLines(answer: string): string[] {
  const all = sentencesOf(answer)
  const told = all.filter(s => !s.raw.trim().endsWith(':') && !s.raw.trim().endsWith('?') && wordsOf(plain(s.raw)).length >= 4)
  if (!told.length) return []
  const lastPara = all[all.length - 1]!.para
  const words = told.map(s => [...new Set(contentOf(s.raw))])
  const df = new Map<string, number>()
  words.flat().forEach(w => df.set(w, (df.get(w) ?? 0) + 1))
  const central = words.map(ws => ws.reduce((n, w) => n + (df.get(w)! - 1), 0) / Math.sqrt(ws.length || 1))
  const top = Math.max(...central)
  const weight = Math.min(1, Math.max(0, (told.length - 2) / 6)) * 2
  const scored = told.map((s, i) => {
    const n = wordsOf(plain(s.raw)).length
    const score =
      (top > 0 ? (central[i]! / top) * weight : 0) +
      (s.para === 0 ? 1 : 0) +
      (i === 0 ? 0.5 : 0) +
      (lastPara > 0 && s.para === lastPara ? 1 : 0) +
      (s.isSummary ? 3 : 0) +
      (s.isBold ? 0.5 : 0) +
      (CUE.test(s.raw) ? 1 : 0) +
      (n >= 8 && n <= 25 ? 0.5 : 0) -
      (/`/.test(s.raw) || new RegExp(PATH.source).test(s.raw) ? 1.5 : 0) -
      (KEY_WORDS.test(s.raw) ? 1 : 0) -
      (n > 30 ? 1 : 0)
    return { s, score }
  })
  // A stable sort: ties keep the earlier sentence first.
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ s }) => shorten(capital(plain(s.raw.replace(/^\s*(summary|tl;?\s?dr|in short|in summary|bottom line|result|outcome)\s*[:\-–—]\s*/i, '')))))
    .filter(Boolean)
}

// Lines compare without case or punctuation.
const key = (line: string) => line.toLowerCase().replace(/[^a-z0-9]/g, '')

// The summary lines: the picks given (Claude's TL;DR line, Haiku's lines) first, the
// reply's best sentences filling in, no line twice, TOP_LINES at most.
export function topLines(answer: string, picks: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of [...picks, ...rankedLines(answer)]) {
    if (!line || seen.has(key(line))) continue
    seen.add(key(line))
    out.push(line)
    if (out.length === TOP_LINES) break
  }
  return out
}

// A long line as lines of RECAP_WORDS at most, each cut at a clause break where one falls.
function chunks(line: string): string[] {
  const out: string[] = []
  let rest = line
  while (rest) {
    const head = shorten(rest)
    out.push(capital(head))
    rest = wordsOf(rest).slice(wordsOf(head).length).join(' ')
  }
  return out
}

// The whole reply after the summary lines, one sentence a line in reading order: long ones
// split, a sentence that loses a third of itself to code or paths (its grammar gone) or
// leaves under 4 words skipped, and the summary lines not typed twice.
export function restLines(answer: string, taken: string[]): string[] {
  const seen = new Set(taken.map(key))
  const out: string[] = []
  for (const s of sentencesOf(answer)) {
    const said = s.raw.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
    const line = plain(said)
    if (line.length < (said.length * 2) / 3 || wordsOf(line).length < 4) continue
    for (const one of chunks(capital(line))) {
      if (seen.has(key(one))) continue
      seen.add(key(one))
      out.push(one)
    }
  }
  return out
}

// A key point: one short line, markdown and backticks gone (a command stays readable).
function keyLine(text: string): string {
  const line = text.replace(/`/g, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()
  return line.length > KEY_CHARS ? `${line.slice(0, KEY_CHARS - 1).trimEnd()}…` : line
}

// Without Haiku: the lines that ask the person something or name a warning or failure.
export function fallbackKeys(answer: string): string[] {
  const picked = proseLines(answer)
    .filter(l => !TLDR_LINE.test(l) && (/\?\s*$/.test(l) || KEY_WORDS.test(l)))
    .map(keyLine)
  return [...new Set(picked)].slice(0, MAX_KEYS)
}

export function recapPrompt(answer: string): string {
  return [
    "Summarise this reply from Claude, a coding assistant, for a typing game. Reply in exactly this format and nothing else:",
    'TYPE: <one sentence, at most 20 words, saying what Claude did or said; plain words only: no code, file names, paths, commands or symbols>',
    'TYPE: <the next most important point, same rules>',
    'TYPE: <the point after that, same rules>',
    'Up to 3 TYPE lines, the first the overall summary; fewer if the reply has less to say.',
    'KEY: <one short line, under 80 characters>',
    'Up to 3 KEY lines, only for: a question Claude asks the user, something the user must do (a command to run, a restart), a warning or a failure. No KEY lines if there are none.',
    '',
    'The reply:',
    '<<<',
    answer.slice(0, REPLY_CHARS),
    '>>>',
  ].join('\n')
}

// Haiku's answer as a recap, held to the same rules as the fallback; no TYPE line means none.
export function readRecap(text: string): { lines: string[]; keys: string[] } | undefined {
  const all = text.split('\n').map(l => l.trim())
  const typed = all
    .filter(l => /^TYPE:/i.test(l))
    .map(l => cut(plain(l.replace(/^TYPE:/i, '')), RECAP_WORDS))
    .filter(Boolean)
  if (!typed.length) return undefined
  const keys = all
    .filter(l => /^KEY:/i.test(l))
    .map(l => keyLine(l.replace(/^KEY:/i, '')))
    .filter(k => k && !/^none\.?$/i.test(k))
  return { lines: [...new Set(typed)].slice(0, TOP_LINES), keys: [...new Set(keys)].slice(0, MAX_KEYS) }
}

const EDIT_FIELD: Record<string, string> = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

// The file a tool call edited, if it was an edit.
export function editedPath(input: Record<string, unknown>): string | undefined {
  const field = EDIT_FIELD[String(input.tool)]
  const path = field ? input[field] : undefined
  return typeof path === 'string' ? path : undefined
}

// The edited files by name, a few of them and how many more.
export function fileList(paths: string[]): string[] {
  const names = [...new Set(paths.map(p => p.split(/[\\/]/).pop() ?? p))]
  return names.length > MAX_KEYS ? [...names.slice(0, MAX_KEYS), `+${names.length - MAX_KEYS} more`] : names
}

// Words compare without case or punctuation.
const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase().replace(/[^a-z0-9']/g, '') === b.toLowerCase().replace(/[^a-z0-9']/g, '')

// Accuracy: the share of the line's words typed right, in place. WPM: five characters a word.
export function score(line: string, typed: string, ms: number): { accuracy: number; wpm: number } {
  const want = wordsOf(line)
  const got = wordsOf(typed.trim())
  const right = want.filter((w, i) => same(w, got[i])).length
  return { accuracy: want.length ? right / want.length : 0, wpm: ms > 0 ? Math.round(typed.trim().length / 5 / (ms / 60_000)) : 0 }
}

// While typing: the share of finished words typed right (null before the first finishes),
// and the WPM so far (null in the first two seconds, too soon to mean anything).
export function liveScore(line: string, typed: string, ms: number): { accuracy: number | null; wpm: number | null } {
  const want = wordsOf(line)
  const done = typed.split(' ').slice(0, -1).slice(0, want.length)
  const right = done.filter((w, i) => same(want[i], w)).length
  return { accuracy: done.length ? right / done.length : null, wpm: ms >= 2000 ? Math.round(typed.length / 5 / (ms / 60_000)) : null }
}

// The words of the line finished between two states of the typing, each typed right or
// not; words typed past the line's end count for nothing.
export function finishedWords(line: string, before: string, after: string): boolean[] {
  const want = wordsOf(line)
  const was = before.split(' ').length - 1
  return after
    .split(' ')
    .slice(0, -1)
    .slice(was, want.length)
    .map((w, i) => same(want[was + i], w))
}

// right/wrong: a letter typed; extra: typed past the word's end; caret: the next letter
// (a space once the word is typed); here: the rest of the word being typed; todo: words to come.
export type Mark = 'right' | 'wrong' | 'extra' | 'caret' | 'here' | 'todo'

type Part = { text: string; mark: Mark }

// How each word of the line draws as it is typed, letter by letter without case: a done
// word typed right is whole; a done word typed wrong shows which letters (missing ones
// wrong too); the word being typed ends at the caret; the words after it wait dim.
export function marks(line: string, typed: string): Part[][] {
  const got = typed.split(' ')
  const at = got.length - 1
  return wordsOf(line).map((w, i) => {
    if (i > at) return [{ text: w, mark: 'todo' }]
    if (i < at && same(w, got[i])) return [{ text: w, mark: 'right' }]
    const now = got[i] ?? ''
    const parts: Part[] = []
    const push = (text: string, mark: Mark) => {
      const end = parts.at(-1)
      if (end?.mark === mark) end.text += text
      else parts.push({ text, mark })
    }
    for (let k = 0; k < Math.min(w.length, now.length); k++) push(w[k]!, w[k]!.toLowerCase() === now[k]!.toLowerCase() ? 'right' : 'wrong')
    if (now.length > w.length) push(now.slice(w.length), 'extra')
    if (i < at) {
      if (now.length < w.length) push(w.slice(now.length), 'wrong')
      return parts
    }
    if (now.length >= w.length) push(' ', 'caret')
    else {
      push(w[now.length]!, 'caret')
      if (now.length + 1 < w.length) push(w.slice(now.length + 1), 'here')
    }
    return parts
  })
}
