import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, Timer } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, null)
const prev = atom({ plugin: 'usage-line', key: 'prev' } as const, null)
const frame = atom({ plugin: 'usage-line', key: 'frame' } as const, 0)
const animFrom = atom({ plugin: 'usage-line', key: 'animFrom' } as const, -100)
const isWorking = atom({ plugin: 'usage-line', key: 'isWorking' } as const, false)
const model = atom({ plugin: 'usage-line', key: 'model' } as const, '')

const TICK_MS = 100
const EASE_FRAMES = 10
const BAR_CELLS = 10
// Where along the bar each color sits: cool while there is room, hot near the end.
const GRADIENT: [number, [number, number, number]][] = [
  [0, [56, 189, 248]],
  [0.35, [74, 222, 128]],
  [0.6, [250, 204, 21]],
  [0.8, [251, 146, 60]],
  [1, [239, 68, 68]],
]
const TRACK = '#3f3f46'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export const toUsage = (u: {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
  cost?: SessionCost
}): Usage => ({
  ctx: u.context.percent,
  tokens: u.context.tokens,
  window: u.context.window,
  limits: u.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
  usd: u.cost?.usd,
})

// `claude-opus-5-5[1m]` reads as `Opus 5.5 1M`; anything else stays as given.
export const modelName = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id.trim())
  if (!m) return id.trim()
  const [, family, major, minor, wide] = m
  const name = family!.charAt(0).toUpperCase() + family!.slice(1)
  return `${name} ${major}${minor ? `.${minor}` : ''}${wide ? ' 1M' : ''}`
}

async function refreshModel($: EngineInterface) {
  const name = modelName(await $.session.model())
  await update($, model, () => name)
}

const hex = (rgb: number[]) => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')

export const gradient = (x: number, lighten = 0) => {
  const at = Math.max(0, Math.min(1, x))
  const i = GRADIENT.findIndex(([stop]) => stop >= at)
  const [s1, c1] = GRADIENT[Math.max(0, i - 1)]!
  const [s2, c2] = GRADIENT[i]!
  const k = s2 === s1 ? 0 : (at - s1) / (s2 - s1)
  return hex(c1.map((c, j) => c + (c2[j]! - c) * k).map(c => c + (255 - c) * lighten))
}

// Whole cells as heavy line, a half cell as its left half, then the thin track.
export const bar = (pct: number, cells = BAR_CELLS) => {
  const halves = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells * 2)
  const full = Math.floor(halves / 2)
  const fill = '━'.repeat(full) + (halves % 2 ? '╸' : '')
  return { fill, track: '─'.repeat(cells - fill.length) }
}

const MODES: Record<string, string> = { 'accept edits': 'edits', 'bypass permissions': 'bypass' }

// `⏵⏵ auto mode on (shift+tab to cycle) · esc to …` reads as `⏵⏵ auto`.
export const modeOnly = (hint: string) => {
  const mode = hint.split(/\s*[(·]/)[0]!.trim().replace(/\s+(mode\s+)?on$/i, '')
  return mode.replace(/[a-z][a-z ]*$/i, name => MODES[name.toLowerCase()] ?? name)
}

const ease = (t: number) => 1 - (1 - t) ** 3
const lerp = (a: number | undefined, b: number, t: number) => (a ?? 0) + (b - (a ?? 0)) * t

let ticker: Timer | undefined

function tick($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      const f = await update($, frame, n => n + 1)
      const settled = f - (await read($, animFrom)) >= EASE_FRAMES
      if (settled && !(await read($, isWorking))) {
        ticker?.cancel()
        ticker = undefined
      }
    })()
  })
}

async function measure($: EngineInterface, next: Usage) {
  const old = await read($, usage)
  await update($, prev, () => old)
  await update($, usage, () => next)
  const f = await read($, frame)
  await update($, animFrom, () => f)
  tick($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Clears the status line pinned by the first version; the bars live in PromptHint.
    $.ui.status(undefined)
    await refreshModel($)
    await measure($, toUsage(await $.session.usage()))
    return r
  })

  on('session.measure', async ($, e, next) => {
    await refreshModel($)
    await measure($, toUsage(e))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isWorking, () => true)
    tick($)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, model, () => modelName(e.to_model))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isWorking, () => false)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const u = await read($, usage)
    if (!u) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const f = await read($, frame)
    const working = await read($, isWorking)
    const old = await read($, prev)
    const modelLabel = await read($, model)
    const t = ease(Math.min(1, (f - (await read($, animFrom))) / EASE_FRAMES))

    const meter = (key: string, label: string, pct: number, from: number | undefined) => {
      const shown = lerp(from, pct, t)
      const { fill, track } = bar(shown)
      // While a turn runs, a soft highlight sweeps along the filled part.
      const glint = working ? (f % (fill.length + 6)) - 1 : -9
      const glow = (i: number) => Math.max(0, 0.55 - Math.abs(i - glint) * 0.25)
      const tip = gradient(shown / 100)
      return (
        <Text key={key}>
          <Text color="subtle">{label} </Text>
          {[...fill].map((c, i) => (
            <Text color={gradient((i + 0.5) / BAR_CELLS, glow(i))}>{c}</Text>
          ))}
          <Text color={TRACK}>{track}</Text>
          <Text color={tip} weight="bold">
            {' '}
            {Math.round(shown)}%
          </Text>
        </Text>
      )
    }

    const sep = <Text color={TRACK}>  ·  </Text>
    const parts = []

    if (u.ctx !== undefined) {
      parts.push(meter('ctx', 'ctx', u.ctx, old?.ctx))
    }
    for (const l of u.limits) {
      const before = old?.limits.find((o: Limit) => o.kind === l.kind)?.percent
      parts.push(meter(l.kind, LABELS[l.kind] ?? l.kind, l.percent, before))
    }
    if (u.usd !== undefined) {
      parts.push(
        <Text key="usd" color="claude" weight="bold">
          ${lerp(old?.usd, u.usd, t).toFixed(2)}
        </Text>,
      )
    }

    return (
      <Box flexDirection="row">
        <Text dimColor wrap="truncate">
          {typeof e.props.hint === 'string' ? modeOnly(e.props.hint) : e.props.hint}
        </Text>
        <Text>   </Text>
        <Text color="claude">{working ? SPINNER[f % SPINNER.length] : '◆'} </Text>
        {modelLabel ? (
          <Text>
            <Text color="claude" weight="bold">
              {modelLabel}
            </Text>
            {parts.length ? sep : null}
          </Text>
        ) : null}
        {parts.flatMap((p, i) => (i ? [sep, p] : [p]))}
      </Box>
    )
  })
}
