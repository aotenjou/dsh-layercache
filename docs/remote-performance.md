# 远程性能与一致性报告

本报告记录当前工作区打包版本在指定 SSH 主机上的实测结果。远程训练上传包 SHA256 为 `73266a74fcccf2aa8ad46d20a89c0fd7058a8504cf4880653017b8680b3a850d`。模型是本机已有的 Qwen3-0.6B，模型文件未复制或修改。训练使用单张 NVIDIA RTX PRO 5000 Blackwell 72GB，3 个固定随机种子，每种模式 24 个采样批次、192 个 rollout，LoRA 训练参数和任务顺序固定。

## 一致性场景

| 场景 | 结果 |
| --- | --- |
| 独立随机工具 | 两个 rollout 得到不同结果，同一 rollout 追加历史沿用已接受结果 |
| 带 seed 工具 | 第二个 rollout 命中缓存，结果和执行后状态一致 |
| TTL 边界 | 300 ms 到期后重新执行，未接受过期节点 |
| 外部资源刷新 | `catalog` 从 v1 刷新到 v2 后重新执行，返回 v2 |
| single-flight | 同一调用的并发请求合并，专项服务累计观察到 5 个合并等待者 |
| 多 dsh 客户端 | 4 个独立客户端并发读写，返回值只有一个版本，共获得 12 次缓存命中 |
| rollout 所有权 | 非所有者关闭请求被拒绝，所有者关闭成功 |

专项脚本返回 `passed: true`。LayerFS 服务的最终统计为 2015 个请求、1161 个命中、862 个执行和 9 个合并请求。专用专项服务的资源状态最终为 `catalog=v2`。

## 0.6B 后训练矩阵

均值和样本标准差来自 seed 7、17、27。吞吐是训练阶段的 rollout/s，训练耗时不含模型加载、前后评估和最终 adapter 保存。

| 模式 | 训练耗时（秒） | 吞吐（rollout/s） | 工具调用耗时（秒） | 命中率 | 每运行真实执行数 | 评估成功率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 无缓存 | 88.741 ± 0.788 | 2.164 ± 0.019 | 0.339 | 0% | 521 | 12.5% → 100% |
| 原版 TVCache | 95.041 ± 0.470 | 2.020 ± 0.010 | 6.693 | 73.684% | 137 | 12.5% → 100% |
| dsh + LayerFS | 110.589 ± 5.128 | 1.739 ± 0.082 | 21.638 | 73.684% | 137 | 12.5% → 100% |

相对无缓存，TVCache 端到端耗时增加 7.1%，吞吐为 0.934 倍。dsh + LayerFS 端到端耗时增加 24.7%，吞吐为 0.803 倍。LayerFS 模式比原版 TVCache 慢 16.4%，工具调用分项约为 3.23 倍。这个任务的工具执行只生成和处理 2048 行本地 CSV，缓存减少了 73.7% 的真实工具执行，却无法抵消双层 HTTP、dsh 协议和 LayerFS 文件 API 的固定成本。高延迟工具的收益需要单独测量。

三种模式每个 seed 的完整 rollout trace、初始 adapter 哈希和最终 adapter 哈希均相同。3 个 seed 都是 12.5% → 100% 的评估成功率，说明缓存没有改变本次训练轨迹或参数结果。每种模式累计 1563 次工具调用，缓存模式累计 1152 次命中和 411 次真实执行。每次成功的工具返回都通过独立 Python 状态转移核对。

## Trace 诊断

训练 step 汇总显示 LayerFS 的 `tool_wall_s` 均值为 0.90 秒，每个工具调用约 31.75 ms。原版 TVCache 为 0.28 秒/step 和 12.42 ms/调用，无缓存为 0.01 秒/step 和 0.63 ms/调用。LayerFS 相对 TVCache 增加的约 19.3 ms/调用来自额外的 dsh HTTP 层、LayerCache HTTP 层和 LayerFS 索引访问。

在同一个已填充 Store 上启用 LayerFS SDK API trace 后，共记录 10,521 次 SDK 调用。服务启动清理阶段占 9,532 次 `fs.read`，这些读取来自同步 TTL/后代清理对所有节点和结果块的扫描，启动过程跨约 139 秒。这个长尾不在训练 step 的吞吐计时内，但服务重启会直接支付它。

