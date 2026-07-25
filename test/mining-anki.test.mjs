/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's Fetch overloads add noise to mocked-fetch tests.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AnkiConnectClient,
  DEFAULT_MINING_ANKI_SETTINGS,
  MiningAnkiService,
  parseCanAdd,
  replaceMediaReferences,
  validateAnkiEndpoint
} from '../src/main/mining-anki.ts'

function jsonResponse (result, error = null, status = 200) {
  return new Response(JSON.stringify({ result, error }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('only accepts loopback AnkiConnect endpoints', () => {
  assert.equal(validateAnkiEndpoint('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/')
  assert.equal(validateAnkiEndpoint('http://localhost:8765'), 'http://localhost:8765/')
  assert.equal(validateAnkiEndpoint('http://[::1]:8765'), 'http://[::1]:8765/')
  assert.throws(() => validateAnkiEndpoint('http://192.168.1.2:8765'), /localhost/)
  assert.throws(() => validateAnkiEndpoint('https://example.com'), /localhost/)
  assert.throws(() => validateAnkiEndpoint('file:///tmp/anki'), /localhost/)
})

test('client sends API v6 and optional key in main-process POST body', async () => {
  const requests = []
  const client = new AnkiConnectClient('http://127.0.0.1:8765', 'secret', async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) })
    return jsonResponse(6)
  })
  await client.ping()
  assert.equal(requests[0].url, 'http://127.0.0.1:8765/')
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(requests[0].body, { action: 'version', version: 6, key: 'secret' })
})

test('client stores multi-megabyte media without overflowing base64 validation', async () => {
  const data = Buffer.alloc(4 * 1024 * 1024, 0xff).toString('base64')
  const client = new AnkiConnectClient('http://127.0.0.1:8765', '', async (_url, init) => {
    const request = JSON.parse(init.body)
    assert.equal(request.params.data.length, data.length)
    return jsonResponse('large.webp')
  })
  assert.equal(await client.storeMedia({
    kind: 'screenshot',
    filename: 'large.webp',
    mimeType: 'image/webp',
    data
  }), 'large.webp')
})

test('detect discovers and sorts decks/models and their fields', async () => {
  const actions = []
  const client = new AnkiConnectClient('http://127.0.0.1:8765', '', async (_url, init) => {
    const request = JSON.parse(init.body)
    actions.push(request)
    if (request.action === 'deckNames') return jsonResponse(['Mining', 'Default'])
    if (request.action === 'modelNames') return jsonResponse(['Basic', 'Lapis'])
    if (request.action === 'modelFieldNames') {
      return jsonResponse(request.params.modelName === 'Lapis' ? ['Expression', 'Sentence'] : ['Front', 'Back'])
    }
    throw new Error('unexpected action')
  })
  assert.deepEqual(await client.detect(), {
    decks: ['Default', 'Mining'],
    models: [
      { name: 'Basic', fields: ['Front', 'Back'] },
      { name: 'Lapis', fields: ['Expression', 'Sentence'] }
    ]
  })
  assert.equal(actions.filter(request => request.action === 'modelFieldNames').length, 2)
})

test('service auto-selects non-default deck and known Hoshi model with defaults', async () => {
  let settings = structuredClone(DEFAULT_MINING_ANKI_SETTINGS)
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    if (request.action === 'deckNames') return jsonResponse(['Default', 'Japanese'])
    if (request.action === 'modelNames') return jsonResponse(['Basic', 'Lapis'])
    if (request.action === 'modelFieldNames') {
      return jsonResponse(request.params.modelName === 'Lapis' ? ['Expression', 'Sentence'] : ['Front'])
    }
    throw new Error('unexpected action')
  })
  const state = await service.detect()
  assert.equal(state.settings.deckName, 'Japanese')
  assert.equal(state.settings.modelName, 'Lapis')
  assert.deepEqual(state.settings.fieldMappings, { Expression: '{expression}', Sentence: '{sentence}' })
})

