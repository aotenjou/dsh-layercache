"""Run after starting `layercache serve --backend local` (or a LayerFS service)."""
import asyncio
from layercache import AsyncExecutor, Client, ToolCall


async def rollout(suffix):
    history = []
    async with AsyncExecutor(task_id="dataset-v1/question-42") as executor:
        for call in [
            ToolCall("file.write", {"path": "/answer.txt", "content": "prefix"}),
            ToolCall("file.append", {"path": "/answer.txt", "content": suffix}),
            ToolCall("file.read", {"path": "/answer.txt"}),
        ]:
            history.append(call)
            value = await executor.execute(history)
        # Feed value to your reward function / trainer here.
        return {"value": value, "final_step_source": executor.last_result["steps"][-1]["source"]}


async def main():
    print(await rollout("-A"))
    print(await rollout("-B"))
    print(await rollout("-A"))
    print(Client().stats())


if __name__ == "__main__":
    asyncio.run(main())
