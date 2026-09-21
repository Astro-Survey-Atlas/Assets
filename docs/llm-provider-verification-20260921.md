# LLM 服务连通性与联网能力验证（2026-09-21）

用户配置：`https://token.72602.space`，OpenAI 兼容协议，模型 `glm-5.3`。
凭证来源是本地 `.info` 的 `llm_key`；文件权限 0600，Git 和 Docker context 均排除。
本文不包含密钥。尚未将凭证部署到业务服务或启用 LLM 探索。

## 已验证

- `GET /v1/models`：HTTP 200，包含 `glm-5.3`。
- `POST /v1/chat/completions`：HTTP 200；提交 `tools: [{type: "web_search",
  web_search: {enable: true, search_result: true}}]`。模型只返回准备搜索的文字，
  没有 tool_calls、搜索结果或引用元数据，finish_reason=stop。
- `POST /v1/responses`：HTTP 200，模型 `glm-5.3`，tools=[{type:"web_search"}]。
  output 只有 reasoning/message，没有 web_search_call；正文明确说不能联网核验，
  所列 URL 来自训练知识且未经验证。

请求均为有限的 SDSS DR9 官方覆盖文档来源探测，没有提交 Warehouse 业务任务，
没有构建/审核/发布。此次两种参数均不能证明该网关已经提供实际联网搜索。
这不证明模型不能调用客户端提供的函数，也不排除网关支持另一种搜索协议。

## 当前缺项

需要此网关可用的联网搜索请求示例（不带密钥），或确认供应商端已开启/透传搜索工具。
如果实际仅支持 function calling，则需要另行提供可执行的搜索工具或搜索服务，
不能将模型生成 URL 当作搜索结果。联网探测必须保留工具执行、来源与引用证据。

API 管理及凭证存储设计见 [api-management-design.md](api-management-design.md)。
服务配置待接入该模块；本次仅完成连接与能力验证，不代表模块或增强流程已上线。

## 后续：Assets 提供联网工具

用户确认不依赖模型内置搜索。Assets 实际读取 CDS 与公开页面，再交由模型整理；
`glm-5.3` 非思考模式的两阶段请求已通过真实 SDSS DR9 验收，取得三条可引用线索，
尚无可构建的 color imaging MOC。上述原生 web_search 验证失败不再阻塞该方案。
见 [当前实现](moc-discovery-enhancement-design.md)。
