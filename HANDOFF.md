# Assets 项目交接

交接日期：2026-10-09（Asia/Shanghai）。本文件是当前状态与待办入口；
[实施历史](docs/handoff-history-through-20261002.md) 保留整理前的完整记录。
历史中的“当前”“最新”“待办”按其日期理解，以本文件为续接依据。

## 2026-10-09 首页 v4 前端实现

实现分支 `feat/homepage-v4` 基于最新 `main` `173f4cf`。本次只调整公开首页的标记、样式、双语文案和浏览器交互；复用现有 `/api/v1/surveys`、导航、主题、语言与目录路由，没有修改后端、数据或天球页面。

首页已按 v4 设计呈现炭黑/浅色主题、透明双主题 Logo、横排标题、概念空间示意、三组同步 Tab、真实四巡天目录行、统计和资源入口。Tab 每 5 秒循环；手动选择重计时，悬停、键盘焦点、隐藏页面暂停；减少动态效果默认暂停。来源清单与科学数据获取分别说明。

验收：`npm run build:site`、`npx tsc -p tsconfig.site.json` 和 `git diff --check` 通过。Playwright/Chromium 使用公开目录 fixture 检查 1440、1024、390、320px，主题、语言、导航、统计、目录失败提示、Tab 联动、轮播计时、悬停/焦点/隐藏暂停和减少动态效果；无横向溢出或浏览器错误。后续文案、标记和 Dev 部署见下节。未启动 Warehouse/Elasticsearch。浏览器截图在 `/tmp/asa-homepage-v4/`。

## 2026-10-09 首页文案与品牌统一 / Dev revision 360

首页标题明确为“按天区查巡天覆盖，再定位数据来源”，说明比较巡天重叠、追到档案来源，并区分 JSON/CSV 来源清单和科学数据。四个首页巡天行、管理台巡天卡片和目录预览共用同一套天区网格、轨迹、红色定位点及巡天简称标记；管理台不再使用风格各异的巡天展示图。页头复用透明双主题站点 Logo。公开首页、天球、目录和管理页页头统一为桌面 64px、手机 60px。仅改文案与前端表现，没有更改路由、API、后端、数据或天球主体。

代码提交 `1598ea7` 已推送到 `feat/homepage-v4`。`npm run build`、`npm test`（456 项，454 通过、2 跳过）、站点 TypeScript 检查、`git diff --check` 和 Helm lint 通过。浏览器验证了 1440、390、320px，中文深浅主题、巡天目录标记、各页页头高度和手动选择后自动轮播；没有横向溢出或浏览器异常。

