# Hoshidicts sidecar

This Electron-owned executable links against the pinned `hayase` branch of the
BerlinPCS Hoshidicts fork in `vendor/hoshidicts`. It owns Hayase-specific
concerns:

- the newline-delimited JSON protocol;
- dictionary manifests, ordering, enablement, and removal;
- transactional and partial-success batch imports;
- Yomitan filename category overrides such as `[Freq]` and `[Pitch]`;
- coarse import progress and state events.

Hoshidicts remains responsible for importing and querying its on-disk format,
including the Unicode-path and cancellable-lookup support carried by the fork.
Do not add Hayase protocol or UI policy to the vendored submodule.
