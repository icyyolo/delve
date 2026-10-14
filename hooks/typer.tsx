// The recap typer, drawn on the desktop's own thread so a key lands with no round trip:
// Monkeytype's way, the line's letters mark as they are typed and the caret sits in the line.
// A wrong letter stays where it fell; Backspace mends the word being typed, never a finished
// one. Everything typed goes to the hooks module, which swings for each word finished and
// scores the line; Enter, a space after the last word, or the last word typed right ends it.
import type { ClientModule } from 'claude-code'

import { marks } from './recap'
import type { Mark } from './recap'

export type TyperProps = { id: string; line: string; typed: string }
type State = { id: string; typed: string; isSent: boolean }
export type TyperPost = { id: string; typed: string; isDone: boolean }

// Letters as Monkeytype draws them: typed right bright, wrong red, extra dim red, still to come dim.
const LOOK: Record<Mark, Record<string, unknown>> = {
  right: {},
  wrong: { color: 'error' },
  extra: { color: 'error', dimColor: true },
  caret: { inverse: true },
  here: { dimColor: true },
  todo: { dimColor: true },
}

const Typer: ClientModule<TyperProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const fresh = (): State => ({ id: props.id, typed: props.typed, isSent: false })
  const now = () => (surface.state?.id === props.id ? surface.state : fresh())
  const want = props.line.split(' ').filter(Boolean)

  surface.onKey(k => {
    const s = now()
    if (s.isSent || k.meta) return
    const word = s.typed.slice(s.typed.lastIndexOf(' ') + 1)
    const at = s.typed.split(' ').length - 1
    const send = (typed: string, isDone: boolean) => {
      surface.setState({ id: props.id, typed, isSent: isDone })
      surface.post({ id: props.id, typed, isDone })
    }
    // An Enter on a line not started does nothing: the habit after a line ends itself skips no line.
    if (k.key === 'return') {
      if (s.typed) send(s.typed, true)
      return
    }
    if (k.key === 'backspace') {
      if (word) send(k.ctrl ? s.typed.slice(0, s.typed.length - word.length) : s.typed.slice(0, -1), false)
      return
    }
    if (k.ctrl) return
    if (k.key === ' ' || k.key === 'space') {
      // A space ends a word; none before the word starts, and the last word's ends the line.
      if (word) send(`${s.typed} `, at >= want.length - 1)
      return
    }
    if ([...k.key].length !== 1) return
    const typed = s.typed + k.key
    const isLast = at === want.length - 1 && `${word}${k.key}`.toLowerCase() === want[at]!.toLowerCase()
    send(typed, isLast)
  })

  const s = now()
  const at = s.typed.split(' ').length - 1
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {marks(props.line, s.typed).map((word, i) => {
        // A finished word with a slip in it is underlined, as Monkeytype marks it.
        const isMissed = i < at && word.some(p => p.mark !== 'right')
        return (
          <Box flexDirection="row">
            {word.map(part => (
              <Text {...LOOK[part.mark]} underline={isMissed || undefined}>
                {part.text}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export default Typer
