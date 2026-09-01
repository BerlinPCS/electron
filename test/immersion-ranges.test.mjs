import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeRanges, splitAtBerlinMidnight } from '../src/main/immersion-ranges.ts'

test('merges overlapping replay ranges without double-counting coverage', () => {
  assert.deepEqual(mergeRanges([[0, 10], [5, 12], [20, 30], [21, 24]]), [[0, 12], [20, 30]])
  assert.equal(mergeRanges([[0, 45], [0, 45], [45, 75]]).reduce((sum, [start, end]) => sum + end - start, 0), 75)
})

test('uses the Berlin midnight after the spring DST change', () => {
  const parts = splitAtBerlinMidnight(
    new Date('2026-03-29T21:59:58.000Z'),
    new Date('2026-03-29T22:00:02.000Z')
  )
  assert.equal(parts[0][1].toISOString(), '2026-03-29T22:00:00.000Z')
})

test('uses the Berlin midnight after the autumn DST change', () => {
  const parts = splitAtBerlinMidnight(
    new Date('2026-10-25T22:59:58.000Z'),
    new Date('2026-10-25T23:00:02.000Z')
  )
  assert.equal(parts[0][1].toISOString(), '2026-10-25T23:00:00.000Z')
})

test('discards invalid coverage ranges', () => {
  assert.deepEqual(mergeRanges([[4, 4], [9, 2], [1, 3]]), [[1, 3]])
})

test('splits wall time at the Europe Berlin day boundary', () => {
  const parts = splitAtBerlinMidnight(
    new Date('2026-08-31T21:59:58.000Z'),
    new Date('2026-08-31T22:00:02.000Z')
  )
  assert.equal(parts.length, 2)
  assert.equal(parts[0][1].toISOString(), '2026-08-31T22:00:00.000Z')
  assert.equal(parts[1][0].toISOString(), '2026-08-31T22:00:00.000Z')
})
