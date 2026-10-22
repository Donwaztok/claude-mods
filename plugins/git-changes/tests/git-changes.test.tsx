import { expect, test } from 'claude-code/testing'

import { join, parseJsonc, parseStatus, unbutton } from '../hooks/register'

const PANE = {
  plugin: 'git-changes',
  component: 'Pane',
  requestId: 'git-changes',
  props: {
    title: 'Source Control',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('parses the pieces', async () => {
  expect(parseJsonc('{ "folders": [ {"path": "."}, // x\n {"path": "../a",}, ], }').folders.length).toBe(2)
  expect(join('/w/app', '../api')).toBe('/w/api')
  const s = parseStatus('## dev...origin/dev [ahead 2, behind 1]\0M  a.ts\0 M b/c.ts\0?? n.ts\0R  new.ts\0old.ts\0MM both.ts\0UU x.ts\0')
  expect(s.branch).toBe('dev')
  expect(s.ahead).toBe(2)
  expect(s.behind).toBe(1)
  expect(s.staged.map(c => c.code + c.path).join(',')).toBe('Ma.ts,Rnew.ts,Mboth.ts')
  expect(s.staged[1]?.orig).toBe('old.ts')
  expect(s.changes.map(c => c.code + c.path).join(',')).toBe('Mb/c.ts,Un.ts,Mboth.ts,Cx.ts')
})

test("the band's buttons become text, and ponytail's commands are kept", async () => {
  const keys: string[] = []
  const band = {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      {
        type: 'Box',
        props: { flexDirection: 'row', width: 110 },
        children: [
          { type: 'Button', props: { key: 'level', plain: true }, children: ['● full'] },
          { type: 'Text', children: ['$0.42'] },
          { type: 'Button', props: { key: 'review', label: 'Review', plain: true } },
          { type: 'Button', props: { key: 'board', label: 'Board', plain: true } },
        ],
      },
      { type: 'engine', props: {} },
    ],
  }
  const out = unbutton(band, keys)
  expect(keys).toEqual(['review'])
  expect(out.children.length).toBe(1)
  expect(out.children[0].props.width).toBe(undefined)
  expect(out.children[0].children.map((c: any) => `${c.type}:${c.children}`).join(',')).toBe('Text:● full,Text:$0.42')
})

test('the pane lists the workspace folders and opens a diff', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ deny: 'no timer in tests' }))
  on('session.cwd', () => ({ value: '/w/app' }))
  on('fs.list', () => ({ value: [{ name: 'app.code-workspace', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: '{"folders":[{"path":"."},{"path":"../api",},]}' }))
  const ran: string[] = []
  on('process.run', (_, e: any) => ({
    value: (ran.push(e.argv.join(' ')), e.argv[1] === 'diff')
      ? { exitCode: 0, stdout: 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+hello\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : e.init?.cwd === '/w/app'
        ? { exitCode: 0, stdout: '## dev...origin/dev [ahead 1]\0 M src/page.tsx\0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 0, stdout: '## main\0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'git-changes', args: '' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^app$/ }))?.text).toBe('app')
  expect((await ui.find({ type: 'Text', text: /^api$/ }))?.text).toBe('api')
  expect(await ui.find({ type: 'Text', text: /No changes/ })).toBeTruthy()
  expect(await ui.find({ key: 'push:app' } as any)).toBeTruthy()
  expect(await ui.find({ key: 'pull:app' } as any)).toBeFalsy()
  expect(await ui.find({ key: 'push:api' } as any)).toBeFalsy()
  await ui.press({ key: 'stage:app:src/page.tsx' })
  expect(ran).toContain('git add -A -- src/page.tsx')
  await ui.press({ key: 'push:app' })
  expect(ran).not.toContain('git push')
  expect(await ui.find({ type: 'Text', text: /Push 1 commit from dev\?/ })).toBeTruthy()
  await ui.press({ key: 'confirm:app' })
  expect(ran).toContain('git push')
  await ui.press({ key: 'app:w:src/page.tsx' })
  expect((await ui.find({ type: 'Text', text: /Working Tree/ }))?.text).toBe('(Working Tree)')
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"source":"@@ -1 +1 @@')
  expect(drawn).not.toContain('diff --git')
  await ui.unmount()
})
