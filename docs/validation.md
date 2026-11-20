# Qualification record — 2026-11-19

This is the inherited LayerCache core qualification, before the dsh plugin.
See [dsh-validation.md](dsh-validation.md) for new plugin evidence.
This record distinguishes executed tests from configured future CI jobs.
Commands were run against the delivered source. GitHub workflows are supplied
but have not been executed on a hosted remote.

## Environment

| Component | Observed value |
| --- | --- |
| Portable host | Windows; Node 22.18.0; Python 3.12.7 |
| Native qualification | Ubuntu 22.04 in WSL2; Linux 5.15.167.4 |
| Native Node | 22.23.4 |
| Rust | 1.99.1, release build, locked upstream dependencies |
| LayerFS | `7d42d0b506eac64801864923149f796f5c7c8d7e`, 1.1.0, unmodified source |
| TVCache reference | `3a4f95a6582eea1e4b7e84a9f3a0c74eaa8fde02` |
| Docker | Desktop 4.55.0; Engine 29.1.3, API 1.52, linux/amd64 |
| Shell runtime | `node:22-bookworm-slim`, image ID `sha256:b774d993885c47eca14db241ba8cc7e5789235142f76e4a2a6a65ec350a1bac0` |
| Store profile | Disposable; uid 0 installation as required by upstream |

## Executed functional checks

| Command / test | Result | Evidence scope |
| --- | --- | --- |
| `npm test` | PASS, 40 tests on Windows and Linux | state restoration/divergence, read-only elision, JSON identity, scope isolation, random-tool policy, parent/resource/TTL validation, concurrent single-flight, conditional publication, legacy records, multi-client dsh pipeline, HTTP/body limit, cleanup and drain |
| `python -m unittest discover -s test -p test_python.py -v` | PASS, 5 tests | real Node HTTP service, Python sync/async calls, preflight/resource refresh, errors/auth, concurrent rollouts, uncached incremental effects execute once |
| `node examples/branching.js` | PASS | A executes 3, B executes 2/hits 1, A replay executes 0/hits 3; file values checked |
| `node examples/benchmark.js` | PASS | 4 synthetic trajectories, 12 uncached executions vs 4 cached executions; values checked |
| `node scripts/check.js` | PASS | JavaScript parsing of source/examples/tests/scripts |
| real `test/layerfs.integration.js` | PASS, no skip | native LayerFS Store init, real Branch/Commit state restoration, 240 KB UTF-8 output persisted in chunks, separate-process reuse, index reopen, prune, uncached sessions |
| final `scripts/test-layerfs-docker.py` on 2026-11-19 | PASS, 1 integration scenario, no skip | real Docker/FUSE mount/exec/commit/unmount, shell A/B branch isolation, hit replay, nonzero exit not cached, Sandbox cleanup, committed file reads, uncached-shell session continuation without duplicate execution |
| Docker resource inspection after qualification | PASS | no containers/volumes with this invocation's test prefix remain |
| npm tarball install in an empty consumer project | PASS | exported Node APIs and installed CLI help work |
| Python wheel install in a fresh virtual environment | PASS | `Client`, `AsyncExecutor`, `ToolCall` import from installed wheel |
| Python source compilation / CLI doctor | PASS | client, scripts, examples parse; prerequisite report works |
| Installed npm service + installed Python wheel smoke | PASS | uncached incremental rollout executes exactly 3 tools, restores `AB`, closes its session |
| Package contents and local Markdown links | PASS | no Python bytecode/runtime data in npm; runtime and client files match source; local links resolve |

Real Store qualification built `layerfs-node` from the pinned Rust source, loaded
its actual `.node` addon through the unmodified public JavaScript SDK, and ran
against a fresh Store on Linux ext4. An initial non-root Init was refused by
upstream; the qualification was then run as uid 0. This restriction is documented
in the setup guide. The Docker test used a separate volume shared by the parent
SDK and Sandbox daemon, and removed that volume after completion.

The benchmark deliberately inserts 20 ms latency per tool and uses the local
copying backend. One observed run was 584.5 ms uncached versus 237.7 ms cached;
these single-run numbers depend on host load and do not measure LayerFS itself.
The reproducible acceptance criterion is equal returned values and 12 versus 4
actual tool executions, not a promised wall-clock speedup.

Saved command output: [Linux portable suite](receipts/portable-linux.txt),
[final native Store suite](receipts/layerfs-store.txt), and
[final Docker/FUSE suite](receipts/layerfs-shell.txt).

## Limits of the evidence

These checks qualify the adaptation's filesystem/tool-cache behavior. They do not
claim a completed GPU RL training run, unchanged model quality, a production
performance distribution, cross-host writers, power-loss durability or compatibility
with LayerFS 2.0. macOS and official Windows-worker routes are documented upstream
but were not exercised here; native Linux and the Docker Desktop Linux route were.
The local backend is explicitly a file-copying reference, not LayerFS or a sandbox.

The real tests report SKIP if their runtime inputs are absent. Do not interpret a
portable-only run as requalification of the native integration after an upgrade.

## Final qualification

After the user started Docker Desktop on 2026-11-19, the final FUSE regression ran
successfully against the delivered code. From the project root, the command was:

```sh
python scripts/test-layerfs-docker.py --repo ../../work/layerfs \
  --addon ../../work/native/layerfs.node --daemon ../../work/native/layerfs-daemon
```

The test exited with code 0: one integration scenario passed, zero failed and
zero skipped. In addition to branching and cache replay, it verified that a
noncacheable shell append executes once within a rollout: the next full-history
request returns `seedonce`, marks the first step as `rollout`, and executes only
the new read. The script removed its test containers and volume; subsequent
Docker inspection found no `layercache-verify-*` containers or `layercache.test`
volumes. No required qualification checks remain outstanding.
