import { expect, test } from 'claude-code/testing'

import { join, parseJsonc, parseStatus, toLaunches, toScripts, toTasks, unbutton } from '../hooks/register'

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

test('launch configurations become commands', async () => {
  const folders = [{ name: 'app', path: '/w/app' }, { name: 'docs', path: '/w/docs' }]
  const [npm, prog, chrome, both] = toLaunches(
    {
      configurations: [
        { name: 'Dev', type: 'node', request: 'launch', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], cwd: '${workspaceFolder:docs}', env: { PORT: '3005', PATH: '${env:PATH}:/x', GONE: null } },
        { name: 'Vinext', type: 'node', request: 'launch', program: '${workspaceFolder}/cli.js', args: ['dev'] },
        { name: 'Web', type: 'chrome', request: 'launch' },
      ],
      compounds: [{ name: 'Both', configurations: ['Dev', 'Vinext'] }],
    },
    'ws',
    '/w/app',
    folders,
  )
  expect(npm!.argv).toEqual(['npm', 'run', 'dev'])
  expect(npm!.cwd).toBe('/w/docs')
  expect(npm!.env).toEqual({ PORT: '3005', PATH: '${env:PATH}:/x' })
  expect(prog!.argv).toEqual(['node', '/w/app/cli.js', 'dev'])
  expect(prog!.cwd).toBe('/w/app')
  expect(chrome!.argv).toBe(undefined)
  expect(chrome!.type).toBe('chrome')
  expect(both!.parts).toEqual(['ws:Dev', 'ws:Vinext'])
})

test('tasks and npm scripts become commands', async () => {
  const [shell, proc, npm, both, gulp] = toTasks(
    {
      tasks: [
        { label: 'up', type: 'shell', command: 'docker compose', args: ['up', 'my db'], options: { cwd: '${workspaceFolder}/infra', env: { A: '1' } } },
        { label: 'tsc', type: 'process', command: 'tsc', args: ['-w'] },
        { type: 'npm', script: 'dev', path: 'web' },
        { label: 'all', dependsOn: ['up', 'tsc'] },
        { label: 'g', type: 'gulp' },
      ],
    },
    'app',
    '/w/app',
    [],
    'pnpm',
  )
  expect(shell!.argv).toEqual(['sh', '-c', "docker compose up 'my db'"])
  expect(shell!.cwd).toBe('/w/app/infra')
  expect(shell!.env).toEqual({ A: '1' })
  expect(proc!.argv).toEqual(['tsc', '-w'])
  expect(npm!.name).toBe('npm: dev')
  expect(npm!.argv).toEqual(['pnpm', 'run', 'dev'])
  expect(npm!.cwd).toBe('/w/app/web')
  expect(both!.argv).toBe(undefined)
  expect(both!.parts).toEqual(['app:task:up', 'app:task:tsc'])
  expect(gulp!.type).toBe('gulp')
  expect(toScripts({ scripts: { dev: 'next dev' } }, 'app', '/w/app', 'yarn')).toEqual([
    { key: 'app:npm:dev', name: 'dev', source: 'app', kind: 'npm', argv: ['yarn', 'run', 'dev'], cwd: '/w/app' },
  ])
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
  const file = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })
  on('fs.list', (_, e: any) => ({
    value: e.path === '/w/api' ? [file('package.json'), file('yarn.lock')] : [file('app.code-workspace')],
  }))
  on('fs.read', (_, e: any) => ({
    value: e.path === '/w/api/package.json' ? '{"scripts":{"start":"node ."}}' : '{"folders":[{"path":"."},{"path":"../api",},],"launch":{"configurations":[{"name":"Dev","type":"node","request":"launch","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"env":{"P":"${env:HOME}/x"}}]}}',
  }))
  on('fs.exists', () => ({ value: false }))
  const spawned: any[] = []
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push(e)
    yield { stream: 'stdout', text: '\x1b[32mready\x1b[0m on :3000\n' }
    return { value: { code: 1, signal: null } }
  } as any)
  const ran: string[] = []
  on('process.run', (_, e: any) => ({
    value: (ran.push(e.argv.join(' ')), e.argv[0] === 'printenv')
      ? { exitCode: 0, stdout: '/home/u\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : e.argv[1] === 'diff'
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
  await ui.press({ key: 'discard:app:src/page.tsx' })
  expect(ran.some(r => r.startsWith('git checkout'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Discard changes in page\.tsx\?/ })).toBeTruthy()
  await ui.press({ key: 'confirm:app' })
  expect(ran).toContain('git checkout -q -- src/page.tsx')
  await ui.press({ key: 'menu:app:w:src/page.tsx' })
  await ui.press({ key: 'reveal:app:w:src/page.tsx' })
  expect(ran.some(r => r.includes('ShowItems array:string:file:///w/app/src/page.tsx'))).toBe(true)
  expect(await ui.find({ key: 'reveal:app:w:src/page.tsx' } as any)).toBeFalsy()
  await ui.press({ key: 'push:app' })
  expect(ran).not.toContain('git push')
  expect(await ui.find({ type: 'Text', text: /Push 1 commit from dev\?/ })).toBeTruthy()
  await ui.press({ key: 'confirm:app' })
  expect(ran).toContain('git push')
  // one line: the first entry picked, the list closed
  expect(await ui.find({ key: 'pick:app:Dev' } as any)).toBeFalsy()
  await ui.press({ key: 'run:app:Dev' })
  expect(spawned[0].argv).toEqual(['npm', 'run', 'dev'])
  expect(spawned[0].cwd).toBe('/w/app')
  expect(spawned[0].env).toEqual({ P: '/home/u/x' })
  // the stub exits at once: ▶ is back, with the exit code beside it
  expect(await ui.find({ key: 'run:app:Dev' } as any)).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeTruthy()
  await ui.press({ key: 'output:app:Dev' })
  expect(await ui.find({ type: 'Text', text: /\(exited\)/ })).toBeTruthy()
  const out = JSON.stringify(await ui.drawn())
  expect(out).toContain('ready on :3000')
  expect(out).toContain('[exited with 1]')
  expect(out).not.toContain('[32m')
  await ui.press({ key: 'back' })
  // the name opens the list; a pick replaces the line's entry and closes it
  expect(await ui.find({ key: 'run:api:npm:start' } as any)).toBeFalsy()
  await ui.press({ key: 'run-pick' })
  expect(await ui.find({ type: 'Text', text: /npm · api/ })).toBeTruthy()
  await ui.press({ key: 'pick:api:npm:start' })
  expect(await ui.find({ key: 'pick:app:Dev' } as any)).toBeFalsy()
  await ui.press({ key: 'run:api:npm:start' })
  expect(spawned[1].argv).toEqual(['yarn', 'run', 'start'])
  expect(spawned[1].cwd).toBe('/w/api')
  await ui.press({ key: 'app:w:src/page.tsx' })
  expect((await ui.find({ type: 'Text', text: /Working Tree/ }))?.text).toBe('(Working Tree)')
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"source":"@@ -1 +1 @@')
  expect(drawn).not.toContain('diff --git')
  await ui.unmount()
})
