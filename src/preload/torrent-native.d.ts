export {}

declare module 'native' {
  interface Native {
    torrentProcessState: () => Promise<{ enabled: boolean, active: boolean, available: boolean, executable: string }>
    setDedicatedTorrentProcess: (enabled: boolean) => ReturnType<Native['torrentProcessState']>
  }
}
