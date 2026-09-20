# 前端消费 Resource Package v3

发布页 `/releases/` 的“常见问题”提供同一流程的中英文版本。本指南适用于自建前端；
Workspace 已实现安装、校验和原生 MOC 投影，可直接使用其公开资源包界面。

1. 读取 `/api/v1/resource-packages/catalog.json`。用户选择包后，保存同一条记录的
   `id`、`version`、`sha256`、`sizeBytes`；相对于目录地址解析 `archiveUrl`。
2. 下载该版本的 ZIP，核对大小和 SHA-256，再解包。核对 `resource-package.json`
   中 `schemaVersion=3`、id/version/surveyId；按其 `files`、`layers` 清单逐个
   校验成员大小和哈希。解包工具应限制输入和解压总量，并只接收清单声明的文件。
3. 概览使用 `footprints/survey-footprints.json`。其 `footprints[]` 每项包含
   `layerId/surveyId/releaseId/nside/pixels`；与 manifest 对应图层关联后，在
   ICRS/NESTED 天球上显示。新版预览不保证存在顶层统一 nside。
4. 精细显示、放大或重合使用同包原生 `mocs/*.moc.fits`，由支持 IVOA MOC 的
   库读取；也可以在后端用固定版本的 MOC Core `project --moc ... --order ...`
   生成真实共同阶数的投影。order 4 概览不能放大后冒充 order 8 精度。
5. 缓存使用 id/version/hash 组合键。目录更新、包更新、DR 激活是不同操作。
   新包通过完整校验后再替换旧缓存；失败保留上一份已验证包。

`availableOrders`、`maxOrder` 与来源精度必须保留；混合图层以共同可用精度计算。
不同 DR/product/layer 不能丢失身份。`sources: []` 是合法的纯几何包；MOC 不是
可下载科学文件清单，不能据此捏造文件地址。

浏览器跨域需要来源服务器正确配置 CORS，或使用你配置的同源后端代理。
Web Crypto 的 `crypto.subtle.digest('SHA-256', bytes)` 需要 HTTPS 或 localhost；
普通 HTTP 页面应由后端验证。前端不能保存 Assets 管理令牌或对象存储凭据。
完整输入 manifest、normalized scan 和任务快照属于证据，不进入首页请求。

在 Workspace 中：同步目录 → 安装/更新所选包 → 勾选所需 DR 加载。已发布包的
加载无需重新扫描。私有 CSST 数据的重新扫描是独立的用户数据任务，不属于公开包安装。

合集 ZIP 仅在发布记录声明 `collection` 时可用。不要硬编码旧的发布 ID、包版本
或已删除的 GitHub Release 链接；具体版本和哈希以选择时的目录记录为准。
