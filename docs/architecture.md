# Architecture and invariants

A rollout starts at the configured seed, pinned as an immutable LayerFS Commit
or Layer. Scope is the SHA-256 of the canonical JSON object
`{schema, namespace, task, baseRef, tools, context}`. The context identifies fixed
experiment inputs such as dataset and runtime versions. Checkpoint expiry is
stored on the node.

## Prefix lookup

Each key hashes the parent state node, input checkpoint, tool name, canonical
arguments and tool version. Read-only calls stay on the current state and are
leaves of the mutation chain. A hit validates the input checkpoint, parent
revision, tool policy, resource versions and expiry. A stateful hit restores its
original observation and output checkpoint together. A miss forks the current
checkpoint and executes the tool.

The registry classifies tools before a rollout starts. Deterministic tools can
share a node. Seeded tools also need a seed and replay version. Explicitly
replayable random tools can share the original unseeded draw and captured state.
Unknown or independent tools, execution-required effects and `cache:false`
disable sharing from that step. The rollout retains accepted steps so an
append-only submission can continue with the same sample.

Concurrent eligible requests join one promise before lookup. Each caller
revalidates its result after awaiting the promise. A completed execution enters
a bounded, process-local publication queue before its rollout continues.
Subsequent calls can reuse an eligible pending revision and start from its
output checkpoint. The worker commits a child only after its exact parent
revision has been committed.

The worker stages each result and then rechecks the observed record, prune
fence, parent, resource versions and deadlines under the store transaction.
A replacement increments the existing generation. The revision identifies the
execution even when pruning removed a previous generation. A failed or
cancelled write invalidates its pending descendants while accepted rollout
history remains available.

## Storage and lifetime

The `lc-index-*` branch stores manifests at
`/.layercache-v1/nodes/<scope>-<key>`. The manifest points to checksummed JSON
chunks under `/.layercache-v1/blobs/`. Chunks are written before the atomic
manifest update. Resource catalog updates use the same publication mechanism.
The `lc-run-*` branch head after execution supplies the output checkpoint.

The deadline is the earliest of the parent deadline, configured checkpoint TTLs
and the expiry of required or produced resources. When the deadline is reached,
the node and its descendants become ineligible. An active rollout keeps its
accepted history and can continue privately from its checkpoint. A new call that
needs an expired resource receives `ResourceExpired`. The operator can refresh
shared resource metadata through the management API.

Startup and periodic cleanup remove expired and invalid descendant records.
Legacy records remain visible in the unfiltered tree and can be pruned.
Local storage also releases unreferenced snapshot directories, retaining the
base and checkpoints referenced by active rollouts, queued publications or
stored records. LayerFS removes manifests and unreferenced chunk files from the
current index tree and protects staged chunks until their writer finishes.
Branches, Commits and historical storage remain in the LayerFS 1.1.0 Store.
