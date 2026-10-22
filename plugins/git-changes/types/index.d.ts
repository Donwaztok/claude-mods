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
export type DiffView = { repo: string; path: string; isStaged: boolean; isFullFile: boolean; text: string }

declare module 'claude-code' {
  interface PluginState {
    'git-changes': {
      repos: Repo[]
      collapsed: string[]
      diff: DiffView | null
    }
  }
}
