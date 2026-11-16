# 数据获取 → 审核 → 发布：唯一流程

本文件是管理台、监控、测试和文档共同遵守的流程定义。其他文档描述某一环节的细节，与本文件冲突时以本文件为准并同步修正。
边界与“正确”的定义见 [boundaries](boundaries.md)。本文只描述 Assets 自己的流程。

**Assets 要回答的两个问题**

1. 某巡天的覆盖是什么？以官方 MOC 为准。
2. 某个 HEALPix 单元对应什么数据、前置路径在哪？这是补充证据，可没有。

所以流程分为一条**主线**（官方 MOC，必须完整）和一条**可选的证据线**（有数据源才有，缺了不影响主线）。

## 主线：官方 MOC 从发现到上线

```mermaid
flowchart LR
  A[1 发现] --> B[2 获取并锁定]
  B --> C[3 构建]
  C --> D[4 登记产品]
  D --> E[5 审核]
  E --> F[6 发布]
  F --> G[7 线上验证]
```

| 阶段 | 做什么 | 产物（不可变，带 SHA-256） | 权威状态 | 代码入口 |
| --- | --- | --- | --- | --- |
| 1 发现 | 监控已登记官方源是否变化；检索 CDS 里的新公开 MOC | 漂移报告、候选清单（不自动进入下一步） | `unchanged / drifted / failed`（每源） | `server/moc-source-monitor.ts`、`npm run moc:monitor`；`server/moc-discovery.ts` |
| 2 获取并锁定 | 取官方 MOC 与来源记录，核对已锁定的快照哈希 | `src/layers/recipes/<id>.lock.json`、`source.fits` | 无独立状态（失败即报错，不留半成品） | `server/official-moc.ts` `stageOfficialMoc` |
| 3 构建 | MOC-Core 校验并规范化，生成 `moc.fits`、查询阶、预览阶 | `moc.fits`、`query-order*.json`、`preview-order*.json` | `MocBuildPhase`：QUEUED → FETCHING → SNAPSHOT_LOCKED → VALIDATING → BUILDING → PROJECTING → BUNDLING → **STAGED**；终态 FAILED / DUPLICATE | `server/moc-build.ts` |
| 4 登记产品 | 把 STAGED 的构建绑定到产品身份（巡天/发布/名称/模态） | 产品草稿 revision | 产品 `draft` | `/api/v1/admin/products` |
| 5 审核 | 检查原生阶 ≥4、来源与哈希完整；管理员逐项接受已披露的限制 | 审核记录（绑定 revision + 制品哈希；内容变则失效） | `review.state`：`draft → reviewed` | `hasCurrentProductReview`、`GET /admin/products/:id/preflight` |
| 6 发布 | 冻结选中产品，候选隔离构建，上传，CAS 切换权威指针 | 新 bundle（`reviewed-<ts>-<hash>`） | 发布任务：queued → running → activating → site-pending → **published**；失败/取消为终态 | `server/public-release-publication.ts`、`publication-task-store.ts` |
| 7 线上验证 | 独立轮询站点的 health、产品、覆盖、包身份 | 验证结果 | 任务停在 site-pending 直到通过 | 同上；超过 120 秒界面提示同步延迟并继续检查 |

**铁律**

- 阶段之间只靠“不可变制品 + 哈希”交接；前一阶段完成**不会**自动触发后一阶段。发现不等于构建，构建不等于审核，审核不等于发布。
- 任何一步失败都不改变线上版本，也不改变上一步的产物。
- 只有 backend 角色写业务状态，site 角色只读（见 [发布运行架构](publication-runtime-split.md)）。

## 产品对管理员只有一个生命周期

管理台一个产品只显示下面五个状态之一（映射在 `site/admin/product-state.ts`，服务端 `review.state` 为准，客户端不重算）：

| 管理台显示 | 含义 | 服务端 `review.state` |
| --- | --- | --- |
| 未登记 | 目录里有，但还没有产品记录 | `unmatched` |
| 待审核 | 有草稿，尚未审核或审核已因内容变化失效 | `draft` / `unmatched-draft` |
| 已审核 | 当前 revision 已审核，未发布 | `reviewed` |
| 已发布 | 当前 revision 已在线上 | `published` / `unmatched-published` |
| 已退休 | 已下架或待撤下 | `retired` |

“可审核/需确认限制/未通过门禁”是**审核资格**，是附在产品上的警告标志，不是第二套状态。
MOC 构建阶段（STAGED 等）和发布任务阶段（published 等）是**各自对象**的进度，只在对应的详情里出现，不并入产品状态。

## 证据线（可选）：每个 HEALPix 对应什么数据

只有登记了数据源才会运行；没有数据源或没有 Warehouse，主线照常发布。

```mermaid
flowchart LR
  S[数据源 PVC/对象存储] --> W[Warehouse 扫描]
  W --> E[ast_* 证据索引]
  E --> I[Assets 证据导入]
  I --> U[原生单元索引候选]
  U --> R[审核]
  R --> A[归档全部输入 + CAS 激活]
  A --> L[覆盖块与 reverse-lookup]
```

- 判定依据是文件的 RA/DEC（或 HEALPix 列、路径规则）落在哪个 HEALPix；用户查看某区域时显示对应的前置路径。
- 证据**不修改**官方覆盖形状，只补充“此单元有哪些数据、链接在哪”。证据等级沿用 `verified / source-listed / rule-derived / entrypoint-only / unavailable`；缺少链接不使已知证据失效。
- 原生索引独立于 bundle 做受管激活：候选隔离 → 验证 → 审核 → 归档全部依赖 → CAS 激活 → 站点 HTTP 验证（细节见 [原生单元管理](native-unit-management.md)）。

## 目前与本文件不一致的地方（待收敛）

这些是现状，不是目标；每项收敛后从此处删除。

1. **发布状态机有三套**：`publication-task-store`（TaskPhase）、`public-release-publication`（PublicationRunStatus：building/uploading/verifying…）、原生索引自己的暂存-激活流。目标：对外只有第 6 阶段那一套。
2. **三条版本轴**：bundle id、原生索引 generation、代码 tag 各自独立发布。目标：bundle 一条，原生索引随 bundle 一起产出，代码 tag 只指镜像。
3. **构建入口有四个**：`from-official-source`、`from-native-units`、`from-evidence`、`from-path-healpix-evidence`，对应三种来源，导入模块重复（`evidence-moc-import` 与 `path-healpix-moc-import`）。目标：官方源一条，证据一条。
4. **重复入口**：发布入口 3 个、建扫描任务入口 3 个、登记构建入口 3 个（见 [冗余审计](audit-redundancy-and-admin-flow-20261108.md) 2.6）。目标：每件事一个入口（先定保留哪个，属产品决策）。
5. **管理台并行词汇已收敛**：生命周期、徽标、天球可见性、审核资格警告在 `product-state.ts`；MOC 构建展示在 `build-display.ts`；native 分块按可见步骤惰性渲染。
6. **阶段 1 的调度未接**：监控只能手动运行；管理页没有“待审核更新”。
7. **阶段 2 的锁定与监控基线是两份**：锁文件 `lock.json` 与 registry 的 `sourceSnapshotSha256` 重复记录同一事实。
