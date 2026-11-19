"""Exercise the Python clients against a real Node HTTP service, no mocks."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "python"))
from layercache import AsyncExecutor, Client, LayerCacheError, ToolCall


class ClientIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="layercache-python-")
        cls.process = subprocess.Popen(
            ["node", str(ROOT / "src" / "cli.js"), "serve", "--backend", "local", "--root", cls.directory.name, "--port", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, "LAYERCACHE_TOKEN": "python-test"},
        )
        # Server emits one ready line after listen; a process exit produces EOF.
        line = cls.process.stdout.readline()
        if not line:
            raise RuntimeError(cls.process.stderr.read())
        cls.url = json.loads(line)["url"]
        cls.client = Client(cls.url, token="python-test")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.communicate(timeout=10)
        cls.directory.cleanup()

    def test_sync_roundtrip_and_null_argument_handling(self):
        self.assertEqual(self.client.health()["status"], "ok")
        calls = [ToolCall("file.write", {"path": "/state.txt", "content": "hello"}), ToolCall("file.read", {"path": "/state.txt"})]
        first = self.client.run("sync", calls)
        second = self.client.run("sync", calls)
        self.assertEqual(first["value"], "hello")
        self.assertEqual(second["hits"], 2)

    def test_errors_keep_machine_readable_code(self):
        with self.assertRaises(LayerCacheError) as error:
            self.client.run("invalid", [ToolCall("missing")])
        self.assertEqual(error.exception.code, "InvalidInput")
        with self.assertRaises(LayerCacheError) as error:
            Client(self.url, token="wrong").health()
        self.assertEqual(error.exception.code, "Unauthorized")

    def test_async_full_history_training_and_branch_isolation(self):
        async def rollout(suffix):
            async with AsyncExecutor("async", self.client) as executor:
                calls = [ToolCall("file.write", {"path": "/x", "content": "A"})]
                await executor.execute(calls)
                calls.append(ToolCall("file.append", {"path": "/x", "content": suffix}))
                await executor.execute(calls)
                calls.append(ToolCall("file.read", {"path": "/x"}))
                return await executor.execute(calls)

        async def run():
            return await asyncio.gather(rollout("B"), rollout("C"))

        self.assertEqual(asyncio.run(run()), ["AB", "AC"])

    def test_uncached_history_executes_once_per_step_within_rollout(self):
        before = self.client.stats()["executions"]

        async def run():
            async with AsyncExecutor("uncached", self.client) as executor:
                calls = [ToolCall("file.write", {"path": "/x", "content": "A"}, cache=False)]
                await executor.execute(calls)
                calls.append(ToolCall("file.append", {"path": "/x", "content": "B"}))
                await executor.execute(calls)
                calls.append(ToolCall("file.read", {"path": "/x"}))
                self.assertEqual(await executor.execute(calls), "AB")
                self.assertEqual(executor.last_result["steps"][0]["source"], "rollout")
            with self.assertRaises(LayerCacheError) as error:
                await executor.execute(calls)
            self.assertEqual(error.exception.code, "Closed")

        asyncio.run(run())
        self.assertEqual(self.client.stats()["executions"] - before, 3)
        self.assertEqual(self.client.stats()["rollouts"], 0)


if __name__ == "__main__":
    unittest.main()
