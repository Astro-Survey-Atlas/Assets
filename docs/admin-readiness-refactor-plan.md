# Assets 管理后台与数据就绪度重构计划

## 2026-09-15：任务记录分栏与紧凑构建结果

任务页标题下增加 02A 任务产出 / 02B MOC 探测记录 / 02C 文件扫描记录三个标签，
保留原有分工与操作入口。每次只显示一块，标签滚动吸顶、支持键盘与会话记忆；
切换仅改变隐藏状态，不重建列表或表单。跨标签使用的 dialog 放到任务页公共容器，
避免从任务产出打开候选审核时继承隐藏状态。创建构建后转到产出，产品/Connector
跨页发起探索或扫描时选中相应标签。轮询仍复用原调度器，不引入额外定时器。

构建结果统一为紧凑行：名称与发布/登记状态、构建阶段、实际 order/单元数、详情与登记入口；
只有运行中显示进度条，失败保留错误摘要，完整生命周期/输出引用留在构建详情。
关联和未关联的构建使用同一个行组件，避免第 N 条产生不同的大卡片。
Connector 列表和详情共用状态推导与图标前景、底色、边框颜色，覆盖 Local/S3 及明暗主题。

回归覆盖：五次轮询保持当前选择、标签键盘切换/刷新记忆、隐藏标签中的共享弹框、
第 4 条构建桌面高度 <100px、Local/S3 四种状态及暗色图标颜色逐项一致。

## 2026-09-15：审核与发布操作反馈

本轮修复同意限制的勾选框与首行文字对齐、取消按钮自适应宽度、Connector 标题固定
44px 正方形图标与长名称换行，三个操作改为同一行 36px 正方形图标按钮（保留可访问名称与提示）。
审核成功后展开所属巡天、定位产品行、焦点回到产品入口，绿色高亮 5 秒后恢复；轮询重绘时
保留高亮剩余时间。发布/审核请求按产品互斥，按钮即时 disabled/aria-busy 与 spinner；
失败恢复重试，同一请求期间不能从另一个入口重复发出。

用户第 4 项仅要求解释：保留工作副本和已发布快照的模型未改，重复的能力面板未合并。
发布是复制 draft 到 published 并记录 publishedRevision，之后编辑工作副本不影响公开快照。
建议后续在内容、版本及证据一致时合并展示，存在未发布变化时再分开展示；待用户决定。

本地 `scripts/admin-action-feedback-browser.py` 拦截所有审核/发布请求，验证同意框、短取消按钮、
行定位/高亮消退、spinner、重复点击单请求、发布失败后重试成功、Connector 移动端正方形/同排。
不通过真实审核或发布来做 UI 测试。

验收：已部署 dev revision 142，镜像 `0.1.0-20260915-133500`。Build、198 Node
测试、Core wheel、TypeScript、Helm lint、新增动作浏览器回归通过。实际 dev 产品
`b2c58698f7945ea9c0a2` 的同意框/取消按钮及 Connector 桌面/移动布局只读验收通过。
生产及权威包未改变；第 4 项仍仅解释，未合并版本面板。

## 2026-09-15：公开内容纠偏与管理页视觉统一

本轮按确认计划实施：公开测试层服务端排除；SDK 改为 Core 介绍与官方文档入口、移除独立 CLI 示例和旧版本/归属说明；GitHub 页更新四个项目的职责与文档/源码入口；巡天图片统一低饱和展示与徽标完整容纳；发布状态统一徽章；产品模态图标与 DR 模态计数；实际执行记录复用发布检查的紧凑状态行、可折叠制品与真实版本提示。中英文同步，保持原图/来源、现有证据和公开能力语义不变。通过回归后仅部署 dev。

smoke 来源调查（配置的 Warehouse `ast_layer_index_v1`，只读）：

| layerId | survey / release | scan_run_id |
| --- | --- | --- |
| smoke-catalog | smoke / local | minio-catalog-smoke-newinfra-20260826 |
| assets-smoke-image-euclid-vis | euclid / q1-smoke | assets-atlas-image-euclid-20260826-20260826034043 |
| assets-atlas-spectrum-sdss-current | sdss / public-smoke-current | assets-atlas-spectrum-sdss-current-20260826-20260826034844 |

三层为 ACTIVE，运行时合并将它们加入 coverage API；巡天目录和资源清单均无这些记录。
修复使用确认过的精确 layerId，不做名称关键字泛化。配置的额外排除项与内置测试层取并集，
避免复用旧 Helm values 时重新暴露。保留 Warehouse 测试数据及原始证据，不进行删除。

验收包括：测试层不在覆盖目录/天球列表，直接块查询和反查不返回内容；正式层保留；
SDK/GitHub 链接及中英文正确；图片悬停/聚焦恢复原色；发布徽章、模态统计、执行记录各状态、
缺失版本与长哈希、明暗主题及移动端；五轮轮询不重置表单。完成后记录实际 dev 版本及截图。

