# Assets 对 data-warehouse 的承接需求

本文只记录 Assets 作为 data-warehouse 使用方的需求。它不描述 Atlas 的
功能，也不要求 data-warehouse 依赖 Atlas。

## 1. 调用边界

Assets 通过 Kubernetes API 提交 `atlas.zhejianglab.org/v1alpha1` 的
`ScanRequest`。远程 Connector 在 Assets 管理的 ConfigMap 中保存 endpoint、region、
bucket、prefix 和 Secret 引用名；远程对象存储的 access key/secret key 只存
在同 namespace 的 Secret 中。本地 Connector 只保存 Warehouse Infra 创建并标记
`atlas.zhejianglab.org/scanner-source=true` 的 PVC 名称，以及可选的 PVC 内相对
`basePath`；Assets 不创建 PV/PVC，也不接受节点名、hostPath、NFS 服务器或导出路径。
ScanRequest 的 `spec.plan` 是一个 ScanPlan v2，
`spec.credentials` 只声明 Secret 名称和键名，不携带值。

Assets 自己负责 Connector、Secret、任务标签、任务名称、幂等键和页面展示。
data-warehouse 不需要知道 Assets 的数据库或页面模型。Assets 不调用 Atlas API，
Atlas 也不需要调用 Assets 的计算接口。

本地扫描使用固定的只读卷契约：Connector 的 `basePath` 映射为
`scanner.sourceVolume.subPath`，任务的 `sourcePaths[0]` 必须是相对于该目录的
POSIX 路径，计划中的 `source.location.rootPath` 位于 `/data` 挂载点下。Warehouse
Operator 在创建 Job 前检查 PVC 存在、授权标签和 `Bound` 状态；Assets 会在提交前
执行同样的检查并返回可操作的错误。

data-warehouse 只需要校验并执行 ScanPlan v2；调用方不能再指定旧的
`handlers`、`userProperties` 或任意 sink 参数。

## 2. 标准任务要求

Assets 生成的最小任务包含：

```yaml
apiVersion: atlas.zhejianglab.org/v1alpha1
kind: ScanRequest
metadata:
  name: <assets-task-id>
  namespace: <warehouse-namespace>
  labels:
    app.kubernetes.io/managed-by: astro-survey-atlas-assets
    astro.zhejianglab.org/task-kind: public-coverage
    astro.zhejianglab.org/task-id: <assets-task-id>
    astro.zhejianglab.org/layer-id: <layer-id>
spec:
  scanner:
    image: <scanner-image>
    evidence: {claimName: <evidence-pvc>, mountPath: /var/lib/atlas-evidence}
  credentials:
    source: {secretName: <connector>-credentials, accessKeyKey: accessKey, secretKeyKey: secretKey}
  plan:
    version: 2
    scanRunId: <stable-run-id>
    layer: {layerId: <layer-id>, surveyId: <survey>, releaseId: <release>, productId: <product>, modality: image, coverageRole: footprint}
    source:
      connector: {type: oss, endpoint: <endpoint>, region: <region>, credentialRef: {accessKeyEnv: ATLAS_SOURCE_ACCESS_KEY, secretKeyEnv: ATLAS_SOURCE_SECRET_KEY}}
      location: {bucket: <bucket>, prefix: <source-prefix>}
    filters: {includeSuffixes: [.fits]}
    extraction: {mode: fits-wcs, outputOrder: 8}
    sink: {connector: {type: elasticsearch, endpoint: <warehouse-es>, credentialRef: {}}}
    evidence: {outputPath: /var/lib/atlas-evidence/<stable-run-id>}
```

要求：

- Job backend 使用 ScanPlan v2 的输入和 status 语义；
- `plan.scanRunId` 稳定映射到 status summary 的 `scanRunId`；
- Operator 不把凭据值写入 plan ConfigMap、Job、日志或索引；
- 任务名称冲突、重复提交和幂等行为必须返回明确结果；
- Job、Pod 或 FlinkSessionJob 保留调用方提供的追踪 labels。

Assets 同时为 ScanRequest 和 MOC discovery request 写入
`assets.atlas.zhejianglab.org/work-ref` annotation。其 JSON 至少包含稳定的
`key` 与面向人的 `title`，并可包含 `surveyId`、`releaseId`、`productId`。
Warehouse 创建 Job 时应保留这组追踪信息，不能用新的 attempt ID 覆盖 work
identity；Assets 会据此把 retry 聚合到同一个 02A work item，并只展示最新 attempt
的统计。

## 3. Status 读取

Assets 管理页只读取自己标签下的 CRD。data-warehouse 不需要保存 Assets 的
任务历史，但需要保持现有 status 字段的兼容性：

```text
phase, reason, message, summary.scanRunId, summary.discoveredFileCount,
summary.processedItemCount, summary.coverageRecordCount, summary.errorCount,
summary.availableOrders, summary.evidencePath
```

status 只描述对应 CRD 的执行观测。它不是 Assets 与 data-warehouse 的共享
业务状态，也不是 Atlas 的任务状态。失败必须有明确 `phase` 和 `message`；
不能因为 operator 没有及时刷新 status 就把失败任务报告为成功。