Dev Helm revision **360** 已部署镜像 `0.1.0-20261009-143026-homepage-brand`；site/backend 均 1/1 Ready、重启数为 0。NodePort `http://10.15.51.75:32083/` 首页、health、assets、coverage 和静态 CSS 返回 HTTP 200。health 的 bundle SHA 为 `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，发布清单 602 files 加 1 个 retained package，共 603 项，与 health 计数一致。FITS 资产 16-byte Range 返回 HTTP 206，`X-Content-SHA256` 与清单一致。当前机器无法连接 Ingress `astro.assets.dev.72602.space`，因此使用 NodePort 验收。未启动或修改 Warehouse/Elasticsearch。

## 当前目标与状态

**第一阶段 MVP 已结束**（用户于 2026-10-04 确认）。Phase 1 覆盖 Euclid、DESI、Legacy
Surveys、HST 与 Workspace 的公开覆盖、原生分块反查、来源链接及 JSON/CSV 下载计划。后续 Phase 2
只更新 **Assets Dev**，不修改 72602、Workspace、公开 MOC 或 public bundle，也不下载科学像素。
2026-10-08 用户另行授权恢复 **Workspace Dev 的 503**；该维护例外仅涉及 Workspace 的
Elasticsearch 内存配置，不扩大巡天补数据或公开发布的范围。

Dev 当前 Helm revision **360**，site/backend 均 1/1 Ready、重启数为 0，镜像 tag
`0.1.0-20261009-143026-homepage-brand`。当前 public bundle SHA-256 为
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，release manifest 共 603 项。此前 revision 354 部署的
防积压修复 commit `d776e48` 已推送并保留在当前版本中。

### 2026-10-08 Workspace Dev 503 恢复

Workspace 应用自身 `/healthz` 为 HTTP 200，但其 Elasticsearch 在 **1 GiB** 内存上限下反复
OOM，导致 Workspace readiness 失败，Ingress 没有 Ready 后端而返回 503。维护前 ES Pod 已重启
370 次；最后确认的退出状态为 `OOMKilled` / exit 137，宿主机对应 cgroup 的 `memory.events`
也记录了 OOM。节点没有 MemoryPressure 或 DiskPressure，NFS 仍有约 716.5 GiB 可用。

已从 Helm revision 67 保存的 chart 与现有 values 恢复部署输入，复用 Elasticsearch 21.6.3
依赖。server dry-run 对比确认 15 个资源中只有 ES StatefulSet 的两个内存字段变化；跳过升级
hooks，部署为 **Workspace Dev Helm revision 68**。request 从 768 MiB 调整为 **1 GiB**，limit
从 1 GiB 调整为 **2 GiB**；JVM heap 仍为 **512 MiB**，CPU、镜像与启动探针参数保持原值。
覆盖参数已保存进 Helm release，后续升级需保留这些 values。没有部署 Workspace 工作树中的
其他变更。

10:29 CST 首次完整恢复检查通过：ES 和 Workspace 均 1/1 Ready、重启数为 0；实际 Dev 域名
首页、`/healthz`、`/api/data-assets/status` 均 HTTP 200，业务响应结构正常。ES health 为 yellow、
`timed_out=false`，3 个 primary shards 已恢复；单节点的 3 个 replica shards 未分配。
新 ES Pod 首次检查内存约 1.23 GiB，超过旧 limit。**10:29–10:39 CST 稳定性观察已通过**：
连续观察 608 秒、21 次采样全部通过，两个 Pod 始终 Ready、重启数为 0，ES cgroup 的
`oom` / `oom_kill` 均为 0；峰值内存约 **1.26 GiB**。PVC UID 和绑定 PV 保持不变。
原始 `curl --fail` 复现从 HTTP 503 / exit 22 变为 HTTP 200 / exit 0；同源 JS/CSS 均 HTTP 200。
恢复后的同版 Helm chart lint 通过，文档 diff 检查与本地链接检查通过。完整状态汇总见仓库外
`recovery-receipt.json` 与 `availability-observation.jsonl`。

业务状态复核中，两条资产记录的 `objects` 均为 `queryable`。其中一条覆盖状态仍为 failed；
只读核对确认对应的最新覆盖制品在 2026-09-24 已是 failed，早于本次恢复，关联的最近扫描
任务为 succeeded。该历史制品问题单独登记为 Workspace 后续待办，未重试或重建任务。

配置备份、已审核的部署差异及仅含状态汇总的验证记录位于仓库外
`/home/aaron/.local/share/astro-workspace-recovery/20261008T022530Z/`。
ES PVC `data-asa-elasticsearch-master-0` 继续绑定原 PV，UID 为
`d156eaf2-7e3c-40c1-9423-1ed0f5f2e959`。没有删除或重建 PVC、重置索引或下载科学数据；
Workspace 私有响应正文、文件身份和 HEALPix cells 未写入 Assets 文档或验证记录。

### 待做清单（2026-10-08）

以下事项仅登记待做，本次不启动新的补数据、审核、清理或迁移。存储事项应先于下一批可选
巡天归档完成。第一阶段 MVP、防积压修复部署、审核界面部署、Wiki 中英文发布与 CASDC 状态
更新已完成，不再作为待办。

| 优先级 | 待做 | 当前状态与完成标准 |
| --- | --- | --- |
| P1 | 审核功能代码提交、推送 | Dev revision 358 已部署并通过完整校验；代码已暂存但尚未提交、推送。检查并保留既有工作树修改，提交后登记 commit 与镜像的对应关系。 |
| P1（下次归档前） | 最多保留三个已完成版本 | 每条逻辑内容版本线包含活动版在内最多保留 3 个已完成版本。现仅盘点部分引用；需覆盖所有保留版本、控制状态和进行中任务依赖，完成引用感知 dry-run，再实施清理与自动留存。共享对象仍有引用时必须保留。 |
| P1（下次归档前） | 独立备份与存储迁移 | 目标尚未选定。确认独立于 `10.15.49.212` 的故障域、所有权和配额；冻结权威依赖清单，逐对象核对 size/SHA，完成恢复演练和 Dev 切换验证。见 [Dev 存储规划](docs/storage-plan-dev-20261007.md)。 |
| P1 | 容量报警与硬配额 | 桶 75%/85%、spool 750/900 MiB 仍为建议阈值，实际报警未落地。核实 NFS/local-path 的硬配额能力，落地容量预警；PVC 声明容量和 1 GiB spool 入队预算不能视为文件系统硬限制。 |
| P2 | 剩余巡天证据与库存缺口 | IPHAS pinned QC 尚待受管导入，保留重复 field/QC 关联；ZTF DR7 仍缺冻结的历史处理清单，不能以当前 IRSA 内容替代。29 个巡天已绑定不代表库存完整；继续按来源核验候选 URI 的实际可用性。ERO 17-target 映射已纳入 Dev，后续精度仍依赖官方有效像素 footprint/MOC 或真实 Tile roster。见 [残余来源复查](docs/research/phase2-residual-native-surveys-followup-20261007.md)。 |
| P2 | 实际产品审核与模态复核 | 审核界面改进已完成，业务审核尚未完成。SDSS 的 25 个产品中 19 个待审项因缺少可验证 MOC 证据而 blocked，6 个已发布；先补足证据再审核，逐产品复核 imaging/catalog/spectroscopy 等身份。DR10 color imaging 已纠正。 |
| P2 | 性能与更广回归 | 测冷/热启动、geometry/native 查询、分页和完整 JSON/CSV 导出；检查更多 component 与中文字体冷缓存首屏。每项记录产品、order/cells、活动版本和实际验收范围，不能把已有局部 smoke 扩写为全局完成。 |
| P2（Workspace 另行安排） | 历史覆盖制品失败 | 本次 503 已恢复，索引查询正常；另有一个维护前已失败的覆盖制品，需在 Workspace 自身的管理流程核对失败原因与恢复办法。Assets 只记录服务状态汇总，不保存私有制品或扫描正文。 |
| 暂缓 | 长期接口与产品能力 | Warehouse/PVC inventory 接口、统一 SQLite、API 自助购买和计费。管理员发 Key、鉴权、配额及公开覆盖 HEALPix API 已有；`onlineBilling=false`。 |

### 2026-10-08 审核体验部署

部署原生索引差异和巡天产品审核资格显示后，真实管理员请求发现可选绑定字段缺失时会令
`/api/v1/admin/native-units` 返回 500。比较签名已改为对规范化值外包一层对象再哈希，使缺失值与
`null` 保持可区分；新增候选缺少 `selector` 的回归测试。变更已构建、推送并部署至 Dev revision
358。backend 冷启动约 4 分钟后 Ready，之后 site/backend 均 1/1 Ready。

`npm run validate` 通过：454 项测试中 452 通过、2 跳过，Core wheel 校验通过；Helm lint 通过。
Dev 上管理员 `/api/v1/admin/native-units` 返回 HTTP 200，generation 13、活动 group
`9b85d5cd59e506748a6e77d1486e8d1e392d616ecc030c7d98fb150f7f0ea54c`，31 个版本条目均有对比摘要，
30 个非活动候选均有内容差异。SDSS readiness 返回 25 个产品，其中 19 个待审项因没有可验证的
原生 MOC 覆盖而标为 blocked、6 个已发布；浏览器工作流 smoke 通过。公开 bundle 仍为
`reviewed-mupsxe2v-c91be91f` / SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，603 files；没有改动 MOC、public
bundle、72602 或 Workspace。审核功能工作树仍未提交。

2026-10-07 按用户授权清理 upload-spool 的旧完整状态快照，释放 **383.611 GiB**；
`eva7028` 于 **09:12:25 CST** 自动报告 `DiskPressure=False`，taint 已消失。最新复查根盘约
**48.07 GB 已用 / 421.30 GiB 可用 / 10%**，两个节点 `DiskPressure=False`。
旧版 backend 曾使 spool 回涨到 **37,180,447,529 bytes**；修复版启动后的校验压缩曾将其降到约
**0.57 GiB**。当前 spool 约 **140,780,790 bytes / 0.13 GiB**，低于 1 GiB 应用层 admission 上限。
Dev `/healthz` 与 `/api/v1/status` 均 HTTP 200；backend liveness 为 TCP，startup/readiness 为 HTTP `/healthz`。

### 2026-10-07 upload-spool 根因、清理与修复

用户提供 `ssh zjlab@10.15.51.75` 并明确授权清理历史无用数据。主机目录审计确认该 PVC
落在 eva7028 根盘，14,128 个 jobs 共 **412,431,876,198 bytes / 384.1 GiB**，全部为 JSON
状态快照，未含科学影像：publication-tasks 11,772 份约 354.7 GiB、native-units 2,356 份约
29.4 GiB。只有 10 份 SHA 完全相同，不能仅靠 SHA 去重解决。

根因是 scheduler 每 5 秒检查完整快照，而 executor 每 15 秒更新 `lease_until`；纯心跳
也改变 SHA，反复复制几十 MB 的全量状态。上传 quota/timeout 失败后全部旧代都留存，且
入队没有容量预算；local-path 不执行 PVC 声明的 1 GiB 写入配额。这是 Assets 实现缺陷。

backend 临时缩至 0 后，先完整校验并备份最新本地状态、每 namespace 最近两份待上传快照，
以及当前任务 SQLite（130 tasks / 142 attempts / 51 runs，`integrity_check=ok`）。备份及清理
清单在 **eva7028** 的 `/home/zjlab/astro-assets-spool-recovery/20261007/`，目录约 **209 MiB**；
本机审计回执在 `/home/aaron/.local/share/astro-assets-deployments/dev/20261007-spool-audit/`。
原任务、已安装索引、输入证据和科学文件均未删除。

校验清单并原子退休后删除 **14,109 份**旧检查点，回收 **411,898,943,716 bytes**；
保留最近两代和所有带 lease 的 jobs，共 **19 份 / 0.496 GiB**。backend 副本数已恢复原值 1。
根盘从 428G 已用 / 39G 可用 / 92% 降至约 45G 已用 / 422G 可用 / 10%；kubelet 自动解除压力。

本轮只读验证了远端 pointer 与对象 size/SHA metadata：publication-tasks generation 14652、
native-units generation 3755。没有完成远端整份对象 SHA 重读（50 MB GET 超时）；
`remote-status.json` 明确 `metadataVerified=true`、`fullBodyShaReverified=false`。
安全清理依赖的是完整 SHA 校验的最新本地状态和 /home 备份，不能声称远端包含全部本地更新。

防复发修复已在 Dev revision 354 生效：

- scheduler 去重忽略纯 `lease_until` 变化，真实任务 phase/结果/历史变化仍生成完整快照。
- 仅合并合法 `state-snapshot`，每 namespace 保留最新两代；先完整 SHA/size 校验替代快照，
  保留 leased、conflict、uploaded 未确认记录及全部唯一文件依赖。损坏替代快照不能触发删除。
- `ASSETS_UPLOAD_SPOOL_MAX_BYTES` 默认 **1073741824**（1 GiB），跨进程 flock 序列化入队与预算检查；
  统计 jobs/quarantine/临时 job 实际字节，超预算拒绝新入队，不删除唯一文件。这是应用入队预算，
  不是文件系统硬配额；lease/receipt/控制元数据仍需少量空间。
- 快照入队失败清除临时 pending 源文件，并把最新未入队的本地 generation 标记 failed；
  较旧 pending 不能遮住这个错误。本地业务状态仍保留，需处理失败后重试同步。

28/28 针对性测试、`npm run build`、完整 `npm test`（448 项，446 通过、2 跳过）、Core wheel
校验、Helm lint 与 `git diff --check` 已通过。修正了旧 SPHEREx fixture：保留其原始锁定的五探测器
来源，同时检查新提议绑定依赖独立 D1 输入；没有改变已安装索引。
续接时重新执行 `npm run build`、完整 `npm test`（448 项，446 通过、2 跳过）、Core wheel 校验
和 Helm lint，全部通过。Registry 拉回镜像的 ID 与构建 ID 一致。该修复有 1 GiB 应用层 spool
admission limit，不是 local-path 文件系统硬配额；入队失败会保留业务状态并将最新快照标为 failed。

### 2026-10-07 Warehouse 历史执行记录清理（用户明确追加授权）

用户要求清理 `atlas-warehouse` 历史任务。本轮先备份完整请求和工作负载元数据，压缩请求备份约
**27,830,579 bytes**，再保存 48 个任务 Pod 的有限诊断日志。归档、UID 清单和执行回执位于本机
`/home/aaron/.local/share/astro-assets-deployments/dev/20261007-spool-audit/`：
`warehouse-requests-before.json.gz`、`warehouse-workloads-before.json`、`warehouse-cleanup-plan.json`、
`warehouse-cleanup-receipt.json`、`warehouse-workloads-after.json`、`warehouse-terminal-pod-logs/`。
这些材料不入 Git，也不进入浏览器初始响应。

已清理：**62 个**超过 7 天且已结束的 MocDiscoveryRequest、**49 个**旧自测 ScanRequest、
**1 个**旧自测 ScanBatchRequest，以及 **51 个**已结束 Job 和 **51 个**旧 Pod（48 个关联任务 Pod、
2 个独立已完成检查/上传 Pod、1 个旧 MinIO Evicted Pod）。删除使用 UID precondition 并重查终态；
没有删除运行中的扫描。旧 MOC controller 缺少终态防重建保护，仅删除 Job 会重新生成任务，因此
归档后连同这些历史请求清理，不能仅用 Job TTL 代替。

保留 **1,664 个**实际扫描 ScanRequest 与 **6 个**ScanBatchRequest，用于源身份和批次追溯；
未清理 Elasticsearch 文档、MinIO 对象或 PVC 内容。09:35 验证 namespace **Job=0**，只剩
Elasticsearch、Kafka、MinIO 三个 Pod，全部 Running / Ready；三个相应工作负载均 1/1。
这是用户授权的运行记录维护，没有修改 Warehouse 代码、镜像、部署或资源 limits。

### 历史集群故障快照（2026-10-07 约 06:50 CST，已由上文清理记录更新）

**已确认的直接触发因素是 `eva7028` 的节点文件系统磁盘压力，不是集群控制面整体宕机。** Kubernetes
仍报告该节点 `Ready=True`，但 `DiskPressure=True`（自 00:42 起），并带有
`node.kubernetes.io/disk-pressure:NoSchedule` taint。kubelet 事件报告正在回收 ephemeral storage，且驱逐了该节点上的
Pod。节点 stats/summary 当时报告容量约 527.3 GB、已用约 467.3 GB、可用约 33.1 GB；inode 使用约 401,488 / 32,768,000，
不是 inode 耗尽。另一节点 `zjlab-ubuntu` 为 Ready 且没有 DiskPressure。

此次读到至少 12 个位于 `eva7028` 的失败/驱逐 Pod，涉及 Assets、Workspace、Atlas operator/discovery、Warehouse MinIO、
Prometheus、node exporter、kube-state-metrics、反向隧道和 NFS provisioner。部分旧 Pod 显示 `Evicted` 或
`ContainerStatusUnknown`。控制器创建替代 Pod 后出现两种结果：

- Assets site/backend 与 Prometheus server 有 `Pending` 替代 Pod；调度事件明确指出另一个节点不符合 Pod 的
  node affinity/selector，而 `eva7028` 有未容忍的 disk-pressure taint。Assets 两个 Deployment 当前均无 Ready 副本，
  Dev NodePort `10.15.51.75:32083` 不可用。
- Workspace 主 Pod 已在 `zjlab-ubuntu` 运行但 readiness 失败，因为 Workspace Elasticsearch 不可用。其 Elasticsearch
  容器状态为 `OOMKilled` / exit 137，内存 limit 1 GiB、JVM heap 512 MiB；本次快照约 75 次重启且仍在增长。
  Atlas operator 容器也为 `OOMKilled` / exit 137，limit 1 GiB，本次快照约 70 次重启且仍在增长。两者的直接退出原因是
  容器内存上限；两节点的 `MemoryPressure` 都是 False，因此不要将其描述成已证实的全节点内存耗尽。超限前的峰值及
  应调整的资源值尚未确认。

这不是全群服务中断：Argo CD、数据库、基础网络/存储，以及 Warehouse Elasticsearch、Kafka、MinIO 当前有 Ready 副本；
已完成的 Warehouse Job 显示 `Completed` 是正常结果，不是故障。上述故障快照中没有清理节点文件、手动移除 taint、
改 Helm 调度或重启 backend。用户将另行安排集群修复。

**以下是清理前的历史诊断，不是当前状态。** 当时磁盘占用来源尚未查明：Kubernetes 只证明节点 filesystem 余量触发了压力和驱逐；没有 `eva7028` 的目录级占用
证据。backend upload-spool 的约 13,259 个任务、372 GB payload 是既有待核查线索，尚未证明其实际落在触发压力的节点文件系统上，
也不能据此删除任务或快照。此前 SSH 到 `eva7028` 因主机名无法解析而失败；本轮只有 Kubernetes 节点统计，没有主机目录检查。
修复人员需在主机上核对 filesystem/mount 对应关系、`df -hT`/`df -i` 与分目录用量，至少检查
k3s/containerd、kubelet、local-path/PVC 和日志路径；处置前先确认数据归属及任务状态。释放空间后应等 kubelet 报告
`DiskPressure=False` 且 taint 自动消失，再检查受影响工作负载的调度、PVC 挂载、Pod readiness 和 Assets NodePort。
Workspace Elasticsearch 与 Atlas operator 的 OOM 需要另外根据实际 RSS、启动日志及 limit 做诊断，不要只通过重启判断恢复。

公开 release 未改变：`reviewed-mupsxe2v-c91be91f`，603 files，SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`；105 published MOCs，
coverage catalog 132 layers。新 Pod 的 object-store release sync 恢复的也是这个相同 release。

截至 2026-10-07 10:11 UTC，目录列出的 **29 个 survey IDs** 已进入 Dev 活动 native group
`9b85d5cd59e506748a6e77d1486e8d1e392d616ecc030c7d98fb150f7f0ea54c`，generation **13**，
128 bindings，managed/verified=true。活动 group digest
`29356a9837365891a7f16771e9570149800e199cafec7244e4298bca9ad756e1`；242/242 checks 通过，
审核明确接受 108 项 gaps。原归档 task `native-muxtcz30-f27a5bc2` attempt 1 完成
**1385/1385** metadata/index dependencies 的远端校验；激活 task `native-muxxw3q4-46ab59f4`
attempt 1 已完成 runtime 与 site HTTP 验证。最新 native-units 控制快照 **5472 / synced**。
18:32 CST 的实时管理 API 复查确认活动索引仍为 generation 13，目录 **29/29 个 survey IDs**
都有 binding，原生任务队列没有非终态任务。活动版与 generation 12 回滚版的引用感知容量盘点、
历史 group 中未归档引用及备份端点资格见 [Dev 存储规划](docs/storage-plan-dev-20261007.md)。

