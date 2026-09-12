# Assets：S3 唯一权威实施计划

日期：2026-09-12。状态：**authority 位置已确认；P1 公开 hydrate 可用；P2/P3 仍有必须修复的缺口；P4 workflow 未达验收；P5 线上切换未开始；P6 文档同步中**。
本文同时保留目标约束、科学语义边界和本次已验证实施记录。生产 S3 对象未删除，扫描、MOC、Resource Package 和覆盖精度语义未改变。

## 实施记录（2026-09-12）

- 生产 authority 不是当前 Helm 部署使用的 `storage/minio` 公开桶。本地 gitignored `.info` 描述的 MinIO 才是已确认的 authority；凭据不得写入仓库、日志或文档。
- 对 `.info` MinIO 的只读 LIST/HEAD 发现根前缀：`authority/`、`authority-content/`、`authority-probe/`、`content/`、`evidence/`、`public/`、`repo-evidence/`。物理指针键：

  | prefix | 物理指针 | snapshot | files | bytes |
  | --- | --- | --- | ---: | ---: |
  | `authority` | `authority/evidence/current.json` | `b5be3ff04a8baf6b7516ef5a45800238730a37cc740d27e16a308af418f49ff3` | 468 | 104,141,186 |
  | `authority-content` | `authority-content/content/current.json` | `7abda54ff00eb14d4a9562d7bd4b99663c90d80b24af3d36862b2c67711a4519` | 4 | 854,957 |
  | `authority-probe` | `authority-probe/evidence/current.json` | `f532707a285fc407926830c255d4bd36242f70179ffe5d281846604182890526` | 1 | 4,873 |
  | `repo-evidence` | `repo-evidence/evidence/current.json` | `9ffec99fbb30995f5bb7af6878e878c1050f02acebd0478700457e9df3155b69` | 250 | 239,337,574 |

- 指针 JSON 形如 `{schemaVersion,namespace,snapshot,files,bytes,updatedAt}`；`files` 是计数。快照清单在 `<prefix>/<namespace>/snapshots/<id>.json`。`authority` 清单路径相对 artifact 根（`layers/`、`packages/`、`csst/` 等），恢复目标是 `$RUNNER_TEMP/authority-test/artifacts/public-survey-footprints`。`authority-content` 恢复到 content 根，不是 artifact 根。
- 当前 Helm release 的集群 MinIO 仍只暴露 `public/current.json`，是线上公开 release 消费者，不是 authority 复现源。P5 必须把线上消费者切到 `.info` 所描述的生产桶，而不是在集群公开桶里寻找 authority 指针。
- 校验完成后，仓库中的生成 release、layer、raw、content、probe 和 staging 副本才被删除；生产 S3 对象未删除。
- 已落地但**不能勾选完成**的部分：P1 公开 hydrate（Helm 公开桶，release `public-survey-footprints-2026-09-09`，manifest SHA `adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`）；spool/state snapshot 骨架；hydrate-first workflow 草稿。
- 继续推进前必须修的缺口：spool 重复入队会删已有 job、crash 窗口毒化 worker、已 uploaded job 未 reconcile 就被清理、state/release 指针无 CAS、损坏本地状态覆盖 S3、入队失败丢 payload、API 把仅本地写入当成功、workflow 仍用缺文件容忍且未接 `.info` authority。

## 1. 唯一目标和验收定义

生产 S3 是 Assets 业务数据的唯一权威。所有已上传数据及其恢复所需的目录、版本、元数据和状态都必须能从 S3 恢复。其他地方只能有下载缓存、计算临时文件和明确标识的待上传数据。

最终验收：在没有 Assets 数据的新环境中，只提供代码、配置和生产 S3 凭据，即可恢复指定版本的资源包下载、发布列表、已同步的编辑/发布状态及天球展示；文件 SHA-256、DR 归属和覆盖语义与基线一致。

未上传的数据无法从 S3 恢复，这是唯一明确例外。用户接受其丢失后重新爬取或计算，但系统不得把未上传文件伪装成可恢复缓存。

## 2. 不可扩大范围

- 不增加扫描完成后自动生成 MOC/Resource Package 的功能。
- 不修改 Warehouse 执行、索引或 ScanPlan sink 设计。
- 不重构包格式、包版本算法或合并静态/动态包构建器。
- 不要求 HTTP 下载改为 S3 代理；保留现有本地 Range 文件服务。
- 不要求先建立全局对象池、合并所有 evidence 前缀或重做 release tar。
- 不改变天球渲染、缩放加载策略、科学算法或覆盖精度。
- 不重写 Git 历史；不顺便删除生产历史发布版本。
- 不在迁移前删除线上正在使用的桶、PVC 或其唯一数据。
- Git 继续管理源码、契约、配方、测试和软件依赖声明；唯一权威规则针对业务数据。