完成记录：2026-09-15 已部署 dev revision 141，镜像 `0.1.0-20260915-113800`。
198 项 Node 测试、Core wheel、build、TypeScript、Helm lint 及本地五轮/执行记录样式浏览器回归通过。
线上 coverage/catalog 的三个测试层已排除（124 层），直接块查询 404、反查无结果；
SDK/GitHub 中英文和实际产品执行记录通过浏览器验收；DESI FITS Range 为 206 且带内容 SHA。
权威 bundle 和生产环境不变。截图 `/dev/shm/asa-sep15-dev-141/`，未提交 Git。

日期：2026-09-13

状态：实施中。本文件是防漂移基线；每个阶段只在有实现和验证依据后更新状态。

## 本轮实施：视觉精修与任务可观测性（2026-09-14）

- 巡天清单改为约 100px 高的紧凑横向条目：真实项目图片、名称、集合/产品/覆盖/文件定位/发布指标。保留 L0–L3 统计与巡天详情路由。图片独立映射、记录来源、懒加载；不能用覆盖点阵或其他项目照片冒充。
- 删除页头低信息量介绍，namespace、接口连接、资源数量、更新时间与刷新控制合并；使用公共站正式 Logo 与明暗主题资源。接口连接不等于执行器健康。
- 发布检查使用 14px 标题与 12–13px 说明，红色阻断、琥珀待处理、绿色通过，同时提供文字、图标和绑定产品的操作；门禁不弱化，不让用户填写 JSON 或编造证据。
- Connector 采用居中图标、名称位置、右侧数量三栏布局。整项低饱和连接状态色；选中描边保留状态底色。旧检查标时效，扫描观察量不能冒充盘点总量。
- 提交后的探索请求必须显示独立于执行器回写的观察摘要：提交时间、等待时长、最近检查、最后进展、执行器健康与诊断来源。Assets 服务端通过有界、缓存的 Kubernetes 只读观察汇总；不发送完整日志。
- 默认 120 秒未创建 Job 标为等待异常，Helm values 可配置。超时不能单独证明执行器坏了；有真实关联诊断才显示执行器异常，无诊断明确“原因尚未确认”。查询失败保留最后已知状态，不回退为 pending。
- 列表与详情共用推导；打开的状态详情允许局部更新，不能重建候选选择和表单。恢复后观察原请求，不删除、不重复提交，不提前承诺一定自动恢复。
- 已核实独立探索 Deployment `astro-atlas-moc-discovery` 具有自己的 ServiceAccount/RoleBinding，其日志出现 `RejectedExecutionException` 与 `Java heap space`。此前仅根据扫描 operator 的权限断言探索失败的交接结论不充分。Warehouse 排查客户端/线程池及堆内存，修复与健康检测归 Warehouse 所有。
- 验收分开：执行器恢复必须观察原 Euclid 请求的 Job/执行结果；状态反馈必须在执行器不可用时依然工作。覆盖超时、故障、无诊断、查询失败、恢复、终态及五次轮询保留操作状态。
- 完成测试、构建、Helm 与 Warehouse 专项验证后部署 dev，在用户地址 `http://astro.assets.dev.72602.space:32080/admin/overview` 核对版本、截图和交互。保留用户工作区及暂存内容，不修改生产环境与公开权威数据。

以上完成情况随验证记录更新，不以实施方案代替完成声明。

### 本轮验收记录

2026-09-14 已部署 dev revision 140，镜像 `0.1.0-20260914-171000`。
用户入口 `http://astro.assets.dev.72602.space:32080/admin/overview` 实际浏览器通过：
巡天条目 104px、发布检查标题 14px、阻断与待处理颜色不同、32 张独立本地展示图、
Connector 整项状态色及右侧盘点量、正式 Logo、明暗主题与移动端无溢出。
本地五轮自动刷新、保留树选择、执行器 OOM/诊断恢复/状态接口失败等回归通过。
Assets build、197 项 Node 测试、Core wheel、TypeScript、Helm lint 通过。

原 Euclid 请求 `euclid-moc-discovery-20260914065533` 已 SUCCEEDED，Job Complete，
候选数 1；未删除或重复提交。Warehouse 已部署控制循环与健康检查修复（revision 6）；
静态门禁和 Asset caller smoke 通过。Warehouse Local fixture 缺少 CSV、Workspace
namespace 缺失使完整跨环境 smoke 尚未全绿，不能与本次 Euclid 恢复混为一项。
权威 bundle 与生产环境未改变。截图保存在 `/tmp/asa-admin-visual-dev-140/`。
总览未加载任务明细时，工具栏与导航数量直接使用总览汇总，避免显示错误的 0 或占位符；
此修正已经实际浏览器验证。DESI FITS Range 返回 206 与内容 SHA。