### 旧 generation 12 group（现已被 generation 13 取代）
build task `native-muwfqf67-c35ba738` 已完成；124 bindings、26 个 survey IDs、234/234 checks 通过。
AllWISE 18,240 units、CFHTLS 171 fields、DECaPS 1,065,941 CCDs、ACT 6 maps、Pan-STARRS 9,000 skycells、
IPHAS 169,380 indexed units（98,793 rows excluded）、Rubin First Look 2 images、ZTF DR7 162,333 identities
均已核验。审核接受了报告列出的 **79 项 gaps**，包括 partial inventory、estimated geometry、文件可用性未核验、
IPHAS final-QC 未对齐及历史 HST COSMOS unavailable binding；这不代表库存完整。

generation 11 到 generation 12 的前一轮流程已完成：归档 task `native-muwp2uoh-ce290269`
attempt 4 完成 1,363/1,363 dependencies 的归档校验，group
`90bb738d3354b0532e43a69c3062737b22e941c1045142920693441717fb6752` 曾作为 generation 12 活动版本。
该版本已由上面的 generation 13 group 取代；早期 attempt 和 spool 状态记录仅作为历史排查材料。

SkyView radio capture2 的 18 个受管输入文件位于 evidence PVC
`/var/lib/assets-evidence/managed/native-units/inputs/20261006-radio-native-capture2/`，共 3,567 张地图及逐图 header，
没有科学像素。NVSS 2,326 张 I 图、SUMSS 748 张、WENSS 493 张已导入并进入 generation 13；WENSS 的 107 个
header 频率与名义 325 MHz 冲突，原值保留并作为已接受 gap。射电适配器的 14 项 Python 测试通过；完整 Node 测试
441 项中 439 通过、2 跳过，Core wheel 校验、Helm lint 通过。

SPHEREx D1 v20-241 header-only capture 原始 staging 位于
`/home/aaron/.local/share/astro-assets-deployments/dev/20261007-spherex-d1-v241-capture1/`，manifest SHA-256
`e8f7e3b8d1ec187751c5a1a605393a0bee0c9fb71ef79cee250e167b48a51eb1`。1 个 listing row 和 23,040-byte FITS 头已导入；
4 个输入文件在 evidence PVC 路径 `/var/lib/assets-evidence/managed/native-units/inputs/20261007-spherex-d1-v241-capture1/`，
逐文件 SHA 与本地 staging 一致。v20-241 D1 使用独立来源，原 v20-240 D2–D6 输入仍保留；没有读取科学像素。

最新 storage 复测显示 `asa-resource` 共享桶为 **46,756,999,982 bytes / 43.55 GiB**、11,983 objects，
60 GiB 配额余 **16.45 GiB**（72.6% 已用）；证据 PVC 为 **109,692,214,128 bytes / 102.16 GiB**。
下一批可选来源归档前应先确定独立备份存储和引用感知留存 dry-run。详细迁移规划见
[Dev 存储规划](docs/storage-plan-dev-20261007.md)。

用户于 2026-10-07 确认本轮不需要回滚，并要求后续 Dev 每条逻辑内容版本线最多保留 **3 个已完成版本**，
包括活动版本。候选构建或归档任务进行中时，其依赖仍需保留；共享对象只可在确认没有任何保留版本引用后清理。
这是留存目标，实际清理前仍需完成引用感知 dry-run；本轮 API 检查没有删除历史对象，也没有改动公开 release、MOC 或 bundle。

接续步骤：

1. 在开始下一批可选巡天归档前，选择与 `10.15.49.212` 故障域独立的备份/对象存储，完成引用感知的 dry-run 清单，
   按每条逻辑内容版本线最多保留 3 个已完成版本估算回收量并预留容量。dry-run 审核前不要删除远端历史对象或切换存储。
2. 从 [2026-10-07 残余来源复查](docs/research/phase2-residual-native-surveys-followup-20261007.md)、
   [残余巡天调查](docs/research/phase2-residual-native-surveys-20261006.md) 和
   [剩余候选审计](docs/research/phase2-remaining-native-unit-candidates-20261006.md) 接续。存储目标与留存决策完成后，
   可评估导入 IPHAS 固定提交中的 QC 元数据；保留重复 field 关联并维持 `inventoryComplete=false`。
   ZTF 不要把当前 IRSA 内容冒充冻结 DR7；逐项记录真实范围、精度与 gaps。
3. 后续仅更新 Assets Dev，不修改 72602、Workspace、公开 MOC/public bundle，也不下载科学影像。

原生分块、输入和反查必须遵守 [coverage workflow](docs/coverage-workflow.md) 与
[native unit management](docs/native-unit-management.md)；不要把 `verified` 描述成巡天库存完整。

## 第一阶段 MVP 与服务基线

MVP 让用户在普通模式查看 HEALPix cell 覆盖的 DR/模态，在重合模式查询所选 component 覆盖的
实际 Tile/brick/target/observation，并导出与页面一致的 JSON/CSV 来源清单。Workspace 将公开
图层/MOC 与私有 CSST 区域求交，通过服务端 API Key 查询 Assets，并保留命中文件的直接父目录。
下载计划是来源清单，不是代用户下载科学数据。

| 服务 | Helm revision | 镜像 tag | 状态及入口 |
| --- | --- | --- | --- |
| Assets Dev | 358 | 0.1.0-20261008-070003-native-review-fix | site/backend 均 1/1 Ready；审核页 http://10.15.51.75:32083/admin/ |
| Assets 72602 | 7 | 0.1.0-20261003-153818-hst-supplement | 未在本轮更新；https://astro.assets.72602.space/atlas/ |
| Workspace Dev | 68 | 0.10.38-dev-20261003-0206-native-selection | 503 已恢复；ES/应用均 1/1 Ready，仅调整 ES 内存；http://astro.workspace.dev.72602.space:32080/ |

- Assets Dev release/namespace：`astro-survey-atlas-assets`；API 与 health 在 host 根路径。
- 2026-10-08 revision 358 下，`/healthz` 与管理员原生索引、产品审核 API 均 HTTP 200；catalog 有 132 layers、
  survey catalog 有 29 IDs。当前 native generation 13，active group 与顶部记录一致；public pointer
  仍为 `reviewed-mupsxe2v-c91be91f` / SHA-256
  `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，105 published MOCs。
- 本轮确认 CASDC index 与 `/Gaia/`、`/GALEX/`、`/Euclid-Q1/` 目录索引均 HTTP 200。线上 Gaia
  reverse-lookup 返回 `https://casdc.china-vo.org/mirror/Gaia/`、`status=verified`；根 index 仍是
  `entrypoint-only`。状态由 `server/survey-access.ts` 中的人工检查快照生成，不是页面实时探测；
  目录索引可达不代表单个科学文件已核验。
- 本轮只读 smoke 中，`/healthz`、`/api/v1/status`、`/api/v1/coverage/catalog`、
  `/api/v1/resource-packages/catalog.json` 与 `/api/v1/releases` 均 HTTP 200；HEALPix 和 reverse-lookup
  服务 available，Warehouse evidence configured。Coverage catalog 有 132 层，其中 111 层支持多个 order。
  DESI 资源包 v3.5.0 下载 HTTP 200，1,805,131 bytes 的 SHA 与响应头一致；`healpix/order4.json` 和
  `order8.json` 分别含 1,385 与 271,022 个巡天并集 cell，文件内另有逐 layer `cells[]`。SPHEREx v3.1.0
  的 O8 并集为空且 7 层均因原生最高阶不足而省略；包固定生成 O4/O8 文件，不保证每个 order 非空。
- `npm run build`、完整 `npm test`（448 项，446 通过、2 跳过）、Core wheel 校验及 Helm lint
  在 2026-10-07 当前代码通过。revision 356 的镜像 push 与 Helm rollout 成功，site/backend 均 1/1 Ready；
  backend readiness 是 HTTP，liveness 是 TCP；防积压修复已部署到 Dev。
- Dev-only Phase 2 不发布 MOC、不改变 public bundle、不更新 72602 或 Workspace。
- Earlier overlap acceptance: Euclid + DESI O4 C01–C06 显示实际相交模态、空间分块单行计数、
  覆盖计算默认折叠；1440/1024/390px 无横向溢出，browser page errors=0。Dev O4 C01 `[190]`
  的 DESI、ERO、Gaia JSON/CSV 导出已通过一致性验收。
- 当前审核接受已知范围缺口；`verified` 不等于巡天库存完整。

## 历史部署基线（revision 337，2026-10-05）

以下数据记录 M31 2MASS 激活前的 revision 337 / generation 5 状态；当前部署与待办以本文顶部为准。

本次发布后确认 Helm、Deployment、网站 health/status：

| 服务 | Helm revision | 镜像 tag | 状态及入口 |
| --- | --- | --- | --- |
| Assets Dev | 337 | 0.1.0-20261005-042120-native-phase2-2mass | site/backend 各 1/1 Ready、重启 0；http://10.15.51.75:32083/atlas/ |
| Assets 72602 | 7 | 0.1.0-20261003-153818-hst-supplement | site/backend 各 1/1 Ready；https://astro.assets.72602.space/atlas/ |
| Workspace | 67 | 0.10.38-dev-20261003-0206-native-selection | 1/1 Ready；http://astro.workspace.dev.72602.space:32080/ |

- Assets Dev release/namespace：astro-survey-atlas-assets；Workspace release：asa，
  namespace：asa-workspace。Assets 的 API 和 health 在 host 根路径。
- /healthz、/api/v1/status 均 HTTP 200；public bundle：
  reviewed-mupsxe2v-c91be91f，603 files，105 published MOCs，catalog 132 layers。
- Bundle SHA-256：0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307。
- Dev 活动 native group 为
  `3fe4ede297e1eac20fdfad80bd76452b563acdcdb2b2f91dc3958da0c16fd104`，
  generation 5，managed=true、verified=true，反查服务 available；24 个锁定输入、71 个产品绑定，
  165/165 检查通过。最近读取的 native-units 控制快照 generation 1101 为 synced；候选状态仍会
  继续产生快照，激活前需再次确认最新 generation 已同步。
- Dev revision 337 镜像为
  `crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:0.1.0-20261005-042120-native-phase2-2mass`。
  `/api/v1/status` 报告公开 bundle `reviewed-mupsxe2v-c91be91f`、105 个 MOC、132 个 catalog layer；
 之前确认的 public bundle 仍为 603 files、SHA-256
  `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`。
- Overlap UI 验收：Euclid + DESI 的 O4 C01–C06 显示组件实际相交模态；抽屉只有一行空间分块计数，
  覆盖计算依据初始收起；1440/1024/390px 无横向溢出，browser page errors=0。
- 72602 活动 native generation 4，group
  `803023a36a8d489d951717214b92d0df4c3d4b7b36607a3634843bb0621d29d5`，
  ERO 17/17 targets、85 份 FITS 头；HST 923,382 observations，138/138 checks。
  原生控制 generation 611、syncStatus=synced；本次新增数据仅部署在 Dev。
- 当前审核接受已知范围缺口；verified 不等于巡天库存完整。
- 此前 ERO alias 更新没有改变公开 bundle、MOC 或当时的 Workspace revision 62。
  /healthz 的 backend-proxy 字段不是实际活动 group；以 /api/v1/status 为准。
- 历史检查：Assets 319 发布 UI/API 代码；公开 bundle、MOC 与 native generation 未变。
  /healthz 和 /api/v1/status 均 HTTP 200，活动 bundle SHA 仍为
  `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，603 files；
  `api/v1/status` 为 105 published MOCs，native generation 2、managed/verified=true。

## Phase 2 VVV、2MASS 与 DES 采集记录（2026-10-05）

VVV DR4 已进入当前活动 generation 5，不再处于候选归档状态。原始 ESO ObsCore 快照有 11,452 行；
213 个非 Tile calibration targets 保留在输入页但不进入空间索引，11,239 行代表 348 个正式 Tile。
H/J/Y/Z 有 1,513 个 Tile image 的 DataLink `#this` 文件身份；Ks 暂无受支持产品直链。Tile frame
转换为 ICRS 后仍为 estimated，未检查有效像素掩膜；这是 DR4 submission increment，不是累计库存，
`inventoryComplete=false`。当前活动组的 VVV adapter 报告 11,239 行、348 个 Tile，6 个产品绑定已活动。

