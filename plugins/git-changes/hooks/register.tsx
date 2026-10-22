import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, DiffView, Repo } from '../types'

const PANE = 'git-changes'
const TITLE = 'Source Control'
const repos = atom({ plugin: 'git-changes', key: 'repos' } as const, [])
const collapsed = atom({ plugin: 'git-changes', key: 'collapsed' } as const, [])
const diff = atom({ plugin: 'git-changes', key: 'diff' } as const, null)

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
    if (x === 'R' || x === 'C') i++ // the original path follows a rename
    if (x === '!') continue
    if (x === '?') changes.push({ path, code: 'U' })
    else if (x === 'U' || y === 'U' || (x === y && (x === 'A' || x === 'D')))
      changes.push({ path, code: 'C' })
    else {
      if (x !== ' ') staged.push({ path, code: x })
      if (y !== ' ') changes.push({ path, code: y })
    }
  }
  return { branch, ahead, behind, staged, changes }
}

async function findFolders($: any): Promise<{ name: string; path: string }[]> {
  const cwd: string = await $.session.cwd()
  const entries = await $.fs.list(cwd)
  const ws = entries
    .filter((f: any) => f.name.endsWith('.code-workspace'))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))[0]
  if (ws) {
    const json = parseJsonc(await $.fs.read(`${cwd}/${ws.name}`))
    return (json.folders ?? []).map((f: any) => {
      const path = join(cwd, f.path ?? '.')
      return { name: f.name ?? basename(path), path }
    })
  }
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

async function scan($: any) {
  {
    const folders = await findFolders($)
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
    void $.ui.open({ id: PANE, title: TITLE, columns: 48 })
    return next(e)
  })

  on('command.run', { command: 'git-changes' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE, columns: 48 })
    return { text: 'Source Control pane opened.' }
  })

  // Claude's own edits show up without waiting for the timer.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const view = await read($, diff)

    if (view) {
      return (
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
        </Box>
      )
    }

    const list = await read($, repos)
    const closed = await read($, collapsed)
    const total = list.reduce((n, r) => n + r.staged.length + r.changes.length, 0)

    const fileRow = (repo: Repo, c: Change, isStaged: boolean) => {
      const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''
      const isDeleted = c.code === 'D'
      return (
        <Box key={`row:${repo.name}:${isStaged ? 's' : 'w'}:${c.path}`} flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" flexShrink={1}>
            <Text>{'    '}</Text>
            <Button
              plain
              key={`${repo.name}:${isStaged ? 's' : 'w'}:${c.path}`}
              onPress={() => void openDiff($, repo, c, isStaged)}
            >
              <Text color={COLORS[c.code]} strikethrough={isDeleted}>
                {basename(c.path)}
              </Text>{' '}
              <Text dimColor>{dir}</Text>
            </Button>
          </Box>
          <Text color={COLORS[c.code]}> {c.code}</Text>
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
            <Text dimColor>{items.length}</Text>
          </Box>
          {isOpen && items.map(c => fileRow(repo, c, isStaged))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>SOURCE CONTROL</Text>
          <Text dimColor>{total}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>No folders found (no .code-workspace or git repo here).</Text>}
        {list.map(repo => {
          const isOpen = !closed.includes(repo.name)
          const count = repo.staged.length + repo.changes.length
          const sync = [repo.behind ? `↓${repo.behind}` : '', repo.ahead ? `↑${repo.ahead}` : '']
            .filter(Boolean)
            .join(' ')
          return (
            <Box key={`repo:${repo.name}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Button plain key={repo.name} onPress={() => void toggle($, repo.name)}>
                  {isOpen ? '▾' : '▸'} <Text bold>{repo.name}</Text>{' '}
                  <Text dimColor>
                    {repo.isRepo ? ` ${repo.branch}${sync ? ' ' + sync : ''}` : 'not a git repo'}
                  </Text>
                </Button>
                {count > 0 && <Text color="#3794ff">{count}</Text>}
              </Box>
              {isOpen && repo.isRepo && count === 0 && <Text dimColor>{'    '}No changes</Text>}
              {isOpen && group(repo, 'Staged Changes', repo.staged, true)}
              {isOpen && group(repo, 'Changes', repo.changes, false)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
