import type { CreditPoolState, ParsedStats, UsageSnapshot, UsageTier } from './protocol'

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
const SAFE_SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/
const SAFE_BIN_RE = /^[A-Za-z0-9_./~:-]{1,256}$/

export interface RunStatsTarget {
  sshHost: string
  gencodeBin: string
}

export const COMBINED_STATS_MARKER = '===GENCODE_ALL_STATS==='

export function buildExecSpec(
  target: RunStatsTarget,
  args: string[],
): { file: string; argv: string[] } {
  const bin = target.gencodeBin.trim() || 'gencode'
  const host = target.sshHost.trim()
  if (!host) {
    return { file: bin, argv: args }
  }
  if (!SAFE_SSH_HOST_RE.test(host)) {
    throw new Error(`유효하지 않은 SSH 호스트 형식입니다: ${host}`)
  }
  if (!SAFE_BIN_RE.test(bin)) {
    throw new Error(`SSH 원격 실행에 허용되지 않는 gencodeBin 경로입니다: ${bin}`)
  }
  return {
    file: 'ssh',
    argv: ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', host, bin, ...args],
  }
}

export function buildCombinedSshExecSpec(target: RunStatsTarget): { file: string; argv: string[] } {
  const bin = target.gencodeBin.trim() || 'gencode'
  const host = target.sshHost.trim()
  if (!SAFE_SSH_HOST_RE.test(host)) {
    throw new Error(`유효하지 않은 SSH 호스트 형식입니다: ${host}`)
  }
  if (!SAFE_BIN_RE.test(bin)) {
    throw new Error(`SSH 원격 실행에 허용되지 않는 gencodeBin 경로입니다: ${bin}`)
  }
  const remoteCmd = `${bin} stats --days 1 && echo ${COMBINED_STATS_MARKER} && ${bin} stats`
  return {
    file: 'ssh',
    argv: ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', host, remoteCmd],
  }
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}

function readRowValue(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`│\\s*${escaped}\\s+([^│]+?)\\s*│`, 'i')
  const match = text.match(re)
  return match ? match[1].trim() : null
}

function parseNumber(raw: string | null): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[$,\s]/g, '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseGencodeStats(rawOutput: string): ParsedStats | null {
  const text = stripAnsi(rawOutput)
  const totalCostRaw = readRowValue(text, 'Total Cost')
  const sessionsRaw = readRowValue(text, 'Sessions')
  if (totalCostRaw === null && sessionsRaw === null) {
    return null
  }
  return {
    sessions: Math.round(parseNumber(sessionsRaw)),
    messages: Math.round(parseNumber(readRowValue(text, 'Messages'))),
    days: Math.round(parseNumber(readRowValue(text, 'Days'))),
    totalCostUsd: parseNumber(totalCostRaw),
    avgCostPerDayUsd: parseNumber(readRowValue(text, 'Avg Cost/Day')),
    inputTokens: readRowValue(text, 'Input') ?? '0',
    outputTokens: readRowValue(text, 'Output') ?? '0',
    cacheReadTokens: readRowValue(text, 'Cache Read') ?? '0',
    cacheWriteTokens: readRowValue(text, 'Cache Write') ?? '0',
  }
}

export function tierFromPercent(percent: number): UsageTier {
  if (percent >= 100) return 'EXHAUSTED'
  if (percent >= 85) return 'RED'
  if (percent >= 60) return 'YELLOW'
  return 'GREEN'
}

export function toneFromTier(tier: UsageTier): UsageSnapshot['tone'] {
  switch (tier) {
    case 'GREEN':
      return 'success'
    case 'YELLOW':
      return 'warning'
    case 'RED':
    case 'EXHAUSTED':
      return 'danger'
    default:
      return 'neutral'
  }
}

function formatUsd(amount: number): string {
  if (amount >= 100) return `$${amount.toFixed(0)}`
  return `$${amount.toFixed(2)}`
}

function clampText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