2MASS 6X 导入快照位于 backend evidence PVC：
`/var/lib/assets-evidence/managed/native-units/inputs/2mass-6x-m31-1deg-atlas-images/`；来源采集目录
为 `/home/aaron/.local/share/astro-assets-deployments/dev/20261005-2mass-6x-m31-capture2/`。
快照 SHA 标识 `bc0cc3160eb6c3a33654c02bfb8d0e6e62efd5a0e3c746ff33e61a71eacfe0b3`，138 张 J/H/K
Atlas images、46 个 coadd。构建 task `native-muua1o70-703f2729` 已完成，候选 group 为
`da26e6375eb6ddcb29fd70a029553eea785e03e890dec3c9f5fbbbfd69c3ea79`，现已在 Dev generation 6
激活。归档 task `native-muucskfc-696a7d9e` 已完成 872/872 依赖文件校验。该快照只代表 M31 一度
范围；不要将其描述为完整 2MASS 6X 清单。

DES DR2 capture3 已完成，manifest SHA-256 为
`3863ef174b9dadc6ca630eb379e846798fef7dc1d585f14a3b892d12780bfca8`，10,169 Tiles / 50,845
normal g/r/i/z/Y rows / 11 TAP pages；16 个输入文件哈希完整。本地适配器导入校验得到 snapshot ID
`b4eeaa92134edd4abeb1a63f86b4922e3b903c8c3de9dea13405b6918e597d94`。原始 staging 在
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-des-dr2-capture3/`。NOIRLab 的
VOTable 1.2 无 namespace；Tile ID 包含 `+/-`；source-listed positive Tile URL 的字面 `+` 必须保持原样
（HEAD 原样 200 `image/fits`，编码成 `%2B` 为 HTTP 500）。几何角点为 estimated；该 capture 尚未导入
管理 API。DES capture1、capture2 是失败的空/部分 staging，缺少完整 manifest，禁止引用。

DES capture3 与 SPHEREx capture2 已暂存并通过管理 API 导入，纳入候选 group
`728f69e52782820fb659e97c1437ef692088d29ca2b5508f94413b210d18d1ba`。唯一构建 task
`native-muufpsg9-c9bc42bf` 仍在运行，当前进度与后续 `review → archive → activate` 以本文顶部状态为准。
完成后验证 DES Tile/原始 URI、SPHEREx observation/detector URI、10,169/50,845 的 DES 计数及各自
estimated footprint 和逐文件 unverified 状态。只更新 Dev；不发布 MOC、不改变 public bundle、
不更新 72602/Workspace，也不下载科学影像。

## Dev 原生分块补充（2026-10-04，已完成）

Dev 323 已部署四类新适配器、SDSS 原始 `rerun="301"` 校验修复、本地临时构建及
父执行器的独立 lease 续期，build 与 389 项测试通过（387 通过、2 跳过、0 失败），
Core wheel 和 Helm lint 通过。
五批输入均已通过认证管理 API 导入：Gaia 3,386 个真实 O8 文件分区，
SDSS DR9 927,643 个正常 rerun-301 field，GALEX 38,729 个唯一 observation，
JWST 22 个 Carina/SMACS observation（现有产品仅绑定 12 个 NIRCam），以及
ERO 17 个 target / 85 份 FITS 头。Roman 查询只有 TEST 元数据，未登记为实际分块。

新来源已登记，当前共有 22 个来源；64-binding 候选选择保留旧 49 个绑定并新增 15 个。
候选构建 `native-mus73ebm-fdbaf336` 在 SDSS 927,643 个身份、零排除后遇到长时间
NFS 写入等待，已通过管理 API 成功取消（HTTP 200）。`survey` SQLite 改为本地临时
磁盘构建后完整复制并原子安装；新 buildKey 记录 `local-staging-v1`，不复用旧临时库。
修复的 build、385 通过/2 跳过测试和 Core wheel、Helm lint 均通过；本地临时磁盘
296 GiB 可用。revision 322 的构建 `native-mus8n6c9-85507367` 完成四类 metadata
写入后，在同步 SQLite 提交/完整性检查期间停止子进程 heartbeat，120 秒 lease
到期导致重复执行；已通过管理 API 取消。revision 323 增加父执行器每 15 秒的
续期，检查同一 running attempt 和活着的受控子进程，退出、取消或 attempt 改变
即停止；两项 mock-timer 测试覆盖超过 5 分钟无 IPC、退出和取消/替换 attempt。
构建 `native-mus9imk7-dd9c95bb` 已复用原导入快照；Gaia 3,386、SDSS 927,643、
GALEX 38,729 和 JWST 22 个索引身份均零排除。第一次 attempt 1 的完整性检查耗时约
1,390 秒后通过，候选构建总耗时约 2,042 秒；构建完成时活动版本仍为旧 generation 2。
候选 group `e2a72cd78a10994462d585a96d79da670481d1eeaf9e30b7574882b1a6eecffe`
包含旧 49 个和新 15 个 binding、22 个锁定输入快照，156/156 验证通过。
构建报告确认 Gaia 3,386 O8 分区、SDSS 927,643 field、GALEX 38,729 observation、
JWST 22 observation、ERO 17 target/85 FITS frames；GALEX 实际索引 67,913 去重元数据行。
唯一 unavailable binding 是历史 HST COSMOS `hst-mast-cosmos-obs-26442812`，与 Dev
基线相同；15 个新 binding 全部可用。审核已接受报告列出的范围/精度缺口及该历史绑定，
不表示库存完整。

归档任务 `native-musaqfrx-9f7b4baa` 已完成 858 项元数据与索引依赖归档及远端校验，
候选审核接受列出的范围与精度缺口后已激活。Dev 现运行 group
`e2a72cd78a10994462d585a96d79da670481d1eeaf9e30b7574882b1a6eecffe` generation 3；
22 个来源、64 个绑定（旧 49 个加新 15 个），156/156 验证通过，15 个新绑定均可用。
旧通用/HST 索引未改写，历史 HST COSMOS 缺失绑定仍保留。
最初构建因把官方 rerun 字符串误验为 number 失败，活动指针未改变；已保留失败记录。

归档 bucket `asa-resource` 的 hard quota 10 GiB 已满，导致控制状态 PUT 返回
`Bucket quota exceeded`。确认实际对象 10,810,821,600 bytes、底层磁盘余量
634,339,958,784 bytes 后，只将该 bucket 配额提高至 20 GiB，保留全部对象和
workload 配置。原失败检查随后通过，native 控制镜像 generation 581 已 synced；
未清除历史任务。配额 receipt 和恢复时 `synced` 的核验分别为
`archive-quota-adjustment.json` 与 `state-sync-after-quota.json`。激活后的原生控制状态
现为 `native-units generation 775 synced`；管理 API 与网站状态
均确认活动 group 和 generation 3 一致。

实现为独立受管 `survey` SQLite，保留真实分区/原始 footprint、来源 SHA 和 selector。
GALEX 限定 AIS 与 GR7 两个已采齐 query，未采非 AIS GR6；JWST 限定上述两个目标，
不代表所有 JWST。复杂 MAST polygon 匹配仍为 conservative estimated。
Gaia interval 匹配为 exact，但 source-ID 位置及文件内容未独立科学校验，结果仍 estimated。
输入、217 份依赖的 staging SHA 核验及管理/部署日志位于仓库外
`/home/aaron/.local/share/astro-assets-deployments/dev/20261003-170800-native-surveys/`。
`/tmp/assets-dev-native-flow.py` 是 Dev 限定的受管续接脚本，复用已完成 import/build receipt。
live/public smoke 已确认 15 个新 binding、132 catalog layers、105 published MOCs、603 files，
2MASS MOC Range/SHA 和 11 项网站 HTTP 检查通过。最终 `npm run build`、390 项测试
（388 通过、2 跳过、0 失败）、Core wheel 校验及 Helm lint 通过。C01 浏览器 JSON/CSV
导出验收得到 9 条空间记录（DESI 1、ERO 5、Gaia 3），8 份 ERO geometry header 证据；
临时 `region:query` Key 已撤销并删除。导出报告、桌面布局截图与报告分别位于本目录下
`browser-exports-gaia-c01/` 和 `browser-layout/`；
1440px/1024px 均为 `max-height=none`、content 785px、无横向溢出或 JS errors。
revision 322 曾因 60 秒 startup probe 窗口不足重启一次；当前窗口为 120 次、每次 3 秒，
revision 329 两个 Pod 均 Ready、重启 0。
Euclid + Gaia 的 O8 overlap C01 曾把两个继续加载按钮撑至 2111px：抽屉宽 1008px，
隐式 auto grid 列却按 max-content 扩至 2163px。`.overlap-drawer` 已显式约束为
`grid-template-columns: minmax(0, 1fr)`；1440px 下按钮为 955px，1024px 下为 664px，
对应抽屉轨道 1007px/716px，均无横向溢出。
不要重采输入、不要改既有 immutable staging 路径，也不要更新 72602。

## Dev 来源入口与地域核验（2026-10-04）

本批部署使用镜像 `0.1.0-20261004-122022-regional-sources`、Helm revision 329；
site/backend 均 1/1 Ready、重启 0，实际 Pod image digest 为
`sha256:d0ca801c2ea601f9ee44b73032ee227c5fb2d3aaec0a178393a841cd5bbcd95e`。
`/healthz` 与 `/api/v1/status` 均 HTTP 200，公开 bundle 仍为
`reviewed-mupsxe2v-c91be91f`、603 files、SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`；活动原生 group
`e2a72cd78a10994462d585a96d79da670481d1eeaf9e30b7574882b1a6eecffe` 为 generation 3，
22 个来源、64 个绑定、156/156 checks，native-units 镜像 generation 777 为 `synced`。

使用短期 `region:query` Key 在真实 Dev 页面选择 Euclid + Gaia 并触发 O8 C01：
组件为 22 个 NESTED cells、约 1.154 deg²（RA 64.16–65.74°、Dec 27.28–28.80°）。
首屏显示 6 个空间分块，授权分页后 JSON 导出得到 7 个空间分块；CSV 为 40 行。
Euclid ERO 返回 IRSA 的 `ERO-Taurus` 目录入口，Gaia 返回真实
`GaiaSource_017019-017658.csv.gz` 文件，并保留 ESA/CDN77/CASDC 的同一逻辑文件来源：
西班牙 ESA 来源、CDN77 镜像、中国 CASDC 目录入口（HTTP 200）及目标目录（HTTP 404，
status=unavailable）。JSON 与 CSV 的 `access_uris`、`source_metadata` 逐项一致；未下载
科学数据。

1440px/1024px 浏览器检查的 document width 分别为 1440/1024，无横向溢出；继续加载按钮
宽度为 955/664px，client/scroll width 一致；页面错误和 console errors 均为 0。截图保留在
`/tmp/astro-assets-regional-sources-c01-1440.png` 与
`/tmp/astro-assets-regional-sources-c01-1024.png`。短期 Key 均在验证后撤销并删除，
当前没有遗留的 `codex-dev-regional-sources-*` 活跃 Key。

来源规则、验证状态和边界见
[巡天下载来源研究记录](docs/research/survey-download-sources-20261004.md)。ERO 的 ESA
TAR 仅作为几何/来源证据；用户可见的访问入口使用 IRSA target 目录。CASDC 根目录可用但
当前 Gaia/GALEX/Euclid-Q1 目标路径 404，故保留为不可用地域来源，不把它显示成可下载文件。
本轮 `npm run build`、392 项测试（390 通过、2 跳过、0 失败）、Core wheel 校验、Helm lint
与 `git diff --check` 均通过。

## Dev 来源状态展示续接（2026-10-04）

