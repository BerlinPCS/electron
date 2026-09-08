# Hayatan 7.1.5

Add an optional dedicated torrent process for VPN split tunneling on Windows and
macOS. It is off by default, requires a restart, and displays the PIA setup path
in Settings → Client. The main app can use Tailscale while the separate
Hayatan Torrent executable has its own PIA rule.

This option configures process separation, not VPN routing or a kill switch.
Follow TORRENT-VPN.md and verify PIA egress and VPN-loss behavior on each device.
Linux retains the existing torrent process. macOS remains a local build/install;
GitHub release downloads are Windows and Linux only.

Validation: 13 focused updater/immersion/torrent tests pass on Node 22. Mac arm64
helper startup, native engine loading, empty-library IPC and shutdown pass;
strict deep ad-hoc signature verification passes. Actual PIA attribution and
VPN-loss protection on Mac/Windows remain installation acceptance gates.
