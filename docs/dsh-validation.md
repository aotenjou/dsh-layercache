# DSH plugin qualification — 2026-11-19

## Pinned inputs

- dsh/Cordis public npm packages: dsh `0.2.2-rc.5`, Cordis `4.1.0`, Schemastery `3.19.0`.
- dsh source reference: `2e39e70496aa02986ca6a820c5d497e816b69d7e`.
- Windows host: Node `24.11.1`, Python `3.12.7`.
- LayerFS `1.1.0`: `7d42d0b506eac64801864923149f796f5c7c8d7e`, unmodified.
- Real Store: Linux volume, uid 0, Disposable profile; existing qualified native binaries.
- Docker Desktop `4.55.0`, Engine `29.1.3`, API `1.52`, Linux/amd64.
- Node 24 Linux image: `sha256:5ba3c1ded6eada2ea16582327a87c672fb3889fca362ee3ac0d78ed742b583c0`.

## Executed checks

| Check | Outcome and scope |
| --- | --- |
| `npm test` | PASS, 40 tests, 0 skipped: consistency cases, multi-client coverage, 4 real Cordis/dsh pipeline cases, HTTP and legacy-record coverage |
| `npm run check` | PASS; includes plugin, service, scripts, examples and tests |
| Python integration | PASS, 5 tests through the actual HTTP service |
| `test-layerfs-docker.py --dsh --image node:24-bookworm-slim ...` | PASS, 2 real subtests, 0 failed/0 skipped |
| Docker resource inspection | PASS, no remaining test containers or labeled volumes |
| Official `dsh plugin --profile web add ...tgz` | PASS in a fresh isolated DSH_HOME; profile lists the bundle |
| `dsh --profile web --dump-config` | PASS, plugin layer and row present |
| Installed plugin schema import | PASS for `x-cordis.entries` row `layercache`, status `schema` |
| Installed tarball execution | PASS, canonical package imports, real Cordis dispatch, incremental `AB`, 3 actual executions, unload closes sessions |

The plugin cases verify branch divergence and replay, incremental uncached
state, owning-session restrictions, default shell denial, policy denial before
mutation, persisted presentation metadata, unload cleanup, backend mismatch,
argument validation, missing agent context, and a dropped mutation response
that prevents a second execution attempt for the same label.

The real integration loads the published Cordis and dsh tools/native executor,
mounts this plugin, and runs its calls through the ordinary pipeline. Its HTTP
service uses the actual native LayerFS SDK and daemon, not a fake backend. It
checks shell `sharedA`/`sharedB`, a shared prefix hit, full replay with zero
executions, and an uncached shell append followed by a full-history read yielding
`seedonce`. Plugin unload closes its live rollout sessions.

Receipts: [27-test suite](receipts/dsh-portable.txt) and
[real dsh/LayerFS/FUSE scenario](receipts/dsh-layerfs.txt).

The first real run could not yield a valid receipt because Python on Windows
tried to decode Node 24's Unicode reporter with GBK. Its
[failed capture](receipts/dsh-layerfs-attempt1.txt) is retained and is not counted
as a pass. The script now captures Docker output as UTF-8, explicitly selects
TAP, enforces a 90 s test deadline and a 110 s container-command timeout. The
recorded passing scenario ran after that harness fix.

## Reproduce

```sh
npm ci --ignore-scripts
npm test
npm run check
python -m unittest discover -s test -p test_python.py -v
python scripts/test-layerfs-docker.py --dsh --image node:24-bookworm-slim \
  --repo /path/to/pinned/layerfs --addon /path/to/layerfs.node \
  --daemon /path/to/layerfs-daemon
```

The Docker script requires an existing image and fixed native binaries. It
mounts source/dependencies read-only and removes only its own random-prefix
containers and volume. Ordinary tests do not require Docker. A missing real
runtime is a skip, never evidence for the LayerFS integration.

## Host schema-inspection limitation

The installed plugin's schema imports through the actual dsh profile resolver and
reports `status: schema` at `#/$defs/config109`. The complete Web-profile
`--dump-config-schema` command exits 1 because dsh's own rows `/198` through `/201`
report "unrecognized Loader tree carrier; use cordis:group or cordis:include for
native child collection". Those diagnostics do not name this plugin. This is not
reported as a successful whole-profile schema dump. Ordinary `--dump-config`
returns 0, and actual plugin execution is qualified separately above.

## Evidence limits

This qualifies the actual plugin/tool pipeline and real filesystem cache path.
It does not claim a GPU training run, model quality, macOS/official worker
coverage, power-loss durability or LayerFS 2.0 compatibility. The dsh Web UI
with a live language model is not exercised by this keyless scenario. Core
qualification inherited from LayerCache is retained separately in
[validation.md](validation.md); its old receipts do not claim to cover the dsh
plugin. Published artifact and profile-install results are recorded with the
release delivery.
