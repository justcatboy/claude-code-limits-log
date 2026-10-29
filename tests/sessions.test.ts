// Запись журнала через движок: хуки register.tsx, итоги сессий (sessions.ts), записи limits
// (log.ts). Хуки теста стоят за движок: файлы и хранилище — в памяти, сессия — подставная.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CONFIG = '/cfg'
const HOUR = 3600_000

// Движок под модом: файлы, $.store, сессия. Сессию можно сменить (как /clear или другой процесс
// с тем же хранилищем) — меняется только id.
function engine(on: On) {
  const files = new Map<string, string>()
  // Файлы, которые есть, но не читаются (заняты другой программой).
  const locked = new Set<string>()
  const store = new Map<string, unknown>()
  const logs: string[] = []
  const state = { session: 'A' }

  // Движок приводит пути к виду платформы («C:\cfg\…» на Windows): в памяти — в одном виде.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) =>
    files.has(norm(e.path)) && !locked.has(norm(e.path))
      ? { value: files.get(norm(e.path))! }
      : { deny: 'missing or locked' },
  )
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: structuredClone(store.get(e.key)) }))
  on('store.set', (_, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: state.session }))
  on('session.cwd', () => ({ value: `C:/proj/${state.session}` }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.usage', () => ({
    value: { startedAt: Date.now() - HOUR, context: { window: 200_000 }, rateLimits: [], cost: { usd: 2.5 } },
  }))
  on('ui.log', (_, e) => {
    logs.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'limits' } }))
  // Шаги самого движка у событий сессии.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))

  const month = () => new Date().toISOString().slice(0, 7)
  const fileOf = (session: string) => `${CONFIG}/limits-log/log/${month()}/${session}.jsonl`
  const records = (session: string) =>
    (files.get(fileOf(session)) ?? '')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
  return { files, locked, store, logs, state, fileOf, records }
}

let turnN = 0
const turn = (input: number, extra: Record<string, unknown> = {}) => ({
  turnId: `t${++turnN}`,
  answer: '',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer' as const,
  usage: {
    model: 'opus',
    input_tokens: input,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  ...extra,
})

const inFuture = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString()
const measure = (h5: number, d7: number) => ({
  context: { window: 200_000, tokens: 50_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: h5, resetsAt: inFuture(3) },
    { kind: 'seven_day', percentUsed: d7, resetsAt: inFuture(100) },
  ],
  cost: { usd: 1.25 },
  changed: ['rateLimits' as const],
})

describe('итог сессии', () => {
  test('одновременные ходы основного цикла и субагента не теряются', async ($, on) => {
    const db = engine(on)
    await $.session.start({ cwd: 'C:/proj/A', surface: null, isInteractive: true })
    await Promise.all([
      $.turn.complete(turn(10)),
      $.turn.complete(turn(5, { agentId: 'ag1', usage: { ...turn(5).usage, model: 'haiku' } })),
      $.turn.complete(turn(20, { reason: 'aborted', isAborted: true })),
      $.tool.call({ tool: 'Read', file_path: 'C:/proj/A/README.md' }),
    ])

    const t = db.store.get('session:A') as any
    expect(t.turns).toBe(2)
    expect(t.aborted).toBe(1)
    expect(t.activeMs).toBe(2000)
    expect(t.tools.Read).toBe(1)
    expect(t.usage.find((u: any) => u.model === 'opus' && !u.agent).input).toBe(30)
    expect(t.usage.find((u: any) => u.agent).input).toBe(5)
    expect(db.logs).toEqual([])
  })
})

