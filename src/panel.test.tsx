import { assert, mount, test } from 'orca/testing'
import * as panelModule from './panel'

test('renders GenCode usage snapshot from worker', async () => {
  const view = await mount(panelModule, {
    requests: {
      'usage.get': {
        tier: 'YELLOW',
        percentUsed: 70,
        source: 'credits',
        hostLabel: 'local',
        today: {
          sessions: 3,
          messages: 12,
          days: 1,
          totalCostUsd: 12.5,
          avgCostPerDayUsd: 12.5,
          inputTokens: '45.2K',
          outputTokens: '11.4K',
          cacheReadTokens: '320.0K',
          cacheWriteTokens: '8.1K',
        },
        allTime: {
          sessions: 14,
          messages: 59,
          days: 34,
          totalCostUsd: 377.47,
          avgCostPerDayUsd: 11.1,
          inputTokens: '272.7K',
          outputTokens: '43.0K',
          cacheReadTokens: '1.6M',
          cacheWriteTokens: '24.9K',
        },
        credits: {
          startBalance: 10000,
          currentBalance: 6500,
          budget: 5000,
          updatedAt: 1700000000000,
        },
        statusText: 'GC 70% (6500cr)',
        tooltip: 'GenCode Usage',
        tone: 'warning',
        updatedAt: 1700000000000,
        error: null,
      },
    },
  })

  assert.ok(view.text().includes('GenCode Usage'))
  assert.ok(view.text().includes('YELLOW'))
  assert.ok(view.text().includes('$12.50'))
  assert.ok(view.text().includes('$377.47'))
  await view.unmount()
})
