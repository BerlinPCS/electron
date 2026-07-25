import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAniListAuthResponse } from '../src/main/auth.ts'

test('parses an AniList implicit OAuth callback', () => {
  assert.deepEqual(
    parseAniListAuthResponse('https://hayase.app/#/authorize?al&access_token=secret&token_type=Bearer&expires_in=31536000'),
    {
      access_token: 'secret',
      expires_in: '31536000',
      token_type: 'Bearer'
    }
  )
})

test('rejects unrelated and incomplete AniList OAuth callbacks', () => {
  assert.equal(parseAniListAuthResponse('https://example.com/#/authorize?al&access_token=secret&token_type=Bearer&expires_in=1'), undefined)
  assert.equal(parseAniListAuthResponse('https://hayase.app/#/authorize?access_token=secret&token_type=Bearer&expires_in=1'), undefined)
  assert.equal(parseAniListAuthResponse('https://hayase.app/#/authorize?al&access_token=secret&expires_in=1'), undefined)
})
