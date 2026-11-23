import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Heading,
  Input,
  KeyValue,
  plugin,
  Progress,
  read,
  Row,
  set,
  Stack,
  Text,
  type PanelContext,
} from 'orca'
import type { UsageSnapshot } from './protocol'

const snapshot = atom<UsageSnapshot | null>(null)
const loading = atom(false)
const startInput = atom('startBalance', '', { persist: 'plugin' })
const currentInput = atom('currentBalance', '', { persist: 'plugin' })
const budgetInput = atom('budget', '', { persist: 'plugin' })
const formError = atom<string | null>(null)

function applySnapshot(next: UsageSnapshot): void {
  set(snapshot, next)
  if (next.credits) {
    if (!read(startInput)) set(startInput, String(next.credits.startBalance))
    if (!read(currentInput)) set(currentInput, String(next.credits.currentBalance))
    if (!read(budgetInput)) set(budgetInput, String(next.credits.budget))
  }
}

async function refreshNow(): Promise<void> {
  set(loading, true)
  try {
    const next = (await plugin.request('usage.refresh')) as UsageSnapshot
    applySnapshot(next)
  } finally {
    set(loading, false)
  }
}

async function saveCredits(): Promise<void> {
  const start = Number.parseFloat(read(startInput).trim())
  const current = Number.parseFloat(read(currentInput).trim())
  const rawBudget = read(budgetInput).trim()
  const budget = rawBudget.length > 0 ? Number.parseFloat(rawBudget) : null

  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(current) || current < 0) {
    set(formError, '시작 잔액(> 0)과 현재 잔액(>= 0)을 숫자로 입력하세요.')
    return
  }
  if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) {
    set(formError, '예산은 0보다 큰 숫자이거나 비워 두세요(기본 50%).')
    return
  }

  set(formError, null)
  set(loading, true)
  try {
    const next = (await plugin.request('usage.setCredits', {
      startBalance: start,
      currentBalance: current,
      budget,
    })) as UsageSnapshot
    applySnapshot(next)
  } finally {
    set(loading, false)
  }
}

async function clearCredits(): Promise<void> {
  set(loading, true)
  try {
    const next = (await plugin.request('usage.clearCredits')) as UsageSnapshot
    set(startInput, '')
    set(currentInput, '')
    set(budgetInput, '')
    set(formError, null)
    applySnapshot(next)
  } finally {
    set(loading, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('usage.changed', (payload) => applySnapshot(payload as UsageSnapshot)),
  )
  void plugin.request('usage.get').then((answer) => applySnapshot(answer as UsageSnapshot))
}

export default function Panel() {
  const data = read(snapshot)
  const isBusy = read(loading)
  const errMsg = read(formError)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading level={2}>GenCode Usage</Heading>
          <Text size="xs" muted>
            대상: {data?.hostLabel ?? 'local'}
          </Text>
        </Stack>
        <Row gap="xs" align="center">
          <Badge tone={data?.tone ?? 'neutral'}>{data?.tier ?? 'LOADING'}</Badge>
          <Button size="xs" variant="outline" icon="refresh" disabled={isBusy} onPress={refreshNow}>
            새로고침
          </Button>
        </Row>
      </Row>

      {data?.error ? (
        <Callout tone="warning" title="조회 경고" icon="warning">
          <Text size="xs">{data.error}</Text>
        </Callout>
      ) : null}

      {data?.percentUsed !== null && data?.percentUsed !== undefined ? (
        <Card title="USAGE_STATE.gencode">
          <Stack gap="xs">
            <Row justify="between">
              <Text size="sm" weight="semibold">
                소진율 {data.percentUsed.toFixed(1)}%
              </Text>
              <Text size="xs" muted>
                {data.source === 'credits' ? '크레딧 풀 기준' : '일일 USD 예산 기준'}
              </Text>
            </Row>
            <Progress label="GenCode 사용률" value={Math.min(100, Math.max(0, data.percentUsed))} />
          </Stack>
        </Card>
      ) : null}

      <Card title="오늘 (gencode stats --days 1)">
        <KeyValue
          items={[
            { label: '비용', value: data?.today ? `$${data.today.totalCostUsd.toFixed(2)}` : '-' },
            { label: '세션 / 메시지', value: data?.today ? `${data.today.sessions} / ${data.today.messages}` : '-' },
            { label: 'Input / Output', value: data?.today ? `${data.today.inputTokens} / ${data.today.outputTokens}` : '-' },
            { label: 'Cache Read', value: data?.today ? data.today.cacheReadTokens : '-' },
          ]}
        />
      </Card>

      <Card title="누적 (gencode stats)">
        <KeyValue
          items={[
            { label: '총 비용', value: data?.allTime ? `$${data.allTime.totalCostUsd.toFixed(2)}` : '-' },
            { label: '일평균 비용', value: data?.allTime ? `$${data.allTime.avgCostPerDayUsd.toFixed(2)}` : '-' },
            { label: '세션 / 일수', value: data?.allTime ? `${data.allTime.sessions} / ${data.allTime.days}일` : '-' },
            { label: 'Cache Read', value: data?.allTime ? data.allTime.cacheReadTokens : '-' },
          ]}
        />
      </Card>

      <Card title="크레딧 잔액 기록 (0-1 규칙)" description="시작 잔액과 현재 잔액을 입력하면 하단 상태바에 GREEN/YELLOW/RED/EXHAUSTED 소진율이 표시됩니다.">
        <Stack gap="sm">
          <Field label="시작 잔액 (GENCODE_START_BALANCE)">
            <Input
              label="시작 잔액"
              labelHidden
              value={read(startInput)}
              placeholder="예: 10000"
              onChange={(v) => set(startInput, v)}
            />
          </Field>
          <Field label="현재 잔액">
            <Input
              label="현재 잔액"
              labelHidden
              value={read(currentInput)}
              placeholder="예: 8200"
              onChange={(v) => set(currentInput, v)}
            />
          </Field>
          <Field label="이번 Run 예산 (비우면 시작 잔액의 50%)">
            <Input
              label="이번 Run 예산"
              labelHidden
              value={read(budgetInput)}
              placeholder="예: 5000"
              onChange={(v) => set(budgetInput, v)}
            />
          </Field>
          {errMsg ? (
            <Text size="xs" tone="danger">
              {errMsg}
            </Text>
          ) : null}
          <Row gap="xs">
            <Button size="sm" disabled={isBusy} onPress={saveCredits}>
              잔액 반영
            </Button>
            <Button size="sm" variant="ghost" disabled={isBusy} onPress={clearCredits}>
              초기화
            </Button>
          </Row>
        </Stack>
      </Card>
    </Stack>
  )
}
