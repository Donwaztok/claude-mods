export type Limit = { kind: string; percent: number; resetsAt?: string }
export type Usage = { ctx?: number; tokens?: number; window: number; limits: Limit[]; usd?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-line': { usage: Usage | null; prev: Usage | null; frame: number; animFrom: number; isWorking: boolean; model: string }
  }
}
