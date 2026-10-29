// Анализ журнала для /limits: недели (окна 7d), текущие окна и что осталось до сброса.
// Чистые функции: всё на входе, снимок с данными на выходе; тексты — в view.ts.
//
// День недели — 24 часа от начала окна 7d (сброс минус 7 дней), 0 … 6: у недели ровно 7 дней, и
// недели сравниваются день в день.
import type { SessionRateLimit } from 'claude-code'

import type { Analysis, DayBudget, NowReport, WeekReport, WindowNow } from '../types'
import type { Row } from './files'
import { DAY, H5, WEEK } from './format'

// Доля недели, раньше которой прогноз по темпу недели не считается: ~3 часа, слишком шумно.
const MIN_FORECAST_SHARE = 0.02
// Сколько последних законченных недель берут полоса «по прошлым неделям» и прогноз.
const PAST_WEEKS = 5
// Окно 5h: раньше этого процента и этого времени от начала окна темп окна не считается.
const MIN_H5_PCT = 5
const MIN_H5_ELAPSED = 15 * 60

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0)
const toUnix = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined)

// День недели (0 … 6) момента t, unix-секунды.
const dayOf = (t: number, reset: number) => Math.min(6, Math.max(0, Math.floor((t - (reset - WEEK)) / DAY)))
const rowDay = (r: Row) => dayOf(Date.parse(r.ts) / 1000, r.d7Reset)

function addTo<K>(map: Map<K, number>, key: K, value: number) {
  map.set(key, (map.get(key) ?? 0) + value)
}

function maxTo<K>(map: Map<K, number>, key: K, value: number) {
  map.set(key, Math.max(map.get(key) ?? 0, value))
}

// Прирост 7d от записи к записи. Окно начинается с нуля; меньший процент — сброс вне расписания,
// прироста не даёт.
function d7Deltas(rows: Row[]): Map<Row, number> {
  const deltas = new Map<Row, number>()
  let prev = 0
  for (const r of rows) {
    deltas.set(r, Math.max(0, r.d7 - prev))
    prev = r.d7
  }
  return deltas
}

function week(reset: number, rows: Row[], nowSec: number): WeekReport {
  const deltas = d7Deltas(rows)

  const byDay = new Map<number, number>()
  const byModel = new Map<string, number>()
  const h5 = new Map<number, number>()
  for (const r of rows) {
    const delta = deltas.get(r)!
    addTo(byDay, rowDay(r), delta)
    if (delta > 0) addTo(byModel, r.model || '?', delta)
    if (r.h5Reset > 0) maxTo(h5, r.h5Reset, r.h5)
  }

  const withTurns = rows.filter(r => r.turns !== undefined)
  const withCost = rows.filter(r => r.spent !== undefined)
  const d7 = rows.at(-1)?.d7 ?? 0
  const start = reset - WEEK

  const report: WeekReport = {
    reset,
    isCurrent: reset > nowSec,
    d7,
    days: [...byDay]
      .sort(([a], [b]) => a - b)
      .map(([index, delta]) => ({ index, start: start + index * DAY, delta })),
    h5: [...h5].sort(([a], [b]) => a - b).map(([reset, max]) => ({ reset, max })),
    models: [...byModel].map(([model, delta]) => ({ model, delta })).sort((a, b) => b.delta - a.delta),
    cost: withCost.length ? sum(withCost.map(r => r.spent!)) : undefined,
    costD7: withCost.length ? sum(withCost.map(r => deltas.get(r)!)) : undefined,
    sessions: new Set(rows.map(r => r.session)).size,
    turns: withTurns.length ? sum(withTurns.map(r => r.turns!)) : undefined,
    turnsDelta: withTurns.length ? sum(withTurns.map(r => deltas.get(r)!)) : undefined,
    rows: rows.length,
  }

  if (report.isCurrent) {
    const share = Math.min(1, Math.max(0, (nowSec - start) / WEEK))
    if (share > MIN_FORECAST_SHARE) {
      report.forecast = Math.round(d7 / share)
      if (d7 > 0 && report.forecast > 100) {
        report.exhaustAt = Math.round(start + ((nowSec - start) * 100) / d7)
      }
    }
  }
  return report
}

// =============================================================================
// Режим now
// =============================================================================

// Окно 5h кончится при темпе этого окна (начало окна — сброс минус 5 часов) — когда, если раньше
// сброса.
function h5ExhaustAt(h5: WindowNow | undefined, nowSec: number): number | undefined {
  if (!h5?.resetsAt || h5.pct < MIN_H5_PCT) return undefined
  const start = h5.resetsAt - H5
  const elapsed = nowSec - start
  if (elapsed < MIN_H5_ELAPSED) return undefined
  const at = Math.round(start + (elapsed * 100) / h5.pct)
  return at < h5.resetsAt ? at : undefined
}

// Средний прирост 7d по дню недели (0 … 6) в законченных неделях.
function dayAverages(complete: WeekReport[]): number[] {
  const totals = [0, 0, 0, 0, 0, 0, 0]
  for (const w of complete) for (const d of w.days) totals[d.index]! += d.delta
  return totals.map(t => t / complete.length)
}

