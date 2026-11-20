"""LayerCache training-loop client. Each executor represents one rollout."""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence


class LayerCacheError(RuntimeError):
    def __init__(self, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.code, self.detail = code, detail


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)
    cache: bool = True

    def to_dict(self) -> dict:
        return {"name": self.name, "arguments": dict(self.arguments), "cache": self.cache}


class Client:
    def __init__(self, url: str = "http://127.0.0.1:8088", token: str | None = None, timeout: float = 300):
        self.url = url.rstrip("/")
        self.token = token if token is not None else os.environ.get("LAYERCACHE_TOKEN")
        self.timeout = timeout

    def _request(self, path: str, data: Any = None) -> Any:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            self.url + path,
            data=None if data is None else json.dumps(data, allow_nan=False).encode(),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                payload = json.load(error)["error"]
            except (ValueError, KeyError, TypeError):
                raise LayerCacheError("HTTPError", f"HTTP {error.code}") from error
            raise LayerCacheError(payload["code"], payload["message"], payload.get("detail")) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise LayerCacheError("TransportError", str(error)) from error

    def prepare(self, task: str, candidate_tools: Sequence[str]) -> dict:
        return self._request("/v1/prepare", {"task": task, "candidate_tools": list(candidate_tools)})

    def refresh_resources(self, resources: Sequence[Mapping[str, Any]]) -> dict:
        return self._request("/v1/resources/refresh", {"resources": list(resources)})

    def run(
        self,
        task: str,
        history: Sequence[ToolCall | dict],
        rollout: str | None = None,
        candidate_tools: Sequence[str] | None = None,
    ) -> dict:
        data = {"task": task, "history": [call.to_dict() if isinstance(call, ToolCall) else call for call in history]}
        if rollout is not None:
            data["rollout"] = rollout
        if candidate_tools is not None:
            data["candidate_tools"] = list(candidate_tools)
        return self._request("/v1/run", data)

    def open_rollout(self, task: str, candidate_tools: Sequence[str] | None = None) -> str:
        return self.open_rollout_info(task, candidate_tools)["rollout"]

    def open_rollout_info(self, task: str, candidate_tools: Sequence[str] | None = None) -> dict:
        data = {"task": task}
        if candidate_tools is not None:
            data["candidate_tools"] = list(candidate_tools)
        return self._request("/v1/rollouts", data)

    def close_rollout(self, rollout: str) -> None:
        self._request("/v1/rollouts/close", {"rollout": rollout})

    def stats(self) -> dict:
        return self._request("/v1/stats")

    def health(self) -> dict:
        return self._request("/health")


class AsyncExecutor:
    """TVCache-style execute(full_history) API returning the last tool value."""

    def __init__(
        self,
        task_id: str,
        client: Client | None = None,
        candidate_tools: Sequence[str] | None = None,
    ):
        self.task_id = task_id
        self.client = client or Client()
        self.candidate_tools = tuple(sorted(set(candidate_tools))) if candidate_tools is not None else None
        self.last_result: dict | None = None
        self.preflight_result: dict | None = None
        self._lock = asyncio.Lock()
        self.rollout_id: str | None = None
        self._closed = False

    async def execute(self, history: Sequence[ToolCall | dict]) -> Any:
        frozen = json.loads(json.dumps(
            [call.to_dict() if isinstance(call, ToolCall) else call for call in history],
            allow_nan=False,
        ))
        async with self._lock:
            if self._closed:
                raise LayerCacheError("Closed", "Executor is closed")
            if self.rollout_id is None:
                rollout = await asyncio.to_thread(
                    self.client.open_rollout_info, self.task_id, self.candidate_tools
                )
                self.rollout_id = rollout["rollout"]
                self.preflight_result = rollout.get("preflight")
            self.last_result = await asyncio.to_thread(
                self.client.run, self.task_id, frozen, self.rollout_id
            )
            return self.last_result["value"]

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            if self.rollout_id is not None:
                await asyncio.to_thread(self.client.close_rollout, self.rollout_id)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()


__all__ = ["Client", "AsyncExecutor", "ToolCall", "LayerCacheError"]
