"""Qualify real LayerFS shell execution in a disposable Docker volume.

The host Docker socket grants runtime control. Use only your trusted local engine.
Only containers with this invocation's random prefix and its own volume are removed.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import uuid


def docker(*args, check=True, **kwargs):
    kwargs.setdefault("timeout", 30)
    return subprocess.run(["docker", *args], check=check, text=True, encoding="utf-8", capture_output=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Pinned LayerFS checkout")
    parser.add_argument("--addon", type=Path, required=True, help="Built Linux layerfs.node")
    parser.add_argument("--daemon", type=Path, required=True, help="Built Linux layerfs-daemon")
    parser.add_argument("--image", default="node:22-bookworm-slim", help="Existing Linux runtime image")
    parser.add_argument("--dsh", action="store_true", help="Qualify the real dsh tool pipeline through HTTP and LayerFS")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    for path in (args.repo / "api/agent/src/index.js", args.addon, args.daemon):
        if not path.exists():
            parser.error(f"Missing input: {path}")
    image = docker("image", "inspect", args.image, "--format", "{{.Id}}").stdout.strip()
    desktop = "docker desktop" in docker("info", "--format", "{{.OperatingSystem}}").stdout.lower()
    prefix = "layercache-verify-" + uuid.uuid4().hex[:12] + "-"
    volume = prefix + "store"
    docker("volume", "create", "--label", "layercache.test=" + prefix, volume)
    try:
        command = ["run", "--rm", "--name", prefix + "client"]
        for source, target in ((project, "/layercache"), (args.repo.resolve(), "/layerfs"), (args.addon.resolve(), "/native/layerfs.node"), (args.daemon.resolve(), "/native/layerfs-daemon")):
            command += ["--mount", f"type=bind,src={source},dst={target},readonly"]
        command += ["--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock", "--mount", f"type=volume,src={volume},dst=/layerfs-store,volume-nocopy"]
        environment = {
            "LAYERCACHE_TEST_SHELL": "1", "LAYERCACHE_TEST_SDK": "file:///layerfs/api/agent/src/index.js",
            "LAYERFS_NATIVE": "/native/layerfs.node", "LAYERFS_DAEMON": "/native/layerfs-daemon",
            "LAYERFS_IMAGE": image, "LAYERFS_VOLUME": volume, "LAYERFS_DOCKER": "/var/run/docker.sock",
            "LAYERFS_STORE_PATH": "/layerfs-store/global/store.sqlite", "LAYERFS_CONTAINER_PREFIX": prefix,
            "LAYERCACHE_TEST_STORE_DIR": "/layerfs-store",
            "LAYERFS_DAEMON_HOST": "host.docker.internal" if desktop else "127.0.0.1",
        }
        if not desktop:
            command += ["--network", "host"]
        for key, value in environment.items():
            command += ["-e", f"{key}={value}"]
        if args.dsh:
            if not (project / "node_modules").is_dir():
                parser.error("Run npm ci first to install the fixed dsh packages")
            # These dependencies are JavaScript only; the Linux runtime loads them read-only.
            command += ["--mount", f"type=bind,src={project / 'node_modules'},dst=/layercache/node_modules,readonly"]
        workspace_test = "test/dsh.layerfs.integration.js" if args.dsh else "test/layerfs.shell.integration.js"
        test_files = ["test/layerfs.integration.js", workspace_test]
        command += ["-w", "/layercache", "--entrypoint", "node", image, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-timeout=90000", *test_files]
        print(json.dumps({"image": image, "volume": volume, "desktop": desktop}), flush=True)
        result = docker(*command, check=False, timeout=110)
        print(result.stdout, end="")
        print(result.stderr, end="")
        return result.returncode
    finally:
        names = docker("ps", "-a", "--format", "{{.Names}}", check=False).stdout.splitlines()
        for name in names:
            if name.startswith(prefix):
                docker("rm", "-f", name, check=False)
        docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(error.stderr or str(error), file=sys.stderr)
        raise SystemExit(error.returncode) from None
    except subprocess.TimeoutExpired as error:
        print(f"Docker command did not finish within {error.timeout}s; inspect the engine and any printed test prefix before retrying.", file=sys.stderr)
        raise SystemExit(1) from None
