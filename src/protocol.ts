export type UsageTier = 'GREEN' | 'YELLOW' | 'RED' | 'EXHAUSTED' | 'INFO'

export interface ParsedStats {
  sessions: number
  messages: number
  days: number
  totalCostUsd: number
  avgCostPerDayUsd: number
  inputTokens: string
  outputTokens: string
  cacheReadTokens: string
  cacheWriteTokens: string
}

export interface CreditPoolState {
  startBalance: number
  currentBalance: number
  budget: number
  updatedAt: number
}

export interface UsageSnapshot {
  tier: UsageTier
  percentUsed: number | null
  source: 'credits' | 'daily-budget' | 'stats-only'
  hostLabel: string
  today: ParsedStats | null
  allTime: ParsedStats | null
  credits: CreditPoolState | null
  statusText: string
  tooltip: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  updatedAt: number
  error: string | null
}

export interface SetCreditsInput {
  startBalance: number
  currentBalance: number
  budget?: number | null
}

export type PluginRequests = {
  'usage.get': { params?: Record<string, never>; result: UsageSnapshot }
  'usage.refresh': { params?: Record<string, never>; result: UsageSnapshot }
  'usage.setCredits': { params: SetCreditsInput; result: UsageSnapshot }
  'usage.clearCredits': { params?: Record<string, never>; result: UsageSnapshot }
}

export type PluginEvents = {
  'usage.changed': UsageSnapshot
}