export function buildUsageSnapshot(input: {
  today: ParsedStats | null
  allTime: ParsedStats | null
  credits: CreditPoolState | null
  dailyBudgetUsd: number
  hostLabel?: string
  updatedAt: number
  error: string | null
}): UsageSnapshot {
  const { today, allTime, credits, dailyBudgetUsd, updatedAt, error } = input
  const hostLabel = input.hostLabel && input.hostLabel.trim().length > 0 ? input.hostLabel.trim() : 'local'

  if (error && !today && !allTime && !credits) {
    return {
      tier: 'INFO',
      percentUsed: null,
      source: 'stats-only',
      hostLabel,
      today: null,
      allTime: null,
      credits: null,
      statusText: 'GenCode err',
      tooltip: clampText(`GenCode 조회 실패 (${hostLabel}): ${error}`, 256),
      tone: 'warning',
      updatedAt,
      error,
    }
  }

  let tier: UsageTier = 'INFO'
  let percentUsed: number | null = null
  let source: UsageSnapshot['source'] = 'stats-only'

  if (credits && credits.budget > 0) {
    const spent = Math.max(0, credits.startBalance - credits.currentBalance)
    percentUsed = Math.round((spent / credits.budget) * 1000) / 10
    tier = tierFromPercent(percentUsed)
    source = 'credits'
  } else if (dailyBudgetUsd > 0 && today) {
    percentUsed = Math.round((today.totalCostUsd / dailyBudgetUsd) * 1000) / 10
    tier = tierFromPercent(percentUsed)
    source = 'daily-budget'
  }

  const todayCost = today ? formatUsd(today.totalCostUsd) : null
  const allCost = allTime ? formatUsd(allTime.totalCostUsd) : null

  let statusText: string
  if (source === 'credits' && percentUsed !== null && credits) {
    statusText = `GC ${Math.round(percentUsed)}% (${Math.round(credits.currentBalance)}cr)`
  } else if (source === 'daily-budget' && percentUsed !== null && todayCost) {
    statusText = `GC ${Math.round(percentUsed)}% · ${todayCost}`
  } else if (todayCost && today && today.sessions > 0) {
    statusText = `GC ${todayCost}/d · ${today.outputTokens} out`
  } else if (allCost && allTime) {
    statusText = `GC ${allCost} (${allTime.sessions}s)`
  } else {
    statusText = 'GC $0.00'
  }

  const tooltipLines: string[] = [`GenCode Usage [${hostLabel}] (클릭해 새로고침)`]
  if (source === 'credits' && credits && percentUsed !== null) {
    tooltipLines.push(
      `크레딧 [${tier}]: ${percentUsed.toFixed(1)}% 소진 (잔액 ${credits.currentBalance} / 시작 ${credits.startBalance}, 예산 ${credits.budget})`,
    )
  } else if (source === 'daily-budget' && percentUsed !== null && today) {
    tooltipLines.push(
      `일일 예산 [${tier}]: ${percentUsed.toFixed(1)}% (${formatUsd(today.totalCostUsd)} / ${formatUsd(dailyBudgetUsd)})`,
    )
  }
  if (today) {
    tooltipLines.push(
      `오늘: ${formatUsd(today.totalCostUsd)} · ${today.sessions}세션 · In ${today.inputTokens} / Out ${today.outputTokens}`,
    )
  }
  if (allTime) {
    tooltipLines.push(
      `누적(${allTime.days}일): ${formatUsd(allTime.totalCostUsd)} · ${allTime.sessions}세션 · Cache ${allTime.cacheReadTokens}`,
    )
  }
  if (error) {
    tooltipLines.push(`경고: ${error}`)
  }

  return {
    tier,
    percentUsed,
    source,
    hostLabel,
    today,
    allTime,
    credits,
    statusText: clampText(statusText, 64),
    tooltip: clampText(tooltipLines.join('\n'), 256),
    tone: toneFromTier(tier),
    updatedAt,
    error,
  }
}