Connector 的连接探测不属于 Warehouse `ScanRequest` status。Assets 管理页按需对
单个 Connector 做只读对象存储请求，或检查 Warehouse Infra 授权源 PVC；结果只在
页面内存中显示，不能要求 Warehouse 将 `READY`、`PENDING` 或 `ERROR` 写入
Connector ConfigMap。

MOC discovery request 使用固定的 `cds-public-moc-v2` policy，只查询 allowlisted
CDS MocServer，写入 evidence，不下载候选 MOC、不执行 probe，也不写 `ast_*`。成功
status 的审核投影为有界 `reviewSummary`：`schemaVersion=2`、`truncated`、
`summaryTruncated`、可选 `searchRecordCount` 和候选数组。搜索最多读取 51 条记录，
状态最多保存前 50 条；第 51 条是判断 `truncated` 的 sentinel，不进入状态。候选至少
有 `candidateId`，并在可用时提供 `title`、`recordUrl`、`mocUrl`、`hipsUrl`。合法的
空候选数组必须保留为可审核的零结果；没有摘要与零结果不是同一种状态。完整响应、
原始响应和 evidence 仍留在 Warehouse evidence，不能塞入 Assets 初始页面 payload。
Assets 只提交候选 ID 创建独立的 MOC build，服务端会以当前 status 重新解析并校验
来源 URL。旧 v1 CR/evidence 只作为只读历史保留，不由 v2 operator 重写或重新执行。

## 4. Sink 语义

data-warehouse 不规定所有任务写 Elasticsearch。`spec.sink` 是每个任务的
选择：可以是 Elasticsearch，也可以是其他受支持的 sink，或者按 CRD 语义
不配置 sink。

Assets 的 coverage task 通常选择 Elasticsearch sink，以便 finalizer 按
稳定 `runId` 查询 normalized coverage。ES 字段合同只适用于明确选择 ES
sink 的任务：

```text
scan_run_id / run_id
source_file_id
asset_id
spatial_status
coverage_method
coverage_role
coverage_frame
coverage_order
coverage_cells
spatial_error
```

其他 data-warehouse 任务不需要填充这些字段，也不应被 Assets 的 coverage
需求限制。

## 5. Coverage scanner 能力

当前 Assets 可依赖的 scanner 模式：

- FITS WCS coverage；
- FITS header position coverage；
- catalog RA/Dec coverage；
- declared NESTED HEALPix coverage（ScanPlan 模式为 `catalog-healpix`）。

Assets 管理页将这四种 extraction mode 映射到 image、spectrum、catalog、cube
四种业务模态；cube 仍使用 FITS WCS，但只提取空间轴，spectrum 的 header
position 结果必须标为 `entrypoint-only`。这些模式需要对非法坐标、缺少空间字段、
空输入和解析失败返回明确的 `spatial_status`/`spatial_error`。

Assets 计划使用但当前 scanner 尚未实现的模式：

- `regions`；
- `tile-table`。

在 data-warehouse 实现前，Assets 管理页不得将这两种模式显示为可提交能力。
若纳入首期，data-warehouse 需要增加解析、ICRS 校验、NESTED HEALPix
栅格化、Job/Flink 一致实现及对应测试。

## 6. 不要求 data-warehouse 做的事

- 不新增 Assets 专用 HTTP API；
- 不保存或管理 Assets 任务历史；
- 不决定 Assets 的凭据、Secret 或 Connector 存储方式；
- 不负责 MOC Core、locked manifest、Resource Package 或 catalog 激活；
- 不把 `coverage-task-v1` 固化成内部数据库模型；
- 不把 Elasticsearch 作为所有任务的默认 sink；
- 不引入 Atlas 依赖。

## 7. 改造顺序与验收

### 阶段 A：CRD 承接稳定性

- CRD render 和 operator reconcile 测试覆盖 Assets 最小任务；
- `batchId -> runId`、status phase/message 和任务标签通过测试；
- 重复任务名/幂等提交返回明确冲突或复用结果。

### 阶段 B：现有 coverage 模式

- FITS WCS、catalog RA/Dec、nested HEALPix 的 Job/Flink 结果一致；
- ES sink 任务可以按 `runId` 查询非空 coverage 文档；
- scanner Bulk 1,500,000 字节限制、500 条硬上限和 item retry 测试通过。

### 阶段 C：扩展模式

- 实现 `regions` 和 `tile-table`；
- 增加非法几何、坐标系、空输入和跨 backend 测试；
- 未实现时返回明确“不支持”，不能静默生成错误覆盖。

### 阶段 D：部署承接

- 提供 Assets 独立 ServiceAccount 的 RBAC 示例；
- 验证 Assets 可创建/读取自己的 ConfigMap、Secret 和 ScanRequest；
- 验证任务 labels 能隔离其他调用方；
- 提供 scanner 镜像、CRD 版本、namespace、sink 和回滚配置说明。

## 8. 成功标准

Assets 提交合法 ScanRequest 后，data-warehouse 能创建并执行任务；Assets 能通过
Kubernetes API 读取自己任务的 phase、scanRunId、计数和错误；选择 ES sink 的
coverage 任务能产生可按 runId 查询的非空结果；其他 sink 和其他调用方的
任务不受 Assets 约束影响。