发现上述范围之外的问题，记录为独立后续项，不混入当前实施。

## 3. 项目职责与当前产物链路

| 项目/模块 | 当前职责 | 不负责 |
|---|---|---|
| Warehouse scanner/operator | 按 ScanPlan 提取文件/覆盖文档，写 ES sink；按 evidence.outputPath 写扫描证据；管理执行状态 | Assets 包、合集、release archive 的生成和发布 |
| MOC-Core-SDK | 输入几何/MOC 的科学计算、规范化、投影；提供 Python 包构建能力 | S3 上传、公开指针、网页展示 |
| Assets | 选择 DR/product/layer、配方与参数；调用 Core；生成和管理结果文件、包、合集、release archive；上传、恢复和 HTTP 服务 | 自动将每个 ES 扫描结果转成资源包 |
| Workspace | 通过 Assets HTTP 契约下载和验证包 | 读取 Assets 工作区/PVC |
| Assets 天球 | 请求 catalog 和 overview cell blocks，构造 Three.js 几何 | 浏览器解析 ZIP/FITS 或推断缺失精度 |

当前静态路径：registry/recipe + layer MOC → rebuild_resource_packages.py/Core → package ZIP → build-release-manifest.ts/collection builder → release tree → release-archive.ts → S3。

当前动态路径：Assets 下载源 MOC → moc_build_worker.py/Core 写 MOC、query、preview、statistics → evidence 目录 → product publication 复制到 content 目录 → 动态包 → 发布候选树/临时 tar → S3。

Warehouse 的 ES 覆盖结果可以被 Assets 查询和展示；这不是生成 release archive 的自动链路。ScanPlan 中 ES sink 与 evidence.outputPath 是不同输出，不要通过改 sink 来实施本计划。

## 4. DR 归属与精度：诚实记录，不追求大而全

- 沿用 survey → release/DR → product → layer 的身份关系。一个巡天包可以包含多个 DR，但必须明确逐层归属及 sources[].releaseId 与 releases 的对应关系。
- 不把未知 DR 猜成某个 DR；不把某 DR 的局部文件集合描述为完整发布覆盖。
- 不无差别合并不同 DR、产品、波段的覆盖。确需跨 DR 并集，必须记录全部成员和并集语义，保留各成员原始身份。
- 记录实际输入快照/文件引用、筛选条件、失败/排除项和覆盖范围限制；完整性未知就写未知。字段格式沿用现有契约，若缺失先给出兼容扩展提案，不暗改包格式。
- 影像 WCS + 尺寸及必要畸变信息可生成影像几何范围；无有效像素 mask 时不宣称有效曝光/深度覆盖。
- RA/Dec 天体目录生成天体分布覆盖，不能默认为影像观测 footprint。观测中心还需要视场几何。
- ICRS/NESTED 不变。previewOrder/queryOrder 是输出表示配置，不等于源精度。粗 MOC 展开成子格不会增加边界信息；细格合并父格是包容性降精度。
- order 4 是常用概览、order 8 是常用查询表示，不保证每个 DR 都有真实 order 8 信息。源 MOC 可以多阶编码；粗单元可能准确表示完整覆盖的区域，不能仅凭最粗阶数判断精度。
- 当前 Core 通用 maxOrder 默认 10，Assets 动态入口默认 12，preview/query 默认 4/8；这是现状差异，不在存储改造中顺便统一。
- 中间数据若经明确策略删除，只能承诺重新计算能力，不能继续承诺原始输入逐字节可复现。

## 5. 目标目录与状态

```text
<local-root>/cache/     从生产 S3 恢复、校验通过的数据；可删除
<local-root>/scratch/   未完成计算；可重算
<local-root>/uploads/   完成计算但未确认上传；不可被缓存清理处理
```

根目录可配置；不要为工作站和集群建立不同业务存储协议。缓存可以用 emptyDir；待上传目录默认使用能跨 Pod 重启保存的专用临时持久卷，以支持慢上传/断网恢复。它不是永久备份。

| 维度 | 语义 |
|---|---|
| 计算 | queued/running/completed/failed；本地结果校验完成即可 completed，保留现有 STAGED 的计算完成含义 |
| 上传 | pending/uploading/uploaded/retryable-failed；独立重试，不回退计算状态 |
| 公开发布 | 未公开/已公开；完整 release 上传验证后才能推进公开指针 |

