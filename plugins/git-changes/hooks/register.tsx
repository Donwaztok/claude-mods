import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, DiffView, Launch, Repo } from '../types'

const PANE = 'git-changes'
const TITLE = 'Source Control'
const repos = atom({ plugin: 'git-changes', key: 'repos' } as const, [])
const collapsed = atom({ plugin: 'git-changes', key: 'collapsed' } as const, [])
const diff = atom({ plugin: 'git-changes', key: 'diff' } as const, null)
const launches = atom({ plugin: 'git-changes', key: 'launches' } as const, [])
const selected = atom({ plugin: 'git-changes', key: 'selected' } as const, null)

// While the pane is drawn, the band above the prompt (as the other plugins drew it) shows inside it.
// Module variables, not $.state: a tree holds the other plugins' press handles, and a reload redraws both sites.
let isShown = false
let band: any = null
let bandKey = ''

// VS Code's gitDecoration colors
const COLORS: Record<string, string> = {
  M: '#e2c08d',
  A: '#81b88b',
  U: '#73c991',
  D: '#c74e39',
  R: '#73c991',
  C: '#e4676b',
  T: '#e2c08d',
}

// A file row's text past its width is cut, its last letters fading out.
// shortcut: fades toward a dark background, as the engine does not say the theme; a light theme gets a dark tail.
const BG = [0x1e, 0x1e, 0x1e]
const TEXT = '#cccccc'
// the dimmed path's color, where its fade starts
const DIM = '#8c8c8c'
const FADE = 4

export type Span = { text: string; color: string; dim?: boolean; strike?: boolean }

const mix = (hex: string, k: number) =>
  '#' +
  [1, 3, 5]
    .map((at, j) => Math.round(parseInt(hex.slice(at, at + 2), 16) * (1 - k) + BG[j]! * k))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('')

export function fadeOut(spans: Span[], width: number): Span[] {
  const total = spans.reduce((n, s) => n + [...s.text].length, 0)
  if (total <= width) return spans
  const steps = Math.min(FADE, Math.max(0, width))
  let left = width - steps
  const head: Span[] = []
  const tail: Span[] = []
  for (const s of spans) {
    const chars = [...s.text]
    const kept = chars.slice(0, Math.max(0, left))
    if (kept.length) head.push({ ...s, text: kept.join('') })
    left -= kept.length
    for (const ch of chars.slice(kept.length)) if (tail.length < steps) tail.push({ ...s, text: ch })
  }
  return [...head, ...tail.map((s, i) => ({ ...s, dim: false, color: mix(s.color, (i + 1) / (steps + 1)) }))]
}

// .code-workspace is JSONC: drop comments and trailing commas outside strings.
export function parseJsonc(text: string): any {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

export function join(base: string, rel: string): string {
  const parts = (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return '/' + out.join('/')
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// `git status --porcelain=v1 -b -z` → branch info and VS Code's two groups.
export function parseStatus(out: string) {
  const entries = out.split('\0')
  let branch = ''
  let ahead = 0
  let behind = 0
  const staged: Change[] = []
  const changes: Change[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    if (e.startsWith('## ')) {
      const head = e.slice(3)
      branch = head.startsWith('No commits yet on ')
        ? head.slice(18)
        : head.split(/\.\.\.| /)[0] ?? ''
      ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
      continue
    }
    const x = e.charAt(0)
    const y = e.charAt(1)
    const path = e.slice(3)
    // the original path follows a rename
    const orig = x === 'R' || x === 'C' ? entries[++i] : undefined
    if (x === '!') continue
    if (x === '?') changes.push({ path, code: 'U' })
    else if (x === 'U' || y === 'U' || (x === y && (x === 'A' || x === 'D')))
      changes.push({ path, code: 'C' })
    else {
      if (x !== ' ') staged.push(orig ? { path, code: x, orig } : { path, code: x })
      if (y !== ' ') changes.push({ path, code: y })
    }
  }
  return { branch, ahead, behind, staged, changes }
}

type Folder = { name: string; path: string }

// The folders, and the workspace file itself when there is one (its `launch` and `tasks` blocks).
async function findFolders($: any): Promise<{ folders: Folder[]; ws?: { name: string; json: any } }> {
  const cwd: string = await $.session.cwd()
  const entries = await $.fs.list(cwd)
  const ws = entries
    .filter((f: any) => f.name.endsWith('.code-workspace'))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))[0]
  if (ws) {
    const json = parseJsonc(await $.fs.read(`${cwd}/${ws.name}`))
    const folders = (json.folders ?? []).map((f: any) => {
      const path = join(cwd, f.path ?? '.')
      return { name: f.name ?? basename(path), path }
    })
    return { folders, ws: { name: ws.name.replace(/\.code-workspace$/, ''), json } }
  }
  return { folders: await findRepos($, cwd, entries) }
}

async function findRepos($: any, cwd: string, entries: any[]): Promise<Folder[]> {
  if (entries.some((f: any) => f.name === '.git')) return [{ name: basename(cwd), path: cwd }]
  // No workspace file and not a repo: every child repo, like opening the parent folder.
  const kids = entries.filter((f: any) => f.kind === 'directory')
  const repos = await Promise.all(
    kids.map(async (f: any) => ((await $.fs.exists(`${cwd}/${f.name}/.git`)) ? f.name : null)),
  )
  return repos.filter(Boolean).map((n: string) => ({ name: n, path: join(cwd, n) }))
}

// One git pass at a time; callers during a pass wait for that pass.
let inFlight: Promise<void> | null = null
const refresh = ($: any) =>
  (inFlight ??= scan($)
    .catch(err => $.ui.log(`git-changes: ${err}`))
    .finally(() => (inFlight = null)))

// ${workspaceFolder} is the file's folder (a workspace file's: its first folder); ${env:X} waits for the run.
const vars = (base: string, folders: Folder[]) => (s: unknown) =>
  String(s)
    .replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (m, n) => (n ? folders.find(f => f.name === n)?.path ?? m : base))
    .replace(/\$\{workspaceFolderBasename\}/g, basename(base))