## 1. 目标与已确认决策

让管理员明确回答：有哪些数据、达到什么能力和精度、缺什么、如何补齐、发布后是否真的可用。

用户确认的约束：

- 维持现有 Helm values 控制部署，不实施 public/full 双模式改造。
- 管理后台以探索为主，扫描为补齐空间索引的辅助步骤。
- 探索支持指定官方站点、现有 CDS 来源和已登记存储。首批选择 CDS、一个官方 DR 来源、一个已接存储跑通；其他来源允许人工结构化登记并附证据。不承诺首轮自动覆盖全部巡天。
- Connector 盘点范围为配置授权的 bucket/prefix 或 PVC/basePath，不以已探索数据量冒充存储总量。
- 纳入必要的 Warehouse 接口与任务实现：Assets 管理探索意图、结果、证据、审核和发布；Warehouse 执行抓取、盘点和扫描。
- 允许分级发布：来源可追溯、输出通过校验的产品可以披露证据缺口后发布；来源缺失、输出校验失败或能力声明无依据时阻止发布。
- 单人可以完成探索、审核、发布；记录审核版本与时间，内容变化后审核失效。首版不引入多用户审批体系。
- 发布顺序固定为：候选包上传权威 → 按固定 hash 隔离恢复验证 → 通过后切换 public/current.json → 核验目标站点。
- 目标站点未使用新版本时显示“站点待生效”；只有站点核验通过才算闭环完成。首个目标为 https://astro.assets.72602.space/ 。
- 保留现有重启 hydrate 更新方式，不新增自动更新轮询。验证不隐含允许自动重启任意环境。

## 2. 当前基础与问题

已有 Connector 列表和连接探测，但探测结果主要保存在页面内存，没有持久盘点量与统计范围；PVC Bound 只证明绑定和挂载授权，不能证明目录可读。

现有探索主要是 Warehouse 的 CDS MOC 候选搜索，不等于完整的 DR、产品、存储布局和文件反查调查。已有产品存储、MOC 构建、发布队列、S3 状态快照及同步状态，应复用而不是重建平行流程。

发布计划已有巡天级变更统计，需要产品级差异与独立恢复、站点生效验证。部分证据展示按模式生成方法和代码模板，不能用作实际运行记录。

## 3. 管理页面结构

2026-09-14 刷新与导航修正：移除总览重复刷新及新建探索入口，恢复 L0–L3/待补充互斥统计和工作/公开版本切换。使用 `/admin/overview`、`/admin/sources`、`/admin/tasks`、`/admin/review`、`/admin/releases`，并支持巡天及产品详情深链接；旧 hash 链接兼容。

工作区分别声明请求资源，路由切换取消旧请求并丢弃过期响应。业务内容不变不重绘；总览与构建结果按稳定键更新 DOM。自动更新有会话级开关，页面不可见时暂停；任务/发布运行期间 3 秒，其余 15 秒。弹框内维持打开时的事实和表单快照，背景更新只提示，关闭后显示新数据。选择树保存搜索、选中项、分支展开及滚动位置。发布计划读取失败保留上一成功结果，提交仍由服务端验证版本。

构建卡片从父级左栏移至整行，身份、状态、进度和操作按纵向分区展示，消除右侧空白；窄屏自动单列。

| 工作区 | 内容与主要操作 |
| --- | --- |
| 数据总览 | 巡天 → DR → Product；突出就绪度、精度、完整性与缺口 |
| 数据来源 | Connector、官方来源、连接检查、授权范围盘点及关联产品 |
| 探索与处理 | 官方探索、存储探索、候选审核；关联盘点、采集、扫描及重试记录 |
| 发布与验证 | 产品级差异、审核门禁、发布进度、隔离恢复及站点核验 |

产品详情固定为：概况、来源与输入、处理过程、输出与反查、验证记录、发布历史。各工作区链接到相同产品详情，避免重复编辑事实。

巡天列表、DR 列表、详情标题和产品卡片必须直接展示状态，不依赖悬浮提示。公开页面展示已发布版本的同一套就绪度摘要。

2026-09-14 易用性约定（覆盖此前平铺列表及可编辑登记表单）：

- 总览首屏为巡天卡片；点击后展示该巡天的数据发布 / 集合及产品状态，支持返回和搜索。
- 能力以中文说明为主、L0–L3 为辅；区分“工作版本”“公开版本”“尚未发布”，删除“已发布·未发布”一类矛盾标签。详情默认查看证据，说明编辑为显式展开操作。
- Connector 使用紧凑统一的存储图标，移除大幅背景水印。
- 候选选择前标明已有构建、登记或发布及产品名称；按候选身份/来源关联的提示不替代构建时的内容哈希判重。集合/滤镜名称不能冒充官方 DR。
- 构建登记只确认系统事实。巡天名称、简介、项目、颜色和模态由服务端统一继承，未知简介明确待核实；登记接口不接受调用方覆盖这些巡天事实。
- 新建探索通过可搜索的巡天 → 数据发布/集合 → 产品树选择已有产品，允许不绑定；探索请求未创建 Job 时标“等待接单”，显示提交时间和最后更新。
- 审核前展示具体阻断项、可披露限制和发布阶段验证。探索输入是查询/响应和下载的来源 MOC，系统保存证据；用户不编写 JSON 或手填哈希。已有构建提供真实产物校验；缺口按钮携带当前产品进入对应探索、扫描或发布操作。