在 revision 329 的地域来源展示上继续部署 revision 331，镜像
`0.1.0-20261004-155016-site-role-warmup`，site/backend 均 1/1 Ready、重启 0，Pod
image digest 为 `sha256:26651a85944a9a27135bb321f048f1adcc476bd7164709a65c4cb1fadd50cd5f`。
site 角色不再尝试本地预热原生索引；该角色没有挂载 evidence PVC，查询由 backend 代理。
因此 site 的 `unable to open database file` 启动告警已消失，backend 原生索引继续正常打开。
发布 bundle 未变：`reviewed-mupsxe2v-c91be91f`、603 files、SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`。`/healthz`、
`/api/v1/status`、`/api/v1/coverage/catalog`、`/api/v1/assets` 与 `/atlas/` 均通过；
状态报告原生 group generation 3、managed/verified=true、reverse-lookup available，
覆盖 catalog 132 layers。FITS MOC Range 请求返回 HTTP 206、`Content-Range: bytes 0-2879/37440`，
`X-Content-SHA256` 与目录 SHA 一致；ZJLab 图标 HTTP 200。

Dev 页面实际选择 Euclid + Gaia 并查看 O8 C01：22 个 NESTED cells、约 1.154 deg²，
匿名预览首屏 6 个空间分块。来源项显示国家旗帜、地域、镜像关系和可用状态；状态包括
已核验、来源列出、规则推导、仅入口、不可用。1440px 桌面与 390px 移动视口均无横向溢出，
浏览器无 JavaScript 错误。C01 的 IRSA ERO 目录已核验 HTTP 200；Gaia 展示 ESA 文件、
CDN77 镜像和 CASDC 入口/目标目录，目标当前 HTTP 404 并标成不可用。独立的 Euclid Q1
VIS 反查样例为 component C09 / Tile `102070144`：保留 ESA 单文件链接，并列出 AWS
目录镜像 `https://nasa-irsa-euclid-q1.s3.us-east-1.amazonaws.com/index.html#q1/MER/102070144/VIS/`，
状态为规则推导；仅对 VIS 使用此规则，不生成归档包链接。

当时的 `zjlab.ico` 静态资源核验已通过，但 provider 标记按 Connector 名称识别 ZJLab，
且 absence 检查使用了 Assets workload namespace。配置的管理 namespace 实际为
`atlas-warehouse`，其中保留 ScanRequest/ScanBatchRequest。下方 revision 333 已以真实
扫描 run 或锁定 batch scope 关联 Connector，并统一采用其可配置图标；旧名称规则已移除。

下载链接暂不能通过管理页编辑。维护入口是 `server/survey-access.ts`，修改时应同时更新
[巡天下载来源研究记录](docs/research/survey-download-sources-20261004.md) 和对应测试；管理页的
原生来源/快照/索引绑定不是下载镜像规则编辑器。revision 331 的 backend 曾报告 Warehouse coverage
catalog 超过配置的 200000 文档上限并回退到仓库内公开几何；6 行 Warehouse layer metadata
仍已载入供 overlap evidence 使用。该限制已由下方 revision 332 修复；回退几何不代表完整扫描库存。

本次 `npm run build`、`npm test`（396 项，394 通过、2 跳过、0 失败）、Helm lint、
`git diff --check`、Dev rollout、桌面/移动浏览器检查通过；未更新 72602。site 新 Pod
启动期间出现一次 startup probe connection refused，之后两项 Deployment 均稳定 Ready、
重启 0。

## Dev Warehouse 覆盖与区域文件续接（2026-10-04）

Dev Helm revision 332，镜像 `0.1.0-20261004-201303-warehouse-geometry`，实际 Pod digest
`sha256:409bdd096be11b5c1c7124f97c620dfbff4ce5e26f64e2d1b38331823d0e6fb6`。
site/backend 各 1/1 Ready、重启 0。运行时日志与网站 `/api/v1/status`、coverage catalog
一致报告 `warehouseGeometry.status=loaded`、3 个图层、266,063 个唯一真实阶数像元、零失败；
单个 DESI 图层的 266,051 个 O8 像元已超过原限制。加载使用每页 10,000 的 ES composite
aggregation，只读取 `(layer, order, ipix)`，不在启动时载入文件关系。
`ASSETS_WAREHOUSE_COVERAGE_MAX_DOCS` 不再用于该加载流程。每层全部分页成功后才提交
新几何；失败层保留此前已核验扫描或已发布几何，成功层仍可用。全局或逐层失败通过
`warehouseGeometry.error/failures` 记录；天空 readout 与 component 抽屉可展开查看原因。
公开天空仍以已审核 MOC 为权威，本次未发布扫描几何或新的 MOC。

Euclid + DESI O4 C01 保持 `[190]`，6 个真实空间分块。改前区域文件结果为 0；现在认证
反查返回 1 个 `exposures-iron.fits` OSS 文件，保留原始 `sourceOrder=8/sourceIpix`、scanRunId
和 sourceSnapshotSha256。请求 O4 区域可查询真实 O8 子像元 `[48640,48896)`；只有 O4 的
扫描不补造 O8。该扫描是 exposures 汇总文件，未证明与 Tile 82406 的原生身份一致，故放在
“未归入空间分块的文件命中”辅助列表，不强行挂到 Tile。OSS 路径是扫描证据，不是公开下载 URL；
当时尚未关联配置 namespace 中的 batch；下方 revision 333 已通过其锁定 scope
识别为 `desi-dr1-spectro-oss`。
认证 API 的 pageSize=2 验收耗尽 19 页同一冻结快照，无截断，`inventoryComplete=false`。
ES 最后一页以额外 hit 判断是否继续，避免把全查询 hits.total 当作剩余条数。

国旗改为用户指定的 Icons8 CDN `<img>`，US/CN/ES/JP 使用各国圆形图标，未知地域使用 globe；
CSP 明确允许 `https://img.icons8.com`。图片加载失败仍保留地域名称与来源状态。
本批 build、404 项测试（402 通过、2 跳过、0 失败）、Core wheel、真实值 Helm lint、
`git diff --check` 与 11 项 live HTTP/Range/SHA 检查通过。
浏览器 Euclid + DESI O4 C01 已通过管理页 Key 解锁并分页加载辅助信息；页面展示该 OSS
路径，JSON 为 6 个空间分块加 1 个文件，CSV 为 38 行，两种导出的文件 URI、实际 O8 匹配
和扫描身份逐项一致。1440/1024/390px 均无横向溢出，抽屉 content 的 max-height 为 none。
Euclid + Gaia O8 C01 实际加载了美国、中国、西班牙国旗与未知地域 globe 图像，naturalWidth>0，
CASDC 目标目录仍标为不可用。通过仅拦截浏览器 catalog/details 响应模拟单层 HTTP 503，
天空 readout 和 component Warehouse 区域均显示失败图层、原因及保留覆盖提示；已有 C01
和 ERO-IC10 仍可查看。JS/console errors 均为 0；未改变真实 Warehouse 数据。
验收临时 managed `region:query` Key 已撤销并删除，receipt 为 `browser-key-cleanup.json`。
注意兼容的 Workspace shared key 可调用服务端反查，但不能用于浏览器 `/access/unlock`；
浏览器需使用管理 API 签发的 `asa_live_` Key。本机 snap Chromium 的自动化下载应显式使用
`/home/aaron/Downloads` 下的 downloads_path，避免其隔离的 `/tmp` 被误读为零字节下载。
公开 bundle 仍为 `reviewed-mupsxe2v-c91be91f`，603 files、105 published MOCs、132 catalog layers，
SHA 为 `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`；
原生 group `e2a72cd78a10994462d585a96d79da670481d1eeaf9e30b7574882b1a6eecffe`
generation 3、managed/verified=true。部署与 API receipts 保留在仓库外
`/home/aaron/.local/share/astro-assets-deployments/dev/20261004-201303-warehouse-geometry/`。
未更新 72602 或 Workspace。
## Dev Connector 图标与扫描文件来源续接（2026-10-04，已完成）

Dev revision 333，镜像 `0.1.0-20261004-215844-connector-icons`，Pod image digest
`sha256:8cdad6c1e1437f3727bb0b482a161bf41611256f0b0c9aff7c46a11198d2ca33`；
site/backend 各 1/1 Ready、重启 0。公开 bundle 仍为 `reviewed-mupsxe2v-c91be91f`、603 files，
SHA-256 `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`；
105 MOCs、132 catalog layers；活动 native group/generation 3 与 Warehouse 266,063 像元保持已核验状态。
本轮仅更新 Dev 的代码与 Connector 展示配置，没有新增科学输入或发布 MOC。

管理页“数据源 → 选择 Connector → 修改图标”支持 HTTP(S)/站内绝对路径、上传 ICO/PNG/JPEG/WebP
（最大 64 KiB）及恢复默认。创建连接也可提供可选 `iconUrl`。未配置时管理页与 overlap
共用类型图标；图片加载失败回退类型图标。认证接口为
`PUT /api/v1/admin/connectors/{name}/icon`，仅接收 `{iconUrl}`，`null` 恢复默认。
展示配置属于 Assets `connector-presentation-v1.json`，按 namespace/name/resource UID
关联现有 Connector；也支持 Warehouse 原生 AstroDataSource 的展示配置，连接 spec/凭据不改写。
修改图标保留既有探测与盘点状态。上传文件用公开、不可变的
`/api/v1/connector-icons/{sha256}` 地址按需读取，支持 GET/HEAD/ETag，保留历史图片供冻结 manifest 使用。
配置和图片共同通过 `connector-presentation` 业务状态归档；已核验远端 generation 5 为 `synced`，
snapshot SHA `f1080d520f282d011aadd36a3665aa865a7fd6a6be1496c3a42c01ffe832166c`，
3 个连接配置复用 1 个图标。原 ICO SHA
`f2d954082f595aba9027e1cdc840942dc4dfb717d75b7ebf99da31c81713fafd`，HTTP 读取与原文件完全相同。

已给 `euclid-q1-mer-catalog`、`desi-dr1-spectro-oss`、`desi-redrock-user-oss` 配置该图标。
运行时按文件本身的 coverage observations 关联 Connector：`scan-run` 要求 run 与 task 的
survey/release/product 匹配；`scan-scope` 要求 batch rule 的 scope ID、evidence layer、
scope SHA、partition count 与产品身份匹配。真实管理 namespace 为 `atlas-warehouse`，
现在读取其 19 个 ScanRequest、6 个 ScanBatchRequest 和 5 个 Connector；各资源读取失败独立处理。
不再从名称或路径前缀给来源贴 ZJLab 标签，也不把层级汇总当作区域文件命中。
关联冲突/缺失时保留原始 URI 与扫描身份，显示 Connector 未关联；连接已移除但有扫描依据时保留已知名称。

真实 Euclid + DESI O4 C01 `[190]` 返回 6 个空间分块、1 个辅助扫描文件
`exposures-iron.fits`，通过 batch scope 识别为 `desi-dr1-spectro-oss`。
真实 O8 `[163654]` 的 Euclid Q1 NISP-H 反查返回 Tile `102157301` 与 `102157302` 的关联文件；
用户所报 Tile `102157301`、file ID
`4f2b6faf096a6f05b4c1e3e3f010b7d5057e16761e53b804a2da016d51bc7114`、run
`batch-64efde111a14-nisp-h-f90ecf293d73` 明确来自锁定的
`euclid-q1-mer-images-20260924` scope，Connector 为 `euclid-q1-mer-catalog`。
文件名称与 OSS 原 URI 保留，run/hash/关联依据折叠展示；来源条目使用 Connector 图标、已扫描
与需授权标记。OSS URI 仍为内部来源证据，不能因图标或扫描命中而成为公开下载链接。
JSON 的 `connectors`、关联文件 CSV `file_observations`、辅助文件 CSV
`source_metadata.connectors` 保留同样信息；分页合并保留多来源 Connector。
新查询使用当前图标，既有冻结快照保留捕获时的图标 URI。

