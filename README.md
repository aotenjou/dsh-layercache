# DSH LayerCache

[中文入门](README.zh-CN.md) · [Configuration and tools](docs/dsh.md) · [Validation](docs/dsh-validation.md)

A DeepSeek Harness plugin for TVCache-style tool-call prefix caching, backed by
[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs). Equivalent trajectories reuse
both tool observations and immutable filesystem states; diverging trajectories fork
independent Branches. This is an independent Apache-2.0 implementation inspired by
[TVCache](https://github.com/TVCache/TVCache), not its original HTTP protocol.

The source bundle registers `tvcache_prepare`, `tvcache_run` and `tvcache_close`. They run through dsh's normal
tool policy and result logging, with cache-hit/execution counts and snapshot refs in
result metadata. Existing dsh tools continue to use their own execution environments.

## Requirements

- DeepSeek Harness **0.2.2-rc.5**, Node **24.9+**, and pnpm for dsh plugin installation.
- An existing LayerCache service. Its Linux process opens LayerFS **1.1.0** at the
  exact commit in [layerfs.json](layerfs.json). Shell tools also need Docker/FUSE.
- The plugin can run on Windows with that service running in Linux. No native
  Windows Store or automatic LayerFS worker provisioning is claimed.

## Install

Download `dsh-layercache-0.1.0.tgz` from the
[GitHub release](https://github.com/aotenjou/dsh-layercache/releases/tag/v0.1.0), then:

```sh
dsh plugin --profile web add /absolute/path/dsh-layercache-0.1.0.tgz
dsh --profile web --dump-config
```

The dump must contain the `dsh-layercache` layer and `layercache` row. It does not
start the service. Back up an existing profile before editing its settings.
The tarball ships executable JavaScript and needs no prepare/build hook. A source
checkout can also be installed with `dsh plugin --profile web add /path/to/checkout`.

Start the service against your existing LayerFS project, following
[LayerFS setup](docs/layerfs-setup.md):

```sh
node src/cli.js serve --backend layerfs --project agent-data \
  --root /private/layercache-owner --namespace experiment-v1
```

Link `@layerfs/agent` from the pinned checkout or pass `--sdk` its public entry
file. Set the same `LAYERFS_*` deployment settings that own the project. Do not
initialize over an existing Store. Start dsh only after this service is ready:

```sh
dsh --profile web --no-open
```

The default endpoint is `http://127.0.0.1:8088`; startup checks for a real LayerFS
backend. For another endpoint, authentication, shell access, or explicit local
reference mode, see [configuration](docs/dsh.md).

## Use the tools

Call `tvcache_run` with the full history after each model-generated tool call:

```json
{
  "task_id": "dataset-v1/question-42",
  "rollout": "A",
  "history": [
    {"name": "file.write", "arguments": {"path": "/answer.txt", "content": "42"}},
    {"name": "file.read", "arguments": {"path": "/answer.txt"}}
  ]
}
```

Use the same `task_id` and a new rollout label for another equivalent trajectory.
A replay returns `value: "42"`, `executed: 0`, `cache_hits: 2`. Incremental requests
within one label retain earlier uncached effects and report them as `continued`.
Call `tvcache_close` with `{"rollout":"A"}` when finished. Labels belong to the
calling dsh session; a closed/failed label stays unavailable until plugin reload.

For changing external data, randomness or external effects, send `cache:false`.
No request is retried. A lost response fails the label instead of creating a new
server session and replaying uncertain effects. A service restart invalidates
its existing rollout IDs. Plugin reload invalidates label ownership: resume only
after inspecting unfinished effects, using a new label deliberately.

## Learn without LayerFS

```sh
node examples/branching.js
```

The explicit directory reference demo produces A, divergent B, then replay A:
3 executions; 2 executions/1 hit; 0 executions/3 hits. For a dsh reference setup,
start `node src/cli.js serve --backend local --root /private/layercache-demo`
and explicitly configure `backend: local` in dsh. There is no fallback.

## Video tool benchmarks

Fixed tool traces on LayerFS 1.1.0 ran the same FFmpeg preprocessing and
LayerFS artifact reads in both arms. The baseline passed `cache: false`
for every call. Speedup is baseline time divided by cached time.

| Workload | Time measured | Cache off | LayerCache | Speedup | Cache hits |
| --- | --- | ---: | ---: | ---: | ---: |
| Terminal-Bench 1 `video-processing`, 2 fixtures | Mean per-arm wall time across 3 trials, 8 rollouts per arm per trial | 11.65 s | 1.78 s | **6.54×** | 84/96 |
| EgoSchema, fixed 100-video manifest | Sum of per-video elapsed times, 4 rollouts per video per arm, up to 8 videos in flight | 6,881.16 s | 1,733.95 s | **3.97×** | 600/800 |

- Terminal-Bench used the task's example and test videos at commit
  `d28711d`. The frame digests and artifact outputs matched across both arms in
  all 3 trials. [Task fixtures](https://github.com/harbor-framework/terminal-bench-1/tree/d28711d0da2675d0bb1d56de45ae5df6082438a3/original-tasks/video-processing)
- EgoSchema used 100 videos totaling 2.06 GB. The frame digests and artifact
  outputs matched for all 100 videos. [Video source](https://huggingface.co/datasets/lmms-eval/egoschema)

Both experiments used FFmpeg 4.4.2 to sample at 15 fps, scale to 1920×1080,
and hash grayscale frames. These measurements cover tool execution and
cache overhead with synchronous publication. They exclude model generation,
training, and official task scoring.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
python -m unittest discover -s test -p test_python.py -v
```

Default tests use the actual published Cordis/dsh registry and execution pipeline
with the local reference backend; no Docker or language-model key is needed.
[Native validation](docs/dsh-validation.md) separately tests the entire dsh → HTTP →
LayerFS → FUSE path. The service and Python post-training client remain usable
without dsh; see [API](docs/api.md), [design](docs/architecture.md) and
[TVCache migration](docs/tvcache-migration.md). Import the Node library from
`dsh-layercache/core`; the package root is the Cordis plugin.

## Limits and licensing

Filesystem history does not capture RAM, sockets or GPU state. LayerFS's tested
Store profile is Disposable, without power-loss durability. One service owns each
project/index. Pruning reuse records does not reclaim LayerFS history. The
`npm run benchmark` example uses synthetic tool latency. The video results above
measure the stated fixed traces. The supported LayerFS version is 1.1.0.

Shell executes code with the service/runtime's privileges. Only trusted callers
may use this service; `allowedTools` limits the plugin's tools, not other clients
of the same endpoint. Shell is disabled in the plugin's default allowlist. Secrets
are read from a named environment variable and excluded from tool results.

See [LICENSE](LICENSE), [notices](THIRD_PARTY_NOTICES.md),
[security](SECURITY.md), [contributing](CONTRIBUTING.md), and
[release procedure](docs/release.md). Community-directory inclusion requires the
LayerFS maintainers to merge the listing PR.
