# Assets / Warehouse / Workspace 边界

这份文档定义 Astro Survey Atlas 组织内三个独立项目的职责，以及 Assets
调用 Warehouse 时需要遵守的边界。任何一个项目都可以独立运行自己的数据面和
任务历史；跨项目连接使用版本化契约。Assets 不依赖旧 Assets ES；覆盖反查只
依赖明确配置的 Warehouse Elasticsearch 索引合同。

## 职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Assets | 公共 survey/release/product/layer 注册；用 ConfigMap + Secret 管理远程 Connector；提交一次性 `ScanRequest`；读取任务状态；MOC Core 的生成、合并、锁定；Resource Package、manifest、provenance、catalog、产品 dossier、证据摘要和只读下载 API | Atlas 用户资产、Atlas 任务历史和 Atlas API；data-warehouse 的内部实现；TAP/ObsCore/SIA 服务实现 |
| Warehouse | 接收 `atlas.zhejianglab.org/v1alpha1/ScanRequest`；校验并执行嵌入的 ScanPlan v2；维护 Operator status；提供 scanner 的执行合同和当前 `ast_*` 索引 | Assets 的 catalog 激活、MOC Core、Resource Package 发布；不规定所有任务的统一 sink |
| Workspace | 独立的用户资产、Connector、任务历史、查询索引和前端；可独立向 Warehouse 提交用户任务；安装并验证 Assets 公共资源包 | Assets 的公共发布、Warehouse scanner/operator、把用户记录写回 Assets |

Assets 管理输入是产品/layer、Connector 名称、源前缀和 ScanPlan 参数。服务端
从 Connector ConfigMap 读取非敏感元数据，从同名 Secret 只引用
`accessKey`/`secretKey`，然后生成标准 `ScanRequest`。ScanPlan v2 是
data-warehouse 的公开执行合同，不是 Assets 或 Atlas 的数据库模型；凭据值永远
不进入 plan、ConfigMap、日志或响应。

Assets 管理页只读取自己提交的 CRD status。status 是 data-warehouse operator
对单个 CRD 的运行观测，不是三方共享的任务历史或业务状态。

公共产品有两层出口：`/api/v1/products` 是保持兼容的已发布列表；产品详情和
`/evidence` 是按需加载的面向人的 dossier。详情把覆盖结论、真实 order、来源、
推导步骤、检查、限制和官方下一站放在同一响应中。输入 manifest、normalized
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

公共 MOC、Resource Package 和大型 query projection 的目标发布位置是版本化
对象存储；Git 保留 catalog、recipe lock、provenance 摘要和 hash。输入 manifest、
normalized scan、任务快照和错误继续留在 evidence PVC/object store。迁移契约见
[公共制品存储与迁移](public-artifact-storage.md)，本轮不执行上传或删除。

```text
Assets 管理页面
  -> 创建一次性 public coverage task
  -> data-warehouse operator 执行远程扫描
  -> Assets MOC Core finalizer
  -> locked manifest + MOC + v3 package
  -> Assets catalog 激活
  -> Atlas 只读安装并校验
```

官方已有 MOC 的产品直接导入锁定。只有区域文件、tile 表或审核后的本地
输入才创建任务。CSST W2/W3/W4 保持独立任务；CSST W1 的权威 MOC、像素、
面积和 SHA-256 保持冻结。当前不生成深度数据，也不把深度字段塞进 FITS MOC。

## 深度扩展

后续可在 v3 包中增加独立 `depth/<layer-id>-<band>.fits` artifact。升级前
必须定义 `depthMetric`、单位、波段、统计方法、HEALPix order/resolution、
输入和算法版本，并记录 depth map SHA-256。没有科学定义前，validator 和
发布流程不会接受虚假的深度文件。
