// Тексты панели /limits: что показать. Каждая функция — одна строка или её часть из данных
// снимка; undefined — строки нет. Раскладка — в panel.tsx.
import type { DayBudget, NowReport, WeekReport, WindowNow } from '../types'
import {
  DAY,
  H5,
  WEEK,
  dayLabel,
  ddmm,
  fromUnix,
  hhmm,
  pad,
  plural,
  signed,
  span,
  usd,
  weekdayName,
} from './format'

// Ширина полосок, клеток.
export const WEEK_METER = 40
export const H5_METER = 20
const DAY_BAR_MAX = 40

// =============================================================================
// Полоски
// =============================================================================

// Цвет по проценту лимита.
export const level = (pct: number) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

// Полоска, заполненная по проценту: «████░░░░».
export function meter(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Столбик прироста: клетка на пункт.
export const bar = (points: number) => '█'.repeat(Math.min(DAY_BAR_MAX, Math.round(points)))

// Полоса недели по дням: отрезок дня шириной в его бюджет, закрашено — потрачено. Соседние дни
// различаются знаком: потрачено █ и ▓, свободно ░ и ▒. Куски — для раскраски.
export type BarRun = { text: string; used: boolean }

// Границы отрезков дней в клетках: от и до каждого дня, закрашено до.
function dayCells(days: DayBudget[], width: number) {
  const cell = (pct: number) => Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  let total = 0
  return days.map(d => {
    const from = cell(total)
    const to = cell(total + d.budget)
    const filled = Math.min(to, cell(total + d.used))
    total += d.budget
    return { from, to, filled }
  })
}

export function dayBar(days: DayBudget[], width: number): BarRun[] {
  const runs: BarRun[] = []
  dayCells(days, width).forEach(({ from, to, filled }, i) => {
    if (filled > from) runs.push({ text: (i % 2 ? '▓' : '█').repeat(filled - from), used: true })
    if (to > filled) runs.push({ text: (i % 2 ? '▒' : '░').repeat(to - filled), used: false })
  })
  return runs
}

// Подписи над полосой: «ср» в начале отрезка дня, если он шире подписи.
export function dayBarLabels(days: DayBudget[], start: number, width: number): string {
  const cells = Array<string>(width).fill(' ')
  dayCells(days, width).forEach(({ from, to }, i) => {
    const name = weekdayName(fromUnix(start + i * DAY).getDay())
    if (to - from > name.length) cells.splice(from, name.length, ...name)
  })
  return cells.join('').trimEnd()
}

// =============================================================================
// Неделя
// =============================================================================

const weekStart = (w: { reset: number }) => fromUnix(w.reset - WEEK)

// «21.10–28.10».
export const tabLabel = (w: WeekReport) => `${ddmm(weekStart(w))}–${ddmm(fromUnix(w.reset))}`

// «25.02 10:00 – 04.03 10:00».
export function weekTitle(w: WeekReport): string {
  const start = weekStart(w)
  const end = fromUnix(w.reset)
  return `${ddmm(start)} ${hhmm(start)} – ${ddmm(end)} ${hhmm(end)}`
}

// «Стоимость $52.82 · $0.88 за 1% 7d · сессий 18».
export function costLine(w: WeekReport): string | undefined {
  if (w.cost === undefined) return undefined
  const perPoint = w.costD7 ? ` · ${usd(w.cost / w.costD7)} за 1% 7d` : ''
  return `Стоимость ${usd(w.cost)}${perPoint} · сессий ${w.sessions}`
}

export function turnsLine(w: WeekReport): string | undefined {
  if (w.turns === undefined || !w.turnsDelta) return undefined
  return `Сообщений на 1% 7d: ${(w.turns / w.turnsDelta).toFixed(1)} (по записям мода)`
}

export function modelsLine(w: WeekReport): string | undefined {
  if (w.models.length === 0) return undefined
  return `Модели: ${w.models.map(m => `${m.model} ${signed(m.delta)}%`).join(', ')}`
}

// «ср 04.03   +5% █████» — день недели (24 часа от начала окна) по дате его начала.
export function dayLine(d: WeekReport['days'][number]): string {
  return `${dayLabel(fromUnix(d.start))} ${pad(`${signed(d.delta)}%`, 5)} ${bar(d.delta)}`
}

// Окна 5h недели по дню недели, в который окно началось: «ср 28.10» и его окна по времени.
export function h5ByDay(w: WeekReport): { day: string; windows: WeekReport['h5'] }[] {
  const start = w.reset - WEEK
  const days: { day: string; windows: WeekReport['h5'] }[] = []
  for (const x of w.h5) {
    const index = Math.min(6, Math.max(0, Math.floor((x.reset - H5 - start) / DAY)))
    const day = dayLabel(fromUnix(start + index * DAY))
    if (days.at(-1)?.day !== day) days.push({ day, windows: [] })
    days.at(-1)!.windows.push(x)
  }
  return days
}

// «  10:00–15:00» — окно под своим днём, с отступом.
export function h5Label(x: WeekReport['h5'][number]): string {
  return `  ${hhmm(fromUnix(x.reset - H5))}–${hhmm(fromUnix(x.reset))}`
}

// =============================================================================
// Сейчас: что осталось и хватит ли до сброса
// =============================================================================
// Строки now — «Подпись   значение»: слово-статус слева, коротко справа.

const status = (word: string, value: string) => `${word.padEnd(10)}${value}`
// Ход основного цикла в панели — «сообщение»: одно сообщение пользователя и вся работа над ним.
const MESSAGES: [string, string, string] = ['сообщение', 'сообщения', 'сообщений']
const SESSIONS: [string, string, string] = ['сессия', 'сессии', 'сессий']
const round1 = (n: number) => Math.round(n * 10) / 10
const at = (seconds: number) => `${dayLabel(fromUnix(seconds))} ${hhmm(fromUnix(seconds))}`

// Подпись полосы по прошлым неделям: «По прошлой неделе», «По 3 прошлым неделям».
export const pastWeeksTitle = (weeks: number) =>
  weeks === 1 ? 'По прошлой неделе' : `По ${weeks} прошлым неделям`

// «Неделя 04.03 10:00 – 11.03 10:00 · 14%».
export function nowWeekTitle(reset: number, pct: number): string {
  const start = fromUnix(reset - WEEK)
  const end = fromUnix(reset)
  return `Неделя ${ddmm(start)} ${hhmm(start)} – ${ddmm(end)} ${hhmm(end)} · ${round1(pct)}%`
}

// «Сброс     через 6д 05ч».
export const resetLine = (n: NowReport) =>
  n.secondsLeft !== undefined ? status('Сброс', `через ${span(n.secondsLeft)}`) : undefined

// «Сегодня   +11% · $34.00 · 120 сообщений».
export function todayLine(n: NowReport): string {
  const { delta, spent, turns } = n.today
  const parts = [`${signed(delta)}%`]
  if (spent !== undefined) parts.push(usd(spent))
  if (turns !== undefined) parts.push(plural(turns, MESSAGES))
  return status('Сегодня', parts.join(' · '))
}

// «Можно     ~11% в день»; меньше суток до сброса — весь остаток.
export function allowanceLine(n: NowReport): string | undefined {
  if (n.perDay === undefined || n.secondsLeft === undefined) return undefined
  return status('Можно', n.secondsLeft < DAY ? `~${n.perDay}% до сброса` : `~${n.perDay}% в день`)
}

// Хватит ли до сброса: хватит — ожидаемое к сбросу не больше 85%, впритык — до 100%.
export function outlookLevel(n: NowReport): 'green' | 'yellow' | 'red' | undefined {
  if (n.left === 0) return 'red'
  if (n.forecast === undefined) return undefined
  return n.forecast <= 85 ? 'green' : n.forecast <= 100 ? 'yellow' : 'red'
}

// «Запас     хватит · к сбросу ~74%», «впритык · …», «не хватит · 100% к пт 06.03 14:00».
export function outlookLine(n: NowReport): string | undefined {
  if (n.left === 0) return status('Запас', 'исчерпан')
  const level = outlookLevel(n)
  if (!level) return undefined
  const word = level === 'green' ? 'хватит' : level === 'yellow' ? 'впритык' : 'не хватит'
  const detail =
    level === 'red' && n.exhaustAt !== undefined ? `100% к ${at(n.exhaustAt)}` : `к сбросу ~${n.forecast}%`
  return status('Запас', `${word} · ${detail}`)
}

// «Цена 1%   $3.14 · 11 сообщений».
export function priceLine(n: NowReport): string | undefined {
  const parts: string[] = []
  if (n.costPerPp !== undefined) parts.push(usd(n.costPerPp))
  if (n.turnsPerPp !== undefined) parts.push(plural(Math.round(n.turnsPerPp), MESSAGES))
  return parts.length ? status('Цена 1%', parts.join(' · ')) : undefined
}

// «Остаток   69% ≈ $217 · 759 сообщений».
export function leftLine(n: NowReport): string | undefined {
  if (n.left === undefined) return undefined
  const parts: string[] = []
  if (n.costPerPp !== undefined) parts.push(`$${Math.round(n.costPerPp * n.left)}`)
  if (n.turnsPerPp !== undefined) parts.push(plural(Math.round(n.turnsPerPp * n.left), MESSAGES))
  const worth = parts.length ? ` ≈ ${parts.join(' · ')}` : ''
  return status('Остаток', `${round1(n.left)}%${worth}`)
}

// «Потрачено $34.56 · 5 сессий».
export function spentLine(w: WeekReport): string | undefined {
  if (w.cost === undefined) return undefined
  return status('Потрачено', `${usd(w.cost)} · ${plural(w.sessions, SESSIONS)}`)
}

// «Модели    claude-opus-5-5 +13%».
export function nowModelsLine(w: WeekReport): string | undefined {
  if (w.models.length === 0) return undefined
  return status('Модели', w.models.map(m => `${m.model} ${signed(m.delta)}%`).join(', '))
}

// «Окно 5h 14:20–19:20».
export function h5Title(w: WindowNow): string {
  if (w.resetsAt === undefined) return 'Окно 5h'
  return `Окно 5h ${hhmm(fromUnix(w.resetsAt - H5))}–${hhmm(fromUnix(w.resetsAt))}`
}

// «Остаток   ~52%».
export const h5LeftLine = (w: WindowNow) => status('Остаток', `~${Math.max(0, round1(100 - w.pct))}%`)

// «Кончится  к 13:40» — только если раньше сброса окна.
export const h5ExhaustLine = (n: NowReport) =>
  n.h5ExhaustAt !== undefined ? status('Кончится', `к ${hhmm(fromUnix(n.h5ExhaustAt))}`) : undefined
