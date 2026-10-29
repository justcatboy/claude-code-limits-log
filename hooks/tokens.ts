// Токены по моделям: сложение хода, разница и сумма списков.
import type { TurnCompleteInput } from 'claude-code'

// Токены одной модели: основной цикл или субагенты (agent). turns — ходы этого цикла.
export type TokenUsage = {
  model: string
  agent?: boolean
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const usageKey = (u: { model: string; agent?: boolean }) => `${u.model}|${u.agent ? 'agent' : 'main'}`

function empty(model: string, agent: boolean): TokenUsage {
  return {
    model,
    ...(agent ? { agent: true } : {}),
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

function combine(a: TokenUsage, b: TokenUsage, sign: 1 | -1): TokenUsage {
  return {
    ...a,
    turns: a.turns + sign * b.turns,
    input: a.input + sign * b.input,
    output: a.output + sign * b.output,
    cacheRead: a.cacheRead + sign * b.cacheRead,
    cacheWrite: a.cacheWrite + sign * b.cacheWrite,
  }
}

const isEmpty = (u: TokenUsage) => u.turns + u.input + u.output + u.cacheRead + u.cacheWrite === 0

// Список плюс токены одного хода (у хода без usage — без изменений).
export function addTurn(list: TokenUsage[], e: TurnCompleteInput): TokenUsage[] {
  if (!e.usage) return list
  const agent = Boolean(e.agentId)
  const turn: TokenUsage = {
    ...empty(e.usage.model, agent),
    turns: 1,
    input: e.usage.input_tokens,
    output: e.usage.output_tokens,
    cacheRead: e.usage.cache_read_input_tokens,
    cacheWrite: e.usage.cache_creation_input_tokens,
  }
  return sum([list, [turn]])
}

// Сумма списков по моделям.
export function sum(lists: TokenUsage[][]): TokenUsage[] {
  const out = new Map<string, TokenUsage>()
  for (const u of lists.flat()) {
    out.set(usageKey(u), combine(out.get(usageKey(u)) ?? empty(u.model, Boolean(u.agent)), u, 1))
  }
  return [...out.values()]
}

// a − b по моделям; отрицательное (итог начался заново) — как ноль, пустые строки отбрасываются.
export function subtract(a: TokenUsage[], b: TokenUsage[]): TokenUsage[] {
  return a
    .map(u => {
      const was = b.find(x => usageKey(x) === usageKey(u))
      return was ? combine(u, was, -1) : u
    })
    .filter(u => u.turns >= 0 && u.input >= 0 && u.output >= 0 && u.cacheRead >= 0 && u.cacheWrite >= 0)
    .filter(u => !isEmpty(u))
}
