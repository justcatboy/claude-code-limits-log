// Итоги сессий: что каждая сессия наработала, для записей session и поля usageTotals записей limits.
//
// У каждой сессии свой накопительный итог в $.store (ключ session:<id>), и пишет его только она:
// общего изменяемого места у сессий нет. Внутри сессии изменения идут по очереди (mutate) — ходы
// субагентов завершаются одновременно с основным. Запись limits только читает итоги всех сессий;
// разницу между записями считает читатель журнала (files.ts, toRows).
//
// Риски:
// - session.end может не дойти (сбой, закрытое окно, короткий бюджет события). Итог остаётся в
//   $.store, и при старте любой сессии итоги, молчащие дольше ORPHAN_AFTER_MS, дописываются в
//   файл брошенной сессии как reason: "orphan". Если такая сессия потом продолжится, mutate
//   снимает endedAt и её session.end запишет итог ещё раз. Итог накопительный, поэтому из
//   записей session с одним id верна последняя — их не складывают.
// - Брошенная сессия, молчавшая дольше ORPHAN_AFTER_MS + KEEP_ENDED_MS, теряет итог в $.store;
//   если она потом продолжится, итог начнётся заново и её последняя запись session будет неполной.
// - Итог закончившейся сессии хранится ещё KEEP_ENDED_MS, чтобы попасть в следующие записи
//   limits. Если за это время записей limits не было, токены её последнего отрезка до записей
//   limits не дойдут (в её записи session они есть).
import type { EngineInterface as Dollar, SessionEndInput, TurnCompleteInput } from 'claude-code'

import { LOG_VERSION, appendRecord, isoNow } from './files'
import type { SessionRecord, UsageTotal } from './files'
import { addTurn } from './tokens'
import type { TokenUsage } from './tokens'

// Через сколько молчания итог без session.end считается брошенным.
const ORPHAN_AFTER_MS = 12 * 3600_000
// Сколько итог закончившейся сессии ещё попадает в записи limits.
const KEEP_ENDED_MS = 24 * 3600_000

type SessionTotals = {
  session: string
  project?: string
  startedAt?: number
  lastAt: number
  turns: number
  aborted: number
  errors: number
  activeMs: number
  usage: TokenUsage[]
  tools: Record<string, number>
  compactions: number
  maxContextTokens?: number
  costUsd?: number
  model?: string
  effort?: string | number
  // Когда записана запись session; снимается, если сессия продолжилась.
  endedAt?: number
}

const PREFIX = 'session:'
const key = (session: string) => `${PREFIX}${session}`

// =============================================================================
// Итог этой сессии
// =============================================================================

// Изменения итога этой сессии — по очереди, чтобы одновременные хуки не затёрли друг друга.
let queue: Promise<unknown> = Promise.resolve()

export function mutate($: Dollar, change: (t: SessionTotals) => SessionTotals | void): Promise<void> {
  const run = queue.then(async () => {
    const session = await $.session.id()
    const stored = (await $.store.get(key(session))) as SessionTotals | undefined
    const totals: SessionTotals = stored ?? {
      session,
      project: await $.session.cwd(),
      startedAt: (await $.session.usage()).startedAt,
      lastAt: Date.now(),
      turns: 0,
      aborted: 0,
      errors: 0,
      activeMs: 0,
      usage: [],
      tools: {},
      compactions: 0,
    }
    const changed = change(totals) ?? totals
    // Сессия идёт — значит, не закончилась: брошенная (orphan) ожила.
    await $.store.set(key(session), { ...changed, lastAt: Date.now(), endedAt: undefined })
  })
  queue = run.catch(() => undefined)
  return run
}

export function onTurn(t: SessionTotals, e: TurnCompleteInput, effort?: string | number): SessionTotals {
  const isMain = !e.agentId
  return {
    ...t,
    turns: t.turns + (isMain ? 1 : 0),
    aborted: t.aborted + (isMain && e.reason === 'aborted' ? 1 : 0),
    errors: t.errors + (isMain && e.reason === 'error' ? 1 : 0),
    activeMs: t.activeMs + (isMain ? e.durationMs : 0),
    usage: addTurn(t.usage, e),
    model: isMain && e.usage ? e.usage.model : t.model,
    effort: isMain && effort !== undefined ? effort : t.effort,
  }
}

// =============================================================================
// Запись session
// =============================================================================

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

function toRecord(t: SessionTotals, reason: string): SessionRecord {
  return {
    v: LOG_VERSION,
    kind: 'session',
    ts: isoNow(),
    session: t.session,
    project: t.project,
    start: t.startedAt === undefined ? undefined : iso(t.startedAt),
    end: iso(t.lastAt),
    reason,
    turns: t.turns,
    aborted: t.aborted,
    errors: t.errors,
    activeMs: t.activeMs,
    costUsd: t.costUsd === undefined ? undefined : Math.round(t.costUsd * 10000) / 10000,
    model: t.model,
    effort: t.effort,
    usage: t.usage,
    tools: t.tools,
    compactions: t.compactions,
    maxContextTokens: t.maxContextTokens,
  }
}

// session.end: итог этой сессии — в её файл журнала. Бюджет кончится после записи, но до endedAt —
// tidySessions потом допишет orphan с тем же итогом; верна последняя запись, так что не страшно.
export async function endSession($: Dollar, e: SessionEndInput) {
  await queue
  const t = (await $.store.get(key(e.sessionId))) as SessionTotals | undefined
  if (!t || t.endedAt) return
  const cost = (await $.session.usage()).cost?.usd
  const final: SessionTotals = { ...t, costUsd: cost ?? t.costUsd }
  await appendRecord($, t.session, toRecord(final, e.reason))
  await $.store.set(key(e.sessionId), { ...final, endedAt: Date.now() })
}

// session.start: дописывает итоги сессий, чьё завершение не дошло, — в их же файлы (их никто
// больше не пишет); убирает итоги, закончившиеся дольше KEEP_ENDED_MS назад.
export async function tidySessions($: Dollar) {
  const current = await $.session.id()
  const now = Date.now()
  for (const k of await $.store.keys()) {
    if (!k.startsWith(PREFIX) || k === key(current)) continue
    const t = (await $.store.get(k)) as SessionTotals | undefined
    if (!t) continue
    if (t.endedAt !== undefined) {
      if (now - t.endedAt > KEEP_ENDED_MS) await $.store.delete(k)
    } else if (now - t.lastAt > ORPHAN_AFTER_MS) {
      await appendRecord($, t.session, toRecord(t, 'orphan'))
      await $.store.set(k, { ...t, endedAt: now })
    }
  }
}

// =============================================================================
// usageTotals для записи limits
// =============================================================================

// Накопленные итоги всех сессий с модом: только чтение.
export async function allTotals($: Dollar): Promise<UsageTotal[]> {
  await queue
  const out: UsageTotal[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith(PREFIX)) continue
    const t = (await $.store.get(k)) as SessionTotals | undefined
    if (t) out.push({ session: t.session, turns: t.turns, usage: t.usage })
  }
  return out
}