上传项必须原子保存 ID、类型、payload 相对路径、size/hash、目标 key、重试记录和成功 receipt。不得只把路径留在内存或 /tmp。上传后允许删除 payload，按 S3 引用恢复。

已同步控制状态也必须能恢复；尚未同步的编辑/状态变更属于待上传数据。界面/API 必须诚实区分“本地保存”“已同步”“已公开”。

## 6. 分阶段施工

### P0：盘点与基线（后续阶段的前置条件）

实施前重新核实实际配置，不依赖历史 HANDOFF 的部署版本。已有调查发现线上仍指向 asa-assets-dev；必须重新验证后迁移。

记录每类数据的写入者、读取者、本地位置、S3 key、size/hash、恢复方式、上传状态、清理条件。覆盖 release/archive/pointer、repo-evidence、cluster evidence、content、产品编辑、MOC build/publication、动态包版本、publication queue/run。

导出基线：固定 bundle/archive hash、所有受支持包/合集 hash、DR/product/layer 关系、availableOrders、overview/query cells、公开过滤结果。记录 Secret 名称而非凭据值。

验收：不存在“无人知道是否已上传”的待删除数据；独有文件列入补传清单。不得把旧文档中的统计值直接当当前结果。

### P1：统一恢复和缓存入口

文件起点：server/artifact-store.ts、server/sync-release.ts、server/content-archive.ts、server/paths.ts，新增薄 CLI，package.json。

复用现有完整 release archive 和指针格式，实现工作站/集群共同调用的按 current 或固定版本恢复。下载到临时目录，验证 archive、manifest、成员 size/hash 后原子激活。缓存损坏可重新下载；禁止隐式读取 Git artifacts 或隐藏 content 目录兜底。

可复用已验证的缓存提高可用性，但必须报告实际运行版本；空缓存时 S3 不可用应明确失败。禁止启动时用空本地状态覆盖远端。

验收：空目录恢复、删除再恢复、错误 hash、缺失对象、下载中断、缓存损坏；失败不激活半成品。恢复不能访问原工作区的数据路径。

### P2：独立待上传队列

文件起点：server/artifact-store.ts、新上传队列模块及 worker、Helm 挂载配置。

实现原子入队、领取/租约、重试退避、重启恢复、hash 幂等写入、成功 receipt 和安全清理。大文件要有实际测试过的重试方式；不得声称已有断点续传而实际上只能从头重传。

容量不足时暂停新任务或明确报错，不静默删除待上传结果。不设隐式丢弃 TTL。显式清除未上传任务须报告需要重算。

验收：断网、进程终止、重复领取、上传成功但 receipt 未写入、旧 claimed 标记、同 key 不同 hash 冲突。缓存清理不能触及 uploads。

### P3：产物及控制状态接入

文件起点：server/moc-build.ts、resource-package-publication.ts、public-release-publication.ts、release-publisher-worker.ts、products.ts、editorial.ts、server.ts；scripts/rebuild_resource_packages.py、harvest_cds_public_mocs.py、acquire_third_party_moc_layers.py、release-archive.ts、update_provenance_hashes.py。

所有现有生成入口写 scratch/uploads 并进入同一上传协议；缓存目录只接收恢复的数据。计算成功不等待上传；引用转换须保持输出身份和 hash。

控制状态不能只靠周期性打包本地 JSON：实现有版本的 S3 快照/事件及条件更新或明确单写者约束，覆盖产品、编辑、build/publication、包版本和发布队列。实现前给出状态清单与一致性设计；不引入新的独立权威数据库。

公开指针更新独立于对象上传：验证完整对象后推进；旧重试不得覆盖较新的发布。以基准指针版本做条件更新/冲突检测；冲突不能自动当作成功。读回指针并记录结果。

验收：已同步状态清空本地后恢复一致；恢复/重试不新建重复包版本；原失败/已完成任务记录保持；未同步变更明确可见；并发发布不倒退指针。

### P4：仓库、运行和发布 workflow 使用恢复入口

文件起点：scripts/build-release-manifest.ts、public_footprint_artifacts.ts、stage-release-assets.ts、.github/workflows/release.yml、package.json、.gitignore、Dockerfile、requirements、Helm templates/values/schema/examples。

构建显式 hydrate 指定数据版本，artifacts 生成数据停止跟踪。Git 中配方/人工维护源目录、业务目录、软件 wheel、测试 fixture 要逐项分类；不能因都在 artifacts 下就一刀切删除。软件依赖迁到明确位置或固定可校验下载来源；测试使用有限 fixture。

