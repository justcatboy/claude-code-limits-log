// Журнал мода: где лежит, формат записей, запись и чтение.
//
// Каждая сессия пишет только свой файл, общего изменяемого места у сессий нет — параллельные
// сессии не теряют друг другу строки. Сводит всё вместе читатель: сортирует записи, убирает
// повторы (одно и то же состояние лимитов видят все активные сессии) и считает токены между
// записями по накопленным итогам.
import type { EngineInterface as Dollar } from 'claude-code'

import { subtract, sum } from './tokens'
import type { TokenUsage } from './tokens'

export type { TokenUsage } from './tokens'

// Папка мода в каталоге профиля: все его файлы.
export const MOD_DIR = 'limits-log'

// Журнал: MOD_DIR/log/<месяц UTC>/<сессия>.jsonl — «log/2026-03/0b6e2c1a-….jsonl», JSON Lines,
// одна запись на строку. Файл пишет только его сессия; по месяцам — чтобы файлы оставались
// маленькими ($.fs.read не читает больше 4 МиБ, дописывать $.fs не умеет).
export const LOG_DIR = `${MOD_DIR}/log`
const MONTH_DIR = /^\d{4}-\d{2}$/

// Версия, которую пишет мод. Поля только добавляются, смысл не меняется; читатель обходится
// без любого поля и пропускает записи незнакомого kind.
// 1 — данные, перенесённые из CSV; 2 — первая версия мода; 3 — usageSince в limits и записи
// session; 4 — файл на сессию, usageTotals вместо usageSince.
export const LOG_VERSION = 4

// Окно лимита как его сообщил ответ API: five_hour, seven_day, spend_limit или новое.
export type LogWindow = { kind: string; pct: number; resetsAt?: number }

// Накопленный итог одной сессии: ходы основного цикла и токены с её начала.
export type UsageTotal = { session: string; turns: number; usage: TokenUsage[] }

// Состояние лимитов: пишется, когда окно сдвинулось на целый процент.
export type LimitsRecord = {
  v: number
  kind: 'limits'
  // Время записи, ISO UTC до секунды.
  ts: string
  windows: LogWindow[]
  model?: string
  // Уровень effort (low…max или число) последнего запроса основного цикла сессии.
  effort?: string | number
  session?: string
  // Накопленная стоимость сессии по ценам API, как в /cost.
  costUsd?: number
  // Входные токены последнего ответа: заполнение контекста.
  contextTokens?: number
  // v1–v3: ходы основного цикла во всех сессиях с прошлой записи.
  turns?: number
  // Только v3: токены с прошлой записи. С v4 не пишется.
  usageSince?: TokenUsage[]
  // С v4: накопленные итоги всех сессий с модом на момент записи; разницу считает читатель.
  usageTotals?: UsageTotal[]
}

// Итог сессии: пишется при её завершении или, если завершение не дошло, при старте другой.
export type SessionRecord = {
  v: number
  kind: 'session'
  // Время записи, ISO UTC до секунды.
  ts: string
  session: string
  // Рабочая папка сессии.
  project?: string
  // Начало (первый запуск) и последняя активность, ISO UTC.
  start?: string
  end: string
  // Почему закончилась: причина session.end (prompt_input_exit, clear, resume, logout, other)
  // или orphan — завершение не дошло, итог дописан при старте другой сессии.
  reason: string
  // Ходы основного цикла: сколько, из них прерванных и с ошибкой; сумма их длительностей, мс.
  turns: number
  aborted: number
  errors: number
  activeMs: number
  // Итоговая стоимость по ценам API, как в /cost.
  costUsd?: number
  model?: string
  effort?: string | number
  usage: TokenUsage[]
  // Вызовы инструментов по имени, субагентов тоже.
  tools: Record<string, number>
  // Сжатия контекста основного цикла и наибольшее заполнение контекста, токены.
  compactions: number
  maxContextTokens?: number
}

export type LogRecord = LimitsRecord | SessionRecord

export const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

// =============================================================================
// Запись
// =============================================================================

// Записи этого процесса — по очереди: файл перезаписывается целиком.
let queue: Promise<unknown> = Promise.resolve()

// Дописывает запись в файл сессии session за месяц её ts; папки write создаёт сам. Файл есть, но
// не читается (занят другой программой, больше 4 МиБ) — отказ: перезапись затёрла бы его.
export function appendRecord($: Dollar, session: string, record: LogRecord): Promise<void> {
  const run = queue.then(async () => {
    const path = `${await configDir($)}/${LOG_DIR}/${record.ts.slice(0, 7)}/${session}.jsonl`
    let text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    if (text && !text.endsWith('\n')) text += '\n'
    await $.fs.write(path, `${text}${JSON.stringify(record)}\n`)
  })
  queue = run.catch(() => undefined)
  return run
}

// =============================================================================
// Чтение
// =============================================================================

// Запись limits в плоском виде для анализа: окна 5h и 7d вынуты из windows; turns, usage и
// spent — с прошлой (уже без повторов) записи.
export type Row = {
  ts: string
  h5: number
  h5Reset: number
  d7: number
  d7Reset: number
  model: string
  session: string
  context?: number
  turns?: number
  usage?: TokenUsage[]
  // Потрачено по ценам API: приросты costUsd всех сессий с прошлой записи, повторы тоже; нет —
  // ни одного известного прироста.
  spent?: number
}

