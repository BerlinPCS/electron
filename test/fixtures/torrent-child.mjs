import { childTransport } from '../../src/main/torrent/transport.ts'
const transport = childTransport(packet => process.send?.(packet))
process.on('message', packet => transport.receive(/** @type {import('../../src/main/torrent/transport.ts').Packet} */ (packet)))
process.once('disconnect', () => process.exit(0))
transport.parent.on('message', ({ data, ports }) => {
  if (data?.id === 'destroy') process.exit(0)
  for (const port of ports) port.on('message', /** @param {{ data: unknown }} event */ event => port.postMessage(event.data))
})
process.send?.({ kind: 'ready' })
