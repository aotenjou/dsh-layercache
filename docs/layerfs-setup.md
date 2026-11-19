# LayerFS 1.1.0 setup

LayerCache consumes the public `@layerfs/agent` SDK. It does not modify LayerFS,
embed a replacement filesystem, or require the original TVCache service.

## Version and prerequisites

Use source commit `7d42d0b506eac64801864923149f796f5c7c8d7e` (1.1.0) of
`https://github.com/Ephemeral-AI-Lab/layerfs`. The 2.0 development branch is a
different API. Build the Linux native addon; shell execution also needs its Linux
daemon, a glibc runtime image, Docker Engine API >=1.48 (28.0+) and `/dev/fuse`.
The SDK source packages are private workspaces, so a public npm download is not
an installation recipe. LayerCache accepts an explicit SDK entry path.

For an existing LayerFS installation, retain its validated runtime/image and
`LAYERFS_*` settings and skip building. Windows users can run the Node service
inside WSL2; Store files must live on local Linux ext4/xfs/btrfs, not `/mnt/c`.
Alternatively use the official `@layerfs/runtime` worker and endpoint, as in the
[upstream runtime guide](https://github.com/Ephemeral-AI-Lab/layerfs/blob/7d42d0b506eac64801864923149f796f5c7c8d7e/api/docs/runtime.md).
Do not invent a host filesystem proxy or retry uncertain worker operations.

## Build from source (Linux)

Install Git, Node >=20, a Rust toolchain supported by upstream, C compiler, and
the system build prerequisites in the upstream guide. The following direct Cargo
build was exercised with Rust 1.99.1; upstream's wrapper pins 1.85.1 and offline
dependencies. Choose a consistent toolchain and keep the build target in your
checkout.

```sh
git clone https://github.com/Ephemeral-AI-Lab/layerfs.git
cd layerfs
git checkout 7d42d0b506eac64801864923149f796f5c7c8d7e
cargo +stable build --locked --release -p layerfs-node -p layerfs-daemon
cp target/release/liblayerfs_node.so engine/crates/layerfs-node/layerfs.node
export LAYERFS_NATIVE="$PWD/engine/crates/layerfs-node/layerfs.node"
```

LayerFS Store installation currently requires uid 0 (the daemon's Store owner).
The qualification command below runs as root inside a dedicated Linux container
with its own Store volume. Do not use a pre-existing experiment's Store for tests.

## Qualify shell execution in an isolated volume

The script accepts host-visible built Linux artifacts, including when invoked
from Windows PowerShell. Docker Desktop must be running. Its test container gets
the Docker socket to create LayerFS Sandboxes, as required by upstream; run this
only against a trusted local engine. It creates a fresh random volume and removes
only its own named containers/volume after the test. Existing images are retained.

```sh
docker pull node:22-bookworm-slim
python scripts/test-layerfs-docker.py \
  --repo /absolute/layerfs \
  --addon /absolute/layerfs/engine/crates/layerfs-node/layerfs.node \
  --daemon /absolute/layerfs/target/release/layerfs-daemon
```

This uses an immutable image ID discovered before the run. The daemon and parent
client open the same Store in the named Docker volume. On Linux the client uses
host networking to reach the daemon's loopback port; Docker Desktop uses
`host.docker.internal`. There is no Windows-native Store route in this script.

## Create a small project for file tools

For file tools only, an SDK process running as the installation user on Linux can
initialize a Store without a Sandbox. Select fresh, private paths and use the
same settings in every later process. The SDK's active profile is Disposable.

```sh
export LAYERFS_HOME=/private/experiment/sdk-home
export LAYERFS_STORE_PATH=/private/experiment/store/global/store.sqlite
mkdir -p "$LAYERFS_HOME" /private/experiment/store/global /private/experiment/seed
chmod 700 "$LAYERFS_HOME"
printf 'seed' > /private/experiment/seed/state.txt
node scripts/init-project.js agent-data /private/experiment/seed \
  /absolute/layerfs/api/agent/src/index.js

node src/cli.js serve --backend layerfs --project agent-data \
  --sdk /absolute/layerfs/api/agent/src/index.js \
  --root /private/experiment/layercache --namespace experiment-v1
```

`LayerFS.init` is explicit and happens once. Later servers call `LayerFS.open`;
do not automatically reinitialize on an error. A failed/uncertain Init can leave
records for investigation. The Store directory and home must be owned by the
SDK/daemon user. Test-run `node src/cli.js doctor` to see configured settings.

## Enable shell tools on a real project

Reuse your existing LayerFS runtime's settings:

| Setting | Meaning |
| --- | --- |
| `LAYERFS_HOME` | private project discovery records |
| `LAYERFS_STORE_PATH` | installed Store in the shared local Linux volume |
| `LAYERFS_NATIVE` | built addon, defaulting to its upstream checkout location |
| `LAYERFS_IMAGE` | immutable `sha256:...` glibc image ID for Sandboxes |
| `LAYERFS_VOLUME` | named Docker volume containing `global/store.sqlite` |
| `LAYERFS_DAEMON` | host-process-visible built daemon executable |
| `LAYERFS_DOCKER` | Unix Docker socket, usually `/var/run/docker.sock` |
| `LAYERFS_DAEMON_HOST` | `127.0.0.1` or Docker Desktop's reachable host address |

The SDK process must open the same Store the Sandbox mounts; a directory on a
different WSL distribution is not automatically the named Docker volume. The
qualification script demonstrates the supported container arrangement. Mounting
is on a writable Branch, never `main`. The shell tool owns explicit Sandbox and
Workspace cleanup. Stop on `Unknown`, inspect history, and avoid blind replay.
