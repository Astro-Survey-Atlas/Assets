# Assets / Warehouse / Workspace 边界

这份文档定义 Astro Survey Atlas 组织内三个产品项目和共享 Core 的职责，以及 Assets
调用 Warehouse 时需要遵守的边界。任何一个项目都可以独立运行自己的数据面和
任务历史；跨项目连接使用版本化契约。Assets 不依赖旧 Assets ES；覆盖反查只
依赖明确配置的 Warehouse Elasticsearch 索引合同。

## 职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Assets | 公共 survey/release/product/layer 注册；用 ConfigMap + Secret 管理远程 Connector，用 ConfigMap 只引用 Warehouse Infra 提供的授权源 PVC；只读汇总 Warehouse `AstroDataSource`；提交一次性 `ScanRequest`；读取任务状态；调用并发布 MOC-Core-SDK 产物；Resource Package、manifest、provenance、catalog、产品 dossier、证据摘要和只读下载 API | Atlas 用户资产、Atlas 任务历史和 Atlas API；Warehouse 的内部实现；TAP/ObsCore/SIA 服务实现；创建 PV/PVC 或接受任意 hostPath/NFS 配置 |
| Warehouse | 接收 `atlas.zhejianglab.org/v1alpha1/ScanRequest`；校验并执行嵌入的 ScanPlan v2；维护 Operator status；提供 scanner 的执行合同和当前 `ast_*` 索引 | Assets 的 catalog 激活、MOC Core、Resource Package 发布；不规定所有任务的统一 sink |
| Workspace | 独立的用户资产、Connector、任务历史、查询索引和前端；可独立向 Warehouse 提交用户任务；安装并验证 Assets 公共资源包 | Assets 的公共发布、Warehouse scanner/operator、把用户记录写回 Assets |
| MOC-Core-SDK | 共享离线科学实现、ICRS/NESTED 规范化、FITS MOC、固定 order 投影、provenance 和 Resource Package v3；发布 Python wheel 与跨语言 fixture | 在线 API、远程 connector、Kubernetes 执行、用户数据或公共 release 决策 |

Assets 管理输入是产品/layer、Connector 名称、源前缀和 ScanPlan 参数。服务端
从 Assets Connector ConfigMap 或 Warehouse `AstroDataSource` 读取非敏感元数据，从引用的
Secret 只读取凭据（Assets 默认键为 `accessKey`/`secretKey`，Warehouse 原生
`AstroDataSource` 默认键为 `access-key`/`secret-key`），或者读取 Warehouse Infra 已授权源 PVC 的名称和相对
`basePath`，然后生成标准 `ScanRequest`。ScanPlan v2 是
data-warehouse 的公开执行合同，不是 Assets 或 Atlas 的数据库模型；凭据值永远
不进入 plan、ConfigMap、日志或响应。

本地扫描的 `sourcePaths[0]` 必须是相对于 Connector `basePath` 的 POSIX 路径；
Assets 将其映射为 `/data/<relative-path>`，并设置只读
`scanner.sourceVolume`。Assets 不创建 PV/PVC，也不接受节点名、hostPath、NFS
服务器或导出路径。Warehouse Operator 和 Assets 都会在执行前确认 PVC 存在、带有
`atlas.zhejianglab.org/scanner-source=true` 标签且处于 `Bound` 状态。

Assets 管理页只读取自己提交的 CRD status。status 是 data-warehouse operator
对单个 CRD 的运行观测，不是三方共享的任务历史或业务状态。Connector ConfigMap
本身没有运行 status：列表显示 `NOT_CHECKED`，用户点击单个 Connector 时，Assets
才按需探测对象存储或授权源 PVC。探测使用 Secret 的凭据但不把凭据写入响应、日志
或 evidence；无敏感字段的结果持久化在内容卷并同步到 authority，连接配置变更后旧
结果自动失效。对象存储授权范围盘点按分页执行；本地 PVC 在 Warehouse 提供独立
inventory 合同前保持 `unknown`，不能用一次扫描的文件数冒充目录总量。

公共产品有两层出口：`/api/v1/products` 是保持兼容的已发布列表；产品详情和
`/evidence` 是按需加载的面向人的 dossier。详情把覆盖结论、真实 order、来源、
推导步骤、检查、限制、就绪度和官方下一站放在同一响应中。未发布草稿不从公开详情
或 evidence 路由返回。输入 manifest、normalized
scan、任务快照和内部存储路径仍属于 evidence 边界，不会进入首页或 dossier
初始请求。

当 Assets 的任务选择 Elasticsearch sink 时，scanner 输出的 normalized
file/coverage 文档可供 Assets 按 `scanRunId` 读取，并由 warehouse
`ast_file_index_v1` / `ast_coverage_index_v1` 提供反查。其他
`ScanRequest` 可以选择不同 sink，不能把 ES 当成 data-warehouse
的全局输出约定。