## 4. 数据就绪度标准

最小评级单位是 Product 的具体版本。能力等级、空间精度、索引完整性、证据状态分别记录，不能混成一个分数。

| 等级 | 名称 | 必要条件 |
| --- | --- | --- |
| L0 | 来源已登记 | 产品身份明确，有可追溯来源依据 |
| L1 | 覆盖可查询 | 有经校验的空间覆盖，声明坐标系、实际阶数、覆盖含义 |
| L2 | 单元可反查 | 稳定单元 ID 与空间范围对应，可定位 Tile、曝光或图像等单元 |
| L3 | 文件可定位 | 空间直接或经单元关联到具体文件，包含标识、位置与匹配依据 |

不满足 L0 标为“待补充”。L3 不强制经过 Tile，文件自身可作为数据单元；不要求公开匿名下载。
访问权限、地址有效性和来源系统的获取方式单独说明。下载计划是来源清单文件；Assets
不替用户下载或裁切科学数据。无直链时仍展示已有来源依据，不据此降低其空间证据等级。

每个版本附带：

- 空间精度：覆盖查询和反查分别列出真实支持的 order；非 HEALPix 索引保留原生几何依据，不制造阶数。几何依据包含原生 MOC、WCS、官方单元边界或估算。
- 索引完整性：完整、部分、未知；保存统计范围、已处理量、已知总量、统计时间。无分母不显示百分比。一次请求截断不等于整个索引不完整。
- 证据状态：输入锁定、实际执行记录、输出校验、隔离恢复验证的独立结果与缺口。
- 发布状态：草稿、待审核、已审核、发布中、权威已发布、站点待生效、站点已验证；阶段失败独立记录，保留上一成功版本。

等级依据制品与检查结果推导，不能手动勾选升级。已有较高能力但证据不足时，只声明可证实能力并列出缺口，不补造历史。

巡天和 DR 汇总规则：

- 按产品最高达成等级展示 L0/L1/L2/L3 分布及待补充数量。
- 另列有覆盖、可反查单元、可定位文件的产品数量；L3 计入较低能力的累计数量。
- 混合精度显示“精度不一致”并允许查看产品分布，不以最高阶数代表整个巡天或 DR。
- 草稿与已发布版本分开汇总；公开页只读取发布快照。
- 缺口链接到证据与建议补全操作，不把“未知”当成失败或零值。

## 5. 数据来源、Connector 与探索

数据来源描述科学出处；Connector 描述协议、位置、授权范围与凭据引用。探索可以没有 Connector，但每份发现必须有来源。官方探索可发现多个位置，不采用必填单一 connectorId。

Connector 概览展示类型、授权范围、检查时间与能力、盘点时间、对象数、总字节数、完整性、关联探索和产品。

- 快速连接检查和异步盘点分开，结果持久化；旧检查注明时间，不暗示实时可用。
- 本地存储区分 PVC 绑定、挂载授权与实际目录读取验证。
- 盘点支持分页、进度、失败重试及中断状态保留；未盘点为未知，部分遍历为部分。
- 任务记录 Connector 标识、当时配置版本和实际范围，不保存凭据到证据记录。
- 大清单进入 evidence 存储；页面初始请求及任务状态只带有界摘要，详情分页读取。

探索结果记录：

- 巡天、DR、产品、模态、数据类型、覆盖含义、特殊性及限制。
- 官方来源、抓取时间、来源快照及 hash；重要事实关联依据，推断与核实事实分开。
- 存储位置、协议、认证要求、组织结构、索引或查询服务。
- 总 MOC、逐单元边界/MOC、Tile 表、文件清单及空间查询接口的可用性。
- 可支持的反查能力、完整性、缺失项和下一步建议。

默认路径：调查官方来源 → 获取覆盖 → 查找官方单元/文件索引或空间服务 → 缺失时关联 Connector → 盘点及必要元数据扫描。不能默认下载整个 DR。

总 MOC 的 HEALPix cell 不等于巡天 Tile；合并覆盖不能恢复被丢弃的 Tile/文件身份。空间到数据单元到文件可能多对多。匹配文件不代表文件已裁剪到查询区域。

人工确认后才将候选关联或创建为产品、Connector；保留多次执行和候选审核历史。

