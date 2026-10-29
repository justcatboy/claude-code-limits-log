// Анализ для /limits (analysis.ts): недели, прирост, стоимость, прогноз. Чистые функции.
import type { SessionRateLimit } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { analyze } from '../hooks/analysis'
import type { Row } from '../hooks/files'

const DAY = 86_400
const WEEK = 7 * DAY
// Неделя: начало и сброс в unix-секундах.
const START = Date.UTC(2026, 1, 25, 10) / 1000
const RESET = START + WEEK

function row(at: number, d7: number, extra: Partial<Row> = {}): Row {
  return {
    ts: new Date(at * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
    h5: 0,
    h5Reset: 0,
    d7,
    d7Reset: RESET,
    model: 'opus',
    session: 'A',
    ...extra,
  }
}

const after = (days: number) => START + days * DAY
const nowMs = (days: number) => after(days) * 1000

describe('неделя', () => {
  test('прирост от нуля, по дням; сброс вне расписания прироста не даёт', async () => {
    const rows = [
      row(after(0.5), 10),
      row(after(0.6), 15),
      row(after(1.5), 20),
      row(after(1.6), 5),
      row(after(2.5), 8),
    ]
    const [w] = analyze(rows, [], nowMs(8)).weeks
    expect(w!.d7).toBe(8)
    expect(w!.isCurrent).toBe(false)
    expect(w!.days.map(d => d.delta)).toEqual([15, 5, 3])
  })

  test('окна 5h — наибольший процент окна, по времени', async () => {
    const rows = [
      row(after(0.1), 1, { h5: 40, h5Reset: after(0.2) }),
      row(after(0.15), 2, { h5: 70, h5Reset: after(0.2) }),
      row(after(0.5), 3, { h5: 10, h5Reset: after(0.6) }),
    ]
    const [w] = analyze(rows, [], nowMs(8)).weeks
    expect(w!.h5).toEqual([
      { reset: after(0.2), max: 70 },
      { reset: after(0.6), max: 10 },
    ])
  })

  test('стоимость — сумма spent недели; за 1% — прирост только записей со стоимостью', async () => {
    const rows = [
      row(after(-1), 50, { d7Reset: START, spent: 4 }),
      row(after(0.5), 10),
      row(after(0.6), 12, { spent: 3 }),
      row(after(0.7), 15, { spent: 6 }),
    ]
    const weeks = analyze(rows, [], nowMs(8)).weeks
    expect(weeks.map(w => w.reset)).toEqual([RESET, START])
    expect(weeks[0]!.cost).toBe(9)
    expect(weeks[0]!.costD7).toBe(5)
  })

  test('текущая неделя: равномерный темп, прогноз и когда 100%', async () => {
    const [w] = analyze([row(after(1), 20)], [], nowMs(1.75)).weeks
    expect(w!.isCurrent).toBe(true)
    expect(w!.forecast).toBe(80)
    expect(w!.exhaustAt).toBeUndefined()

    const [fast] = analyze([row(after(1), 40)], [], nowMs(1.75)).weeks
    expect(fast!.forecast).toBe(160)
    // 40% за 1,75 дня → 100% через 4,375 дня от начала.
    expect(fast!.exhaustAt).toBe(Math.round(after(4.375)))
  })

  test('ходы на прирост — из turns строк', async () => {
    const rows = [row(after(0.5), 2, { turns: 6 }), row(after(0.6), 4, { turns: 4 })]
    const [w] = analyze(rows, [], nowMs(8)).weeks
    expect(w!.turns).toBe(10)
    expect(w!.turnsDelta).toBe(4)
  })
})

describe('сейчас', () => {
  // Текущая неделя — следующая за RESET; анализ в её середине.
  const NEXT = RESET + WEEK
  const NOW = 10.5
  const limit = (kind: string, pct: number, reset: number) =>
    ({ kind, percentUsed: pct, resetsAt: new Date(reset * 1000).toISOString() }) as SessionRateLimit
  const current = (at: number, d7: number, extra: Partial<Row> = {}) =>
    row(after(at), d7, { d7Reset: NEXT, ...extra })

  test('окно 5h: когда кончится при темпе окна, если раньше сброса', async () => {
    const reset = after(NOW) + 3 * 3600
    const fast = analyze([], [limit('five_hour', 50, reset)], nowMs(NOW)).now
    // Окно началось 2 часа назад, 50% за 2 часа → 100% через 4 часа от начала.
    expect(fast.h5ExhaustAt).toBe(after(NOW) + 2 * 3600)
    const slow = analyze([], [limit('five_hour', 20, reset)], nowMs(NOW)).now
    expect(slow.h5ExhaustAt).toBeUndefined()
  })

  test('остаток, в день, сегодня, цена 1%; без законченных недель — по темпу этой', async () => {
    const rows = [
      current(8, 20),
      current(10.4, 25, { spent: 2, turns: 5 }),
      current(10.45, 30, { spent: 3, turns: 7 }),
    ]
    const n = analyze(rows, [limit('seven_day', 30, NEXT)], nowMs(NOW)).now
    expect(n.left).toBe(70)
    expect(n.secondsLeft).toBe(3.5 * DAY)
    expect(n.perDay).toBe(20)
    expect(n.today).toEqual({ delta: 10, spent: 5, turns: 12 })
    expect(n.costPerPp).toBe(0.5)
    expect(n.turnsPerPp).toBe(1.2)
    // Полнедели прошло, 30% → к сбросу 60%.
    expect(n.basis).toBe('pace')
    expect(n.forecast).toBe(60)
  })

  test('полосы дней: сегодня перерасходовал — будущим дням остаётся меньше', async () => {
    // Вчера (день 0) +20%, сегодня (день 1) ещё +20%.
    const now = [current(7.5, 20), current(8.4, 40)]
    const seven = [limit('seven_day', 40, NEXT)]
    const round = (days: { budget: number; used: number }[]) =>
      days.map(d => [Math.round(d.budget * 100) / 100, d.used])

    const alone = analyze(now, seven, nowMs(8.5)).now.week!
    expect(alone.today).toBe(1)
    // Поровну на сегодня было бы 80 / 6 ≈ 13,3% — потрачено 20%, остальным по (100 − 40) / 5.
    expect(round(alone.even)).toEqual([
      [20, 20],
      [20, 20],
      [12, 0],
      [12, 0],
      [12, 0],
      [12, 0],
      [12, 0],
    ])
    expect(alone.usual).toBeUndefined()

    // Прошлая неделя по дням: 10, 30, 0, 0, 20, 20, 20.
    const past = [
      row(after(0.5), 10),
      row(after(1.5), 40),
      row(after(4.5), 60),
      row(after(5.5), 80),
      row(after(6.5), 100),
    ]
    const usual = analyze([...past, ...now], seven, nowMs(8.5)).now.week!.usual!
    // Сегодня 80 × 30/90 ≈ 26,7%, потрачено 20; остаток 53,3% — по 20:20:20, выходным ничего.
    expect(round(usual)).toEqual([
      [20, 20],
      [26.67, 20],
      [0, 0],
      [0, 0],
      [17.78, 0],
      [17.78, 0],
      [17.78, 0],
    ])
  })

  test('по прошлым неделям — не больше 5 последних законченных', async () => {
    // Начало k-й недели назад; 5 последних тратят в день 5, шестая — в день 3.
    const weekStart = (k: number) => NEXT - (k + 1) * WEEK
    const past = [1, 2, 3, 4, 5].map(k => row(weekStart(k) + 5.5 * DAY, 10, { d7Reset: weekStart(k) + WEEK }))
    const oldest = row(weekStart(6) + 3.5 * DAY, 70, { d7Reset: weekStart(6) + WEEK })

    const week = analyze([oldest, ...past, current(8.4, 5)], [limit('seven_day', 5, NEXT)], nowMs(8.5)).now
      .week!
    expect(week.pastWeeks).toBe(5)
    // Шестая неделя не учтена: дню 3 ничего, весь остаток после сегодня — дню 5.
    expect(week.usual![3]!.budget).toBe(0)
    expect(week.usual![5]!.budget).toBe(95)
  })

  test('прогноз по законченным неделям: средний прирост дня недели в оставшиеся дни', async () => {
    // Прошлая неделя: +10% каждый день.
    const past = [0, 1, 2, 3, 4, 5, 6].map(i => row(after(i + 0.5), 10 * (i + 1)))
    const rows = [...past, current(10.4, 30)]

    const calm = analyze(rows, [limit('seven_day', 30, NEXT)], nowMs(NOW)).now
    expect(calm.basis).toBe('weeks')
    expect(calm.forecast).toBe(65)
    expect(calm.exhaustAt).toBeUndefined()

    // 70% и ещё 3,5 дня по 10% → 100% через 3 дня.
    const tight = analyze(rows, [limit('seven_day', 70, NEXT)], nowMs(NOW)).now
    expect(tight.forecast).toBe(105)
    expect(Math.abs(tight.exhaustAt! - after(NOW + 3))).toBeLessThan(3600)
  })
})
