# Assets / data-warehouse / Atlas 边界

这份文档是本仓库的架构决策记录。Assets 是公共覆盖制品发布者，不是
Atlas 用户数据服务，也不是远程扫描执行器。

## 职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Assets | 公共 survey/release/product 注册；Connector 引用、recipe 和一次性公共 coverage task；MOC Core 的生成、合并、锁定；Resource Package、manifest、provenance、catalog 和只读下载 API | Atlas 用户资产、用户任务、权限、查询索引、扫描历史；保存远程凭据；常驻扫描服务 |
| data-warehouse | 执行 S3/OSS/JDBC 等扫描；凭据、Range、分页、分片、重试和临时数据；返回规范化扫描结果或锁定构建输入 | 公共 catalog 激活、Resource Package 发布权限 |
| Atlas | 本地文件/PVC scanner；可选远程 scanner 插件；用户资产、任务历史、查询索引和前端；安装并验证 Assets 公共资源包 | Assets 的 Connector、Job、数据库、worker 或计算接口 |

Assets 到 data-warehouse 的一次性交接使用
[`coverage-task-v1.schema.json`](../contracts/coverage-task-v1.schema.json)。这个
schema 只传 `connectorId`、配置哈希、recipe 和输出约束，不传凭据。任务完成
后，Assets 将结果交给 MOC Core，生成不可变的锁定 manifest、MOC、投影、
provenance 和 v3 package；任务运行时状态不会成为 Atlas 的依赖。

## 唯一稳定交集

Atlas 只需要安装并验证 Resource Package v3：

- `resource-package.json`、`layerId`、survey/release/product；
- `coverageRole`、`dataOrigin`、`sourceTier`；
- IVOA FITS MOC、ICRS、NESTED；
- order 8 查询投影和 order 4 预览；
- 文件大小、SHA-256、provenance 和公共 catalog 信任校验；
- conformance fixtures 和安装验证规则。

Atlas 不调用 Assets 的计算接口，也不需要知道任务由哪个 Connector、Job、
数据库或 k3s worker 执行。公开 API 只暴露当前 release allowlist、survey/
coverage 索引、包 catalog 和不可变下载/预览；写入方法统一返回 `405`。

## 任务生命周期

```text
Assets 管理页面
  -> 创建一次性 public coverage task
  -> data-warehouse 执行远程扫描
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