// Ожидаемый 7d к сбросу по среднему приросту законченных недель: остаток сегодняшнего дня — его
// долей, дальше — дни целиком.
function forecastByWeeks(
  d7: number,
  reset: number,
  nowSec: number,
  averages: number[],
): { forecast: number; exhaustAt?: number } {
  const start = reset - WEEK
  let acc = d7
  let exhaustAt: number | undefined
  for (let i = dayOf(nowSec, reset); i < 7; i++) {
    const from = Math.max(nowSec, start + i * DAY)
    const end = start + (i + 1) * DAY
    const growth = (averages[i]! * (end - from)) / DAY
    if (exhaustAt === undefined && acc < 100 && acc + growth >= 100) {
      exhaustAt = Math.round(from + ((100 - acc) / growth) * (end - from))
    }
    acc += growth
  }
  return { forecast: Math.round(acc), exhaustAt }
}

// amount по весам; веса нулевые — поровну.
function split(amount: number, weights: number[]): number[] {
  const total = sum(weights)
  return weights.map(w => (total > 0 ? (amount * w) / total : amount / weights.length))
}

// Бюджеты дней недели: прошедшие — сколько потрачено; сегодня — его доля остатка, а если потрачено
// больше — потраченное; будущие делят то, что осталось после сегодня, по весам.
function dayBudgets(used: number[], today: number, weights: number[]): DayBudget[] {
  const left = Math.max(0, 100 - sum(used.slice(0, today)))
  const todayBudget = Math.max(used[today]!, split(left, weights.slice(today))[0]!)
  const future = split(Math.max(0, left - todayBudget), weights.slice(today + 1))
  return used.map((u, i) => ({
    budget: i < today ? u : i === today ? todayBudget : future[i - today - 1]!,
    used: i <= today ? u : 0,
  }))
}

function nowReport(windows: WindowNow[], weeks: WeekReport[], rows: Row[], nowSec: number): NowReport {
  const current = weeks[0]?.isCurrent ? weeks[0] : undefined
  const h5 = windows.find(w => w.kind === 'five_hour')
  const d7Window = windows.find(w => w.kind === 'seven_day')

  // Окно 7d: из ответа API, иначе последняя запись текущей недели.
  const d7 = d7Window?.pct ?? current?.d7
  const reset = d7Window?.resetsAt ?? current?.reset
  const isOpen = d7 !== undefined && reset !== undefined && reset > nowSec

  // Сегодня — записи текущей недели за текущий день недели.
  const today = isOpen ? dayOf(nowSec, reset) : undefined
  const currentRows = current ? rows.filter(r => r.d7Reset === current.reset) : []
  const deltas = d7Deltas(currentRows)
  const todayRows = currentRows.filter(r => rowDay(r) === today)
  const spentRows = todayRows.filter(r => r.spent !== undefined)
  const turnRows = todayRows.filter(r => r.turns !== undefined)

  // Цена 1% — по всем неделям, где она известна.
  const costWeeks = weeks.filter(w => w.cost !== undefined && w.costD7)
  const costD7 = sum(costWeeks.map(w => w.costD7!))
  const turnWeeks = weeks.filter(w => w.turns !== undefined && w.turnsDelta)
  const turnsD7 = sum(turnWeeks.map(w => w.turnsDelta!))

  const report: NowReport = {
    h5ExhaustAt: h5ExhaustAt(h5, nowSec),
    today: {
      delta: sum(todayRows.map(r => deltas.get(r)!)),
      spent: spentRows.length ? sum(spentRows.map(r => r.spent!)) : undefined,
      turns: turnRows.length ? sum(turnRows.map(r => r.turns!)) : undefined,
    },
    costPerPp: costD7 > 0 ? sum(costWeeks.map(w => w.cost!)) / costD7 : undefined,
    turnsPerPp: turnsD7 > 0 ? sum(turnWeeks.map(w => w.turns!)) / turnsD7 : undefined,
  }
  if (!isOpen || today === undefined) return report

  report.left = Math.max(0, 100 - d7)
  report.secondsLeft = reset - nowSec
  report.perDay = Math.round((report.left / Math.max(1, report.secondsLeft / DAY)) * 10) / 10

  // Потрачено по дням; то, чего журнал ещё не знает (ответ API свежее записи), — сегодня.
  const used = [0, 0, 0, 0, 0, 0, 0]
  for (const d of current?.days ?? []) used[d.index] = d.delta
  used[today]! += Math.max(0, d7 - (current?.d7 ?? 0))

  // Недели — от последней к первой: последние PAST_WEEKS законченных.
  const past = weeks.filter(w => !w.isCurrent).slice(0, PAST_WEEKS)
  const averages = past.length ? dayAverages(past) : undefined
  report.week = {
    start: reset - WEEK,
    today,
    even: dayBudgets(used, today, [1, 1, 1, 1, 1, 1, 1]),
    usual: averages && dayBudgets(used, today, averages),
    pastWeeks: past.length,
  }

  if (averages) {
    Object.assign(report, forecastByWeeks(d7, reset, nowSec, averages), { basis: 'weeks' })
  } else if (current?.forecast !== undefined) {
    report.forecast = current.forecast
    report.exhaustAt = current.exhaustAt
    report.basis = 'pace'
  }
  return report
}

export function analyze(logRows: Row[], limits: SessionRateLimit[], now: number): Analysis {
  const nowSec = Math.floor(now / 1000)
  const rows = logRows.filter(r => r.d7Reset > 0)
  const resets = [...new Set(rows.map(r => r.d7Reset))].sort((a, b) => b - a)
  const weeks = resets.map(reset =>
    week(
      reset,
      rows.filter(r => r.d7Reset === reset),
      nowSec,
    ),
  )
  const windows: WindowNow[] = limits
    .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
    .map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: toUnix(l.resetsAt) }))

  return {
    at: new Date(now).toISOString(),
    windows,
    weeks,
    now: nowReport(windows, weeks, rows, nowSec),
  }
}
