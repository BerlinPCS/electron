export function mergeRanges (input: Array<[number, number]>) {
  const ranges = input
    .filter(range => Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0])
    .sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) merged.push([...range])
    else last[1] = Math.max(last[1], range[1])
  }
  return merged
}

export function splitAtBerlinMidnight (start: Date, end: Date) {
  if (berlinDateKey(start) === berlinDateKey(end)) return [[start, end]] as Array<[Date, Date]>
  let low = start.getTime()
  let high = end.getTime()
  const startKey = berlinDateKey(start)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (berlinDateKey(new Date(middle)) === startKey) low = middle
    else high = middle
  }
  const boundary = new Date(high)
  return [[start, boundary], [boundary, end]] as Array<[Date, Date]>
}

function berlinDateKey (date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date)
}

// Observed playback into the final 10% (at most three minutes), including a
// resumed episode. A seek-only point or a tiny mining sample is not completion.
export function hasWatchedEnding (ranges: Array<[number, number]>, duration: number) {
  return Number.isFinite(duration) && duration > 0 && ranges.some(([start, end]) =>
    end - start >= Math.min(30, duration * 0.25) && end >= duration - Math.min(180, duration * 0.1))
}