Assets 管理页固定展示 image、spectrum、catalog、cube 四种业务模态的集群任务
验收状态。它只统计真实持久化的 ScanRequest，不把本地或内存 probe 当成已完成
的集群扫描。对应 extraction mode 分别是 `fits-wcs`、
`fits-header-position`、`catalog-radec`/`catalog-healpix`、`fits-wcs`（忽略
非空间轴）。

Assets 的公开分发遵循成熟巡天的组合模式：页面负责发现和解释，FITS MOC 与
order 投影负责空间计算，Resource Package v3 负责离线安装，官方 archive/query
负责科学文件获取。Assets 当前不宣称 TAP、ObsCore 或 SIA 兼容，也不代理巡天
科学文件；相关标准和实践见 [公开巡天分发调研](public-survey-distribution-research-20260827.md)。

## 任务生命周期

公共 MOC、Resource Package 和大型 query projection 的权威发布位置是版本化
对象存储；Git 保留公开 catalog、recipe lock、非敏感 provenance 摘要和 hash。真实私有数据（包括 CSST）
及其预览/配方不进入 Git；CSST 私有数据由 Workspace 持有，Assets 不再保留副本，测试采用合成数据。输入 manifest、
normalized scan、任务快照和错误继续留在 evidence PVC/object store。已确认的
authority 是 gitignored `.info` 描述的 MinIO，不是当前 Helm `storage/minio`
公开桶。P0-P5 的盘点、恢复、队列、CAS、workflow 和线上切换均已验收；本地
生成 release、layer、raw、content 和 probe 副本在独立恢复及 SHA-256/size 校验
后清理。旧开发桶对象和 Secret 已退役，仍在使用的 PVC 按迁移收据保留。迁移契约
见[公共制品存储与迁移](public-artifact-storage.md)。

```text
Assets 管理页面
  -> 创建一次性 public coverage task
  -> data-warehouse operator 执行远程扫描
  -> Assets MOC Core finalizer
  -> locked manifest + MOC + v3 package
  -> 审核具体产品版本并明确选择发布
  -> 增量对象上传、authority CAS 与网站核验
  -> Assets 公开 catalog 生效
  -> Atlas 只读安装并校验
```

官方已有 MOC 的产品直接导入锁定。只有区域文件、tile 表或审核后的本地
输入才创建任务。私有 CSST 的重新扫描和生成由 Workspace 发起，不再由 Assets
历史导入脚本恢复。当前不生成深度数据，也不把深度字段塞进 FITS MOC。

## 深度扩展

后续可在 v3 包中增加独立 `depth/<layer-id>-<band>.fits` artifact。升级前
必须定义 `depthMetric`、单位、波段、统计方法、HEALPix order/resolution、
输入和算法版本，并记录 depth map SHA-256。没有科学定义前，validator 和
发布流程不会接受虚假的深度文件。
# Storage implementation handoff

The [S3 authority implementation plan](s3-authority-implementation-plan.md)
records the confirmed authority as the MinIO described by gitignored `.info`,
not the currently deployed Helm `storage/minio` public bucket. Production S3 is
the authority for uploaded business bytes and synced control state. `cache/`
contains disposable verified restores, `scratch/` contains recomputable work,
and `uploads/` contains explicit pending payloads that cleanup must not remove.
Hydrate and Helm startup require S3 and fail closed in a fresh environment;
HTTP still serves verified `/data/current` and the configured local content
root without reading S3 per request.

P2/P3 durability work (atomic spool enqueue, CAS pointers, corrupt-local
restore and honest API sync status) and the P5 online cutover are complete.
The old development bucket and Secret were removed after hash and consumer
checks; active release/content/evidence/upload-spool PVCs remain because they
are still mounted or can contain recoverable state. This work does not add
automatic scan-to-MOC/package conversion or change Warehouse's execution/index
responsibilities or coverage semantics.


## Assets 运行边界（2026-09-20 已上线）

公开 site 与单写者 backend 使用独立 release cache PVC。site 不初始化草稿、
构建或业务任务存储；管理请求经鉴权代理到 backend。backend 独占业务写入与
SQLite 发布队列，子执行进程通过 fenced IPC 请求父进程激活 authority。
网站同步、快照上传、发布执行和上线核验独立推进。Warehouse ACTIVE 是执行
状态，只有审核且明确发布的版本进入公开数据边界。

已有 MOC 探索由 Warehouse 查询 CDS，Assets 负责候选选择、构建、审核与发布。
联网 LLM 增强仍为设计，不能描述为现有执行能力。详见
[发布运行架构](publication-runtime-split.md)、[增强设计](moc-discovery-enhancement-design.md)
及 [当前交接](../HANDOFF.md)。
