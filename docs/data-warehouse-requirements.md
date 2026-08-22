# Assets 对 data-warehouse 的承接需求

本文只记录 Assets 作为 data-warehouse 使用方的需求。它不描述 Atlas 的
功能，也不要求 data-warehouse 依赖 Atlas。

## 1. 调用边界

Assets 通过 Kubernetes API 提交标准资源：

- `AstroDataSource`：由 Assets 自己管理的 source/sink 配置和凭据引用；
- `AstroMetadataScanTask`：一次性覆盖计算任务。

Assets 自己负责 Connector、DataSource、Secret、任务标签、任务名称、
幂等键和任务历史。data-warehouse 不需要知道 Assets 的数据库或页面模型。
Assets 不调用 Atlas API，Atlas 也不需要调用 Assets 的计算接口。

data-warehouse 只需要按 CRD 标准承接任务，允许不同调用方拥有不同的
metadata labels，并按资源自身的 source、handlers、userProperties、
extraEnv 和 sink 执行。

## 2. 标准任务要求

Assets 生成的最小任务包含：

```yaml
apiVersion: org.zhejianglab.astro.metadata/v1alpha1
kind: AstroMetadataScanTask
metadata:
  name: <assets-task-id>
  namespace: <warehouse-namespace>
  labels:
    app.kubernetes.io/managed-by: astro-survey-atlas-assets
    astro.zhejianglab.org/task-kind: public-coverage
    astro.zhejianglab.org/task-id: <assets-task-id>
    astro.zhejianglab.org/layer-id: <layer-id>
spec:
  backend: job
  source:
    dataSourceRef: {name: <source-data-source>}
    paths: [<source-path>]
  handlers: [default, fits, coverage]
  userProperties: {}
  sink:
    dataSourceRef: {name: <sink-data-source>}
  extraEnv:
    batchId: <stable-run-id>
```

要求：

- Job 和 Flink backend 使用相同的输入和 status 语义；
- `extraEnv.batchId` 能稳定映射到 status `runId`；
- operator 不丢失合法的 `userProperties`；
- `extraEnv` 不能覆盖 operator 管理的连接参数；
- 任务名称冲突、重复提交和幂等行为必须返回明确结果；
- Job、Pod 或 FlinkSessionJob 保留调用方提供的追踪 labels。

## 3. Status 读取

Assets 管理页只读取自己标签下的 CRD。data-warehouse 不需要保存 Assets 的
任务历史，但需要保持现有 status 字段的兼容性：

```text
phase, backend, runId, discoveredFiles, processedHdus,
coverageDocuments, objectDocuments, startedAt, completedAt, message
```

status 只描述对应 CRD 的执行观测。它不是 Assets 与 data-warehouse 的共享
业务状态，也不是 Atlas 的任务状态。失败必须有明确 `phase` 和 `message`；
不能因为 operator 没有及时刷新 status 就把失败任务报告为成功。

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
- catalog RA/Dec coverage；
- declared nested HEALPix coverage。

这些模式需要在 Job/Flink 两条路径保持一致，并对非法坐标、缺少空间字段、
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
- 验证 Assets 可创建/读取自己的 DataSource 和 ScanTask；
- 验证任务 labels 能隔离其他调用方；
- 提供 scanner 镜像、CRD 版本、namespace、sink 和回滚配置说明。

## 8. 成功标准

Assets 提交合法 CRD 后，data-warehouse 能创建并执行任务；Assets 能通过
Kubernetes API 读取自己任务的 phase、runId、计数和错误；选择 ES sink 的
coverage 任务能产生可按 runId 查询的非空结果；其他 sink 和其他调用方的
任务不受 Assets 约束影响。
