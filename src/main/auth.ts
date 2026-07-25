import type { AuthResponse } from 'native'

const HAYASE_AUTH_ORIGIN = 'https://hayase.app'

export function parseAniListAuthResponse (target: string): AuthResponse | undefined {
  let callback: URL
  try {
    callback = new URL(target)
  } catch {
    return
  }
  if (callback.origin !== HAYASE_AUTH_ORIGIN || !callback.hash.startsWith('#/authorize?')) return

  const params = new URLSearchParams(callback.hash.slice(callback.hash.indexOf('?') + 1))
  const accessToken = params.get('access_token')
  const expiresIn = params.get('expires_in')
  const tokenType = params.get('token_type')
  if (!params.has('al') || !accessToken || !expiresIn || tokenType?.toLowerCase() !== 'bearer') return
  return {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: 'Bearer'
  }
}