## 6. 实际证据与审核

每个实际步骤保存输入引用/hash、参数、工具版本或镜像 digest、时间、执行结果、输出引用/hash、校验项、失败原因。来源快照、执行记录和输出通过稳定 ID 关联。

公开展示区分来源声明、方法说明/示例代码、实际执行记录、验证观察。模板不得产生执行成功记录；hash 证明内容一致，不单独证明科学正确性。

审核记录绑定产品 revision、制品与证据版本。任何影响被审核发布内容的变化使审核失效。管理员可以接受明确披露的证据缺口，不能绕过来源与输出完整性门禁。

## 7. 发布与验证闭环

发布前产品级差异包括新增、修改、移除，以及来源、覆盖、order、文件映射、资源包、就绪度和证据缺口变化。绑定审核 revision 与基线 release hash，拒绝过期计划。

复用队列、状态快照和同步状态，按以下顺序执行：

1. 构建候选包并上传权威不可变位置，暂不切换 current。
2. 在干净验证目录按候选 hash 从权威恢复，不借用管理侧缓存或文件。
3. 验证 manifest、目录、产品详情、覆盖、反查索引和资源包的完整性及引用一致性；不适用项明确记录。
4. 通过后使用现有并发保护机制切换 current；基线已变化则阻止过期候选覆盖。
5. 核对配置目标站点的实际 bundle hash 和受影响产品；执行适用的固定覆盖/反查案例、下载与资源包校验。
6. 目标站点为旧版时标为待生效；核验通过后才完成该目标的发布闭环。

验证目标仅来自运维配置，不接受任意探测地址。首个目标是 72602。人工触发重新核验可以保留，不新增自动更新发布包机制。

各阶段显示错误、失败时间、证据及可用重试。验证重试不重新发布；验证失败不抹除上一成功版本。公开回退作为显式操作，不在未知错误下自动切换版本。

## 8. 接口、存储与迁移

扩展就绪度摘要、Connector 检查/盘点、探索发现、产品执行证据、审核和发布验证接口。使用稳定关联标识；列表有界摘要，清单分页，原始 evidence 不进入初始浏览器请求。

复用 S3 authority 与状态恢复机制；新增命名空间必须有保存/恢复验证。凭据继续保存在既有 Secret 体系。运行时只连接配置的 Warehouse ES，不引入旧 ES 回退。

历史数据按实际可核验材料生成就绪度和缺口清单。迁移不能重写历史执行事实、虚构验证通过或自动授予 L3。旧任务与发布历史保持可访问；新增公开字段保持向后兼容。

修改覆盖、扫描、MOC、证据和反查代码前，按 AGENTS.md 查找并阅读 coverage-workflow skill 与相关契约；跨 Warehouse 修改也必须读取其仓库约束。

## 9. 实施阶段与验收矩阵

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| P0 | 核对 Assets/Warehouse 契约，选典型 DR 和存储，锁定样例与历史缺口 | 已完成（实现核对） |
| P1 | 就绪度规则、历史推导、巡天/DR/Product 总览与摘要接口 | 已完成（首版） |
| P2 | 持久连接检查、Warehouse 盘点、典型官方探索及产品关联 | 进行中（探测与对象存储分页盘点已持久化；Assets 已兼容只读 Warehouse `AstroDataSource`，但 Warehouse 原生/PVC 盘点契约仍未完成） |
| P3 | 产品证据详情、实际步骤记录、分级审核和审核失效 | 已完成首版（执行收据、revision/hash 审核门禁与失效已实现；历史证据迁移仍需补齐） |
| P4 | 产品级差异、先隔离验证再切 current、目标站点核验 | 已完成首版（产品 diff 含 added/modified/removed；候选 hash 隔离恢复和 Resource Package 语义校验通过后才 CAS 切换；固定目标核验入口已实现，72602 实际核验待部署） |
| P5 | 四工作区收敛、公开摘要、浏览器闭环测试与部署验收 | 进行中（四工作区、公开摘要和浏览器 smoke 已验证；目标环境部署验收待完成，smoke 不替代完整发布闭环） |

P0 优先选择同时公开覆盖及 Tile/文件索引的 DR。具体来源与存储由只读检查确定并记录；不为凑齐 L3 生成不实关系。

必须覆盖的验收：

- 混合 L1/O8 与 L3/O4 的 DR 正确汇总，不声称全部支持 O8 文件反查。
- Connector 刷新后保留状态；未盘点、部分、完整、权限失败明确区分。
- 官方探索无需 Connector；存储探索可追溯配置版本与授权范围。
- 总 MOC 只达 L1；可验证单元映射达到 L2；文件映射达到 L3；受限下载不伪装为公开直链。
- 证据模板不生成运行通过；审核后内容变更阻止沿用旧审核。
- 候选恢复失败不切换 current；基线变化阻止过期发布；目标站点未更新时不报全部完成。
- 清空管理缓存仍可从权威恢复完整候选；目录、覆盖、详情、反查与资源包引用可用。
- 浏览器端到端完成：查看 DR 状态 → 定位缺口 → 探索/处理 → 审核差异 → 发布 → 查看站点验证。

