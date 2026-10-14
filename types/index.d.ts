export type Usage = { calls: number; input: number; output: number }

export type Draft = { text: string; secondsLeft: number }

export type Suggestion = {
  source: string
  options: string[]
  notes: string[]
  unknown: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'en-coach': { suggestion: Suggestion | null; isBusy: boolean; isHidden: boolean; history: Suggestion[]; usage: Usage; draft: Draft | null }
  }
}
