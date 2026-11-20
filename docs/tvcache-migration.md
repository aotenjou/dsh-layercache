# Migrating the TVCache execution model

Reference: TVCache commit `3a4f95a6582eea1e4b7e84a9f3a0c74eaa8fde02`.
This adaptation implements the stateful tool-value cache model independently;
it is not a wire-compatible TVCache server or a drop-in `tvclient` subclass.

| TVCache concept | LayerCache mapping |
| --- | --- |
| Tool Call Graph / prefix tree | persistent hashed state-prefix graph in a LayerFS index Branch |
| cached value | checksummed JSON chunks + final manifest in LayerFS |
| cached `env_id` | immutable Commit/Layer ref |
| `ToolCallEnv.fork()` | `branch.fork(uniqueName, immutableRef)` |
| mutable sandbox environment | independent Branch, optionally mounted for shell |
| `will_mutate_state()` | registry `mutates` declaration |
| read-only-chain elision | read-only leaves do not advance the state prefix |
| executor `execute(full_history)` | Python `AsyncExecutor.execute(full_history)` |
| current rollout environment | explicit rollout session retaining the last immutable ref and uncached observations |
| environment locking/fork bank | immutable cached refs; per-miss branches; same-prefix single-flight |
| prune cached environments | remove reuse manifests; upstream history is retained |

In the reference executor, `_get_serialized_stateful_chain` preserves preceding
mutating calls plus the final call. `_maybe_put_to_cache` forks a tool environment
and associates its ID with a graph node. LayerCache replaces that environment
ID with immutable LayerFS history: cached environments cannot be modified by
future rollouts. There is no pre-fork bank because creating a Branch already
shares committed state; Workspace/container startup still has a real cost.

## Convert a training loop

1. Represent each invocation as `ToolCall(name, JSON_arguments)`.
2. Register its implementation in the Node service. `fileTools` covers text file
   operations and shell; custom handlers can execute existing Python tools via
   scripts in the snapshot. Make any future-needed environment state file-backed.
3. Replace direct tool execution with `await executor.execute(history)`.
4. Assign stable task IDs per dataset sample and versions per tool/environment.
5. Start one cache service for all workers sharing an experiment. Different
   rollout executors may call it concurrently.

The service currently stores successful results only. If a failed tool result
is a deliberate observation in your environment, implement that behavior in a
custom handler returning a structured JSON observation and document whether it
is deterministic/cacheable. The built-in shell rejects nonzero exits.

The original HTTP routes (`/put`, `/get`, `/prefix_match`, `/lock`, etc.), arbitrary
Python `ToolCallEnv` constructors, test-result special cases and fork-bank APIs
are not exported. An HTTP response that is lost is not automatically resent.
The migration changes the state representation and authority model explicitly.

## Cache scope

LayerCache groups calls by task ID, namespace, pinned initial snapshot,
tool registry fingerprint and explicit context. Reuse can span training epochs.
Version fixed experiment inputs in the configured context and declare changing
dependencies through the resource API.
