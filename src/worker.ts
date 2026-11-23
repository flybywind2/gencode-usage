import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

interface CommandOutput {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runCommandRaw(file: string, argv: string[], timeoutMs: number): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${file} 실행 오류: ${err.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').trim(),
        timedOut,
      })
    })
  })
}

function resolveSshConfigPath(): string | undefined {
  const candidate = join(homedir(), '.ssh', 'config')
  return existsSync(candidate) ? candidate : undefined
}

async function defaultRunStats(target: RunStatsTarget, args: string[]): Promise<string> {
  const isSsh = target.sshHost.trim().length > 0
  const effectiveTarget: RunStatsTarget = isSsh
    ? { ...target, sshConfigPath: target.sshConfigPath ?? resolveSshConfigPath() }
    : { ...target, gencodeBin: resolveLocalBinary(target.gencodeBin) }
  const useCombined = isSsh && args.length === 1 && args[0] === '__combined__'
  const { file, argv } = useCombined
    ? buildCombinedSshExecSpec(effectiveTarget)
    : buildExecSpec(effectiveTarget, args)

  const res = await runCommandRaw(file, argv, 25_000)
  if (res.code === 0) {
    return res.stdout
  }
  if (res.timedOut) {
    throw new Error(`시간 초과(25초): ${res.stderr || 'SSH/gencode 응답 없음'}`)
  }

  let detail = res.stderr || res.stdout.trim()
  if (!detail && isSsh) {
    // Re-probe once with ssh -v so we can show the exact reason SSH exited 255.
    try {
      const diagSpec = buildCombinedSshExecSpec(effectiveTarget, true)
      const diagArgv = [...diagSpec.argv.slice(0, -1), 'true']
      const diag = await runCommandRaw('ssh', diagArgv, 10_000)
      const diagLines = (diag.stderr || diag.stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const interesting = diagLines.filter(
        (l) =>
          /denied|refused|resolve|no such|error|failed|identity|config|connecting|closed|bad|key/i.test(
            l,
          ),
      )
      const picked = (interesting.length > 0 ? interesting : diagLines).slice(-4).join(' | ')
      detail = picked || `ssh -v 출력 없음 (platform=${process.platform}, cfg=${effectiveTarget.sshConfigPath ?? 'none'})`
    } catch (diagErr) {
      detail = diagErr instanceof Error ? diagErr.message : String(diagErr)
    }
  }

  const tag = `exit=${res.code ?? 'null'}${res.signal ? `/${res.signal}` : ''}`
  throw new Error(`[${tag}] ${(detail || '(출력 없음)').split(/\r?\n/).slice(-4).join(' | ')}`)
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
        error = err instanceof Error ? err.message : String(err)
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