专项实际 workload 的 trace 片段包含 72 次 API 调用。38 次 `fs.read` 合计 194.8 ms，16 次 `fs.write` 合计 219.6 ms，9 次 `fs.apply` 合计 109.1 ms，9 次 `branch.fork` 合计 8.0 ms。对应的 P95 分别约为 11.16 ms、15.86 ms、13.03 ms 和 1.05 ms。API 队列等待均值低于 0.6 ms，说明训练期间主要成本是调用数量和往返次数，而不是 LayerFS 单次提交或 SQLite 锁等待。

当前实现对每个缓存节点都采用独立的 LayerFS 记录读写。`readRecord` 先读取 manifest，再逐块读取结果。父状态一致性检查在 lookup 前后重复调用 `liveParent`，发布前还会再次读取当前节点。非根节点命中因此至少包含当前记录和多次父记录读取。未命中还要增加工具状态分支、结果块写入和最终 manifest 发布。dsh rollout 又通过 `/run` 把每个新增工具调用单独送入这一流程。

优先级最高的优化方向是为 manifest/节点记录增加带 revision 的进程内缓存，在发布和资源刷新时失效。随后可以在一次请求内复用已验证的父 revision，合并 lookup、父校验和条件发布前的重复读取。启动清理应改为先监听服务再后台分批扫描，或维护可按 expiry 查询的索引，避免重启时同步读取全部历史。完成这些改动后需要重新采集同样的 LayerFS API trace，确认 `fs.read` 数量和 dsh 每调用 wall time 同时下降。

## LayerFS 额外资源

以下数值来自远程运行结束后的只读采样。Store 同时包含训练缓存和专项一致性索引，结果目录则包含 adapter、trace 和 metrics，不应把结果目录大小归因于 LayerFS。

| 资源 | 观测值 | 说明 |
| --- | ---: | --- |
| LayerFS Store 目录 | 19,087,248 bytes（约 18.2 MiB） | 当前 XFS Store 的全量占用，包含索引、结果块和专项记录 |
| LayerFS 主服务 RSS | 147,284 KiB（约 143.8 MiB） | 训练服务进程的结束时采样 |
| dsh 网关 RSS | 136,280 KiB（约 133.1 MiB） | dsh + native executor 进程，属于 LayerFS 集成路径 |
| LayerFS 主服务累计字符 I/O | read 2,078,776,856，write 1,392,917,677 | `/proc/<pid>/io` 进程生命周期计数，包含页缓存和服务协议读写 |
| LayerFS 主服务累计实际块 I/O | read 0，write 492,445,696 | 同一进程计数，不能解释为纯 LayerFS 数据写放大 |
| 训练 GPU 显存 | 运行中探针最高约 3,976 MiB | 进程结束后 GPU 已释放 |
| 原版 TVCache Flask RSS | 33,748 KiB（约 33.0 MiB） | 对照服务结束时采样 |
| 原版 TVCache 实际块 I/O | read 1,490,944，write 1,536,000 | Flask 进程 `/proc/<pid>/io` 计数 |

远程 `/init` 是 SDK 支持的 XFS 挂载，当前容器视角为 150 MiB 配额，运行结束使用约 32 MiB。根目录 overlayfs 被 LayerFS Store 拒绝，因为不能保证 SQLite 跨内核锁，测试没有绕过这个检查。远程主机没有 `/dev/fuse` 和 Docker daemon，因此没有声称远程 shell/FUSE 通过。Windows Docker Desktop 上的真实 Store/FUSE 和 dsh/FUSE 各 2 个子测试均已通过。

## 验证数量

- 本地最终 Node 测试 40 通过，Python 测试 5 通过，静态检查通过。
- 远程当前包 Node 测试 40 通过，Python 测试 5 通过。
- 远程 XFS LayerFS Store 集成测试 1 通过。
- 远程一致性、多客户端和资源专项 1 通过。
- 本地 Docker/LayerFS 两条命令共 4 个子测试通过，容器和测试卷已清理。

## 回收范围

Local backend 会删除无引用快照目录。LayerFS 1.1.0 没有公开删除历史 Branch/Commit 的接口，因此 LayerFS 路径只清理缓存索引、结果记录和未引用结果块，底层历史空间不会被报告为已回收。活跃 rollout 的检查点在关闭前保留。远程实验目录和证据包按运行隔离，服务关闭后不会触碰模型目录。

远程原始 JSON、metrics、trace 和服务日志保存在本次验证生成的 evidence archive 中。训练矩阵的分析文件是 `results/analysis.json`，专项结果是 `results/remote-consistency.json`，资源采样是 `results/resources.json`。