test('startup reachability probe restores decks, models, and fields for saved settings', async () => {
  const settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Japanese',
    modelName: 'Kiku',
    fieldMappings: { Expression: '{expression}' }
  }
  const actions = []
  const service = new MiningAnkiService({
    read: () => settings,
    write: () => {}
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    actions.push(request.action)
    if (request.action === 'version') return jsonResponse(6)
    if (request.action === 'deckNames') return jsonResponse(['Japanese'])
    if (request.action === 'modelNames') return jsonResponse(['Kiku'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Expression', 'Sentence'])
    throw new Error(`unexpected action: ${request.action}`)
  })

  assert.deepEqual(await service.probeReachability(), { status: 'success' })
  const state = service.state()
  assert.equal(state.connectionStatus, 'connected')
  assert.deepEqual(state.decks, ['Japanese'])
  assert.deepEqual(state.models, [{ name: 'Kiku', fields: ['Expression', 'Sentence'] }])
  assert.deepEqual(actions, ['version', 'deckNames', 'modelNames', 'modelFieldNames'])
})

test('duplicate probe uses first field and deck-root/check-all-model options', async () => {
  let settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Japanese::Mining',
    modelName: 'Basic',
    duplicateScope: 'deckRoot',
    checkAllModels: true,
    allowDuplicates: true,
    fieldMappings: { Front: '{expression}' }
  }
  let checkedNote
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    if (request.action === 'deckNames') return jsonResponse(['Japanese::Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front', 'Back'])
    if (request.action === 'canAddNotesWithErrorDetail') {
      checkedNote = request.params.notes[0]
      return jsonResponse([{ canAdd: false, error: 'duplicate' }])
    }
    throw new Error('unexpected action')
  })
  const result = await service.checkDuplicate({ expression: '食べる' })
  assert.deepEqual(result, { status: 'success', duplicate: true })
  assert.deepEqual(checkedNote.fields, { Front: '食べる' })
  assert.deepEqual(checkedNote.options, {
    allowDuplicate: false,
    duplicateScope: 'deck',
    duplicateScopeOptions: { deckName: 'Japanese', checkChildren: true, checkAllModels: true }
  })
})

test('add stores host-loaded media, adds note, and force syncs', async () => {
  let settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Mining',
    modelName: 'Basic',
    forceSync: true,
    fieldMappings: {
      Front: '{expression}',
      WordAudio: '{audio}',
      SentenceAudio: '{sentence-audio}',
      Back: '{sentence}<br>{furigana-plain}<br>{frequencies}<br>{timestamp}<br>{screenshot}<br>dict.png'
    }
  }
  const requests = []
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    if (request.action === 'deckNames') return jsonResponse(['Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front', 'WordAudio', 'SentenceAudio', 'Back'])
    if (request.action === 'canAddNotesWithErrorDetail') return jsonResponse([{ canAdd: true }])
    if (request.action === 'storeMediaFile') return jsonResponse(request.params.filename)
    if (request.action === 'addNote') return jsonResponse(42)
    if (request.action === 'sync') return jsonResponse(null)
    throw new Error('unexpected action')
  }, {
    loadWordAudio: async () => ({ filename: 'word.opus', mimeType: 'audio/ogg', data: new Uint8Array([1, 2]) }),
    loadDictionaryMedia: async () => new Uint8Array([3, 4])
  })
  const result = await service.addNote({
    payload: {
      expression: '食べる',
      matched: '食べる',
      furiganaPlain: '食[た]べる',
      frequenciesHtml: '<ol><li>100</li></ol>',
      audio: 'https://audio.example/word.opus',
      dictionaryMedia: [{ dictionary: 'JMdict', path: 'dict.png', filename: 'dict.png' }]
    },
    context: {
      sentence: 'パンを食べる。',
      selectedText: '食べる',
      title: 'Book',
      timestamp: 12.5,
      sentenceOffset: 3,
      media: [
        { kind: 'screenshot', filename: 'shot.png', mimeType: 'image/png', data: 'AQI=' },
        { kind: 'audio', filename: 'sentence.wav', mimeType: 'audio/wav', data: 'AwQ=' }
      ]
    }
  })
  assert.deepEqual(result, { status: 'success', noteId: 42 })
  assert.equal(requests.filter(request => request.action === 'storeMediaFile').length, 4)
  const note = requests.find(request => request.action === 'addNote').params.note
  assert.equal(note.fields.Front, '食べる')
  assert.match(note.fields.Back, /パンを<b>食べる<\/b>。/)
  assert.match(note.fields.Back, /食\[た]べる/)
  assert.match(note.fields.Back, /<ol><li>100<\/li><\/ol>/)
  assert.match(note.fields.Back, /00:00:12\.500/)
  assert.equal(note.fields.WordAudio, '[sound:word.opus]')
  assert.equal(note.fields.SentenceAudio, '[sound:sentence.wav]')
  assert.match(note.fields.Back, /<img src="shot\.png">/)
  assert.match(note.fields.Back, /<img src="dict\.png">/)
  assert.equal(requests.at(-1).action, 'sync')
})