## 10. 防漂移规则与非目标

- 每阶段完成必须附实现与验证依据，再更新矩阵；不得用“页面已有按钮”代替真实后端能力验收。
- 数据结构细化、接口路径和组件拆分可按代码现状决定；改变已确认产品语义、职责归属、发布顺序或范围时，先更新本计划并明确变更原因。
- 本轮不改重合算法、不扩展全网自动发现、不自动覆盖所有巡天、不另建部署模式、不建设多用户审批体系。
- 不以增加巡天数量、整体视觉换肤或大规模框架迁移替代数据就绪度、证据链和发布闭环。

## 11. 实施记录

### 2026-09-13 P0/P1 首批落地

- 已核对 Assets `ProductRecord`/`CoverageCellLayer`、管理端 Kubernetes
  `ScanRequest`/`MocDiscoveryRequest` 接口，以及 Warehouse v2 的
  `CoverageLayer`/`FileAsset`/`SourceSnapshot` 约束。Warehouse 当前没有独立的
  授权范围 inventory API，因此 Connector 不能把一次扫描的 `discoveredFiles`
  当作 bucket/PVC 总量；P2 需要先补该契约。
- 典型官方 DR 锁定为 DESI DR1：已有官方 `tiles-iron.fits` 输入、
  `tile-table` recipe、ICRS/NESTED 输出和可复核的 Tile 目录，适合作为 L2
  单元反查样例；文件级 L3 仍需 Warehouse `ast_file_index_v1` 的真实执行证据。
  典型本地存储为带 `atlas.zhejianglab.org/scanner-source=true` 的 Bound PVC，
  对象存储样例沿用 S3/OSS ConfigMap + 引用 Secret。
- 新增 `server/admin-readiness.ts`：Product 版本推导 `-1/L0/L1/L2/L3`、几何与反查
  独立 precision、完整性状态、证据状态及缺口；`aggregateReadiness` 只给出
  产品分布和累计能力数量，不用最高产品等级代表整个 DR。
- 新增 `GET /api/v1/admin/overview`，返回有界的 Survey → DR → Product 摘要、
  草稿/已发布分别汇总、coverage 加载状态和任务/探索/构建计数；未配置 Warehouse
  时仍可返回静态产品事实，原始 manifest/normalized scan 不进入初始响应。
- 管理页面新增“数据总览”工作区，把真实等级、order、反查能力和缺口直接挂在
  巡天/DR/Product 行上；Connector 行显示配置范围、最近扫描观测和“未盘点/未知”
  状态，任务、审核、发布工作区保留原有操作入口。
- Connector 按需探测结果现在写入内容卷 `connector-probes-v1.json`，并通过新增
  `connector-probes` 状态快照命名空间同步；状态不含凭据，刷新和重启后仍可见。

### 2026-09-13 P2-P4 首版闭环

- Connector 新增 `POST /api/v1/admin/connectors/{name}/inventory`。S3/OSS 按
  `ListObjectsV2` continuation token 分页累计对象数和字节数，状态写入
  `connector-inventory-v1.json` 与 `connector-inventory` 快照；`complete` 才提供授权
  范围总量，`running`/`partial` 保留有界进度。本地 PVC 仍明确为 unknown，等待
  Warehouse 原生 inventory API，不用扫描 `discoveredFiles` 冒充总量。
- ProductStore 增加 revision 绑定的执行收据（输入/输出引用、hash、工具、参数、检查和
  失败原因）及 `GET/POST .../executions`；方法模板代码标记为
  `classification=method-explanation`。草稿或执行证据变化会清除旧审核。
- 产品审核只接受当前真实缺口，来源不可追溯、覆盖依据缺失和输出校验缺失会阻止审核；
  发布要求审核 hash/revision 匹配并接受其余缺口。发布计划现在包含产品级 added/modified
  字段 diff，未审核 revision 直接阻塞。
- Release publisher 拆分不可变 archive 上传、hash 隔离恢复校验和 current CAS 激活；
  候选失败或基线变化不切换指针。`ASSETS_PUBLIC_VERIFY_URL` 配置固定目标，支持核验
  `/healthz`、公开产品、coverage catalog 和 Resource Package catalog，旧 bundle 显示
  `site-pending`。
- 首版验证：`npm run build:server`、`npm run build:site`、管理/产品/发布/HTTP 相关
  Node 测试通过；尚未进行 72602 目标站点实际部署核验，也未新增 Warehouse inventory
  控制器或浏览器自动化测试。