describe('записи limits', () => {
  test('в файл своей сессии, с итогами всех сессий; то же состояние второй раз не пишется', async ($, on) => {
    const db = engine(on)
    // Итог другой сессии уже лежит в общем хранилище.
    db.store.set('session:B', {
      session: 'B',
      turns: 3,
      usage: [{ model: 'opus', turns: 3, input: 99, output: 0, cacheRead: 0, cacheWrite: 0 }],
      lastAt: Date.now(),
    })
    await $.session.start({ cwd: 'C:/proj/A', surface: null, isInteractive: true })
    await $.turn.complete(turn(10))
    await $.session.measure(measure(10, 1))
    await $.session.measure(measure(10, 1))

    const recs = db.records('A')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      v: 4,
      kind: 'limits',
      session: 'A',
      costUsd: 1.25,
      contextTokens: 50_000,
    })
    const totals = Object.fromEntries(recs[0].usageTotals.map((t: any) => [t.session, t.turns]))
    expect(totals).toEqual({ A: 1, B: 3 })
    expect(db.files.has(db.fileOf('B'))).toBe(false)
    expect(db.logs).toEqual([])
  })

  test('файл сессии есть, но не читается — не затирается', async ($, on) => {
    const db = engine(on)
    await $.session.measure(measure(10, 1))
    const before = db.files.get(db.fileOf('A'))
    db.locked.add(db.fileOf('A'))
    await $.session.measure(measure(11, 1))

    expect(db.files.get(db.fileOf('A'))).toBe(before)
    expect(db.logs).toHaveLength(1)
  })

  test('без окон и с закончившимся окном — не пишется', async ($, on) => {
    const db = engine(on)
    await $.session.measure({ ...measure(10, 1), rateLimits: [] })
    const ended = measure(11, 1)
    ended.rateLimits[0]!.resetsAt = new Date(Date.now() - HOUR).toISOString()
    await $.session.measure(ended)
    expect(db.records('A')).toHaveLength(0)
  })
})

describe('запись session', () => {
  test('session.end пишет итог с итоговой стоимостью в файл сессии', async ($, on) => {
    const db = engine(on)
    await $.session.start({ cwd: 'C:/proj/A', surface: null, isInteractive: true })
    await $.turn.complete(turn(10))
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'A', resume: { id: 'A' } as any })

    const rec = db.records('A').find((r: any) => r.kind === 'session')
    expect(rec).toMatchObject({
      kind: 'session',
      session: 'A',
      reason: 'prompt_input_exit',
      turns: 1,
      costUsd: 2.5,
    })
    expect(rec.project).toBe('C:/proj/A')
    expect((db.store.get('session:A') as any).endedAt).toBeDefined()
  })

  test('брошенная сессия дописывается как orphan в её файл; старый закончившийся итог удаляется', async ($, on) => {
    const db = engine(on)
    const quiet = Date.now() - 13 * HOUR
    db.store.set('session:C', {
      session: 'C',
      turns: 2,
      aborted: 0,
      errors: 0,
      activeMs: 5,
      usage: [],
      tools: {},
      compactions: 0,
      lastAt: quiet,
    })
    db.store.set('session:D', {
      session: 'D',
      turns: 1,
      usage: [],
      lastAt: quiet,
      endedAt: Date.now() - 25 * HOUR,
    })
    db.store.set('session:E', { session: 'E', turns: 1, usage: [], lastAt: Date.now() - HOUR })

    await $.session.start({ cwd: 'C:/proj/A', surface: null, isInteractive: true })

    expect(db.records('C')).toEqual([
      expect.objectContaining({ kind: 'session', session: 'C', reason: 'orphan' }),
    ])
    expect((db.store.get('session:C') as any).endedAt).toBeDefined()
    expect(db.store.has('session:D')).toBe(false)
    // Молчит меньше 12 часов — ещё жива.
    expect(db.records('E')).toEqual([])
    expect((db.store.get('session:E') as any).endedAt).toBeUndefined()
  })

  test('брошенная сессия ожила — её session.end пишет полный итог', async ($, on) => {
    const db = engine(on)
    await $.turn.complete(turn(10))
    // Другая сессия сочла A брошенной: orphan записан, endedAt стоит.
    const t = db.store.get('session:A') as any
    db.store.set('session:A', { ...t, lastAt: Date.now() - 13 * HOUR, endedAt: Date.now() })

    await $.turn.complete(turn(10))
    expect((db.store.get('session:A') as any).endedAt).toBeUndefined()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'A', resume: { id: 'A' } as any })

    const rec = db.records('A').find((r: any) => r.kind === 'session')
    expect(rec).toMatchObject({ reason: 'prompt_input_exit', turns: 2 })
  })
})
