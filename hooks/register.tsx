// Журнал лимитов подписки и отчёт /limits.
//
// Здесь — все хуки событий сессии, по одному на событие (движок не принимает два без матчера):
// они раздают событие модулям. log.ts — записи limits; sessions.ts — итоги сессий (записи session
// и usageTotals); panel.tsx — команда и панель /limits (свои хуки с матчерами); analysis.ts,
// view.ts, format.ts, files.ts, tokens.ts — анализ, тексты, форматирование, журнал, токены.
import type { EngineInterface as Dollar, Register } from 'claude-code'

import { currentEffort, recordLimits, setEffort } from './log'
import { registerPanel, startPanel } from './panel'
import { endSession, tidySessions, mutate, onTurn } from './sessions'

// Сбой записи не должен ломать сессию: пишем в лог мода и идём дальше.
async function safely($: Dollar, what: string, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (error) {
    await $.ui.log(`limits-log: ${what} не удалось: ${error}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await startPanel($)
    const result = await next(e)
    await safely($, 'разобрать итоги сессий', () => tidySessions($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await safely($, 'обновить итог сессии', () =>
      mutate($, t => ({
        ...t,
        costUsd: e.cost?.usd ?? t.costUsd,
        maxContextTokens: Math.max(t.maxContextTokens ?? 0, e.context.tokens ?? 0) || undefined,
      })),
    )
    if (e.changed.includes('rateLimits')) await safely($, 'запись лимитов', () => recordLimits($, e))
    return result
  })

  // effort запроса основного цикла; поток ответа проходит без изменений.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) setEffort(e.effort)
    return yield* next(e)
  })

  // Ходы и токены — основного цикла и субагентов.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await safely($, 'учесть ход', () => mutate($, t => onTurn(t, e, currentEffort())))
    return result
  })

  // Счётчик инструментов; вызов не ждёт записи.
  on('tool.call', async ($, e, next) => {
    void safely($, 'учесть инструмент', () =>
      mutate($, t => ({ ...t, tools: { ...t.tools, [e.tool]: (t.tools[e.tool] ?? 0) + 1 } })),
    )
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && result.messages) {
      await safely($, 'учесть сжатие', () => mutate($, t => ({ ...t, compactions: t.compactions + 1 })))
    }
    return result
  })

  // Итог сессии — до шага движка: у session.end короткий общий бюджет. Не успели — итог
  // останется в $.store и будет дописан как orphan.
  on('session.end', async ($, e, next) => {
    await safely($, 'запись итога сессии', () => endSession($, e))
    return next(e)
  })

  registerPanel(on)
}
