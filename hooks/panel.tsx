// Панель /limits: раскладка. Снимок анализа считается при открытии (refresh), тексты строк —
// в view.ts. Три режима, у каждого свои компоненты: now (хватит ли до сброса: окна 7d и 5h, полоса
// дней, цена и остаток), week (вкладки законченных недель — окон 7d, последняя первой),
// windows (окна 5h по всему журналу). Режим — аргумент команды или клавиши n / w / o; r
// пересчитывает снимок.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, Register, TextProps } from 'claude-code'

import type { Analysis, DayBudget, View, WeekReport } from '../types'
import { analyze } from './analysis'
import { LOG_DIR, configDir, projectsOf, readRecords, toRows } from './files'
import { storedProjects } from './sessions'
import { ddmm, hhmm, pad } from './format'
import * as text from './view'

const PANE = 'limits'
// Вкладок недель с клавишами 1–9.
const MAX_TABS = 9
// Уже панели полосы не сжимаются: дни перестают различаться.
const MIN_WIDTH = 21

const analysis = atom({ plugin: 'limits-log', key: 'analysis' } as const, null, { shape: 'analysis-10' })
// Индекс выбранной недели среди законченных (вкладки режима week).
const week = atom({ plugin: 'limits-log', key: 'week' } as const, 0, { shape: 'week-1' })
const view = atom({ plugin: 'limits-log', key: 'view' } as const, 'now' as View, { shape: 'view-2' })

const VIEWS: Record<string, View> = {
  '': 'now',
  now: 'now',
  week: 'week',
  weeks: 'week',
  windows: 'windows',
  h5: 'windows',
}

async function refresh($: Dollar) {
  const records = await readRecords($, `${await configDir($)}/${LOG_DIR}`)
  // Папки сессий: законченных — из записей session, идущих — из их итогов.
  const projects = { ...projectsOf(records), ...(await storedProjects($)) }
  const usage = await $.session.usage()
  await update($, analysis, () => analyze(toRows(records), usage.rateLimits, Date.now(), projects))
  await update($, week, () => 0)
}

// =============================================================================
// Кирпичики
// =============================================================================

type Ui = ReturnType<Dollar['ui']['resolve']>

// Что умеют кнопки панели.
type Actions = { setView: (v: View) => void; setWeek: (i: number) => void; refresh: () => void }

// Строка текста; без текста — ничего.
function Line(p: { ui: Ui; text?: string; dim?: boolean; bold?: boolean; color?: TextProps['color'] }) {
  if (!p.text) return null
  const { Text } = p.ui
  return (
    <Text dimColor={p.dim} bold={p.bold} color={p.color}>
      {p.text}
    </Text>
  )
}

// Заголовок раздела с пустой строкой перед ним.
function Heading({ ui, text }: { ui: Ui; text: string }) {
  const { Box, Text } = ui
  return (
    <Box marginTop={1}>
      <Text bold>{text}</Text>
    </Box>
  )
}

// «label ████░░░░ 34%», полоска в цвете уровня.
function MeterLine(p: { ui: Ui; label: string; pct: number; width: number }) {
  const { Text } = p.ui
  return (
    <Text>
      {p.label} <Text color={text.level(p.pct)}>{text.meter(p.pct, p.width)}</Text> {pad(p.pct, 3)}%
    </Text>
  )
}

// Полоса недели по дням во всю ширину: подпись над ней, дни над отрезками, потрачено — в цвете
// уровня недели.
function DayBars(p: { ui: Ui; title: string; days: DayBudget[]; start: number; pct: number; width: number }) {
  const { Box, Text } = p.ui
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{p.title}</Text>
      <Text dimColor>{text.dayBarLabels(p.days, p.start, p.width)}</Text>
      <Text>
        {text.dayBar(p.days, p.width).map((r, i) =>
          r.used ? (
            <Text key={String(i)} color={text.level(p.pct)}>
              {r.text}
            </Text>
          ) : (
            <Text key={String(i)} dimColor>
              {r.text}
            </Text>
          ),
        )}
      </Text>
    </Box>
  )
}

// =============================================================================
// Разделы
// =============================================================================

function Header({ ui, at, mode, act }: { ui: Ui; at: Date; mode: View; act: Actions }) {
  const { Box, Text, Button } = ui
  const modeButton = (key: View, hotkey: string, label: string) => (
    <Button
      key={`view:${key}`}
      hotkey={hotkey}
      variant={mode === key ? 'primary' : undefined}
      onPress={() => act.setView(key)}
    >
      {`${hotkey} ${label}`}
    </Button>
  )
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      <Text bold>{`Анализ на ${hhmm(at)} ${ddmm(at)}`}</Text>
      {modeButton('now', 'n', 'сейчас')}
      {modeButton('week', 'w', 'недели')}
      {modeButton('windows', 'o', 'окна')}
      <Button hotkey="r" onPress={act.refresh}>
        r обновить
      </Button>
    </Box>
  )
}

