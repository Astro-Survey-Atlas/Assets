# API 设置与调用管理

实现日期：2026-09-21。后台入口 `/admin/api`（导航“API 设置”）。
本模块由 Assets 后台管理并执行，不修改 Warehouse 或 Workspace 接口。

## LLM 服务

支持 OpenAI 兼容 Chat Completions：HTTPS 服务地址、模型、启用状态和替换凭证。
留空凭证保持现有值；更换地址必须同时更换凭证，防止误向新服务发送旧密钥。
可清除凭证并停用。保存需要匹配配置 revision，冲突时刷新后重试。
测试按钮复用统一后台样式和图标，点击后显示转圈；结果在按钮下方按成功、模型缺失、
失败区分展示，浏览器最多等待 25 秒。“测试已保存配置”仅读取 `/v1/models`，不发起推理，也不证明服务支持联网搜索。
请求固定到公共 HTTPS 地址，不跟随重定向，不将凭证发送到私网。

现有 Secret 中的 LLM 配置首次启动时导入；之后以保存的配置为准，停用或清除后
不回退到环境变量凭证。保存影响后续探索，已经启动的探索使用启动时配置。
MOC 表单仍默认关闭增强；只有 CDS 完整成功、未截断且零候选时才触发。
Assets 查询 CDS/读取公开网页后提供材料给模型，不依赖供应商内置联网工具。
预算与候选校验见 [MOC 增强](moc-discovery-enhancement-design.md)。

每次实际模型调用记录任务、模型、成功/失败、耗时、供应商输入/输出 token。
统计从模块启用开始，不追溯旧任务；缺失用量单独计数，不估算费用。
连通测试不计作模型推理。最近调用保留最多 1000 条，总量持续累计。

## 对外 API Key

公开 Catalog、资源包列表和下载继续匿名。首期唯一 scope 为 `region:query`，
授权已有 `POST /api/v1/access/region-query` 区域查询与
`POST /api/v1/coverage/reverse-lookup` 重合区域下载计划，请求头为：

```http
X-Assets-API-Key: <创建时取得的 Key>
Content-Type: application/json
```

区域查询正文沿用现有契约（ICRS/NESTED、具体产品/图层及覆盖版本），最多 8 个来源。
天球反查下载计划接收 layerIds/order/cells，最多 64 个产品图层；多个 DR/波段仍按独立
产品处理，不合并或截掉第 8 层之后的产品。两者保持 4096 个请求像元、100 平方度、
总计 10000 个几何结果、1000 个索引单元及 2 MiB 响应限制。
“下载全部区块”依次请求，避免单次点击产生超过并发上限的查询；错误展示具体原因。
Key 不授权管理、审核、发布或签发 Key，也不用于 URL query 参数。
原 Workspace 服务 Key 与浏览器密码解锁会话保持兼容。
天球的“下载密码或 API Key”输入框接受以上 Key，经 `/api/v1/access/unlock` 验证后
签发最长一小时的 HttpOnly/SameSite 会话。浏览器不保存 Key 明文，每次查询重新检查
关联 Key 的有效期、撤销与限流；撤销会阻止已解锁会话的后续请求。
解锁本身计入 Key 调用额度，查询与下载计划共享同一 Key 限额。后台重启需重新解锁。
授权不会生成原本缺失的科学文件索引，只返回产品实际具备的下载计划。

创建时填写使用方名称、每分钟限额（1–30）和有效期（页面 1–365 天，默认 90 天）。
完整明文只在创建响应及一次性弹框中出现，关闭弹框清空，不写浏览器存储。
服务端仅保存 SHA256 校验值与前缀。轮换先创建替代 Key，再撤销旧 Key。
撤销立即拒绝后续请求，已开始的查询不取消。

已知 Key 的请求、拒绝、错误、最后调用时间与耗时均记录；无效未知 Key 不创建
无限量统计条目。撤销/过期返回 401，scope 不符 403，限流 429。
每分钟计数持久化，重启不会重置；现有区域计算硬限制（并发、每日计算量、
区域大小、结果数量和超时）继续生效。每日/并发计算保护仍为原进程内实现。

## 存储与恢复

仅单后台写入 `ASSETS_CONTENT_ROOT/api-management.sqlite`，SQLite WAL/FULL。
LLM 凭证使用 AES-256-GCM 加密，独立 Kubernetes Secret `assets-api-management`
的 `master-key`（32 字节随机值的 base64）通过 `ASSETS_API_MASTER_KEY` 注入后台。
网站不挂载该 Secret。主密钥不进入 Git、状态快照、页面或日志。
主密钥缺失/错误不能解密时启动失败，不静默覆盖保存的凭证。

状态通过 `api-management` 命名空间排队归档到 authority；配置变更立即排队，
调用统计每 60 秒及正常关机时排队。SQLite 中统计每次同步落盘；突然丢失 PVC
时可恢复到最后已上传快照，可能缺少尚未归档的近期计数。
恢复需要同时保留稳定 master Secret；不要直接重建/轮换此 Secret。
密钥轮换需要显式重新加密流程，首期没有在线 master-key 轮换按钮。

## API 路由

所有以下管理操作需要现有管理员身份，响应 `Cache-Control: no-store`：

- `GET /api/v1/admin/api-management`：脱敏配置、Key 元数据和用量。
- `PUT /api/v1/admin/api-management/llm`：保存配置。
- `POST /api/v1/admin/api-management/llm/test`：读取模型列表。
- `POST /api/v1/admin/api-management/keys`：创建，一次性返回完整 Key。
- `POST /api/v1/admin/api-management/keys/:id/revoke`：撤销。

部署不自动生成对外业务 Key、不触发模型探索、不审核或修改发布数据。
