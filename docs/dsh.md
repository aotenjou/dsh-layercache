# DSH configuration and tool reference

## Design

The plugin is a Cordis function plugin and a `dsh.bundle` package. It registers
explicit tools through `ctx.tools.register(defineTool(...))`; the host's policy,
argument validation, execution, renderer and metadata persistence remain active.
It does not replace the host executor or wrap arbitrary filesystem/shell tools.

A shared LayerCache service owns one LayerFS project/index using `@layerfs/agent`
public calls. It stores results, prefix records and immutable filesystem refs in
LayerFS. The plugin holds only session-to-rollout handles in memory. Python
training workers can share the same service with dsh.

Linux makes Store calls in the service process. A Windows dsh connects to that
Linux service over HTTP; this release does not provision a macOS/Windows worker.
The community listing supports `linux` and `windows-wsl2` as client deployment
routes. macOS has not been qualified. The existing service can also be hosted in
a dedicated Linux container; the Docker qualification script uses that route.

## Profile configuration

After installing the bundle, add an override to the profile's `cordis.patch.yml`.
Keep existing entries, and replace the row's entire config explicitly:

```yaml
- id: layercache
  config:
    endpoint: http://127.0.0.1:8088
    backend: layerfs
    tokenEnv: LAYERCACHE_TOKEN
    requestTimeoutMs: 120000
    maxRollouts: 1024
    allowedTools:
      - file.write
      - file.append
      - file.read
```

Set `LAYERCACHE_TOKEN` in both the service and dsh processes when authentication
is enabled. Store the secret in the environment, not the YAML or tool arguments.
`endpoint` is an HTTP(S) origin without credentials, a path, query or fragment.
There are no redirects or retries. A request deadline is not a remote execution
kill: after a lost response, inspect effects before choosing a new rollout.

`backend` is an assertion checked through `/health` at plugin startup. `layerfs`
is the default. The explicit `local` value requires the service's directory
reference backend. A mismatch fails plugin loading; no fallback occurs.

`maxRollouts` counts labels, including closed/failed tombstones, for one plugin
lifetime. Tombstones prevent accidental reopen and side-effect replay. Close
rollouts promptly to free the server's separate live-session limit. A plugin
reload clears labels; finish or inspect pending work before reloading.

The service defaults to `file.write`, `file.append`, `file.read`, and `shell`.
The plugin's default `allowedTools` excludes shell. Add `shell` explicitly for
trusted commands. Custom service tools need both registration in the service
(`--tools`, see [API](api.md)) and an entry in the plugin allowlist. Ordinary
policy hooks see the entire history before any cache call. They can deny the
outer tool call. The plugin does not impersonate ordinary dsh `bash`/file tools.

## `tvcache_run`

Arguments:

| Field | Meaning |
| --- | --- |
| `task_id` | Stable dataset/sample identity; equivalent trajectories may reuse it |
| `rollout` | Required trajectory label, local to the calling dsh session |
| `candidate_tools` | Optional list of tool names to preflight for this rollout. Defaults to the allowlist. |
| `history` | Complete nonempty append-only array of `{name, arguments?, cache?}` |

Use `tvcache_prepare` to preview a candidate list before starting a rollout.
Supply the same candidates when calling `tvcache_run`. A registered tool
omitted from an explicit list is tracked in `unknown_tools` and disables
sharing from its first invocation. The plugin still checks its allowlist.

The result includes `task_id`, `rollout`, `value`, `ref`, `executed`,
`cache_hits`, `continued`, `preflight` and `unknown_tools`.
`value` is the last tool's JSON value. `ref` is its immutable state reference.
`cache_hits` counts cross-trajectory reuse; `continued` counts already-completed
steps in the current session. These counts are distinct. The same metadata is
stored through dsh's `output.presentationMeta` for replayable result cards.

Calls on a label are serialized. Different labels are independent trajectories.
A changed `task_id` or rewritten history on a live label is refused. A tool,
transport or protocol failure poisons that label; later calls cannot reopen it.
A request cancelled before dispatch does no work. Cancelling an in-flight HTTP
request may leave server-side work running; its label fails closed and is not
replayed. Unloading drains accepted plugin requests, attempts to close known
server sessions once, and reports cleanup failures.

Paths are absolute in the cached project (`/answer.txt`), not the dsh workspace.
Only file-backed state is captured. Images, datasets and tool dependencies must
be versioned in service namespace/context; never rely only on textual calls.

## `tvcache_close`

Arguments: `{"rollout":"A"}`. Only the calling dsh session may close its label.
It waits for queued calls, closes the server session once, and keeps the local
label closed. A second close is idempotent locally. Unknown labels are refused.
A failed cleanup is reported and is not automatically repeated.

## Beginner prompt

Tell the agent: “Use tvcache_run for dataset-v1/question-42, rollout A. Write
/answer.txt with 42, then read it, sending the full history after each step.
Close A. Use a new rollout B to replay that same complete history and report
value, cache_hits and executed. Use the cached project tools for these files.”

Agents needing direct SDK access should read the pinned LayerFS
[agent skill](https://github.com/Ephemeral-AI-Lab/layerfs/blob/7d42d0b506eac64801864923149f796f5c7c8d7e/.agents/skills/layerfs-js-sdk/SKILL.md)
and its references. The plugin tools already apply the relevant lifecycle rules.
