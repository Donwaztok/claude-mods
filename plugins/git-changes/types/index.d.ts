export type Change = { path: string; code: string; orig?: string }
export type Repo = {
  name: string
  path: string
  branch: string
  ahead: number
  behind: number
  isRepo: boolean
  staged: Change[]
  changes: Change[]
}
// A launch configuration, task or npm script as Run and Debug lists it: a command, others to start, or a type this pane cannot run.
export type Launch = {
  key: string
  name: string
  source: string
  kind: 'launch' | 'task' | 'npm'
  type?: string
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
  parts?: string[]
}
export type DiffView = { repo: string; path: string; isStaged: boolean; isFullFile: boolean; text: string }

declare module 'claude-code' {
  interface PluginState {
    'git-changes': {
      repos: Repo[]
      collapsed: string[]
      diff: DiffView | null
      launches: Launch[]
      // the Run and Debug entry ▶ starts
      selected: string | null
    }
  }
}
