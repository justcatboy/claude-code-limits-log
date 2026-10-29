// Чтение журнала (files.ts, toRows) и подсчёт токенов (tokens.ts): как сводятся записи
// параллельных сессий. Чистые функции — движок не нужен.
import { describe, expect, test } from 'claude-code/testing'

import { toRows } from '../hooks/files'
import type { LimitsRecord, LogRecord, UsageTotal } from '../hooks/files'
import { subtract, sum } from '../hooks/tokens'
import type { TokenUsage } from '../hooks/tokens'

const H5_RESET = 2_000_000_000
const D7_RESET = 2_100_000_000

const opus = (input: number, turns = 1): TokenUsage => ({
  model: 'opus',
  turns,
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})
const agent = (input: number): TokenUsage => ({ ...opus(input), model: 'haiku', agent: true })
const total = (session: string, turns: number, usage: TokenUsage[]): UsageTotal => ({ session, turns, usage })

function limits(
  ts: string,
  session: string,
  h5: number,
  d7: number,
  usageTotals?: UsageTotal[],
  h5Reset = H5_RESET,
): LimitsRecord {
  return {
    v: 4,
    kind: 'limits',
    ts: `2026-03-04T${ts}Z`,
    session,
    windows: [
      { kind: 'five_hour', pct: h5, resetsAt: h5Reset },
      { kind: 'seven_day', pct: d7, resetsAt: D7_RESET },
    ],
    usageTotals,
  }
}

const inputOf = (usage?: TokenUsage[]) => (usage ?? []).reduce((s, u) => s + u.input, 0)

describe('повторы и порядок', () => {
  test('один сдвиг, записанный тремя сессиями, — одна строка', async () => {
    const rows = toRows([
      limits('09:00:02', 'C', 10, 1),
      limits('09:00:00', 'A', 10, 1),
      limits('09:00:01', 'B', 10, 1),
      limits('09:10:00', 'B', 11, 1),
    ])
    expect(rows.map(r => [r.ts.slice(11, 19), r.session, r.h5])).toEqual([
      ['09:00:00', 'A', 10],
      ['09:10:00', 'B', 11],
    ])
  })

  test('запоздавший ответ (ниже, те же сбросы, сразу после) отброшен', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 48, 8),
      limits('09:00:30', 'B', 47, 8),
      limits('09:01:00', 'A', 49, 8),
    ])
    expect(rows.map(r => r.h5)).toEqual([48, 49])
  })

  test('ниже, но позже 5 минут — сброс вне расписания, остаётся', async () => {
    const rows = toRows([limits('09:00:00', 'A', 48, 8), limits('09:06:00', 'A', 2, 8)])
    expect(rows.map(r => r.h5)).toEqual([48, 2])
  })

  test('новое окно 5h (другой сброс) — не запоздавший ответ, даже сразу после', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 95, 8),
      limits('09:00:10', 'A', 1, 8, undefined, H5_RESET + 18_000),
    ])
    expect(rows.map(r => r.h5)).toEqual([95, 1])
  })

  test('записи session и незнакомые kind в строки не попадают', async () => {
    const other = { v: 9, kind: 'future', ts: '2026-03-04T09:00:00Z' } as unknown as LogRecord
    const rows = toRows([limits('09:00:00', 'A', 10, 1), other])
    expect(rows).toHaveLength(1)
  })
})