const dataLines = (text: string) => text.split(/\r?\n/).filter(line => line.trim())

function parseRecords(text: string): LogRecord[] {
  const records: LogRecord[] = []
  for (const line of dataLines(text)) {
    try {
      records.push(JSON.parse(line) as LogRecord)
    } catch {
      // Битая строка (например, оборванная запись) — пропускаем.
    }
  }
  return records
}

const windowsState = (r: LimitsRecord) =>
  r.windows
    .map(w => `${w.kind}:${w.pct}:${w.resetsAt ?? ''}`)
    .sort()
    .join('|')

// Сколько после записи более низкие проценты тех же окон считаются запоздавшим ответом.
const STALE_WITHIN_S = 5 * 60

// Запоздавший ответ другой сессии: окна с теми же сбросами, ни одно не выше, хоть одно ниже, и
// почти сразу после предыдущей записи. Настоящий сброс вне расписания так не выглядит — после
// него проценты остаются низкими дольше.
function isStale(prev: LimitsRecord, cur: LimitsRecord): boolean {
  if ((Date.parse(cur.ts) - Date.parse(prev.ts)) / 1000 > STALE_WITHIN_S) return false
  let lower = false
  for (const w of cur.windows) {
    const was = prev.windows.find(p => p.kind === w.kind)
    if (!was || was.resetsAt !== w.resetsAt || w.pct > was.pct) return false
    if (w.pct < was.pct) lower = true
  }
  return lower
}

// Прирост costUsd сессий от записи к записи. costUsd — накопленная стоимость процесса: меньше
// прошлой — процесс начался заново (resume), считается с нуля. Первая стоимость сессии — вся её
// трата, если раньше у сессии не было записей без стоимости (тогда с чего считать, неизвестно).
function costTracker() {
  const last = new Map<string, number>()
  const blind = new Set<string>()
  return (r: LimitsRecord): number | undefined => {
    const session = r.session ?? ''
    const was = last.get(session)
    if (r.costUsd === undefined) {
      if (was === undefined) blind.add(session)
      return undefined
    }
    last.set(session, r.costUsd)
    if (was === undefined) return blind.has(session) ? undefined : r.costUsd
    return r.costUsd >= was ? r.costUsd - was : r.costUsd
  }
}

// Записи limits всех сессий → строки анализа. Сортирует по времени и отбрасывает повторы (то же
// состояние окон, что у предыдущей оставленной, — его видели несколько сессий) и запоздавшие
// ответы. Для записей с usageTotals turns и usage — разница с итогами предыдущих оставленных
// записей по каждой сессии. spent — по всем записям: трата из отброшенной идёт в оставленную.
export function toRows(records: LogRecord[]): Row[] {
  const limits = records
    .filter((r): r is LimitsRecord => r.kind === 'limits' && Array.isArray(r.windows))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  const rows: Row[] = []
  const totals = new Map<string, UsageTotal>()
  const spentBy = costTracker()
  let kept: LimitsRecord | undefined
  for (const r of limits) {
    const spent = spentBy(r)
    if (kept && (windowsState(r) === windowsState(kept) || isStale(kept, r))) {
      const row = rows.at(-1)!
      if (spent !== undefined) row.spent = (row.spent ?? 0) + spent
      continue
    }
    kept = r

    let turns = r.turns
    let usage: TokenUsage[] | undefined
    if (r.usageTotals) {
      turns = 0
      const diffs: TokenUsage[][] = []
      for (const t of r.usageTotals) {
        const was = totals.get(t.session)
        turns += Math.max(0, t.turns - (was?.turns ?? 0))
        diffs.push(subtract(t.usage, was?.usage ?? []))
        totals.set(t.session, t)
      }
      usage = sum(diffs)
    }

    const h5 = r.windows.find(w => w.kind === 'five_hour')
    const d7 = r.windows.find(w => w.kind === 'seven_day')
    rows.push({
      ts: r.ts,
      h5: h5?.pct ?? 0,
      h5Reset: h5?.resetsAt ?? 0,
      d7: d7?.pct ?? 0,
      d7Reset: d7?.resetsAt ?? 0,
      model: r.model ?? '',
      session: r.session ?? '',
      context: r.contextTokens,
      turns,
      usage,
      spent,
    })
  }
  return rows
}

// Все записи журнала: все файлы всех месяцев. Нет папки — пусто.
export async function readRecords($: Dollar, logDir: string): Promise<LogRecord[]> {
  const list = async (path: string) => {
    try {
      return await $.fs.list(path)
    } catch {
      return []
    }
  }
  const records: LogRecord[] = []
  for (const month of await list(logDir)) {
    if (month.kind !== 'dir' || !MONTH_DIR.test(month.name)) continue
    for (const file of await list(`${logDir}/${month.name}`)) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      records.push(...parseRecords(await readText($, `${logDir}/${month.name}/${file.name}`)))
    }
  }
  return records
}

// Строки анализа по всему журналу. Объявлена через function: validate следует за $ через импорт
// только в объявления функций.
export async function readLog($: Dollar, logDir: string): Promise<Row[]> {
  return toRows(await readRecords($, logDir))
}

// Каталог профиля: CLAUDE_CONFIG_DIR, иначе ~/.claude.
export async function configDir($: Dollar): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return `${home}/.claude`
}

export async function readText($: Dollar, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}