首批验证依据：`npm run build:server`、`npm run build:site`、
`npx tsx --test test/admin-readiness.test.ts test/admin.test.ts` 和带合成发布根的
`test/server-http.test.ts`（9 项通过）。后续 P2/P5 的 Warehouse 原生盘点、浏览器 E2E
完整交互闭环和 72602 目标站点部署核验仍需单独完成。

### 2026-09-13 P2-P5 收尾验证

- Assets 管理端同时读取自有 Connector ConfigMap 和只读 Warehouse
  `org.zhejianglab.astro.metadata/v1alpha1/AstroDataSource`，按名称去重；从
  `spec.mount`、`credentialSecretRef` 映射授权 PVC/basePath/Secret。新增 RBAC 只读
  `astrodatasources`，不创建 Warehouse 数据源或 PVC。Warehouse 尚无授权范围 inventory
  合同，PVC inventory 继续明确为 `unknown`。
- 候选 release archive 的隔离恢复现在解析每个 Resource Package ZIP 的
  `resource-package.json`，校验 `id/version/surveyId` 与外层 catalog 绑定；语义校验失败
  停在 candidate 阶段，不切换 `public/current.json`。新增回归用例覆盖身份不一致。
- 产品退休是显式、可审计的管理操作：保留 published 历史内容，当前公开产品/asset/
  coverage/反查隐藏，发布计划给出 `change=removed`；退休后编辑、执行证据、审核和重新发布
  被拒绝，重复退休保持幂等。
- 新增 `scripts/admin-browser-smoke.py` / `npm run test:admin-browser`，真实登录管理台、
  切换五个工作区、检查横向溢出并验证 overview schema。验证命令（本地服务）：
  `ASSETS_ADMIN_URL=http://127.0.0.1:4199/admin/ ASSETS_ADMIN_TOKEN=... npm run test:admin-browser`。
- 本轮验证：`npm run build:server`、`npm run build:site`、`npx tsc -p tsconfig.site.json --noEmit`、
  Product/Publication focused tests 全部通过；使用隔离 release root 的 `test/server-http.test.ts`
  通过（8 passed，1 intentional skip）。目标 `ASSETS_PUBLIC_VERIFY_URL`/72602 仍未在本轮部署核验。

### 2026-09-13 管理闭环补强

- readiness 详情的每个缺口现在带有明确的工作区动作：来源/盘点跳转到数据源，覆盖、单元和执行缺口跳转到探索与处理，输出证据跳转到审核，隔离恢复跳转到发布与验证；跳转不会把未知状态误报为失败。
- 产品详情按需读取并展示审计历史（登记、草稿、执行、审核、发布、退休），避免把历史内容塞入总览响应。退休产品在管理列表和详情中显示 `RETIRED`，编辑、审核和发布控件关闭；服务端 lifecycle 将其 runtime 标为 `INACTIVE`，历史公开内容保留但不再暴露当前入口。
- 增加 Warehouse 原生 `access-key`/`secret-key` Secret 字段及 Secret resourceVersion 轮换失效测试；Assets 自有 Connector 的历史 `accessKey`/`secretKey` 仍兼容。`docs/data-warehouse-requirements.md`、`docs/api-reference.md` 和架构边界已明确该只读兼容边界。
- 目标站点核验增加 products/layers/packages 的存在性和 survey 身份断言，并在无 `products[]` 时 fail-closed；新增可注入 HTTP 客户端的成功、缺失、归属错误和契约缺失测试。
- 发布失败现在持久化 `failureStage`，管理端显示停留步骤并可按当前计划创建新的重试 run；站点核验仍单独重试，不重新发布。
- 本轮验证：`npm run build`、`npm test`（188 passed）、`npx tsc -p tsconfig.site.json --noEmit`、管理/产品/发布 focused tests、`helm lint charts/astro-survey-atlas-assets`、`git diff --check` 和 `ASSETS_ADMIN_URL=http://127.0.0.1:4199/admin/ ASSETS_ADMIN_TOKEN=... npm run test:admin-browser -- --allow-control-plane-unavailable --workflow` 均通过。浏览器脚本的 workflow 模式已覆盖总览 schema、产品详情/历史、缺口工作区跳转和发布验证工作区的只读串联。当前仍未完成 Warehouse 正式 PVC inventory 合同、`astro.assets.72602.space` 部署核验及会执行写入的完整浏览器发布闭环。

### 2026-09-14 最终代码验收

- 重新执行 `npm run build`、`npm test`（188 项）、`npx tsc -p tsconfig.site.json --noEmit`、`helm lint charts/astro-survey-atlas-assets` 和 `git diff --check`，全部通过。
- 本地服务 `http://127.0.0.1:4199/admin/` 的管理台 smoke 以 `--allow-control-plane-unavailable --workflow` 通过；workflow 为只读检查，未伪造 Warehouse 或发布写入结果。
- P2/P5 矩阵仍保持“进行中”：PVC/授权范围 inventory 需要 Warehouse 正式接口；72602 目标站点核验和写入型发布 E2E 需要明确的部署与授权后才能执行。本地代码和测试不将这些外部门禁标记为完成。

