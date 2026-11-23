import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { buildExecSpec, createActivator } from './worker'
import { parseGencodeStats } from './stats'

const SAMPLE_TODAY = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                              3 │
│Messages                                             12 │
│Days                                                  1 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                       $12.50 │
│Avg Cost/Day                                     $12.50 │
│Input                                             45.2K │
│Output                                            11.4K │
│Cache Read                                       320.0K │
│Cache Write                                        8.1K │
└────────────────────────────────────────────────────────┘
`

const SAMPLE_ALL = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                             14 │
│Messages                                             59 │
│Days                                                 34 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                      $377.47 │
│Avg Cost/Day                                     $11.10 │
│Input                                            272.7K │
│Output                                            43.0K │
│Cache Read                                         1.6M │
│Cache Write                                       24.9K │
└────────────────────────────────────────────────────────┘
`

test('parses gencode stats table output accurately', () => {
  const parsed = parseGencodeStats(SAMPLE_ALL)
  assert.ok(parsed !== null)
  assert.equal(parsed.sessions, 14)
  assert.equal(parsed.messages, 59)
  assert.equal(parsed.days, 34)
  assert.equal(parsed.totalCostUsd, 377.47)
  assert.equal(parsed.inputTokens, '272.7K')
  assert.equal(parsed.cacheReadTokens, '1.6M')
})

test('builds local and remote SSH exec specs safely', () => {
  assert.deepEqual(buildExecSpec({ sshHost: '', gencodeBin: 'gencode' }, ['stats']), {
    file: 'gencode',
    argv: ['stats'],
  })
  assert.deepEqual(
    buildExecSpec({ sshHost: 'ubuntu@my-server', gencodeBin: '/usr/bin/gencode' }, ['stats', '--days', '1']),
    {
      file: 'ssh',
      argv: [
        '-n',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'LogLevel=ERROR',
        'ubuntu@my-server',
        '/usr/bin/gencode',
        'stats',
        '--days',
        '1',
      ],
    },
  )
  assert.throws(() => buildExecSpec({ sshHost: '-oProxyCommand=bad', gencodeBin: 'gencode' }, ['stats']))
})

test('updates status bar from gencode stats and computes credit pool tiers', async () => {
  const statusUpdates: unknown[] = []
  const host = mockHost({
    results: {
      'settings.get': {
        settings: { sshHost: '', gencodeBin: 'gencode', refreshIntervalSec: 60, dailyBudgetUsd: 0 },
      },
      'statusBar.update': (params: unknown) => {
        statusUpdates.push(params)
        return { ok: true }
      },
    },
  })

  const runStats = async (_target: { sshHost: string; gencodeBin: string }, args: string[]) =>
    args.includes('--days') ? SAMPLE_TODAY : SAMPLE_ALL

  const worker = await mountWorker({ default: createActivator(runStats) }, { host })

  const initial = await worker.request('usage.refresh')
  assert.equal(initial.tier, 'INFO')
  assert.equal(initial.statusText, 'GC $12.50/d · 11.4K out')
  assert.ok(statusUpdates.length >= 1)

  const yellow = await worker.request('usage.setCredits', {
    startBalance: 10000,
    currentBalance: 6500,
    budget: 5000,
  })
  assert.equal(yellow.tier, 'YELLOW')
  assert.equal(yellow.percentUsed, 70)
  assert.equal(yellow.tone, 'warning')
  assert.equal(yellow.statusText, 'GC 70% (6500cr)')

  const exhausted = await worker.request('usage.setCredits', {
    startBalance: 10000,
    currentBalance: 4000,
    budget: 5000,
  })
  assert.equal(exhausted.tier, 'EXHAUSTED')
  assert.equal(exhausted.tone, 'danger')

  const cleared = await worker.request('usage.clearCredits')
  assert.equal(cleared.source, 'stats-only')
  assert.equal(cleared.tier, 'INFO')

  await worker.deactivate()
})
