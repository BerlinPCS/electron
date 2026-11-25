import { releaseProxy } from 'abslink'
import { expose } from 'abslink/w3c'

import { childTransport } from '../../src/main/torrent/transport.ts'
const transport = childTransport(packet => process.send?.(packet))
process.on('message', packet => transport.receive(/** @type {import('../../src/main/torrent/transport.ts').Packet} */ (packet)))
process.once('disconnect', () => process.exit(0))
transport.parent.on('message', ({ data, ports }) => {
  if (data?.id === 'destroy') process.exit(0)
  if (data?.id === 'rpc') {
    for (const port of ports) {
      expose({
        episode: async (/** @type {import('abslink').Remote<(episode: number) => void>} */ callback, /** @type {number} */ episode) => {
          await callback(episode)
          await callback[releaseProxy]()
          return episode
        },
        metadata: () => new Uint8Array([0, 128, 255]),
        stats: () => ({ seeders: 3, downloaded: 1024 })
      }, port)
    }
    return
  }
  for (const port of ports) port.on('message', /** @param {{ data: unknown }} event */ event => port.postMessage(event.data))
})
process.send?.({ kind: 'ready' })