构建、413 项测试（411 通过、2 跳过、0 失败）、Core wheel、前端/服务端 TypeScript、
真实值 Helm lint 和 `git diff --check` 通过。管理页真实浏览器已完成 ICO 上传、恢复默认、重新上传、
刷新保留，且连接/探测/盘点字段逐项保持原值；图标 GET/HEAD/304 与 SHA 通过。
11 项线上页面/API/MOC Range/SHA 检查通过。真实 C01 浏览器看到 DESI Connector 图标，
JSON 导出为 6 空间分块+1 文件、CSV 38 行，Connector 元数据逐项一致；
1440/1024/390px 无横向溢出，抽屉 max-height=none，JavaScript/console errors 为 0。
附加的部署 UI 区域 payload replay 使用上述真实 O8 结果核验关联文件样式与图标；
它是显示层 replay，不作为该文件位于 C01 的几何证明。临时 region:query Key 已撤销并删除。
代码没有修改 Warehouse/Workspace；72602 未部署。凭据只在进程内使用。

本次部署与验证记录位于仓库外：
`/home/aaron/.local/share/astro-assets-deployments/dev/20261004-215844-connector-icons/`。
主要报告：`admin-icon-browser-report.json`、`connector-presentation-archive.json`、
`live-smoke-report.json`、`browser/browser-report.json`、`browser-repro-report.json`。


## 72602 独立部署（2026-10-03）

用户要求读取交接后在 72602 集群部署 Assets。目标为 SSH host
`72602-minipc-proxy` 的 `72602-minipc` 节点。沿用既有 Helm release/namespace
`astro-survey-atlas-assets-72602`、fullname `astro-assets-72602` 及 HTTPS Ingress，
由 revision 2 升级到 revision 3，镜像为 `0.1.0-20261003-131508-72602`。

该实例由旧的只读站点升级为 site/backend 分离部署。使用 local-path 的独立
content 4Gi、evidence 16Gi、upload-spool 4Gi，以及 site/backend 各 8Gi 发布缓存；
原 1Gi release PVC 仍保留。对象存储使用独立前缀 `environments/72602`，发布、
原生及状态 current 指针与 Dev 分别管理。恢复沿用已审核、归档且激活任务
`native-muqkwqqx-618baf65` 已完成的原生 generation 2。

从固定的公开/原生 authority 和 12 类状态快照恢复，共复制及逐对象完整 SHA-256
核验 1,103 个对象、1,382,665,497 bytes（1.288 GiB）。复制前后核对公开、原生、
产品、MOC、资源包及任务指针一致，来源任务均处于终态。冷启动恢复经独立 bootstrap
任务完成，实际后端 HTTP 确认 native managed/verified=true、reverse available；
公开网站随后通过相同版本及反查检查。公开 bundle SHA 仍为
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，
603 files、105 published MOCs、132 catalog layers；18 个原生来源、49 个产品绑定、
52/52 checks 和既有审核、归档引用均恢复。迁移 receipt 位于 backend 的
`/var/lib/assets-content/72602-deployment-migration-receipt.json`。

72602 尚无 Warehouse，`warehouse.elasticsearchUrl` 为空，status 明确报告
warehouse-evidence=unconfigured。公开覆盖和已恢复的原生反查可用；Warehouse 扫描、
文件级扫描证据和相关管理操作需后续接入。Helm schema 现允许空 ES URL，运行时
沿用已有未配置处理。管理及 API/LLM 凭据通过 Secret 配置，部署 values 保持在仓库外。

已通过 npm build、375 项测试（373 通过、2 跳过）、Core wheel 校验、Helm lint、
site/backend rollout、15 个网站 HTTP 检查和 2MASS MOC FITS Range/SHA 检查。
O4 DESI + Euclid C01 `[190]` 返回 DESI Tile 82406，ERO 缺口及不完整状态仍保留。
四巡天 O4 C02 `[637,639,725,958,959,1002,1003]` 的授权首屏及续页各返回 20 条
原生记录，首屏含四巡天，同一快照续页无重复；这是 40 条分页检查，尚未在 72602
重做 22,772 条完整导出。Dev 仍为 revision 319，health 的 bundle SHA 与文件数一致。

1440px/1024px 桌面浏览器检查通过 C01 抽屉、Swagger 和原生来源管理页：抽屉
top=68、bottom=1000、content clientHeight=405，DESI Tile 和 Euclid 缺少 7 个
target 映射提示可见；来源 18/18，无横向溢出，JavaScript errors=0。字体冷加载
仍有已知等待；第一次截图的默认 30 秒字体等待超时，延长截图等待后通过，
不据此宣称字体传输性能已解决。

部署配置和证据保存在仓库外的
`/home/aaron/.local/share/astro-assets-deployments/72602/20261003-131508/`，包括
`values-72602.json`、`migration-receipt.json`、`bootstrap.log`、`helm-upgrade.log`、
`smoke-report.json`、`browser-report.json` 和 `screenshots/`。远端 Helm 工具、chart
及 values 在 `72602-minipc` 的
`/home/aaron/.local/share/astro-assets-deployments/20261003-131508-72602/`。
完整迁移/HTTP/桌面验证 receipt 已在独立前缀的 `deployment/receipts/` 不可变归档，
标记 deliveryClass=evidence；对象 key、SHA 和大小见本地 `receipt-object.json`。

## Workspace 第二阶段 MVP（2026-10-03）

用户已授权实施第二阶段、部署 Workspace Dev 和真实下载验收。公开原生数据仍由
Assets 持有；Workspace 使用服务端 Key 临时查询，沿用冻结快照/cursor，不新增查询
会话资源。第二阶段没有更新 Assets 的 bundle、MOC 或活动原生索引。

Workspace 已实现无状态文件预览、显式勾选/确认、任务下载及 Connector 注册。
桌面先选择已返回的原生分块，默认每巡天一个，可从前 128 个中增加；改变分块选择
清空旧文件预览和勾选，完整区域及反查/导出分页不受限制。
同一快照重新校验后才能创建任务；持久化例外仅限用户选定的最小文件清单与进度，
重试复用审批集合，不追加新发现文件。CSST 私有覆盖、身份、映射和父目录留在
Workspace，不进入 Assets 请求、日志、仓库或归档。

真实 DESI、Legacy 和 HST FITS 下载完成，大小、磁盘 SHA、FITS 可读性与 Connector
已独立核验。HST 下载后登记资产并独立扫描生成真实 O10、estimated 用户 MOC，
父目录反查已通过。Euclid 当前候选约 1.47 GB，超过默认 512 MiB 单文件上限，
未开始该文件的科学传输。第二阶段成功不替代本文件下面的 ERO C01 映射缺口。

1440px 四巡天与用户覆盖的完整页面/JSON/CSV 核对保留 9,056 个公开记录和
3,893 个直接父目录，三者一致；分页配额等待后继续同一快照。Workspace revision 67
线上 synthetic 桌面检查 4/4；revision 66 完整基线 338 项中 336 通过、2 跳过、0 失败。
67 的 1024px 真实文件预览用 25 个公共产品层，从首屏 100 个原生分块中默认选四巡天
各一个，约 15.3 秒返回 92 个文件候选；全部未选，没有创建下载任务，快照/完整区域
一致，无页面错误或横向溢出，仍保留 selectionTruncated/inventory.truncated。
此前一次解析全部 100 分块在 450 秒内未返回；没有据此宣称大批量解析性能通过。
这次 25 层预览与上述 14 层导出是不同选择。28 个资源包（6 个已安装）
的版本/活动选择与原有用户资产身份均保持；新增的真实验收产物保留在 Workspace。

完整实现契约和实际验收记录位于相邻 Workspace 仓库的
`docs/download-plan-workflow.md`、`docs/api-reference.md` 和
`docs/phase2-mvp-verification-20261003.md`。后续先收集用户桌面反馈，再扩大组件范围。

## ERO C01：72602 补齐与 Dev 后续纳管

2026-10-03 用户要求继续补充巡天数据，优先 ERO，并去掉
`.overlap-drawer-content` 的 `max-height: 405px`。72602 已部署该样式变化；
1440px/1024px、1000px 高度的浏览器检查为 `max-height=none`、内容高度 785px，
无横向溢出和 JavaScript errors。随后通过官方包内 FITS 头补齐全部 17 个 ERO target，
原来的 7-target 空间映射缺口在 **72602** 已解决。2026-10-08 管理 API 只读复查确认，Dev
generation 13 的 ERO 活动输入也已是下述 snapshot、17 rows；“Dev 仍保留旧缺口”已过期。
下文 10-row 输入和 C01 缺口只作为旧快照的历史记录，不是当前 Dev 状态。

ERO 新输入从官方 XML 明确列出的 34 个 VIS/NISP Stack 包采集 85 份头文件，
仅请求 tar 头和压缩 FITS 头前缀、解码至 END 头块；未获取完整科学包或像素。
322,560 bytes 的包范围请求提供 ICRS/TAN WCS、各自 VIS/Y/J/H/Chi2、成员身份和 SHA。
85 个 frame 与 Astropy 独立核对，最大差 `5.684341886080801e-13` 度。
反查使用产品对应波段，保存 `geometryEvidence[]`，CSV 保存 `geometry_evidence`。
仍为 estimated frame bounds：有效像素、权重孔洞及 catalogue 对象范围未核验，
原生身份仍是 target，没有核实 Tile 清单，`inventoryComplete=false`。

锁定输入 SHA `199538862e494dbb037169346744927c40ab70f0ea70f7ef2b3f329ebc7b268d`，
1,249,141 bytes；受管 snapshot
`6b11e9c027fa1e2c744cea62f4afd87b1f0addda3da1166f1c3eec882591bd2d`，
source revision 2。import `native-mus1n4g9-5e9741aa`、build
`native-mus1n7mg-447fee76`、640/640 archive `native-mus1nifn-e2da5237`、activate
`native-mus1nldt-e2073f9d` 均完成，激活任务通过运行时及网站 HTTP 核验，generation 3。
CDN 证书时间校验失败的显式例外保留在采集 receipt 和已接受审核缺口中；CA 链及
hostname 仍验证，没有禁用运行时 TLS。科学库存、Q1 范围和 HST 旧缺口仍如实保留。

72602 O4 C01 `[190]` 现显示 DESI Tile 82406 和 ERO-IC10 的 color/VIS/Y/J/H
共六个产品空间记录，已移除“缺少 7 个 target”提示。此有限查询
`queryExhausted=true`、`resultTruncated=false`，而 `inventoryComplete=false`；
匿名 supporting 预览上限仍可使外层 truncated=true。15 个网站 HTTP 检查及两种桌面
宽度通过；四巡天 C02 验证仍是首屏/续页各 20 条，不是新的完整导出。