// a null env value unsets the variable in VS Code; here it is just left out
const envOf = (env: any, sub: (s: unknown) => string) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, sub(v)]))

// launch.json: Run and Debug's configurations and compounds.
export function toLaunches(launch: any, source: string, base: string, folders: Folder[]): Launch[] {
  const sub = vars(base, folders)
  const configs: Launch[] = (launch?.configurations ?? []).map((c: any) => {
    const key = `${source}:${c.name}`
    const args = [c.runtimeArgs ?? [], c.program ?? [], c.args ?? []].flat().map(sub)
    const argv =
      c.type === 'node-terminal' && c.command
        ? ['sh', '-c', sub(c.command)]
        : /^(pwa-)?node$/.test(c.type) && c.request === 'launch' && (c.runtimeExecutable || c.program)
          ? [sub(c.runtimeExecutable ?? 'node'), ...args]
          : undefined
    if (!argv) return { key, name: c.name, source, kind: 'launch', type: c.type }
    return { key, name: c.name, source, kind: 'launch', argv, cwd: sub(c.cwd ?? base), env: envOf(c.env, sub) }
  })
  const compounds: Launch[] = (launch?.compounds ?? []).map((c: any) => ({
    key: `${source}:${c.name}`,
    name: c.name,
    source,
    kind: 'launch',
    parts: (c.configurations ?? []).map((p: any) => (typeof p === 'string' ? `${source}:${p}` : `${p.folder}:${p.name}`)),
  }))
  return [...configs, ...compounds]
}