function WeekBody({ ui, w }: { ui: Ui; w: WeekReport }) {
  const { Box } = ui
  return (
    <Box flexDirection="column">
      <Line ui={ui} bold text={text.weekTitle(w)} />
      <MeterLine ui={ui} label="7d" pct={w.d7} width={text.WEEK_METER} />
      <Line ui={ui} text={text.costLine(w)} />
      <Line ui={ui} text={text.turnsLine(w)} />
      <Line ui={ui} dim text={text.modelsLine(w)} />

      <Heading ui={ui} text="По дням" />
      {w.days.map(d => (
        <Line ui={ui} key={String(d.index)} text={text.dayLine(d)} />
      ))}

      <Heading ui={ui} text="Окна 5h, наибольший процент" />
      {text.h5ByDay(w).map((d, i) => (
        <Box key={d.day} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Line ui={ui} dim text={d.day} />
          {d.windows.map(x => (
            <MeterLine
              ui={ui}
              key={String(x.reset)}
              label={text.h5Label(x)}
              pct={x.max}
              width={text.H5_METER}
            />
          ))}
        </Box>
      ))}
    </Box>
  )
}

function WeekTabs({ ui, weeks, index, act }: { ui: Ui; weeks: WeekReport[]; index: number; act: Actions }) {
  const { Box, Button } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {weeks.slice(0, MAX_TABS).map((w, i) => (
        <Button
          key={`week:${w.reset}`}
          hotkey={String(i + 1)}
          variant={i === index ? 'primary' : undefined}
          onPress={() => act.setWeek(i)}
        >
          {`${i + 1} ${text.tabLabel(w)}`}
        </Button>
      ))}
    </Box>
  )
}

// =============================================================================
// Режим now: хватит ли до сброса
// =============================================================================

// Сверху — ответ: заполнение 7d и 5h, хватит ли, окно 5h, сегодня и сколько можно. Дальше полоса
// дней (по прошлым неделям, пока их меньше двух — поровну), затем цена, остаток и потраченное.
// width — клеток в теле панели: полоски растягиваются на всю ширину.
function NowView({ ui, a, width }: { ui: Ui; a: Analysis; width: number }) {
  const { Box } = ui
  const n = a.now
  const current = a.weeks[0]?.isCurrent ? a.weeks[0] : undefined
  const d7 = a.windows.find(w => w.kind === 'seven_day')
  const h5 = a.windows.find(w => w.kind === 'five_hour')
  const reset = d7?.resetsAt ?? current?.reset
  const pct = d7?.pct ?? current?.d7
  if (reset === undefined || pct === undefined) {
    return <Line ui={ui} dim text="Лимитов ещё нет: придут с первым ответом API." />
  }
  const meter = Math.max(10, width - 8)
  return (
    <Box flexDirection="column">
      <Line ui={ui} bold text={text.nowWeekTitle(reset, n.secondsLeft)} />
      <MeterLine ui={ui} label="7d" pct={pct} width={meter} />
      {h5 && <MeterLine ui={ui} label="5h" pct={h5.pct} width={meter} />}

      <Box flexDirection="column" marginTop={1}>
        <Line ui={ui} color={text.outlookLevel(n)} text={text.outlookLine(n)} />
        {h5 && (
          <Line
            ui={ui}
            color={n.h5ExhaustAt !== undefined ? 'yellow' : undefined}
            text={text.h5Line(h5, n)}
          />
        )}
        <Line ui={ui} text={text.todayLine(n)} />
        <Line ui={ui} text={text.allowanceLine(n)} />
      </Box>

      {n.week && (
        <DayBars
          ui={ui}
          title={text.dayBarTitle(n.week.usual && n.week.pastWeeks)}
          days={n.week.usual ?? n.week.even}
          start={n.week.start}
          pct={pct}
          width={width}
        />
      )}

      <Box flexDirection="column" marginTop={1}>
        <Line ui={ui} text={text.priceLine(n, a.h5)} />
        <Line ui={ui} text={text.leftLine(n)} />
        {current && <Line ui={ui} text={text.spentLine(current)} />}
        {current && <Line ui={ui} dim text={text.nowModelsLine(current)} />}
      </Box>

      {current?.work && <WeekWork ui={ui} work={current.work} />}
    </Box>
  )
}

