# Changelog

## Unreleased

- Added checkpoint expiry, parent state validation, shared resource versions
  and startup cleanup. `--ttl-ms` now sets the default checkpoint lifetime.
- Added tool preflight, explicit replay policies and conditional publication.
  Legacy records remain available through the unfiltered tree and prune APIs.
- Moved cache publication to a bounded background queue. Compatible rollouts
  can reuse pending results and checkpoints in the same process.

## DSH plugin 0.1.0 — 2026-11-19

- Cordis plugin/bundle for dsh 0.2.2-rc.5, with tvcache_run and tvcache_close.
- Explicit backend check, per-dsh-session rollout ownership, allowlisted tools,
  request deadlines and failed/closed labels that prevent accidental replay.
- Canonical tool values and persisted cache counts/snapshot metadata.
- Real dsh pipeline → HTTP → LayerFS Store/FUSE integration qualification.

## Included LayerCache core 0.1.0 — 2026-11-19

- New LayerFS 1.1.0 adaptation of TVCache's stateful tool-call prefix graph.
- Persisted tool results, immutable Commit/Layer refs, branch-on-divergence.
- Node service/library, Python sync/async training client and custom tool registry.
- Rollout sessions preserve uncached effects across incremental histories, with
  explicit cleanup and no automatic recovery replay after failure/restart.
- Directory development backend, scope/version/context isolation, time-bucket TTL,
  record pruning, concurrent miss coalescing and chunked result persistence.
- Bilingual quickstarts, source attribution, CI, real-runtime verification scripts
  and synthetic benchmark with explicit limits.