describe('токены между записями (usageTotals)', () => {
  test('разница по сессиям, субагенты отдельно, ходы основного цикла', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 10, 1, [total('A', 1, [opus(10), agent(5)]), total('B', 1, [opus(20)])]),
      // B пишет раньше, чем A успела записать свой ход — в итогах A он уже есть.
      limits('09:10:00', 'B', 11, 1, [
        total('A', 2, [opus(110, 2), agent(5)]),
        total('B', 2, [opus(220, 2)]),
      ]),
      limits('09:20:00', 'A', 12, 2, [
        total('A', 2, [opus(110, 2), agent(5)]),
        total('B', 2, [opus(220, 2)]),
      ]),
    ])
    expect(rows.map(r => r.turns)).toEqual([2, 2, 0])
    expect(rows.map(r => inputOf(r.usage))).toEqual([35, 300, 0])
    expect(rows[0]!.usage!.find(u => u.agent)?.input).toBe(5)
  })

  test('повтор с более свежими итогами не теряет токены: их считает следующая запись', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 10, 1, [total('A', 1, [opus(10)])]),
      limits('09:00:05', 'B', 10, 1, [total('A', 2, [opus(30, 2)])]),
      limits('09:10:00', 'A', 11, 1, [total('A', 3, [opus(60, 3)])]),
    ])
    expect(rows.map(r => inputOf(r.usage))).toEqual([10, 50])
  })

  test('сессия, которой нет в следующей записи, ничего не добавляет и не вычитается', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 10, 1, [total('A', 1, [opus(10)]), total('B', 1, [opus(20)])]),
      limits('09:10:00', 'A', 11, 1, [total('A', 2, [opus(15, 2)])]),
    ])
    expect(rows.map(r => inputOf(r.usage))).toEqual([30, 5])
  })

  test('старые записи (v1–v3) без usageTotals — turns как записан', async () => {
    const old: LimitsRecord = { ...limits('09:00:00', 'A', 10, 1), v: 2, turns: 4 }
    expect(toRows([old])[0]!.turns).toBe(4)
    expect(toRows([old])[0]!.usage).toBeUndefined()
  })
})

describe('стоимость между записями (spent)', () => {
  const paid = (r: LimitsRecord, costUsd?: number): LimitsRecord => ({ ...r, costUsd })

  test('прирост costUsd по каждой сессии; первая запись сессии — вся её стоимость', async () => {
    const rows = toRows([
      paid(limits('09:00:00', 'A', 10, 1), 1),
      paid(limits('09:05:00', 'B', 11, 1), 2),
      paid(limits('09:10:00', 'A', 12, 1), 3),
    ])
    expect(rows.map(r => r.spent)).toEqual([1, 2, 2])
  })

  test('повтор не теряет стоимость своей сессии: она идёт в оставленную запись', async () => {
    const rows = toRows([
      paid(limits('09:00:00', 'A', 10, 1), 1),
      paid(limits('09:00:02', 'B', 10, 1), 4),
      paid(limits('09:10:00', 'B', 11, 1), 5),
    ])
    expect(rows.map(r => r.spent)).toEqual([5, 1])
  })

  test('стоимость упала (resume — новый процесс) — считается с нуля', async () => {
    const rows = toRows([
      paid(limits('09:00:00', 'A', 10, 1), 3.5),
      paid(limits('09:10:00', 'A', 11, 1), 0),
      paid(limits('09:20:00', 'A', 12, 1), 1.5),
    ])
    expect(rows.map(r => r.spent)).toEqual([3.5, 0, 1.5])
  })

  test('до первой стоимости у сессии были записи без неё — с чего считать, неизвестно', async () => {
    const rows = toRows([
      limits('09:00:00', 'A', 10, 1),
      paid(limits('09:10:00', 'A', 11, 1), 15),
      paid(limits('09:20:00', 'A', 12, 1), 16),
    ])
    expect(rows.map(r => r.spent)).toEqual([undefined, undefined, 1])
  })
})

describe('tokens.ts', () => {
  test('sum складывает по модели и циклу', async () => {
    const s = sum([[opus(1), agent(2)], [opus(3)]])
    expect(s.find(u => !u.agent)?.input).toBe(4)
    expect(s.find(u => u.agent)?.input).toBe(2)
  })

  test('subtract отбрасывает пустое и отрицательное (итог начался заново)', async () => {
    expect(subtract([opus(5)], [opus(5)])).toEqual([])
    expect(subtract([opus(3)], [opus(5)])).toEqual([])
    expect(subtract([opus(8, 2)], [opus(5)])).toEqual([opus(3, 1)])
  })
})