### 2026-09-14 易用性第二轮

- 实现巡天卡片下钻、中文能力说明、默认查看与显式编辑分离、Connector 紧凑图标、候选既有构建/产品提示、只读登记确认和可搜索产品树。
- 审核缺口提供当前产品及关联候选上下文，链接到原探索、补充扫描、真实构建校验和发布恢复流程；输入/输出及校验记录用结构化阅读界面展示，移除流程 JSON 编辑。
- 新增 `verify-build` 产品操作：读取真实来源/输出字节并执行 Core MOC 校验；失败保存记录、撤销旧审核，旧成功记录不能覆盖最新失败。该操作不改变产品能力等级定义或生成新覆盖精度。
- 验证：完整 Node suite 190 项及 Core wheel 通过，构建与类型检查通过；增加来源/输出篡改测试、HTTP 登记事实一致性和失败校验阻止审核测试。本地只读 workflow smoke 与 `scripts/admin-usability-browser.py` 通过。后者使用 JWST/Roman 合成响应，验证搜索、已有候选、只读登记及 390px 窄屏；登记 POST 被拦截，不声称完成真实发布。
- Roman 实际阻塞：`nancy-grace-roman-space-telescope-moc-disc-retry-20260914014039` 无 status/Job；`atlas-system/astro-atlas-operator` 的 ServiceAccount 对 `atlas-warehouse` 的 `mocdiscoveryrequests.atlas.zhejianglab.org` 执行 `kubectl auth can-i list` 返回 `no`，实际 Role 只有 ScanRequest 权限，缺少 MOC discovery 权限。Assets 页面已明确等待接单；控制器权限修复及接单复验属于 Warehouse 部署工作，未在本轮修改其资源。
- 本轮代码尚未部署 dev 或 72602。P2/P5 的原外部验收项继续保留。

### 2026-09-14 dev 部署验收

- 按用户要求部署管理后台易用性改动到本地 k3s dev：Helm revision `137`，镜像 `0.1.0-20260914-125847`，运行镜像 digest `sha256:26d9d11187ed839b027d8da582c5c7f1cc02987aac2e30ea2c032334e71bdf26`。复用线上 values，仅覆盖镜像 tag；site 与 release-publisher 均完成 rollout。
- 部署前 `npm run build`、`npm test`（190 项 + Core wheel）、Helm lint 通过。hydrate exit 0；公开目录和 coverage API 200，DESI FITS Range 206 并带内容哈希；dev 管理后台浏览器 smoke 通过。
- 可用入口：`http://10.15.51.75:32083/admin/`。配置的 Ingress 仍为 `astro.assets.dev.72602.space`，但该域名从当前工作站连接失败。72602 生产站点和 Warehouse 控制器/RBAC 均未修改，原 P2/P5 外部门禁继续保留。

### 待办：发布巡天无法勾选时说明原因（2026-09-18）

- [ ] 在 `/admin/releases` 点击不可选择的巡天选择框或对应交互区域时，弹窗说明该巡天不能选择的具体原因；不能仅依赖原生 disabled checkbox 接收点击。
- 弹窗使用当前发布计划的 `blockers`，区分未审核产品、缺失制品、发布策略限制；无变化时明确提示“没有待发布变更”。未审核产品尽量显示名称、版本及审核入口，不只显示内部 ID。
- 验收：不可选巡天点击后可见原因，支持键盘操作；无阻塞巡天仍可正常勾选；不得绕过服务端发布校验。
- 状态：仅记录待办，尚未实现或部署。

### 2026-09-14 路由与稳定刷新部署

- dev 更新至 revision `138`，镜像 `0.1.0-20260914-142228`，digest `sha256:63967c1b9fd830cf5de1e061fb26d544a9a8676ef4a605aac9dd86d9a280d644`。站点及发布 worker rollout 成功，hydrate 保留原权威 bundle。
- 实施本文件第 3 节刷新与导航修正；新增 navigation/workspaces/stable-dom 模块，未引入框架。工作区复用管理入口壳，但使用独立 URL、请求集合和取消代际，旧 hash 仍兼容。
- 193 项 Node 测试及 Core wheel 通过，站点和服务端构建/类型检查通过；新增路由兼容、观察时间戳忽略、取消后旧响应丢弃测试。浏览器覆盖连续五轮真实请求、Euclid 选择不重建、暂停/手动刷新、变更提示、深链接刷新、构建满宽及窄屏。
- 公开 assets/coverage 为 200，FITS Range 为 206 并带 SHA-256。生产环境及 Warehouse RBAC 未改。