test('native capture probes word audio, encodes generated media, and preserves original word audio', async () => {
  const settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Mining',
    modelName: 'Basic',
    fieldMappings: {
      Front: '{expression}',
      WordAudio: '{audio}',
      SentenceAudio: '{sentence-audio}',
      Picture: '{screenshot}'
    }
  }
  const requests = []
  const encoderCalls = []
  const encoder = {
    state: () => ({ available: true }),
    probeDuration: async media => {
      assert.equal(media.filename, 'word.opus')
      return 1.25
    },
    encode: async (capture, duration) => {
      encoderCalls.push({ capture, duration })
      return [
        { kind: 'screenshot', filename: 'shot.webp', mimeType: 'image/webp', data: new Uint8Array([1]) },
        { kind: 'audio', filename: 'sentence.mp3', mimeType: 'audio/mpeg', data: new Uint8Array([2]) }
      ]
    },
    stop: () => {}
  }
  const service = new MiningAnkiService({
    read: () => settings,
    write: () => {}
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    if (request.action === 'deckNames') return jsonResponse(['Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front', 'WordAudio', 'SentenceAudio', 'Picture'])
    if (request.action === 'canAddNotesWithErrorDetail') return jsonResponse([{ canAdd: true }])
    if (request.action === 'storeMediaFile') return jsonResponse(request.params.filename)
    if (request.action === 'addNote') return jsonResponse(7)
    throw new Error(`unexpected action: ${request.action}`)
  }, {
    loadWordAudio: async () => ({ filename: 'word.opus', mimeType: 'audio/ogg', data: new Uint8Array([3]) })
  }, undefined, encoder)
  const result = await service.addNote({
    payload: { expression: '猫', audio: 'https://audio.example/word.opus' },
    context: {
      sentence: '猫',
      selectedText: '猫',
      title: 'Video',
      timestamp: 12,
      media: [],
      capture: {
        sourceUrl: 'http://localhost:7344/video.mkv',
        currentTime: 12,
        start: 11.8,
        end: 13.2,
        captureImage: true,
        captureAudio: true,
        imageMode: 'animated',
        staticFormat: 'webp',
        animatedFormat: 'webp',
        quality: 'balanced',
        maxHeight: 720,
        fps: 12,
        syncAnimationToWordAudio: true
      }
    }
  })
  assert.deepEqual(result, { status: 'success', noteId: 7 })
  assert.equal(encoderCalls.length, 1)
  assert.equal(encoderCalls[0].duration, 1.25)
  const stored = requests.filter(request => request.action === 'storeMediaFile')
    .map(request => request.params.filename)
    .sort((a, b) => a.localeCompare(b))
  assert.deepEqual(stored, ['sentence.mp3', 'shot.webp', 'word.opus'])
  const note = requests.find(request => request.action === 'addNote').params.note
  assert.equal(note.fields.WordAudio, '[sound:word.opus]')
  assert.equal(note.fields.SentenceAudio, '[sound:sentence.mp3]')
  assert.equal(note.fields.Picture, '<img src="shot.webp">')
})

test('duplicate rejection happens before native media encoding', async () => {
  const settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Mining',
    modelName: 'Basic',
    fieldMappings: { Front: '{expression}', Picture: '{screenshot}' }
  }
  let encoded = false
  const service = new MiningAnkiService({
    read: () => settings,
    write: () => {}
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    if (request.action === 'deckNames') return jsonResponse(['Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front', 'Picture'])
    if (request.action === 'canAddNotesWithErrorDetail') return jsonResponse([{ canAdd: false, error: 'duplicate' }])
    throw new Error(`unexpected action: ${request.action}`)
  }, {}, undefined, {
    state: () => ({ available: true }),
    probeDuration: async () => undefined,
    encode: async () => {
      encoded = true
      return []
    },
    stop: () => {}
  })
  const result = await service.addNote({
    payload: { expression: '猫' },
    context: {
      sentence: '猫',
      selectedText: '猫',
      title: 'Video',
      timestamp: 12,
      media: [],
      capture: {
        sourceUrl: 'http://localhost:7344/video.mkv',
        currentTime: 12,
        start: 11.8,
        end: 13.2,
        captureImage: true,
        captureAudio: false,
        imageMode: 'static',
        staticFormat: 'webp',
        animatedFormat: 'webp',
        quality: 'balanced',
        maxHeight: 720,
        fps: 12,
        syncAnimationToWordAudio: false
      }
    }
  })
  assert.deepEqual(result, { status: 'duplicate' })
  assert.equal(encoded, false)
})

