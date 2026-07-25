const BASE64_CHUNK_SIZE = 64 * 1024
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]+$/

/**
 * Validates canonical padded base64 without applying a nested repeating regular
 * expression to the entire payload. V8 can exhaust its regexp stack on media
 * payloads only a few megabytes large.
 */
export function isCanonicalBase64 (value: string) {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const contentLength = value.length - padding
  if ((padding === 0 && contentLength % 4 !== 0) ||
      (padding === 1 && contentLength % 4 !== 3) ||
      (padding === 2 && contentLength % 4 !== 2)) return false

  for (let offset = 0; offset < contentLength; offset += BASE64_CHUNK_SIZE) {
    if (!BASE64_CHARACTERS.test(value.slice(offset, Math.min(offset + BASE64_CHUNK_SIZE, contentLength)))) {
      return false
    }
  }

  if (padding === 2 && (base64Sextet(value.charCodeAt(contentLength - 1)) & 0x0f) !== 0) return false
  if (padding === 1 && (base64Sextet(value.charCodeAt(contentLength - 1)) & 0x03) !== 0) return false
  return true
}

function base64Sextet (code: number) {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  return code === 43 ? 62 : code === 47 ? 63 : -1
}