GitHub workflow 使用生产 S3 只读凭据恢复固定 bundle 的附件；整个 run 固定同一个指针快照，不能各步骤重新读 current。保留现有镜像/Chart 发布行为。

HTTP 下载继续读取缓存并保留 Range/ETag/SHA 契约；天球继续加载 catalog/overview blocks，order-8 query 用于服务端实际支持的查询。运行资源缓存可删除恢复；不得将 CI 缺文件容忍开关用于生产验收。

验收：没有旧数据的新 checkout 完成恢复、构建、附件 staging、服务启动。镜像不依赖业务 ZIP；动态状态恢复不依赖旧 PVC。

### P5：线上迁移与清理

顺序不可调换：补传缺口 → 隔离环境恢复 → 配置生产桶/凭据 → 验证 Pod 实际读写 → 演练计算完成后的断网/恢复上传 → 重建 Pod 恢复 → 确认无开发桶消费者 → 清空开发桶并删除其配置/Secret 引用/端口转发 → 清理旧 PVC 和仓库数据。

旧 PVC 只在每类已同步状态完成恢复验证后删除；待上传项必须迁移到新 spool 或明确重算。保存小型迁移 receipt，记录已验证 hash、目标 key 和删除范围。

迁移失败时回到生产 S3 中已验证的旧版本及兼容代码配置；不要把开发桶恢复为长期权威。生产 S3 历史发布和 evidence 前缀清理另开任务。

### P6：收尾与交接

移除已无调用者的旧路径、双桶脚本和本地兜底。更新存储契约、API 的同步状态说明、README、Helm 注释、agent 指令和 HANDOFF。每阶段留下修改文件、命令、结果、未完成项；不得仅凭实现意图勾选完成。

## 7. 最终测试矩阵

| 场景 | 必须结果 |
|---|---|
| 空环境仅有代码/配置/S3 凭据 | 指定版本完整恢复，hash 一致 |
| 删除缓存或重建 Pod | 恢复包、目录、已同步状态及天球数据 |
| 上传慢、断网、中断 | 计算仍完成；上传待重试；payload 保留 |
| 缓存清理 | 不删除待上传项 |
| 重试/并发发布 | 无重复版本，无指针倒退 |
| 下载回归 | 固定版本、合集、FITS、Range/ETag/SHA 不变 |
| 覆盖回归 | DR/product/layer、cells、orders、精度限制不变 |
| 隐私回归 | CSST/证据保持现有公开过滤；初始请求无扫描原文 |
| 配置回归 | 无开发桶读写，无原工作区/PVC 独有依赖 |

适用门禁：npm test、server/site tsc、Vite build、Helm lint/template、git diff --check；完整数据校验须先 hydrate。补充测试集中在恢复、队列和状态一致性接口，不重复测试未改动科学算法。

## 8. 改动量和风险评估

这是中大型存储生命周期改造。最难的是控制状态恢复和上传重试，不是 ZIP 打包或天球。

| 工作块 | 文件估算（有重叠） | 人日估算 |
|---|---:|---:|
| 文档/盘点 | 10–15 | 1–2 |
| 恢复/缓存 | 5–8 | 2–4 |
| 上传队列 | 6–10 | 3–5 |
| 产物/控制状态接入 | 10–16 | 5–8 |
| 构建/Helm/workflow | 8–12 | 3–5 |
| 故障测试/迁移 | 8–14 | 3–5 |

预计 35–55 个代码/测试/配置文件及 10–15 个文档，合计约 17–29 人日，非承诺工期。P0/P3 状态清单核实后重新估算。大量生成文件的 Git 删除不代表同等逻辑复杂度。无需自动转包，因此估算不包含扫描结果转包功能。

## 9. 文档生效与发布规则

本文保留目标、范围和语义约束，并在顶部记录已确认的 authority 位置、P1
公开 hydrate 结果，以及仍须修复的 P2/P3/P4 缺口；public-artifact-storage.md
区分当前实现、恢复证明和仍待执行的 P5；HANDOFF 顶部记录实际进度。已删除的
旧 resource-package-migration-plan/handoff 不再作为操作依据，历史可从 Git 查询。

修改被 release-manifest 收录的文档会使当前工作区 manifest hash 失效。正式验证/发布前由实施 agent 在已 hydrate 的工作区运行 catalog:build 并验证新 bundle；文档变更不应伪装成与旧 bundle 字节一致。本次文档任务不自动重新发布线上 release。