实现证据及边界见
[ERO FITS 头补充报告](docs/research/euclid-ero-fits-header-supplement-20261003.md)。
输入和管理 receipt 在仓库外
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-ero/`，
发布/HTTP/浏览器验证在
`/home/aaron/.local/share/astro-assets-deployments/72602/20261003-145758-ero/`。

### 旧 Dev 快照的 C01 缺口（历史基线）

用户点击的是 O4 C01、cell [190]，面积 13.4287 deg²，
RA 0–9°、Dec 57.3995–63.4483°。当前公开覆盖图命中 Euclid ERO 与 DESI，
但冻结的 ERO 原生映射在此区域没有命中：

- 空间分块只有 DESI DR1 Tile 82406，estimated，URI：
  https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/82406/20211118/ 。
- spatialPage.shown=1、hasMore=false；不是首屏或分页隐藏了 Euclid。
  辅助信息还有自己的分页，混合 omitted 数量不是剩余 Tile 数量。
- Euclid 的 source identity、覆盖依据和官方入口仍保留；页面已提示尚缺 7 个 target
  的空间映射，JSON/CSV 也保留这一缺口。快照为
  queryExhausted=false、inventoryComplete=false、resultTruncated=true。
  分页耗尽与库存完整性必须分开表达。
- **问题属于覆盖 MOC 与原生空间映射的完整性缺口，该组件的 MVP 尚未完成。**
  不能用 Q1 C04 的结果替代这个 ERO 场景的解释或验收。

ERO 当前锁定快照 ID 为
0a6b254384f5082dab056b81f98751805f68ca890c5cfb51da01f1f0941e32e3，文件 SHA-256 为
7f8b99523c7b3a07a9a3c6b5c1dcd9f40d80ed6b4ce2c8970a5c97467af3e323，共 10 条关联记录。
原 8 个排除 target 中，Messier78/M78 别名关联问题已修复；其 ESA Sky outreach footprint
命中 O4 cell [1429]，precision 为 estimated，不在 C01。仍有 7 个 target 没有从已核查的
官方 outreach 表找到可验证 footprint：Barnard30、Taurus、NGC6254、HolmbergII、IC10、
NGC2403、Fornax。这个结论仅限定于已检查来源。

Messier78 在 ESA 表中有 M78/M78_HighRes、object_name 为 Messier 78 nebula，
该明确别名已按来源关联规则纳入索引。IC10 的官方 XML 已有 VIS/NISP Stack/Catalog 包链接，
但当前 outreach 表没有可核实的 IC10 footprint；链接或天体中心不构成区域映射。
只读检查的 images.euclid_outreach 与 images.mv_euclid_outreach_fdw 都为 19 行，
images.mv_euclid_outreach_ext_fdw 为零行，未因此获取或激活新快照。

ERO 原生身份是 target；没有核实的 Tile inventory。继续补关联时仍需核实 footprint
与产品范围，不能编造 Tile 或以点坐标替代影像足迹。本次没有可靠 geometry 能确定
C01 应命中哪个 target，也没有据此增加空间单元。

公开诊断证据（临时文件，可能被系统清理）：
/tmp/assets-c01-details.json、/tmp/assets-c01-reverse.json、
/tmp/assets-c01-browser-before.log、/tmp/assets-c01-before.png、
/tmp/assets-mv_euclid_outreach_fdw.json。

## HST 有界补充及最终 72602 验证（2026-10-03）

保留原来的 2026-10-01 CAOM 输入（1,201,094 行、601 页，SHA
`d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`），
组合 20 个实际捕获的新分页、39,187 行。上游总数现为 1,201,187，净差 93 不能当成新增
observation 数；分页顺序和重复身份与旧输入不同。逐身份比较得到 **7,266 个新增索引
observation**，总数从 916,116 到 **923,382**。独立 SQLite joins 确认旧身份和原始索引
记录均零丢失。输入的 1,240,281 是两批证据行之和，含重复，不是新全量库存数。

慢速全量 acquire `native-mus2a19c-dbc4f7ed` 已通过 API 取消，没有遗留的自动激活任务。
采用 schemaVersion 2 / bounded-supplement，保存旧 manifest 原字节/日期及新页实际号、
query、上游总数、哈希和捕获范围，不能重编号或宣称完整当前刷新。新 manifest SHA
`65abc912ef79ec923156742fa8d082e2759ee5eb3794e7f18431f58272ea1897`，5,925 bytes；
受管 snapshot `d68f139b7b6c648fad76c1d08755957f11df6970ce5f3e549cebc79315e53a2a`，
source revision 2。隔离复制已安装 v4 SQLite 再合并，旧索引保留。

import `native-mus31wr4-3e2a5e68`、build `native-mus322bm-d922d3bf`、archive
`native-mus32h8t-b1948674`（661/661 依赖）、activate `native-mus32zi3-f00fe5ff`
均完成，runtime/site HTTP 验证通过，活动 generation 4、138/138 checks。
HST 不可解析行从 18 到 19，已接受 `hst-partial-refresh`；旧 COSMOS obs 26442812 的
缺失绑定仍保留。页面/JSON/CSV 说明历史输入日期/SHA及补充范围，inventoryComplete=false。
公开 bundle/MOC、通用索引及 ERO 17 个目标/85 个头均保持，Dev/Workspace 未更新。

最终镜像 `0.1.0-20261003-153818-hst-supplement`、Helm revision 7，site/backend 各
1/1 Ready。npm build、382 项测试（380 通过、2 跳过、0 失败）、Core wheel 和 Helm lint
通过。15 个 HTTP 检查重验 ERO C01 和四巡天 C02 首屏/续页各 20 条；仍未重做完整
四巡天 component 导出。新增 ACS obs 97287786（O8 cell 121713、12 records/1 page）和
WFC3 obs 199602393（O8 cell 13801、114 records/2 pages）的网站反查保留原始 s_region、
estimated、相同快照和官方 MAST Products API。已从锁定输入核实旧身份缺失；“before”
网站请求实际晚于激活，未用作激活前证据。

C01 实际浏览器 JSON/CSV 下载核对通过：6 条空间记录、5 个 IC10 产品关联、8 个
头证据引用，原始 polygon/各自 SHA 一致，inventoryComplete=false，JS errors=0。
最终镜像的 1440px/1024px 检查均为 max-height=none、contentHeight=785px，抽屉
top=68/bottom=1000，无横向溢出，DESI 82406 和 IC10 可见，旧 7-target 提示已移除。
混合 page 的 hasMore 仍可来自 supporting 预览，不能当成剩余空间单位。最初 0-byte
下载属于 Snap Chromium 默认临时目录隔离；指定共享下载目录后通过，没有更改应用导出代码。

数据/receipt 在仓库外 `/home/aaron/.local/share/astro-assets-survey-supplements/20261003-hst/`；
部署证据在 `/home/aaron/.local/share/astro-assets-deployments/72602/20261003-153818-hst-supplement/`。
详情见 [HST 补充报告](docs/research/hst-bounded-supplement-20261003.md)。

## 已部署修复与已完成计划

| 项目 | 当前状态与限制 |
| --- | --- |
| 原生天空分块纳管 | 已实现来源/快照/候选增量索引/产品绑定/验证/审核/归档/恢复/CAS 激活及管理 UI/API。18 来源、49 绑定；Dev generation 2 为 52/52 checks，72602 generation 4 为 138/138，已逐项接受当前实际范围缺口。后续补数据沿用此流程。 |
| 原生管理 UI | Assets 316 已按巡天分组并折叠来源详情、整理索引摘要。1440px/1024px 桌面检查覆盖总览、18 个来源与筛选、ERO 来源操作、17 个任务、审核和激活；无横向溢出或浏览器错误。截图：`/tmp/assets-native-admin-316/`。 |
| HST 请求超时 | 普通及重合反查已共用锁定的本地 CAOM SQLite v4；Assets 请求期间不访问 MAST。 |
| HST 错误跳转 | 313 已将无效 Portal searchQuery=obsid 链接换为 Mast.Caom.Products API 链接。用户打开后看到 MAST 的 JSON 产品清单；不是 Portal GUI。obsid 24125502 实查 HTTP 200、32 products。 |
| C04 授权首屏只有 DESI | 314 已将新快照按巡天交替排列，授权 manifest 页返回独立 spatialPage/supportingPage；旧快照沿用旧排序以兼容续页。这个修复不补齐 C01 的 ERO 映射。 |
| Legacy DR10 South | 官方 366,912 个 roster 成员已全部索引；北区保留 DR9 North 身份，尚无权威 DR10 North roster/Coadd/Tractor tree。 |
| 数据模态 | Legacy DR10 color imaging 已经产品 revision 6 审核发布纠正为 imaging；其他产品尚需系统性复核。 |
| 首页与介绍材料 | 首页文案已更新；intro-edits.zip 已审阅并按四巡天及完整组件契约合并 Assets README。独立组织仓库未修改，outreach 未发送。 |
| 公开 API 页面 | /api-docs/、Swagger/OpenAPI、/api/v1/status 与指定 survey/order 的 HEALPix 分页 API 已实现。Assets 318 为兼容旧客户端保留无参数 `/api/v1/coverage` 全量响应，并支持按完整产品 footprint 分页；Swagger 默认 `pageSize=10`。管理员发 Key、region:query 鉴权及每分钟 30 次配额已实现；onlineBilling=false。 |
| 控制状态归档队列 | 312 已修复最新指针被旧快照整批上传阻塞的问题；最后检查原生控制 generation 370、发布任务 2623、API 管理 238 均 synced。565 个旧快照排队是该次历史检查数，本次未重测队列。 |
| Agent 设置 | .codex 主模型、默认 subagent、review model 和 builder 均已改为 gpt-6.1-sol。 |

归档、恢复、激活和无变化构建已经完成，续接时不要重新接管当前基线：
归档任务 native-mupvp914-33d3866c 完成 640/640 依赖；
restore 为 native-muq0vy0w-c1d3e07f；
激活 native-muq0zbfr-9dcb6278 已 completed 且通过运行时/网站 HTTP 验证；
native-muq141z5-18e90874 的 acquire/build 返回 noChange=true，索引哈希保持不变。
细节见 [原生分块管理流程](docs/native-unit-management.md)。

## 当前界面状态

Assets 315 已完成 C01/C02 反查桌面验收；Assets 316 保留这些主流程并部署原生管理页改版。
空间 cursor 耗尽后，缺口提示显示没有原生
映射的 survey/release、模态、官方入口及已核实的 ERO 关联缺口；提示不计入空间分块数。
页面、JSON、CSV 三者保留同一条 DESI Tile、Euclid ERO 来源和不完整状态。

Assets 319 的 Dev 基线将桌面 overlap drawer 固定在导航栏下方并延伸至视口底边；
当时内容 viewport max-height 为 405px。72602 已按本次用户要求移除该上限，
由 grid 剩余视口高度确定内容区，保留内部滚动。旧 Dev O4 C01 `[190]` 检查于 2430×1151：
drawer top=68、bottom=1151，content clientHeight=405、scrollHeight=1532；DESI Tile 82406、
Euclid 缺少 7 个 target 映射提示均显示，browser errors=0。截图：
`.tmp-screens/deployed-overlap-drawer-c01.png`。本次没有补造 ERO footprint 或修改缺口状态。

原生来源管理 UI 按巡天分组、逐来源折叠，并把索引状态显示为摘要指标。316 桌面检查
覆盖总览、来源筛选和详情、任务、审核、激活视图；1440px 与 1024px 均无横向溢出，
浏览器错误为 0。桌面截图保存在 `/tmp/assets-native-admin-316/`。

Assets 分支 main，本次部署时 HEAD `84a38d8`
（feat(api): implement paginated coverage footprints endpoint with cursor support）。
72602 部署开始时工作树干净；本轮修改为 Helm 的可选 Warehouse URL schema、values
注释及交接记录，完整清单以 git status --short 为准。历史实施和 ERO 审计文件保留；
本轮没有提交或暂存这些修改。
Workspace 第二阶段实现与文档修改均保持未暂存，实际清单以该仓库 git status 为准；
本轮没有提交、整体暂存、重置或清理任何仓库修改。

## 验证范围：不能扩写为全局完成

| 版本与场景 | 已验证内容 | 实际范围 |
| --- | --- | --- |
| Assets 72602 revision 3，独立恢复与网站验证 | site/backend 均 1/1 Ready；1,103 个对象完整 SHA 核验；12 类状态恢复；15 个 HTTP 检查、MOC FITS Range/SHA、1440px/1024px C01 抽屉与 18 个原生来源管理页、Swagger 均通过，JavaScript errors=0。四巡天 O4 C02 首屏/续页各 20 条，首屏含四巡天，同一快照无重复。 | bundle 为 603 files / 105 published MOCs，native generation 2。C01 ERO 缺口与 C02 不完整库存状态保留；分页检查未耗尽完整导出。Warehouse 未接入，Dev 仍为 319。 |
| Assets 319，Dev rollout 与 DESI + Euclid O4 C01 `[190]` | Helm revision 319；site/backend 均 1/1 Ready。全屏抽屉从 y=68 到 viewport bottom，405px 内容区可滚动；Tile 82406 和 Euclid 缺少 7 个 target 映射提示均可见，无页面错误。`/healthz`、`/api/v1/status`、`/api/v1/assets`、`/api/v1/coverage` HTTP 200；coverage 响应 639,433 bytes。2MASS H-band MOC FITS `Range: bytes=0-15` 返回 206、16 bytes，SHA 与 manifest 一致。 | bundle 未变：reviewed-mupsxe2v-c91be91f，SHA `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，603 files。C01 的 ERO 缺口仍存在；本次仅部署代码。截图 `.tmp-screens/deployed-overlap-drawer-c01.png`。 |
| Assets 318，Swagger `/api/v1/coverage` | 无参数旧响应保持 132 footprints / 639,433 bytes；`pageSize=10` 返回 10 条完整 footprint，cursor 可续页且 revision 相同。Swagger 实际发送 `?pageSize=10`，响应 JSON 正常显示，桌面 Chromium browser errors=0。 | 服务端旧响应约 17 ms；故障在 Swagger 渲染大响应。O4 overview footprints 不是原生 Tile/brick/observation 清单。 |
| Assets 315，DESI + Euclid O4 C01 [190] | 桌面页面、JSON、CSV 一致：DESI DR1 Tile 82406 一条空间单元；Euclid ERO 官方来源/覆盖依据保留，缺少 7 个 target footprint 映射提示可见；page errors=0。 | 空间页 hasMore=false，但 queryExhausted=false、inventoryComplete=false、resultTruncated=true；C01 原生映射仍不完整。 |
| Assets 315，四巡天 O4 C02 [637,639,725,958,959,1002,1003] | 桌面完整导出 22,772 条空间单元，页面 DOM、JSON、CSV 逐条一致，四巡天均有结果；7 次 Key 限流等待后在原快照续接成功，page errors=0。 | hasMore=false 只表示本次分页已耗尽；快照仍 resultTruncated=true、queryExhausted=false、inventoryComplete=false，并保留 HST/DESI/Legacy 来源范围与缺口。 |
| Assets 315，四巡天 O4 C01 [483,486,487,498]、C03 [787,790]、C04 [1944] | 匿名首屏预览，各区域均有下一页。 | 未耗尽分页，不据此推断未显示的巡天没有命中；C04 的 875 条是先前 DESI + Euclid Q1 选择。 |
| Assets 316，原生管理 UI 桌面 | 1440px/1024px 检查总览、18 个来源/筛选/ERO 操作、17 个任务、审核和激活视图；无横向溢出、浏览器错误为 0。 | 管理页验收不替代用户对 C01/C02 公共反查主流程的确认。 |
| Assets 314，DESI + Euclid C04 | 完整 O4 七 cells [637,639,725,958,959,1002,1003]，约 94 deg²；匿名 6 项与授权 20 项都有两巡天，续至 50 项无重复；完整页面/JSON/CSV 875 native records 逐条一致，CSV 二次导出额外分页 0。 | Q1 场景；875 是 layer/unitKind/unitId 记录数，不是唯一 Tile 数，不适用于 C01。 |
| Assets 314，DESI + Euclid + HST C04 | 全新桌面浏览器的匿名 6 项与授权 20 项首屏均有三巡天、续页可用、page errors=0。 | 首屏检查，未在 314 重做三/四巡天完整导出。 |
| Assets 311 / Workspace 62，固定完整 O4 七-cell 场景 | Assets 的 11 组合与授权流程记录 22,772 native records；Workspace 的 14 个公开产品层返回 9,056 native records，附 3,893 个直接父目录且 directoriesTruncated=false。页面/JSON/CSV 相符，版本固定，CSV 二次导出额外分页 0。 | 历史固定区域基线，不能证明全部 component 或全巡天 inventory 完整；Assets/Workspace 所选产品分别为 20/14 层。 |
| 311/62，公开 HEALPix API | O4 Euclid 44、DESI 1,385、Legacy 2,247、HST 2,262 个唯一 cells；分页、422/409/400 和配额等待续接通过。 | 已发布 MOC 的像元列表，与原生单位库存完整性独立。 |

