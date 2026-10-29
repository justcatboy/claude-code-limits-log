// Время и форматирование чисел для панели: общие мелочи без знания о лимитах.

export const HOUR = 3600
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY
export const H5 = 5 * HOUR

// Unix-секунды → Date.
export const fromUnix = (seconds: number) => new Date(seconds * 1000)

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
export const weekdayName = (weekday: number) => WEEKDAYS[weekday]!

const two = (n: number) => String(n).padStart(2, '0')
export const pad = (value: string | number, width: number) => String(value).padStart(width)

// Локальное время: «14:05», «28.10», «ср 28.10».
export const hhmm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`
export const ddmm = (d: Date) => `${two(d.getDate())}.${two(d.getMonth() + 1)}`
export const dayLabel = (d: Date) => `${weekdayName(d.getDay())} ${ddmm(d)}`

// ISO UTC из журнала как «2026-03-04 12:34:06».
export const utc = (iso: string) => iso.replace('T', ' ').replace('Z', '')

// Локальный день ISO-времени: «2026-03-04».
export const localDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE')

// Длительность: «6д 05ч», меньше суток — «5ч 07м».
export function span(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days > 0 ? `${days}д ${two(hours)}ч` : `${hours}ч ${two(minutes % 60)}м`
}

// Число со словом в нужной форме: plural(3, ['ход', 'хода', 'ходов']) — «3 хода».
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const tens = n % 100
  const units = n % 10
  const form = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many
  return `${n} ${form}`
}

export const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`
export const usd = (n: number) => `$${n.toFixed(2)}`