// Работа недели: проекты за неделю, затем сессии по дням (итог дня и его сессии).
function WeekWork({ ui, work }: { ui: Ui; work: NonNullable<WeekReport['work']> }) {
  const { Box } = ui
  const width = text.nameWidth([
    ...work.projects.map(p => text.projectName(p.project)),
    ...work.days.flatMap(d => d.sessions.map(s => text.projectName(s.project))),
  ])
  return (
    <Box flexDirection="column">
      <Heading ui={ui} text="Проекты недели" />
      {work.projects.map(p => (
        <Line ui={ui} key={p.project ?? '?'} text={text.projectLine(p, width)} />
      ))}

      <Heading ui={ui} text="Сессии по дням" />
      {work.days.map((d, i) => (
        <Box key={String(d.index)} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Line ui={ui} dim text={text.workDayTitle(d)} />
          {d.sessions.map(s => (
            <Line ui={ui} key={s.session} text={text.sessionLine(s, width)} />
          ))}
        </Box>
      ))}
    </Box>
  )
}

// =============================================================================
// Режим week
// =============================================================================

// Только законченные недели, последняя первой: текущую показывает now.
function WeekView({ ui, a, index, act }: { ui: Ui; a: Analysis; index: number; act: Actions }) {
  const { Box } = ui
  const past = a.weeks.filter(w => !w.isCurrent)
  const selected = past[Math.min(index, past.length - 1)]
  if (!selected) return <Line ui={ui} dim text="Законченных недель ещё нет: текущая — в now." />
  return (
    <Box flexDirection="column">
      <WeekTabs ui={ui} weeks={past} index={past.indexOf(selected)} act={act} />
      <WeekBody ui={ui} w={selected} />
    </Box>
  )
}

// =============================================================================
// Режим windows
// =============================================================================

// Окна 5h по всему журналу: сколько и до какого процента доходили, что окно стоит в 7d, сколько
// окон вмещает остаток недели, в какие часы окна начинаются чаще.
function WindowsView({ ui, a }: { ui: Ui; a: Analysis }) {
  const { Box } = ui
  const x = a.h5
  if (x.total === 0) return <Line ui={ui} dim text="Законченных окон 5h в журнале ещё нет." />
  const most = x.byStart[0]?.count ?? 0
  return (
    <Box flexDirection="column">
      <Line ui={ui} bold text={text.windowsTitle(x)} />
      <Box flexDirection="column" marginTop={1}>
        {x.levels.map(l => (
          <Line ui={ui} key={String(l.from)} text={text.levelLine(l, x.total)} />
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Line ui={ui} text={text.usualWindowLine(x)} />
        <Line ui={ui} text={text.fullWindowLine(x)} />
        <Line ui={ui} text={text.fillLine(x)} />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Line ui={ui} text={text.windowsWeekLine(x)} />
        <Line ui={ui} text={text.fitLine(x)} />
      </Box>

      <Heading ui={ui} text="По часу начала" />
      {x.byStart.map(s => (
        <Line ui={ui} key={String(s.hour)} text={text.startLine(s, most)} />
      ))}
    </Box>
  )
}

// =============================================================================
// Команда и панель
// =============================================================================

// На session.start (его хук в register.tsx).
export async function startPanel($: Dollar) {
  await $.command.register({
    name: 'limits',
    description: 'Лимиты подписки: что осталось до сброса, по неделям',
    argumentHint: '[now|week|windows]',
  })
}

export function registerPanel(on: Parameters<Register>[0]) {
  on('command.run', { command: 'limits' }, async ($, e) => {
    const mode = VIEWS[e.args.trim().toLowerCase()]
    if (!mode) return { text: `Не знаю режим «${e.args.trim()}»: now, week или windows.` }
    await refresh($)
    await update($, view, () => mode)
    await $.ui.open({ id: PANE, title: 'Limits' })
    return { text: `Панель Limits открыта: ${mode}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button } = ui
    const act: Actions = {
      setView: v => void update($, view, () => v),
      setWeek: i => void update($, week, () => i),
      refresh: () => void refresh($),
    }

    const snapshot = await read($, analysis)
    if (!snapshot) {
      return (
        <Box flexDirection="column">
          <Line ui={ui} dim text="Анализа ещё нет." />
          <Button hotkey="r" onPress={act.refresh}>
            Посчитать
          </Button>
        </Box>
      )
    }

    const mode = await read($, view)
    const index = await read($, week)

    return (
      <Box flexDirection="column">
        <Header ui={ui} at={new Date(snapshot.at)} mode={mode} act={act} />
        <Box marginTop={1}>
          {mode === 'now' && (
            <NowView ui={ui} a={snapshot} width={Math.max(MIN_WIDTH, e.props.bodyColumns)} />
          )}
          {mode === 'week' && <WeekView ui={ui} a={snapshot} index={index} act={act} />}
          {mode === 'windows' && <WindowsView ui={ui} a={snapshot} />}
        </Box>
      </Box>
    )
  })
}
