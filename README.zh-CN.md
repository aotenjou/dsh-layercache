# DSH LayerCache：在 dsh 中使用 LayerFS 工具缓存

[English](README.md) · [配置和工具接口](docs/dsh.md) · [验证记录](docs/dsh-validation.md)

这个 dsh 插件将 TVCache 的工具调用前缀缓存方法接到 LayerFS：相同前缀复用工具结果
和不可变文件状态，轨迹分叉时创建独立 Branch。它是 Apache-2.0 独立实现，
不需要运行原 TVCache 服务，也不兼容其原始 HTTP 协议。

## 先理解 LayerFS

| 概念 | 在插件中的作用 |
| --- | --- |
| Project / Store | 保存一次实验的文件、历史、缓存索引和结果 |
| Commit / Layer | 缓存节点引用的不可变文件系统状态 |
| Branch | 每个未命中步骤从前缀状态分叉，避免污染其他轨迹 |
| Workspace / Sandbox | shell 执行时 mount → exec → commit → unmount |

架构是 `dsh 工具 → HTTP 缓存服务 → LayerFS SDK → Store / FUSE`。
服务在 Linux 中使用 LayerFS；Windows 上的 dsh 可以连接它。
已有普通 dsh 文件和 Bash 工具仍使用自己的工作区。要参与缓存，显式调用插件工具。

## 安装

要求：dsh **0.2.2-rc.5**、Node **24.9+**、pnpm。
从 [GitHub Release](https://github.com/aotenjou/dsh-layercache/releases/tag/v0.1.0)
下载 `dsh-layercache-0.1.0.tgz`，在终端运行：

```sh
dsh plugin --profile web add /absolute/path/dsh-layercache-0.1.0.tgz
dsh --profile web --dump-config
```

配置中应出现 `dsh-layercache` 层及 `layercache` 行。
安装包已包含可执行 JavaScript，无需构建脚本。修改已有 profile 前先备份。
源码目录也可通过 `dsh plugin --profile web add /path/to/checkout` 安装。

## 启动真实 LayerFS 服务

按照 [环境配置](docs/layerfs-setup.md) 准备 Linux SDK、已有 Project，
以及 shell 所需的 Docker/FUSE。固定的 LayerFS 提交见 [layerfs.json](layerfs.json)，
本版本针对 **1.1.0**。服务默认要求真实 LayerFS，不会自动切换成本地目录。

在源码目录中启动：

```sh
node src/cli.js serve --backend layerfs --project agent-data \
  --root /private/layercache-owner --namespace experiment-v1
```

先链接固定源码的 `@layerfs/agent`，或用 `--sdk` 指定它的公开入口文件。
使用拥有该 Project 的 `LAYERFS_*` 配置；Store 放在 Linux 本地文件系统中。
服务就绪后启动 dsh：

```sh
dsh --profile web --no-open
```

默认连接 `http://127.0.0.1:8088`。服务地址、鉴权、shell 白名单和显式本地参考模式
的设置见 [配置说明](docs/dsh.md)。本插件连接服务，不会替你启动 worker 或重建 Store。

## 在对话中使用

模型每生成一个工具调用，将它追加到当前 rollout 的完整历史，再调用 `tvcache_run`：

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

同一样本的新轨迹沿用 `task_id`，换一个 rollout 标签；完全重放会返回
`value: "42"`、`executed: 0`、`cache_hits: 2`。
同一标签中的历史只能追加。之前执行的步骤会计入 `continued`，包括不可缓存调用。
完成后用 `tvcache_close` 传入 `{"rollout":"A"}` 释放服务端会话。
标签属于发起调用的 dsh 会话，其他会话无法关闭它。

随机性、变化的外部数据和外部效果应设置 `cache:false`，该点后的轨迹不复用缓存。
请求失败、超时或响应丢失后，标签会停止继续执行，不自动重试或新建会话重放。
服务重启会使旧会话失效；插件重载会丢失标签映射。先检查未完成的外部效果，再明确
使用新标签继续，不能把重载当作无风险的恢复手段。

## 无需环境，先跑懂前缀缓存

```sh
node examples/branching.js
```

依次看到：A 执行 3 次；B 命中公共前缀、执行 2 次；A 重放命中 3 次、执行 0 次。
这个示例显式使用复制文件的本地参考后端。要在 dsh 中体验它，启动：

```sh
node src/cli.js serve --backend local --root /private/layercache-demo
```

同时必须在 dsh 插件配置中明确设置 `backend: local`。它不提供安全沙箱。

## 视频工具基准

两组都在 LayerFS 1.1.0 上执行固定轨迹，调用同样的 FFmpeg 预处理和 LayerFS
产物读取工具。无缓存组为每一步设置 `cache: false`。加速比为无缓存耗时除以缓存耗时。

| 工作负载 | 计时口径 | 无缓存 | LayerCache | 加速比 | 缓存命中 |
| --- | --- | ---: | ---: | ---: | ---: |
| Terminal-Bench 1 `video-processing`，2 个视频 | 3 轮单组墙钟时间的均值，每轮每组 8 个 rollout | 11.65 秒 | 1.78 秒 | **6.54×** | 84/96 |
| EgoSchema，固定清单的 100 个视频 | 逐视频耗时求和，每组每视频 4 个 rollout，最多 8 个视频并发 | 6,881.16 秒 | 1,733.95 秒 | **3.97×** | 600/800 |

- Terminal-Bench 使用提交 `d28711d` 中的示例和测试视频。3 轮中两组的帧哈希和产物均一致。
  [任务视频](https://github.com/harbor-framework/terminal-bench-1/tree/d28711d0da2675d0bb1d56de45ae5df6082438a3/original-tasks/video-processing)
- EgoSchema 的 100 个视频共 2.06 GB。100 个视频的帧哈希和产物均一致。
  [视频来源](https://huggingface.co/datasets/lmms-eval/egoschema)

两个实验均用 FFmpeg 4.4.2 以 15 fps 采样，缩放到 1920×1080 并对灰度帧计算哈希。
计时覆盖工具执行和同步发布版本的缓存开销，模型生成、训练和官方任务评分均在测量范围之外。

## 测试、边界和开源

默认测试使用真实发布版 Cordis/dsh 工具执行链，不需要模型 API Key 或 Docker。
完整 LayerFS/FUSE 验证及证据见 [验证记录](docs/dsh-validation.md)。
原 Node 服务和 Python 后训练客户端也可独立使用，见 [接口](docs/api.md) 和
[TVCache 迁移](docs/tvcache-migration.md)。Node 库从 `dsh-layercache/core` 导入。

文件快照不保存 RAM、网络连接和 GPU 状态。LayerFS 当前为 Disposable 模式；
不承诺掉电持久性。一个项目索引只运行一个服务；删除缓存索引不会回收历史空间。
本项目支持 LayerFS 1.1.0。`npm run benchmark` 示例使用模拟工具延迟。
shell 会在服务环境中执行代码，插件默认白名单不含 shell；只向可信调用方开放服务。

仓库包含插件 bundle、缓存服务、Python 客户端、测试、CI、许可证和中英文文档。
GitHub 发布与社区目录收录是两个步骤；官网展示需要 LayerFS 维护者合并目录 PR。
