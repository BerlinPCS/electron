import assert from 'node:assert/strict'
import test from 'node:test'

import { isCanonicalBase64 } from '../src/main/base64.ts'

test('validates canonical base64 without a payload-sized regexp stack', () => {
  assert.equal(isCanonicalBase64(''), true)
  assert.equal(isCanonicalBase64('Zg=='), true)
  assert.equal(isCanonicalBase64('Zm8='), true)
  assert.equal(isCanonicalBase64('Zm9v'), true)
  assert.equal(isCanonicalBase64('Zh=='), false)
  assert.equal(isCanonicalBase64('Zm9='), false)
  assert.equal(isCanonicalBase64('Zg='), false)
  assert.equal(isCanonicalBase64('Zm=v'), false)

  const large = Buffer.alloc(4 * 1024 * 1024, 0xff).toString('base64')
  assert.equal(isCanonicalBase64(large), true)
})