test('legacy disabled setting does not disable configured Anki mining', () => {
  let settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    enabled: false,
    deckName: 'Mining',
    modelName: 'Basic',
    fieldMappings: {
      Audio: '{sasayaki-audio}',
      Picture: '{book-cover}'
    }
  }
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  })
  const state = service.state()
  assert.equal(state.available, true)
  assert.equal('enabled' in state.settings, false)
  assert.deepEqual(state.settings.fieldMappings, {
    Audio: '{sentence-audio}',
    Picture: '{screenshot}'
  })
})

test('show notes opens the Anki browser for the selected note type and expression across decks', async () => {
  let settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Japanese::Mining',
    modelName: 'Basic "JP"',
    showNotes: true
  }
  let browseQuery
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  }, async (_url, init) => {
    const request = JSON.parse(init.body)
    if (request.action === 'deckNames') return jsonResponse(['Japanese::Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic "JP"'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front Side', 'Back'])
    if (request.action === 'guiBrowse') {
      browseQuery = request.params.query
      return jsonResponse([11, 12])
    }
    throw new Error('unexpected action')
  })
  const result = await service.showNotes({ expression: '食べる "to eat"' })
  assert.deepEqual(result, { status: 'success', cardIds: [11, 12] })
  assert.equal(
    browseQuery,
    'note:"Basic \\"JP\\"" "Front Side:食べる \\"to eat\\""'
  )
})

test('show notes respects its setting without contacting AnkiConnect', async () => {
  let settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Mining',
    modelName: 'Basic',
    showNotes: false
  }
  let requested = false
  const service = new MiningAnkiService({
    read: () => settings,
    write: value => { settings = value }
  }, async () => {
    requested = true
    return jsonResponse([])
  })
  assert.deepEqual(await service.showNotes({ expression: '食べる' }), {
    status: 'error',
    message: 'Showing notes is disabled in Anki settings.'
  })
  assert.equal(requested, false)
})

test('duplicate and malformed responses remain explicit', async () => {
  assert.equal(parseCanAdd([{ canAdd: true }]), true)
  assert.throws(() => parseCanAdd([{ allowed: true }]), /invalid duplicate-check/)
  const client = new AnkiConnectClient('http://127.0.0.1:8765', '', async () => jsonResponse(null, 'boom'))
  await assert.rejects(client.ping(), /boom/)
})

test('keeps sentence audio separate from optional word audio', () => {
  assert.equal(
    replaceMediaReferences(
      '{audio}|{sentence-audio}',
      new Map([['{sentence-audio}', '[sound:sentence.wav]']])
    ),
    '|[sound:sentence.wav]'
  )
})

test('shares offline reachability state and recovers on a later probe', async () => {
  let online = false
  let requestCount = 0
  const events = []
  const settings = {
    ...structuredClone(DEFAULT_MINING_ANKI_SETTINGS),
    deckName: 'Mining',
    modelName: 'Basic',
    fieldMappings: { Front: '{expression}' }
  }
  const service = new MiningAnkiService({
    read: () => settings,
    write: () => {}
  }, async (_url, init) => {
    requestCount++
    if (!online) throw new TypeError('fetch failed')
    const request = JSON.parse(init.body)
    if (request.action === 'version') return jsonResponse(6)
    if (request.action === 'deckNames') return jsonResponse(['Mining'])
    if (request.action === 'modelNames') return jsonResponse(['Basic'])
    if (request.action === 'modelFieldNames') return jsonResponse(['Front'])
    if (request.action === 'canAddNotesWithErrorDetail') return jsonResponse([{ canAdd: true }])
    throw new Error(`unexpected action: ${request.action}`)
  }, {}, event => events.push(event))

  assert.equal((await service.probeReachability()).status, 'error')
  assert.equal(service.state().connectionStatus, 'disconnected')
  const offlineRequestCount = requestCount
  const offlineResults = await Promise.all([
    service.checkDuplicate({ expression: '猫' }),
    service.checkDuplicate({ expression: '犬' })
  ])
  assert.equal(requestCount, offlineRequestCount)
  assert.ok(offlineResults.every(result => result.status === 'error'))

  online = true
  assert.deepEqual(await service.probeReachability(), { status: 'success' })
  assert.equal(service.state().connectionStatus, 'connected')
  assert.equal((await service.checkDuplicate({ expression: '猫' })).status, 'success')
  assert.ok(events.some(event => event.data.connectionStatus === 'disconnected'))
  assert.ok(events.some(event => event.data.connectionStatus === 'connected'))
})
