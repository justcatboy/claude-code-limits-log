// Состояние панели /limits ($.state): снимок анализа и выбранные режим и неделя.
// Снимок — только данные; тексты строит hooks/view.ts.

// Окно лимита на момент снимка.
export type WindowNow = { kind: string; pct: number; resetsAt?: number }

// Одна неделя — одно окно 7d (по сбросу окна 7d).
export type WeekReport = {
  // Сброс окна, unix-секунды; начало недели — на 7 дней раньше.
  reset: number
  isCurrent: boolean
  // Последний процент 7d в журнале.
  d7: number
  // Только у текущей: прогноз к сбросу при нынешнем темпе и когда дойдёт до 100% (unix-секунды),
  // если раньше сброса.
  forecast?: number
  exhaustAt?: number
  // Прирост 7d по дням недели — 24 часа от начала окна, index 0 … 6, start — unix-секунды; только
  // дни с записями.
  days: { index: number; start: number; delta: number }[]
  // Окна 5h («сессии» лимита), в которых были записи, по времени: сброс (unix-секунды) и
  // наибольший процент.
  h5: { reset: number; max: number }[]
  // Прирост 7d по модели записи, где он записан.
  models: { model: string; delta: number }[]
  // Потрачено за неделю (spent записей); нет — в записях не было стоимости. costD7 — прирост 7d
  // в записях, где трата известна: на него делится cost.
  cost?: number
  costD7?: number
  sessions: number
  // По записям с turns: ходы и прирост 7d за них.
  turns?: number
  turnsDelta?: number
  rows: number
}

// Бюджет дня недели в процентах окна 7d: ширина его отрезка на полосе и сколько потрачено.
export type DayBudget = { budget: number; used: number }

// Режим now: что осталось и хватит ли до сброса. Проценты — окна 7d, время — unix-секунды.
export type NowReport = {
  // Неделя по дням: начало, сегодняшний день (0 … 6) и бюджеты дней — поровну и по прошлым
  // неделям (по среднему приросту последних законченных, не больше 5; pastWeeks — сколько их;
  // нет законченных — нет).
  week?: { start: number; today: number; even: DayBudget[]; usual?: DayBudget[]; pastWeeks: number }
  // Когда кончится окно 5h при темпе этого окна, если раньше его сброса.
  h5ExhaustAt?: number
  // Остаток 7d, секунд до сброса и сколько можно тратить в день (меньше суток — весь остаток).
  left?: number
  secondsLeft?: number
  perDay?: number
  // Сегодня (локальный день) в текущей неделе: прирост 7d, трата по ценам API, ходы.
  today: { delta: number; spent?: number; turns?: number }
  // Ожидаемый 7d к сбросу и когда 100%, если раньше сброса. basis — по чему: weeks — средний
  // прирост законченных недель в оставшиеся дни недели, pace — темп этой недели.
  forecast?: number
  exhaustAt?: number
  basis?: 'weeks' | 'pace'
  // Цена 1% 7d по всему журналу: $ по ценам API и ходы.
  costPerPp?: number
  turnsPerPp?: number
}

export type View = 'now' | 'week'

// Снимок на момент открытия /limits.
export type Analysis = {
  at: string
  windows: WindowNow[]
  weeks: WeekReport[]
  now: NowReport
}

declare module 'claude-code' {
  interface PluginState {
    'limits-log': {
      analysis: Shaped<Analysis | null>
      week: Shaped<number>
      view: Shaped<View>
    }
  }
}
