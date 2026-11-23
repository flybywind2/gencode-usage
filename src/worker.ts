import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CreditPoolState, SetCreditsInput, UsageSnapshot } from './protocol'
import {
  buildCombinedSshExecSpec,
  buildExecSpec,
  buildUsageSnapshot,
  COMBINED_STATS_MARKER,
  parseGencodeStats,
  type RunStatsTarget,
} from './stats'

export { buildCombinedSshExecSpec, buildExecSpec, type RunStatsTarget }

const execFileAsync = promisify(execFile)

const STATUS_BAR_ID = 'gencode-usage'
const CREDITS_KEY = 'gencode.credits.v1'
const SNAPSHOT_KEY = 'gencode.snapshot.v1'

export type RunStatsFn = (target: RunStatsTarget, args: string[]) => Promise<string>

function resolveLocalBinary(bin: string): string {
  if (bin !== 'gencode') return bin
  const home = homedir()
  const candidates = [
    '/opt/homebrew/bin/gencode',
    '/usr/local/bin/gencode',
    '/usr/bin/gencode',
    join(home, '.local', 'bin', 'gencode'),
    join(home, '.npm-global', 'bin', 'gencode'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return bin
}

function formatExecError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const rec = err as {
    message?: string
    stderr?: string
    stdout?: string
    killed?: boolean
    signal?: string
    code?: string | number
  }
  const stderr = typeof rec.stderr === 'string' ? rec.stderr.trim() : ''
  if (stderr) {
    return stderr.split(/\r?\n/).slice(-3).join(' | ')
  }
  if (rec.killed) {
    return `명령 실행 시간 초과 (${rec.signal ?? 'timeout'}) — SSH 연결 또는 원격 gencode 응답이 지연되었습니다.`
  }
  return rec.message ?? String(err)
}

async function defaultRunStats(target: RunStatsTarget, args: string[]): Promise<string> {
  const isSsh = target.sshHost.trim().length > 0
  const effectiveTarget: RunStatsTarget = isSsh
    ? target
    : { ...target, gencodeBin: resolveLocalBinary(target.gencodeBin) }
  const { file, argv } =
    isSsh && args.length === 1 && args[0] === '__combined__'
      ? buildCombinedSshExecSpec(effectiveTarget)
      : buildExecSpec(effectiveTarget, args)
  const { stdout } = await execFileAsync(file, argv, {
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

interface PluginSettings {
  sshHost: string
  gencodeBin: string
  refreshIntervalSec: number
  dailyBudgetUsd: number
}

async function readSettings(orca: OrcaWorkerApi): Promise<PluginSettings> {
  try {
    const response = (await orca.host.call('settings.get')) as Record<string, unknown> | undefined
    const raw =
      response && typeof response.settings === 'object' && response.settings !== null
        ? (response.settings as Record<string, unknown>)
        : response
    const sshHost = typeof raw?.sshHost === 'string' ? raw.sshHost.trim() : ''
    const gencodeBin =
      typeof raw?.gencodeBin === 'string' && raw.gencodeBin.trim().length > 0
        ? raw.gencodeBin.trim()
        : 'gencode'
    const refreshIntervalSec =
      typeof raw?.refreshIntervalSec === 'number' && Number.isFinite(raw.refreshIntervalSec)
        ? Math.min(3600, Math.max(15, Math.round(raw.refreshIntervalSec)))
        : 60
    const dailyBudgetUsd =
      typeof raw?.dailyBudgetUsd === 'number' &&
      Number.isFinite(raw.dailyBudgetUsd) &&
      raw.dailyBudgetUsd >= 0
        ? raw.dailyBudgetUsd
        : 0
    return { sshHost, gencodeBin, refreshIntervalSec, dailyBudgetUsd }
  } catch {
    return { sshHost: '', gencodeBin: 'gencode', refreshIntervalSec: 60, dailyBudgetUsd: 0 }
  }
}

async function readCredits(orca: OrcaWorkerApi): Promise<CreditPoolState | null> {
  const value = await orca.storage.get(CREDITS_KEY)
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  if (
    typeof rec.startBalance !== 'number' ||
    typeof rec.currentBalance !== 'number' ||
    typeof rec.budget !== 'number'
  ) {
    return null
  }
  return {
    startBalance: rec.startBalance,
    currentBalance: rec.currentBalance,
    budget: rec.budget,
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
  }
}

export function createActivator(runStats: RunStatsFn = defaultRunStats) {
  return function activate(orca: OrcaWorkerApi): () => void {
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false

    async function publish(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
      await orca.storage.set(SNAPSHOT_KEY, snapshot)
      try {
        await orca.host.call('statusBar.update', {
          id: STATUS_BAR_ID,
          text: snapshot.statusText,
          icon: 'gauge',
          tone: snapshot.tone,
          tooltip: snapshot.tooltip,
          visible: true,
        })
      } catch {
        // Desktop-only API: ignore when running on a headless runtime or mock without statusBar handler.
      }
      orca.panels.post('usage.changed', snapshot)
      return snapshot
    }

    async function refresh(): Promise<UsageSnapshot> {
      const [settings, credits] = await Promise.all([readSettings(orca), readCredits(orca)])
      let today = null
      let allTime = null
      let error: string | null = null

      const target: RunStatsTarget = {
        sshHost: settings.sshHost,
        gencodeBin: settings.gencodeBin,
      }

      try {
        let todayOut: string
        let allOut: string
        if (target.sshHost.trim().length > 0 && runStats === defaultRunStats) {
          const combined = await runStats(target, ['__combined__'])
          const splitIdx = combined.indexOf(COMBINED_STATS_MARKER)
          if (splitIdx >= 0) {
            todayOut = combined.slice(0, splitIdx)
            allOut = combined.slice(splitIdx + COMBINED_STATS_MARKER.length)
          } else {
            todayOut = combined
            allOut = combined
          }
        } else {
          todayOut = await runStats(target, ['stats', '--days', '1'])
          allOut = await runStats(target, ['stats'])
        }
        today = parseGencodeStats(todayOut)
        allTime = parseGencodeStats(allOut)
        if (!today && !allTime) {
          error = 'gencode stats 출력을 해석하지 못했습니다.'
        }
      } catch (err) {
        error = formatExecError(err)
      }

      const snapshot = buildUsageSnapshot({
        today,
        allTime,
        credits,
        dailyBudgetUsd: settings.dailyBudgetUsd,
        hostLabel: settings.sshHost || 'local',
        updatedAt: Date.now(),
        error,
      })
      return publish(snapshot)
    }

    orca.commands.register('gencodeUsage.refresh', async () => {
      await refresh()
    })

    orca.panels.handle('usage.get', async () => {
      const cached = await orca.storage.get(SNAPSHOT_KEY)
      if (cached && typeof cached === 'object') {
        return cached as UsageSnapshot
      }
      return refresh()
    })

    orca.panels.handle('usage.refresh', async () => refresh())

    orca.panels.handle('usage.setCredits', async (params: SetCreditsInput) => {
      const startBalance = Number(params.startBalance)
      const currentBalance = Number(params.currentBalance)
      const requestedBudget =
        params.budget !== undefined && params.budget !== null
          ? Number(params.budget)
          : startBalance * 0.5
      const budget =
        Number.isFinite(requestedBudget) && requestedBudget > 0
          ? requestedBudget
          : Math.max(1, startBalance * 0.5)
      const nextCredits: CreditPoolState = {
        startBalance: Number.isFinite(startBalance) && startBalance >= 0 ? startBalance : 0,
        currentBalance: Number.isFinite(currentBalance) && currentBalance >= 0 ? currentBalance : 0,
        budget,
        updatedAt: Date.now(),
      }
      await orca.storage.set(CREDITS_KEY, nextCredits)
      return refresh()
    })

    orca.panels.handle('usage.clearCredits', async () => {
      await orca.storage.delete(CREDITS_KEY)
      return refresh()
    })

    void readSettings(orca).then((settings) => {
      if (disposed) return
      void refresh()
      timer = setInterval(() => {
        if (!disposed) {
          void refresh()
        }
      }, settings.refreshIntervalSec * 1000)
      timer.unref?.()
    })

    return () => {
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

export default createActivator()
