import { test, expect } from 'claude-code/testing'
import { bar, gradient, modeOnly, modelName, timeLeft, toUsage } from './register'

test('bar fills in half cells', () => {
  expect(bar(0)).toEqual({ fill: '', track: '──────────' })
  expect(bar(50)).toEqual({ fill: '━━━━━', track: '─────' })
  expect(bar(100)).toEqual({ fill: '━━━━━━━━━━', track: '' })
  expect(bar(35)).toEqual({ fill: '━━━╸', track: '──────' })
})

test('gradient runs from blue to red and lightens', () => {
  expect(gradient(0)).toBe('#38bdf8')
  expect(gradient(1)).toBe('#ef4444')
  expect(gradient(0, 1)).toBe('#ffffff')
})

test('model ids read as their names', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('Opus 5.5')).toBe('Opus 5.5')
})

test('maps session usage to the bar figures', () => {
  const u = toUsage({
    context: { tokens: 45000, window: 200000, percent: 23 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-19T18:00:00Z' }],
    cost: { usd: 1.234 },
  })
  expect(u).toEqual({
    ctx: 23,
    tokens: 45000,
    window: 200000,
    limits: [{ kind: 'five_hour', percent: 12.5, resetsAt: '2026-10-19T18:00:00Z' }],
    usd: 1.234,
  })
})

test('modeOnly drops the shortcut hints', () => {
  expect(modeOnly('⏵⏵ auto mode on (shift+tab to cycle)')).toBe('⏵⏵ auto')
  expect(modeOnly('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')).toBe('⏵⏵ auto')
  expect(modeOnly('⏵⏵ auto mode on')).toBe('⏵⏵ auto')
  expect(modeOnly('⏸ plan mode on (shift+tab to cycle)')).toBe('⏸ plan')
  expect(modeOnly('⏵⏵ accept edits on (shift+tab to cycle)')).toBe('⏵⏵ edits')
  expect(modeOnly('⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('⏵⏵ bypass')
})

test('timeLeft counts down to the reset', () => {
  const now = Date.parse('2026-10-22T15:12:00Z')
  expect(timeLeft('2026-10-22T15:12:30Z', now)).toBe('1m')
  expect(timeLeft('2026-10-22T15:50:00Z', now)).toBe('38m')
  expect(timeLeft('2026-10-22T18:30:00Z', now)).toBe('3h18m')
  expect(timeLeft('2026-10-24T20:12:00Z', now)).toBe('2d5h')
  expect(timeLeft('2026-10-22T10:00:00Z', now)).toBe('0m')
  expect(timeLeft(undefined, now)).toBe('')
})

const HINT = {
  plugin: 'usage-line',
  component: 'PromptHint',
  surface: 'terminal',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('a resumed session gets its bars back, drawing without writing state', async ($, on) => {
  on('session.usage', () => ({
    value: { context: { tokens: 1, window: 100, percent: 43 }, rateLimits: [], cost: { usd: 0 } } as any,
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('clock.every', () => ({ deny: 'no timer in tests' }))
  on('classic.SessionStart', () => ({}) as any)
  // the engine's own line, beneath the plugin
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['? for shortcuts'] }) as any)
  // the state of a resumed session: empty, and no session.start
  const empty = await $.ui.mount(HINT as any)
  expect(JSON.stringify(await empty.drawn())).not.toContain('Opus 5.5')
  await empty.unmount()
  await $.classic.SessionStart({ source: 'resume' } as any)
  const ui = await $.ui.mount(HINT as any)
  expect(JSON.stringify(await ui.drawn())).toContain('Opus 5.5')
  await ui.unmount()
})
