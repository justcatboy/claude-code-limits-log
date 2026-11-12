// Тексты панели /limits: что показать. Каждая функция — одна строка или её часть из данных
// снимка; undefined — строки нет. Раскладка — в panel.tsx.
import type {
  DayBudget,
  NowReport,
  ProjectWork,
  SessionWork,
  WeekReport,
  WindowNow,
  WindowsReport,
  Work,
} from '../types'
import {
  DAY,
  H5,
  WEEK,
  baseName,
  short,
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

// «25.02 10:00 – 04.03 10:00», у неполной — « · неполная: 16% до начала журнала».
export function weekTitle(w: WeekReport): string {
  const start = weekStart(w)
  const end = fromUnix(w.reset)
  const missed = w.missed === undefined ? '' : ` · неполная: ${w.missed}% до начала журнала`
  return `${ddmm(start)} ${hhmm(start)} – ${ddmm(end)} ${hhmm(end)}${missed}`
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

// Подпись полосы дней: «Поровну», «По 3 прошлым неделям» (их не меньше двух).
export const dayBarTitle = (pastWeeks?: number) => (pastWeeks ? `По ${pastWeeks} прошлым неделям` : 'Поровну')

// «Неделя 04.03 10:00 – 11.03 10:00 · сброс через 6д 05ч».
export function nowWeekTitle(reset: number, secondsLeft?: number): string {
  const start = fromUnix(reset - WEEK)
  const end = fromUnix(reset)
  const left = secondsLeft !== undefined ? ` · сброс через ${span(secondsLeft)}` : ''
  return `Неделя ${ddmm(start)} ${hhmm(start)} – ${ddmm(end)} ${hhmm(end)}${left}`
}

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

// «1% недели ~6.1% 5h окна · $3.14 · 11 сообщений»; доля окна — по d7PerPct режима windows.
export function priceLine(n: NowReport, x?: WindowsReport): string | undefined {
  const parts: string[] = []
  if (x?.d7PerPct) parts.push(`~${round1(1 / x.d7PerPct)}% 5h окна`)
  if (n.costPerPp !== undefined) parts.push(usd(n.costPerPp))
  if (n.turnsPerPp !== undefined) parts.push(plural(Math.round(n.turnsPerPp), MESSAGES))
  return parts.length ? status('1% недели', parts.join(' · ')) : undefined
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

// «Окно 5h   14:20–19:20 · остаток ~52%», если кончится раньше сброса — « · кончится к 17:40».
export function h5Line(w: WindowNow, n: NowReport): string {
  const parts: string[] = []
  if (w.resetsAt !== undefined) parts.push(`${hhmm(fromUnix(w.resetsAt - H5))}–${hhmm(fromUnix(w.resetsAt))}`)
  parts.push(`остаток ~${Math.max(0, round1(100 - w.pct))}%`)
  if (n.h5ExhaustAt !== undefined) parts.push(`кончится к ${hhmm(fromUnix(n.h5ExhaustAt))}`)
  return status('Окно 5h', parts.join(' · '))
}

// =============================================================================
// Работа сессий: проекты и сессии по дням
// =============================================================================

// Имя проекта — последняя часть рабочей папки; неизвестна — «?».
export const projectName = (project?: string) => (project ? baseName(project) : '?')

// Ширина колонки имён: по самому длинному, не больше 24.
export const nameWidth = (names: string[]) => Math.min(24, Math.max(0, ...names.map(n => n.length)))

const fit = (name: string, width: number) =>
  name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width)

// «$6.00 · 6 сообщений · вывод 140k · всего 12M».
function workText(w: Work): string {
  const parts: string[] = []
  if (w.spent !== undefined) parts.push(usd(w.spent))
  parts.push(plural(w.turns, MESSAGES), `вывод ${short(w.output)}`, `всего ${short(w.tokens)}`)
  return parts.join(' · ')
}

// «main-manager  ~36% · $58.00 · 41 сообщение · вывод 120k · всего 40M · 5 сессий».
export function projectLine(p: ProjectWork, width: number): string {
  const share = p.share !== undefined ? `~${round1(p.share)}% · ` : ''
  return `${fit(projectName(p.project), width)}  ${share}${workText(p)} · ${plural(p.sessions, SESSIONS)}`
}

// «ср 11.11 · $70.00 · 30 сообщений · вывод 200k · всего 60M» — итог дня по его сессиям.
export function workDayTitle(d: { start: number; sessions: SessionWork[] }): string {
  const total: Work = { turns: 0, output: 0, tokens: 0 }
  for (const s of d.sessions) {
    total.turns += s.turns
    total.output += s.output
    total.tokens += s.tokens
    if (s.spent !== undefined) total.spent = (total.spent ?? 0) + s.spent
  }
  return `${dayLabel(fromUnix(d.start))} · ${workText(total)}`
}

// «  09:12 main-manager  $40.00 · 12 сообщений · вывод 80k · всего 20M» — время первой записи дня.
export const sessionLine = (s: SessionWork, width: number) =>
  `  ${hhmm(fromUnix(s.first))} ${fit(projectName(s.project), width)}  ${workText(s)}`

// =============================================================================
// Окна 5h по журналу
// =============================================================================

const WINDOWS: [string, string, string] = ['окно', 'окна', 'окон']
const WEEKS: [string, string, string] = ['неделю', 'недели', 'недель']
// Ширина столбика окон по часу начала, клеток.
const START_BAR = 16

// «Окна 5h · 48 окон за 6 недель · ~8 в неделю».
export function windowsTitle(x: WindowsReport): string {
  const perWeek = x.weeks ? ` · ~${round1(x.total / x.weeks)} в неделю` : ''
  return `Окна 5h · ${plural(x.total, WINDOWS)} за ${plural(x.weeks, WEEKS)}${perWeek}`
}

// «100%      12 · 25%», «80–99%    …», «до 50%    …».
export function levelLine(l: WindowsReport['levels'][number], total: number): string {
  const label = l.from === 100 ? '100%' : l.from === 0 ? `до ${l.to}%` : `${l.from}–${l.to - 1}%`
  const share = total ? ` · ${Math.round((l.count / total) * 100)}%` : ''
  return status(label, `${pad(l.count, 3)}${share}`)
}

// «Обычно    ~64% окна · 1% 5h ≈ 0.12% 7d».
export function usualWindowLine(x: WindowsReport): string | undefined {
  if (x.avgMax === undefined) return undefined
  const rate = x.d7PerPct !== undefined ? ` · 1% 5h ≈ ${x.d7PerPct.toFixed(2)}% 7d` : ''
  return status('Обычно', `~${Math.round(x.avgMax)}% окна${rate}`)
}

// «Полное    ≈ 12% 7d» — окно до 100%.
export const fullWindowLine = (x: WindowsReport) =>
  x.d7PerPct !== undefined ? status('Полное', `≈ ${round1(x.d7PerPct * 100)}% 7d`) : undefined

// «До 100%   за ~2ч 40м · сброса ждали ~2ч 20м».
export function fillLine(x: WindowsReport): string | undefined {
  if (x.fillSeconds === undefined || x.waitSeconds === undefined) return undefined
  return status('До 100%', `за ~${span(x.fillSeconds)} · сброса ждали ~${span(x.waitSeconds)}`)
}

// «Неделя    5 окон · 2 до 100%».
export const windowsWeekLine = (x: WindowsReport) =>
  x.week ? status('Неделя', `${plural(x.week.total, WINDOWS)} · ${x.week.full} до 100%`) : undefined

// «Вмещает   ~3.2 до 100% · ~4 до 80% · по времени до 16» — остаток 7d текущей недели.
export function fitLine(x: WindowsReport): string | undefined {
  if (!x.fit) return undefined
  const { full, high, byTime } = x.fit
  return status('Вмещает', `~${round1(full)} до 100% · ~${round1(high)} до 80% · по времени до ${byTime}`)
}

const hour = (h: number) => String(h).padStart(2, '0')

// «10–15  ████████  12 · ~72% · 4 до 100%» — окна, начатые в этот час; столбик — доля от самого
// частого.
export function startLine(s: WindowsReport['byStart'][number], most: number): string {
  const cells = Math.max(1, Math.round((s.count / Math.max(1, most)) * START_BAR))
  const full = s.full ? ` · ${s.full} до 100%` : ''
  return `${hour(s.hour)}–${hour((s.hour + 5) % 24)}  ${'█'.repeat(cells).padEnd(START_BAR)} ${pad(s.count, 3)} · ~${Math.round(s.avgMax)}%${full}`
}
