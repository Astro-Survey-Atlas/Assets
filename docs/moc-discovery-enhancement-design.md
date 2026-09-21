# MOC 探索的可选 LLM 增强

2026-09-21 实现：现有“新建公开 MOC 探测”表单展示只读 CDS 地址
`https://alasky.cds.unistra.fr/MocServer/query`，旁边为默认关闭的“启用 LLM 增强”。
悬停/键盘聚焦说明触发条件。配置不可用时禁用开关，普通 CDS 探索仍可用。

## 边界与触发

仅修改 Assets。Warehouse 保留现有受控 CDS 查询、任务及 evidence 合同；Workspace 不变。
Assets 接收额外布尔 `llmEnabled`（缺省 false），本地保存，不传入 Warehouse CR。
CDS 成功、候选数明确为零、完整 v2 摘要不截断时才执行增强。CDS 有候选、失败、超时、
摘要缺失/不完整都不触发。地址由后端固定，客户端不能更换 CDS endpoint。

后台每五秒推进已开启任务，单次串行执行；不依赖浏览器轮询。状态及候选持久化至
content PVC 的 `llm-discovery-v1.json`，并通过 `llm-discovery` 命名空间归档到 authority。
运行标记先于调用落盘；运行中重启标记 interrupted，不自动重复付费请求。原“重新探查”
创建新的 CDS 尝试并继承增强开关。没有独立的 LLM 任务页面或新的用户提交步骤。

## 模型与联网

首次启动从环境配置导入；之后通过“API 设置”加密保存并管理，已停用配置不回退。
环境配置 `ASSETS_LLM_BASE_URL`、`ASSETS_LLM_MODEL`、`ASSETS_LLM_API_KEY`；本次服务为
`https://token.72602.space` / `glm-5.3`。凭证由独立 Secret 注入后台，网站无此凭证。
Helm 的 `llm.enabled` 默认 false；启用时设置 baseUrl/model/secretName，Secret 键为 api-key。
`.info` 只用于部署时读取，运行时不使用，也不进入 Git 或镜像。

使用两阶段 OpenAI 兼容 Chat Completions：模型先提出 CDS 查询别名和可能的官网地址，
Assets 实际查询 CDS、读取页面及有限的覆盖相关链接，再让模型根据取得的材料输出候选。
采用非思考模式以避免推理耗尽输出预算；若服务返回截断或无效 JSON，明确失败。
不依赖网关原生 web_search/function calling；不承诺穷尽全网搜索。

每次最多两次模型调用、五次 CDS 查询、十个页面，整体 180 秒，单页面 2 MiB，
来源累计 10 MiB，输出最多 20 条。读取每跳检查 DNS 与公共地址，并将连接固定到已校验 IP；
拒绝私网、本机、metadata、带凭证 URL 和非 HTTP(S) 地址，最多三次重定向。
页面是数据，不是工具指令。模型无产品编辑、审核、发布能力。

## 候选与构建

摘要标明 LLM 来源、引用、来源页、抓取时间/hash 和 observed/planned/simulated/unknown。
引用必须在实际取得的页面文本中出现，MOC URL 必须在该材料或其链接中出现。
无法证明同一巡天/DR/产品、未知/计划/模拟或没有覆盖文件的结果仅为线索，禁止构建。
模型的匹配判断不是科学验证；用户仍须检查其语义和范围。

可选择候选通过 Assets 的统一解析入口进入现有 MOC 构建；构建请求仍只指定任务及候选 ID，
实际 URL 来自持久化结果。LLM 来源使用公共地址受控下载，CDS 保留原来源规则。
构建重试、恢复和重新校验均识别两种来源。格式、ICRS/NESTED、哈希、真实原生 order >=4、
人工审核与发布门禁不变，不从旧预览制造覆盖。

原始页面、模型响应、错误与 token 用量保存在 evidence PVC，并排队归档；不进入初始
浏览器载荷或公开资源包。失败、部分来源失败、空候选分别提示；用量未返回时记录 unknown。
后台 `/admin/api` 提供 LLM 配置和用量，以及独立的对外 API Key 管理，见
[API 设置说明](api-management-design.md)。探索详情先展示结论、来源性质、缺口和下一步，
原始引用折叠；只有线索时标记“探查完成，仅有线索”，不显示可审核。

## 验证

fixture 覆盖严格空结果触发、关闭/有候选/失败/不完整不触发、引用伪造、线索禁构建、
空结果/格式错误/token 上限/服务错误、并发 tick 去重、重启不重复调用和凭证脱敏。
浏览器验证只读地址、默认关闭、悬停/焦点提示、未配置禁用及 1440/900/390px。

真实 SDSS DR9 color imaging 验收通过 Assets 取得 3 条有引用线索（CDS 记录、DR9
imaging 页面、DR9 官网），均未认定为可构建 color imaging MOC。部分页面读取失败如实
标注；没有因此自动构建、审核或发布。首次测试遇模型思考耗尽输出预算，修正为非思考模式
并保留截断错误后重新验收成功。这是来源探索，不是找到该产品可用 MOC 的承诺。