Assets 319 的 `npm run build`、`npm test`（375 项：373 通过、2 跳过、0 失败）、
Helm lint（1 chart、0 failed）、revision 319 site/backend rollout、`/healthz` 与 `/api/v1/status`
检查均通过。`/healthz` 为 HTTP 200，
`/api/v1/status` 报告活动 native generation 2、managed/verified=true，public bundle 为
603 files / 105 published MOCs。此前 Assets 370 项/Workspace 308 项属于较早代码测试基线，
不是当前镜像的完整测试结果。辅助 `admin-browser-smoke.py --workflow` 曾因定位隐藏的
发布记录按钮超时；同一批管理视图已通过手动 Playwright 桌面检查。

关键日志：/tmp/assets-euclid-pagination-main-flow.jsonl、
/tmp/assets-three-survey-first-page.log、/tmp/assets-three-survey-first-page.png、
/tmp/assets-managed-active-assets-desktop.log、
/tmp/assets-managed-active-workspace-desktop.log、
/tmp/assets-managed-active-healpix.log、/tmp/assets-managed-active-stream-perf.log。
assets-euclid-pagination-desktop.log 末尾有一次追加三巡天驱动失败；
成功的两巡天结果已摘出为 main-flow.jsonl，成功三巡天另用全新浏览器验证。
私有响应、导出和偏好仅在内存中使用，保存的 Workspace 证据只有汇总。

## 历史性能基线与验收限制

当前待办统一见本文顶部“待做清单（2026-10-08）”。第一阶段 MVP 已结束，旧的 MVP 等待确认
步骤及“Dev 仍保留旧 ERO 快照”不再作为当前接续条件。

历史固定场景的性能基线为激活后的 Assets 首批 4.437 s / 完整查询 20.189 s，
Workspace 首批 4.692 s / 完整查询 33.495 s，geometry 冷 12.376 s /
复用 0.560 s。这些不含后续全部分页导出和 Key 配额等待；
50/87 秒等早期数字留在历史记录，不是当前基线。
扩充 Legacy 前先评估流式或增量构建，历史接近 4 GiB 的冷构建峰值未 OOM，
不应仅凭峰值扩容。

## 原生库存及链接仍有哪些限制

| 来源 | 当前范围及剩余工作 |
| --- | --- |
| Euclid Q1 | 仅锁定 BGSUB 清单 2,908 行、352 Tiles；不是完整 Q1。72602 的 ERO 17-target 映射已补齐，仍无核实的 Tile/有效像素库存；Q1 不能替代 ERO。 |
| DESI | DR1/EDR Tile 是 estimated 候选，不是目标级光谱覆盖。用户部分 OSS 中 904 redrock 已扫描；约 904 spectra 压缩文件和 12,855 coadd 未扫描，也不代表完整 BGS/DR1。扫描走 Assets → Warehouse 标准任务。 |
| Legacy | DR10 South 366,912 个成员、Coadd 363,328 个正曝光候选；DR9 North roster 93,548 bricks。没有权威 DR10 North roster/产品树，不能从 all-sky grid、合并 Tractor 或 PSC 推断。DR5–DR9 URI 规则与所有代的逐文件存在性未全部核验。 |
| HST | 72602 保留旧 1,201,094 行输入并补 20 页/39,187 行，923,382 observations，排除 19 行，属于有界补充而非完整当前刷新；Dev 仍为 916,116/排除 18。复杂 footprint 使用保守候选，precision=estimated，原始 s_region 和两批来源保留；Products API 链接不等于本地逐文件库存。 |
| HSC | 保留 tract/patch 和需登录 DAS Search，文件存在性/直链尚未确认；不扩入第一阶段四巡天范围。 |

HST 与 Legacy 来源补查结论见 [HST footprint 审计](docs/research/hst-unindexed-footprints-20261001.md)、
[HST 补查](docs/research/hst-footprint-supplement-20261001.md)、
[Legacy North 补查](docs/research/legacy-north-source-supplement-20261001.md)
及 [原生 URI 调研](docs/research/native-block-access-uris.md)。

## 历史存储盘点与暂缓事项（2026-10-01）

公开清单和两份 SQLite 的安装/恢复位置是 Assets evidence PVC；
当时的受管输入与索引已按 authority 归档。两份库分别是通用 native source-unit
索引（Legacy/DESI/Euclid Q1/HSC 等）和 HST 专用 observation/footprint 索引，
不是两个重复库。ERO 使用锁定的 target 元数据。
用户偏好统一 SQLite，但明确“先这样”；统一库暂缓。

以下为 2026-10-01 的历史迁移盘点，不能用于当前 Dev generation 13 的容量或搬迁估算；
当前 Dev 实测容量及待完成的引用清单见 [Dev 存储规划](docs/storage-plan-dev-20261007.md)。

当时的权威对象盘点：native 去重依赖加指针/manifest 为 943.69 MiB，
public 为 155.43 MiB，合计 1,152,509,295 bytes / 1.073 GiB。
加业务状态/其他证据的旧估算后，生产首次迁移约 1.26 GiB，可按 1.3 GiB 理解；
业务状态尚未重新冻结，不能当作精确复制清单。原始输入与两份索引恢复后约 2.904 GiB。
旧索引 2.10 GiB 备份、历史发布及 site/backend 的可重建 release 缓存不计搬迁。
详见 [存储盘点与生产迁移口径](docs/storage-inventory-20261001.md)。
旧的 3.25 GiB 估算是压缩归档前口径，当前不应直接引用。

既有 MOC 探索/LLM 可选增强已实现，见
[MOC 探索增强文档](docs/moc-discovery-enhancement-design.md)；
历史末尾“尚未实施”的旧描述已过期。
历史的 catalog ETag 和旧包 allowlist 问题在当前代码已有响应哈希及当前包白名单处理；
本次仅静态核对，未重跑发布测试。相关发布实现变化时再验证，不作为本轮新发现的未修复问题。

## 续接步骤与持续边界

1. 读本文件、git status --short 和 [MVP 契约](docs/four-survey-mvp.md)；
   修改相关代码前按 AGENTS.md 读取 coverage workflow 技能和
   [覆盖流程](docs/coverage-workflow.md)。
2. 开始补来源/快照/索引之前读 [原生分块管理流程](docs/native-unit-management.md)，
   从系统取得当前活动输入和缺口报告，优先处理 P0；支持的操作用管理 UI 或认证 API。
   新格式可以补采集/适配代码，但暂存元数据先导入系统，活动索引不原地覆盖。
3. 分别记录代码构建/部署、产品元数据发布、原生候选激活和实测场景。
   全部依赖归档并且激活任务通过 runtime/site HTTP 后才报告新版本 active。
   每个结论写清实际 region、版本、分页/库存状态，不以单一成功场景外推全部天空。

Assets 拥有公开 MOC、原生索引、证据及反查快照。
Workspace 只同步公开图层/几何包，API Key 只发送公开 layer IDs、order/cells、
公开单元身份及游标/快照选择器；
公开原生反查响应只在请求/浏览器内存使用，不存入 Workspace 的后端、缓存、
制品、配方或日志正文。用户确认后的下载任务可持久化所选文件的最小来源清单及进度，
不保存原始响应或未选候选，重试不追加文件。CSST 私有扫描、覆盖、分块映射和直接父目录只在 Workspace；
本仓库不记录其身份、路径或像元，不将其送入 Assets。
Runtime ES 只连接配置的 Warehouse；input manifests、normalized scans 和 task
snapshots 属于 evidence，浏览器初始请求只取汇总/引用。
下载计划是来源清单，Assets 不代用户下载科学数据；
保留 ICRS/NESTED、真实 order、输入哈希、exact/estimated/entrypoint-only/truncated，
根据来源实际证据展示身份和链接。

部署前阅读 deploy-astro-assets-k3s 技能。其旧 deploy/k3s-values.yaml 引用当前不存在，
此前用 Helm release 已有 values、reuse-values 仅覆盖 image.tag；需先核对实际配置。
凭据使用已有 Secret/管理会话，不复制此前用户贴出的 Cookie，不写日志或文档。