// A shell task's args are quoted as VS Code does for an arg holding spaces.
const quote = (a: string) => (/\s/.test(a) ? `'${a.replaceAll("'", `'\\''`)}'` : a)

// tasks.json: shell, process and npm tasks; dependsOn starts the named tasks beside it.
// shortcut: no per-OS blocks, problem matchers or dependsOrder "sequence"; add them when a task needs them.
export function toTasks(tasks: any, source: string, base: string, folders: Folder[], pm = 'npm'): Launch[] {
  const sub = vars(base, folders)
  return (tasks?.tasks ?? []).map((t: any) => {
    const name: string = t.label ?? (t.script ? `npm: ${t.script}` : String(t.command))
    const key = `${source}:task:${name}`
    const parts = [t.dependsOn ?? []].flat().map((d: any) => `${source}:task:${typeof d === 'string' ? d : d.label}`)
    const args = (t.args ?? []).map((a: any) => sub(typeof a === 'string' ? a : a.value))
    const argv =
      t.type === 'npm' && t.script
        ? [pm, 'run', t.script]
        : t.command && t.type === 'process'
          ? [sub(t.command), ...args]
          : t.command
            ? ['sh', '-c', [sub(t.command), ...args.map(quote)].join(' ')]
            : undefined
    const cwd = sub(t.options?.cwd ?? (t.type === 'npm' && t.path ? `${base}/${t.path}` : base))
    return {
      key,
      name,
      source,
      kind: 'task',
      ...(argv ? { argv, cwd, env: envOf(t.options?.env, sub) } : !parts.length && { type: t.type }),
      ...(parts.length && { parts }),
    }
  })
}

// package.json scripts, run by the package manager its lock file names, as VS Code's NPM Scripts view.
export function toScripts(pkg: any, source: string, base: string, pm: string): Launch[] {
  return Object.keys(pkg?.scripts ?? {}).map(name => ({
    key: `${source}:npm:${name}`,
    name,
    source,
    kind: 'npm',
    argv: [pm, 'run', name],
    cwd: base,
  }))
}

const packageManager = (names: Set<string>) =>
  names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lock') || names.has('bun.lockb') ? 'bun' : 'npm'

async function findLaunches($: any, found: Folder[], ws?: { name: string; json: any }): Promise<Launch[]> {
  const cwd: string = await $.session.cwd()
  // A folder that is not a repo still runs, as VS Code opens any folder.
  const folders = found.length ? found : [{ name: basename(cwd), path: cwd }]
  const names = async (dir: string) => new Set<string>((await $.fs.list(dir).catch(() => [])).map((f: any) => f.name))
  // A broken file hides its own entries, not the pane.
  const json = async (file: string) => {
    try {
      return parseJsonc(await $.fs.read(file))
    } catch (err) {
      $.ui.log(`git-changes: ${file}: ${err}`, { to: 'debug' })
    }
  }
  const own = await Promise.all(
    folders.map(async f => {
      const here = await names(f.path)
      const vscode = here.has('.vscode') ? await names(`${f.path}/.vscode`) : new Set()
      const pm = packageManager(here)
      return {
        launches: vscode.has('launch.json') ? toLaunches(await json(`${f.path}/.vscode/launch.json`), f.name, f.path, folders) : [],
        tasks: vscode.has('tasks.json') ? toTasks(await json(`${f.path}/.vscode/tasks.json`), f.name, f.path, folders, pm) : [],
        scripts: here.has('package.json') ? toScripts(await json(`${f.path}/package.json`), f.name, f.path, pm) : [],
      }
    }),
  )
  const first = folders[0]!.path
  return [
    ...(ws ? toLaunches(ws.json.launch, ws.name, first, folders) : []),
    ...own.flatMap(o => o.launches),
    ...(ws ? toTasks(ws.json.tasks, ws.name, first, folders) : []),
    ...own.flatMap(o => o.tasks),
    ...own.flatMap(o => o.scripts),
  ]
}

async function scan($: any) {
  {
    const { folders, ws } = await findFolders($)
    const nextLaunches = await findLaunches($, folders, ws)
    if (JSON.stringify(await read($, launches)) !== JSON.stringify(nextLaunches)) await update($, launches, () => nextLaunches)
    const next: Repo[] = await Promise.all(
      folders.map(async f => {
        const run = await $.process
          .run(['git', 'status', '--porcelain=v1', '-b', '-z', '-uall'], { cwd: f.path })
          .catch(() => ({ exitCode: 1, stdout: '' }))
        if (run.exitCode !== 0)
          return { ...f, branch: '', ahead: 0, behind: 0, isRepo: false, staged: [], changes: [] }
        return { ...f, isRepo: true, ...parseStatus(run.stdout) }
      }),
    )
    const prev = await read($, repos)
    if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, repos, () => next)
  }
}

// Code draws at most 100000 characters, and a hunk cut midway does not parse.
const MAX_DIFF = 95000

async function openDiff($: any, repo: Repo, change: Change, isStaged: boolean) {
  const gitDiff = async (context: string) => {
    const argv = isStaged
      ? ['git', 'diff', context, '--cached', '--', change.path]
      : change.code === 'U'
        ? ['git', 'diff', context, '--no-index', '--', '/dev/null', change.path]
        : ['git', 'diff', context, '--', change.path]
    const run = await $.process.run(argv, { cwd: repo.path })
    const at = run.stdout.indexOf('@@')
    // Drop the `diff --git` / `index` header: Code reads hunks only.
    return { hunks: at < 0 ? '' : run.stdout.slice(at), raw: run.stdout || run.stderr }
  }
  // Whole file around the changes, as VS Code's inline diff; a huge file falls back to 3 lines.
  let isFullFile = true
  let out = await gitDiff('--unified=100000')
  if (out.hunks.length > MAX_DIFF) {
    isFullFile = false
    out = await gitDiff('--unified=3')
  }
  const view: DiffView = {
    repo: repo.name,
    path: change.path,
    isStaged,
    isFullFile,
    text: out.hunks.slice(0, MAX_DIFF) || out.raw || '(no textual diff)',
  }
  await update($, diff, () => view)
}

const openPane = ($: any) => $.ui.open({ id: PANE, title: TITLE, columns: 48 })

// The engine draws another plugin's Buttons only in the site that drew them, so in the pane
// they become their text, and the ones ponytail runs as commands become this plugin's own.
// shortcut: only ponytail's Review and Audit stay pressable; add keys here when a band adds commands.
const BAND_KEYS = ['review', 'audit']

const bandAction = ($: any, key: string) => $.command.run({ command: `ponytail:ponytail-${key}`, args: '' })

export function unbutton(node: any, keys: string[]): any {
  if (!node || typeof node !== 'object') return node
  // The engine's own part of the band stays out of the pane.
  if (node.type === 'engine') return null
  if (node.type === 'Button') {
    if (BAND_KEYS.includes(node.props?.key)) keys.push(node.props.key)
    return node.children?.length ? { type: 'Text', children: node.children } : null
  }
  // The band sized itself to its own width; the pane is narrower.
  const { width, ...props } = node.props ?? {}
  const children = node.children?.map((c: any) => unbutton(c, keys)).filter((c: any) => c !== null)
  return { ...node, props, ...(children && { children }) }
}

// Rows a tree takes: a column Box sums its children, anything else is its tallest part.
// shortcut: a Text that wraps or a flexWrap row counts as one row, so the thumb drifts there; measure if the engine ever reports it.
export function rowsOf(node: any): number {
  if (node == null || typeof node === 'boolean') return 0
  if (typeof node !== 'object') return String(node).split('\n').length
  if (node.type === 'Code') return String(node.props?.source ?? '').split('\n').length
  const rows = (node.children ?? []).flat().map(rowsOf)
  const own = node.type === 'Box' && node.props?.flexDirection === 'column'
    ? rows.reduce((a: number, b: number) => a + b, 0)
    : Math.max(node.type === 'Box' ? 0 : 1, ...rows)
  return Math.max(own, typeof node.props?.minHeight === 'number' ? node.props.minHeight : 0)
}

// The scrollbar's thumb in a window of `rows` over `total` rows, on a track of `track` cells:
// the window's top row, then the thumb's start and size on the track.
// `top` is the engine's offset as is: `total` is counted and may be short, and the engine already keeps the window in the tree.
export function scrollThumb(offset: number, rows: number, total: number, track = rows) {
  const top = Math.max(0, offset)
  const size = Math.max(1, Math.round((track * rows) / total))
  return { top, at: Math.round(Math.min(1, top / (total - rows)) * (track - size)), size }
}

// Runs a git action, toasts its failure, then rescans so the pane follows.
async function git($: any, repo: Repo, args: string[], doing?: string) {
  if (doing) $.ui.toast(`${repo.name}: ${doing}…`)
  const run = await $.process
    .run(['git', ...args], { cwd: repo.path, env: { GIT_TERMINAL_PROMPT: '0' } })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (run.exitCode !== 0) $.ui.toast(`${repo.name}: git ${args[0]} failed: ${(run.stderr || run.stdout).trim().split('\n').pop()}`)
  else if (doing) $.ui.toast(`${repo.name}: ${args[0]} done`)
  await refresh($)
}

// Push/pull/discard waiting for a yes, as VS Code asks first. Module variable: a reload drops the question.
let pending: { repo: string; op: 'push' | 'pull' } | { repo: string; op: 'discard'; change: Change } | null = null
const ask = ($: any, value: typeof pending) => {
  pending = value
  $.ui.invalidate('ui.render')
}

const stage = ($: any, repo: Repo, paths: string[]) => git($, repo, ['add', '-A', '--', ...paths])
// reset, unlike restore --staged, also works before the first commit
const unstage = ($: any, repo: Repo, items: Change[]) =>
  git($, repo, ['reset', '-q', '--', ...items.flatMap(c => (c.orig ? [c.path, c.orig] : [c.path]))])
// The working tree back to the index; an untracked file is deleted, as VS Code's Discard Changes.
const discard = ($: any, repo: Repo, c: Change) =>
  git($, repo, c.code === 'U' ? ['clean', '-fq', '--', c.path] : ['checkout', '-q', '--', c.path])

// The file row whose ⋯ menu is open. Module variable, as pending.
let menu: string | null = null
const setMenu = ($: any, key: string | null) => {
  menu = key
  $.ui.invalidate('ui.render')
}

// The freedesktop file manager selects the file (Dolphin, Nautilus...); else xdg-open shows its folder; else macOS's open -R.
async function reveal($: any, repo: Repo, c: Change) {
  const file = join(repo.path, c.path)
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const shown = c.code === 'D' ? dir : file
  // encoded per segment: dbus-send splits an array on commas
  const uri = 'file://' + shown.split('/').map(encodeURIComponent).join('/')
  for (const argv of [
    ['dbus-send', '--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'],
    ['xdg-open', dir],
    ['open', '-R', shown],
  ]) {
    const run = await $.process.run(argv, { cwd: repo.path }).catch(() => null)
    if (run?.exitCode === 0) return
  }
  $.ui.toast(`${repo.name}: no file manager found to show ${c.path}`)
}

// The children Run and Debug started, by launch key. Module variables: a reload ends them, as the engine kills a module's children.
type Run = { stream: any; out: string; code?: number | null; signal?: string | null }
const runs = new Map<string, Run>()
// The launch whose output the pane shows.
let output: string | null = null
const showOutput = ($: any, key: string | null) => {
  output = key
  $.ui.invalidate('ui.render')
}

// Run and Debug's list, open above its line. Module variable, as menu.
let isPicking = false
const setPicking = ($: any, value: boolean) => {
  isPicking = value
  $.ui.invalidate('ui.render')
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
const MAX_OUTPUT = 50000
const isRunning = (key: string) => runs.has(key) && !('code' in runs.get(key)!)

// ${env:X} from the host environment, which $.env reads only by literal name.
async function hostEnv($: any, texts: string[]) {
  const names = [...new Set(texts.flatMap(t => [...t.matchAll(/\$\{env:([^}]+)\}/g)].map(m => m[1]!)))]
  const values = await Promise.all(
    names.map(n => $.process.run(['printenv', n]).then((r: any) => r.stdout.replace(/\n$/, ''), () => '')),
  )
  return (t: string) => t.replace(/\$\{env:([^}]+)\}/g, (_, n) => values[names.indexOf(n)] ?? '')
}

async function start($: any, l: Launch, all: Launch[]) {
  // a compound, or a task's dependsOn
  for (const k of l.parts ?? []) {
    const part = all.find(x => x.key === k)
    if (part?.argv || part?.parts) void start($, part, all)
    else $.ui.toast(`${l.name}: nothing runnable named ${k.slice(k.indexOf(':') + 1)}`)
  }
  if (!l.argv || isRunning(l.key)) return
  const env = l.env ?? {}
  const sub = await hostEnv($, [...l.argv, l.cwd ?? '', ...Object.values(env)])
  const run: Run = {
    stream: $.process.spawn({
      argv: l.argv.map(sub),
      cwd: l.cwd && sub(l.cwd),
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sub(v)])),
    }),
    out: `$ ${l.argv.join(' ')}\n`,
  }
  runs.set(l.key, run)
  $.ui.invalidate('ui.render')
  try {
    // read by hand: the loop's return value is { code, signal }, which stream.result can miss
    let step
    while (!(step = await run.stream.next()).done) {
      run.out = (run.out + step.value.text.replace(ANSI, '')).slice(-MAX_OUTPUT)
      if (output === l.key) $.ui.invalidate('ui.render')
    }
    Object.assign(run, step.value)
  } catch (err) {
    // stopped (the stream closed early) or never started
    run.out += `\n${err}\n`
    run.code ??= null
    run.signal ??= 'stopped'
  }
  // always ended, so ▶ can start it again
  run.code ??= null
  run.out += `\n[exited${run.signal ? ` by ${run.signal}` : ` with ${run.code}`}]\n`
  if (run.code) $.ui.toast(`${l.name}: exited with ${run.code}`)
  $.ui.invalidate('ui.render')
}

// Closing the stream kills the child.
const stop = (key: string) => void runs.get(key)?.stream.return(undefined)

const toggle = ($: any, key: string) =>
  update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-changes',
      description: 'Show the Source Control pane (git changes of the workspace folders)',
    })
    void refresh($)
    $.clock.every(4000, () => void refresh($))
    void openPane($)
    return next(e)
  })

  on('command.run', { command: 'git-changes' }, async $ => {
    await refresh($)
    await openPane($)
    return { text: 'Source Control pane opened.' }
  })

  // Claude's own edits show up without waiting for the timer.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isShown = false
      $.ui.invalidate('ui.render')
    }
    return closed
  })

  // Pane open: the band's rows move into it, so the prompt gets the space. Closed: the band plus a reopen button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e).catch(() => undefined)
    const { Box, Button } = $.ui.resolve(e)
    if (isShown) {
      const key = JSON.stringify(below ?? null)
      if (key !== bandKey) {
        band = below ?? null
        bandKey = key
        $.ui.invalidate('ui.render')
      }
      return <Box />
    }
    const reopen = (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="git-changes-open" plain onPress={() => void openPane($)}>
          ⎇ Source Control
        </Button>
      </Box>
    )
    return below ? <Box flexDirection="column">{below}{reopen}</Box> : reopen
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    if (!isShown) {
      // Drawn means placed: now the band can move in here.
      isShown = true
      $.ui.invalidate('ui.render')
    }

    const rule = (
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(e.props.bodyColumns)}
      </Text>
    )
    const configs = await read($, launches)
    const closed = await read($, collapsed)
    const pick = await read($, selected)
    const picked = configs.find(l => l.key === pick) ?? configs.find(l => l.argv || l.parts) ?? configs[0]

    const tagOf = (l: Launch) =>
      !(l.argv || l.parts) ? `${l.type ?? '?'} (unsupported)` : l.kind === 'launch' ? l.source : `${l.kind} · ${l.source}`
    const statusOf = (key: string) => {
      const run = runs.get(key)
      if (isRunning(key)) return <Text color="#89d185">●</Text>
      return run && run.code !== 0 ? <Text color="#f14c4c">{run.signal ?? run.code}</Text> : null
    }

    // Run and Debug as VS Code's: one line, ▶ / ■ for the picked entry, its name opening the list above it.
    const runSection = () => {
      if (!picked) return <Text dimColor>Nothing to run</Text>
      const isLive = isRunning(picked.key)
      const isRunnable = !!(picked.argv || picked.parts)
      // the others running, out of sight while the list is closed
      const others = [...runs.keys()].filter(k => isRunning(k) && k !== picked.key).length
      return (
        <Box flexDirection="column">
          {isPicking &&
            configs.map(l => (
              <Box key={`pick-row:${l.key}`} flexDirection="row" justifyContent="space-between">
                <Button
                  plain
                  key={`pick:${l.key}`}
                  onPress={() => {
                    setPicking($, false)
                    void update($, selected, () => l.key)
                  }}
                >
                  <Text bold={l.key === picked.key} dimColor={!(l.argv || l.parts)} wrap="truncate-end">
                    {l.key === picked.key ? '› ' : '  '}
                    {l.name}
                  </Text>
                </Button>
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  {statusOf(l.key)}
                  <Text dimColor>{tagOf(l)}</Text>
                </Box>
              </Box>
            ))}
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={1} flexShrink={1}>
              {isRunnable ? (
                <Button
                  plain
                  key={`${isLive ? 'stop' : 'run'}:${picked.key}`}
                  label={isLive ? '■' : '▶'}
                  onPress={() => (isLive ? stop(picked.key) : void start($, picked, configs))}
                />
              ) : (
                <Text dimColor>·</Text>
              )}
              <Button plain key="run-pick" onPress={() => setPicking($, !isPicking)}>
                <Text bold wrap="truncate-end">
                  {picked.name}
                </Text>{' '}
                {isPicking ? '▴' : '▾'}
              </Button>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {statusOf(picked.key)}
              {runs.has(picked.key) && (
                <Button plain key={`output:${picked.key}`} label="Output" onPress={() => showOutput($, picked.key)} />
              )}
              {others > 0 && <Text dimColor>+{others}</Text>}
            </Box>
          </Box>
        </Box>
      )
    }

    // The engine scrolls the body but draws no bar: one in the last column, over the rows in view.
    // Home at its top and End at its bottom, for the mouse; a pane too short for them has the track alone.
    // shortcut: no Page Up/Down here, as $.ui.scroll takes no row and the plugin's own call skips its ui.scroll hook; the wheel and the keys page.
    const scrollbar = (total: number) => {
      const rows = e.props.scroll.bodyRows
      const hasKeys = rows >= 4
      const { top, at, size } = scrollThumb(e.props.scroll.offset, rows, total, hasKeys ? rows - 2 : rows)
      const track = Array.from({ length: hasKeys ? rows - 2 : rows }, (_, i) =>
        i >= at && i < at + size ? <Text color={TEXT}>┃</Text> : <Text dimColor>│</Text>,
      )
      return (
        <Box position="absolute" top={top} right={0} flexDirection="column">
          {hasKeys && <Button plain key="scroll:home" label="⤒" dimColor onPress={() => void $.ui.scroll({ in: PANE, to: 'start' })} />}
          {track}
          {hasKeys && <Button plain key="scroll:end" label="⤓" dimColor onPress={() => void $.ui.scroll({ in: PANE, to: 'end' })} />}
        </Box>
      )
    }

    // The band, then Run and Debug, at the pane's bottom edge.
    const withBand = (body: any) => {
      const keys: string[] = []
      const text = band && unbutton(band, keys)
      const content = (
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="column" flexGrow={1}>
            {body}
          </Box>
          {band && rule}
          {band && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {text}
              {keys.map(k => (
                <Button key={`band:${k}`} plain onPress={() => void bandAction($, k)}>
                  {k[0]!.toUpperCase() + k.slice(1)}
                </Button>
              ))}
            </Box>
          )}
          {rule}
          {runSection()}
        </Box>
      )
      const rows = e.props.scroll.bodyRows
      const total = rowsOf(content)
      // the last column stays the bar's, so rows do not shift when it appears
      return (
        <Box flexDirection="column" minHeight={rows} paddingRight={1}>
          {content}
          {total > rows && scrollbar(total)}
        </Box>
      )
    }

    const shown = output ? configs.find(l => l.key === output) : undefined
    const run = output ? runs.get(output) : undefined
    if (shown && run) {
      const isLive = isRunning(shown.key)
      return withBand(
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => showOutput($, null)}>
              ← Back
            </Button>
            <Text bold wrap="truncate-end">
              {shown.name}
            </Text>
            <Text dimColor>{isLive ? '(running)' : '(exited)'}</Text>
          </Box>
          <Code source={run.out.split('\n').slice(-e.props.scroll.bodyRows).join('\n')} format="source" wrap="truncate-end" />
        </Box>,
      )
    }

    const view = await read($, diff)

    if (view) {
      return withBand(
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => void update($, diff, () => null)}>
              ← Back
            </Button>
            <Text bold wrap="truncate-start">
              {basename(view.path)}
            </Text>
            <Text dimColor>{view.isStaged ? '(Index)' : '(Working Tree)'}</Text>
          </Box>
          <Text dimColor wrap="truncate-start">
            {view.repo}/{view.path}
          </Text>
          {!view.isFullFile && <Text dimColor>Large file: showing changed hunks only.</Text>}
          <Code source={view.text} path={view.path} format={view.text.startsWith('@@') ? 'diff' : 'source'} wrap="truncate-end" />
        </Box>,
      )
    }

    const list = await read($, repos)
    const total = list.reduce((n, r) => n + r.staged.length + r.changes.length, 0)

    const fileRow = (repo: Repo, c: Change, isStaged: boolean) => {
      const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''
      const isDeleted = c.code === 'D'
      const rowKey = `${repo.name}:${isStaged ? 's' : 'w'}:${c.path}`
      // one line: the indent, the name, a space, then ⋯ ↶ + M (staged: ⋯ − M), and the scrollbar's column
      const width = e.props.bodyColumns - 1 - 4 - 1 - (isStaged ? 5 : 7)
      const label = fadeOut(
        [
          { text: basename(c.path), color: COLORS[c.code] ?? TEXT, strike: isDeleted },
          ...(dir ? [{ text: ` ${dir}`, color: DIM, dim: true }] : []),
        ],
        width,
      )
      return (
        <Box key={`row:${rowKey}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" flexShrink={1}>
              <Text>{'    '}</Text>
              <Button
                plain
                key={rowKey}
                onPress={() => void openDiff($, repo, c, isStaged)}
              >
                <Text wrap="truncate-end">
                  {label.map(l => (
                    <Text color={l.dim ? undefined : l.color} dimColor={l.dim} strikethrough={l.strike}>
                      {l.text}
                    </Text>
                  ))}
                </Text>
              </Button>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Button plain key={`menu:${rowKey}`} label="⋯" onPress={() => setMenu($, menu === rowKey ? null : rowKey)} />
              {!isStaged && (
                <Button
                  plain
                  key={`discard:${repo.name}:${c.path}`}
                  label="↶"
                  onPress={() => ask($, { repo: repo.name, op: 'discard', change: c })}
                />
              )}
              <Button
                plain
                key={`${isStaged ? 'unstage' : 'stage'}:${repo.name}:${c.path}`}
                label={isStaged ? '−' : '+'}
                onPress={() => void (isStaged ? unstage($, repo, [c]) : stage($, repo, [c.path]))}
              />
              <Text color={COLORS[c.code]}>{c.code}</Text>
            </Box>
          </Box>
          {menu === rowKey && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text>{'      '}</Text>
                <Button
                  plain
                  key={`reveal:${rowKey}`}
                  label="› Reveal in File Explorer"
                  onPress={() => {
                    setMenu($, null)
                    void reveal($, repo, c)
                  }}
                />
              </Box>
              <Box flexDirection="row">
                <Text>{'      '}</Text>
                <Button plain key={`menu-close:${rowKey}`} label="› Close" onPress={() => setMenu($, null)} />
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const group = (repo: Repo, label: string, items: Change[], isStaged: boolean) => {
      if (items.length === 0) return null
      const key = `${repo.name}:${isStaged ? 'staged' : 'changes'}`
      const isOpen = !closed.includes(key)
      return (
        <Box key={`g:${key}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              <Text>{'  '}</Text>
              <Button plain key={key} onPress={() => void toggle($, key)}>
                {isOpen ? '▾' : '▸'} {label}
              </Button>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button
                plain
                key={`${isStaged ? 'unstage' : 'stage'}-all:${repo.name}`}
                label={isStaged ? '−' : '+'}
                onPress={() => void (isStaged ? git($, repo, ['reset', '-q']) : git($, repo, ['add', '-A']))}
              />
              <Text dimColor>{items.length}</Text>
            </Box>
          </Box>
          {isOpen && items.map(c => fileRow(repo, c, isStaged))}
        </Box>
      )
    }

    return withBand(
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>SOURCE CONTROL</Text>
          <Text dimColor>{total}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>No folders found (no .code-workspace or git repo here).</Text>}
        {list.map(repo => {
          const isOpen = !closed.includes(repo.name)
          const count = repo.staged.length + repo.changes.length
          return (
            <Box key={`repo:${repo.name}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Button plain key={repo.name} onPress={() => void toggle($, repo.name)}>
                  {isOpen ? '▾' : '▸'} <Text bold>{repo.name}</Text>{' '}
                  <Text dimColor>
                    {repo.isRepo ? ` ${repo.branch}` : 'not a git repo'}
                  </Text>
                </Button>
                <Box flexDirection="row" gap={1}>
                  {repo.isRepo && (
                    <Button plain key={`fetch:${repo.name}`} label="Fetch" onPress={() => void git($, repo, ['fetch'], 'fetching')}>↻</Button>
                  )}
                  {repo.behind > 0 && (
                    <Button plain key={`pull:${repo.name}`} label={`Pull ${repo.behind}`} onPress={() => ask($, { repo: repo.name, op: 'pull' })}>{`↓${repo.behind}`}</Button>
                  )}
                  {repo.ahead > 0 && (
                    <Button plain key={`push:${repo.name}`} label={`Push ${repo.ahead}`} onPress={() => ask($, { repo: repo.name, op: 'push' })}>{`↑${repo.ahead}`}</Button>
                  )}
                  {count > 0 && <Text color="#3794ff">{count}</Text>}
                </Box>
              </Box>
              {pending?.repo === repo.name && (
                <Box flexDirection="row" gap={1}>
                  <Text color="#3794ff">
                    {'  '}
                    {pending.op === 'discard'
                      ? pending.change.code === 'U'
                        ? `Delete untracked ${basename(pending.change.path)}?`
                        : `Discard changes in ${basename(pending.change.path)}?`
                      : pending.op === 'push'
                        ? `Push ${repo.ahead} commit${repo.ahead === 1 ? '' : 's'} from ${repo.branch}?`
                        : `Pull ${repo.behind} commit${repo.behind === 1 ? '' : 's'} into ${repo.branch}?`}
                  </Text>
                  <Button
                    key={`confirm:${repo.name}`}
                    hotkey="y"
                    onPress={() => {
                      const p = pending!
                      ask($, null)
                      if (p.op === 'discard') void discard($, repo, p.change)
                      else void git($, repo, [p.op], p.op === 'push' ? 'pushing' : 'pulling')
                    }}
                  >
                    Yes
                  </Button>
                  <Button key={`cancel:${repo.name}`} hotkey="n" onPress={() => ask($, null)}>
                    No
                  </Button>
                </Box>
              )}
              {isOpen && repo.isRepo && count === 0 && <Text dimColor>{'    '}No changes</Text>}
              {isOpen && group(repo, 'Staged Changes', repo.staged, true)}
              {isOpen && group(repo, 'Changes', repo.changes, false)}
            </Box>
          )
        })}
      </Box>,
    )
  })
}
