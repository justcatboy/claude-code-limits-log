// Записи limits: состояние лимитов, когда окно сдвинулось на целый процент.
//
// Пишется на session.measure, в файл этой сессии. Событие приходит только в сессию, получившую
// ответ API, поэтому фильтр простаивающих сессий не нужен. Один и тот
// же сдвиг может записать каждая активная сессия — повторы убирает читатель (files.ts, toRows).
// Хуки событий подключает register.tsx.
import type { EngineInterface as Dollar, SessionMeasureInput } from 'claude-code'

import { LOG_VERSION, appendRecord, isoNow } from './files'
import type { LimitsRecord, LogWindow } from './files'
import { allTotals } from './sessions'

// effort последнего запроса основного цикла этой сессии (turn.step). Переменная модуля: после
// перезагрузки мода пусто до следующего запроса.
let effort: string | number | undefined
export const setEffort = (value: string | number | undefined) => void (effort = value)
export const currentEffort = () => effort

// Состояние окон последней записи этой сессии: то же второй раз не пишем. Переменная модуля —
// после перезагрузки мода возможен один повтор, его уберёт читатель.
let lastState: string | undefined

const toUnix = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined)

export async function recordLimits($: Dollar, e: SessionMeasureInput) {
  const windows: LogWindow[] = e.rateLimits.map(l => ({
    kind: l.kind,
    pct: l.percentUsed,
    resetsAt: toUnix(l.resetsAt),
  }))
  if (windows.length === 0) return

  // Хоть одно окно уже закончилось — значения ответа устарели.
  const now = Math.floor(Date.now() / 1000)
  if (windows.some(w => w.resetsAt !== undefined && w.resetsAt <= now)) return

  const state = windows
    .map(w => `${w.kind}:${w.pct}:${w.resetsAt ?? ''}`)
    .sort()
    .join('|')
  if (state === lastState) return

  const session = await $.session.id()
  const record: LimitsRecord = {
    v: LOG_VERSION,
    kind: 'limits',
    ts: isoNow(),
    windows,
    model: await $.session.model(),
    effort,
    session,
    costUsd: e.cost === undefined ? undefined : Math.round(e.cost.usd * 10000) / 10000,
    contextTokens: e.context.tokens,
    usageTotals: await allTotals($),
  }
  await appendRecord($, session, record)

  lastState = state
}
