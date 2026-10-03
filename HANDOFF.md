# Assets 项目交接

交接日期：2026-10-03（Asia/Shanghai）。本文件是当前状态与待办入口；
[实施历史](docs/handoff-history-through-20261002.md) 保留整理前的完整记录。
历史中的“当前”“最新”“待办”按其日期理解，以本文件为续接依据。

## 当前目标与状态

用户要求先完成 Euclid、DESI、Legacy Surveys、HST 四巡天的最小桌面 MVP，
待用户确认主流程后再扩大到更多 component。当前反查使用已有分页 cursor 与冻结快照；
不新增可创建、查询状态、停止/继续的独立查询会话资源。普通浏览按页继续，JSON/CSV
导出可耗尽同一快照，并必须保留实际范围、精度与数据缺口。

第一阶段 MVP 是 Euclid、DESI、Legacy Surveys、HST：
普通 HEALPix 点击展示覆盖的 DR/模态；重合模式支持四巡天的任意组合，
点击整个 component 返回各巡天实际的 Tile/brick/target/observation、原始
footprint/s_region 和来源 URI；JSON/CSV 下载计划与页面内容一致。
Workspace 同步公开图层/MOC 后与本地 CSST 求交，通过服务端 API Key 向 Assets
查询公开分块，并附上 CSST 命中文件的直接父目录。桌面优先，移动端天球适配不列优先事项。

**一个四巡天 component 的完整导出已跑通，其他 component 仍需逐一验证。**
C04 的 875 条属于 DESI + Euclid Q1，不能证明 C01 的 ERO 映射已完成，也不代表完整巡天库存。

## 当前部署与权威数据

本次发布后确认 Helm、Deployment、网站 health/status：

| 服务 | Helm revision | 镜像 tag | 状态及入口 |
| --- | --- | --- | --- |
| Assets | 319 | 0.1.0-20261003-124841 | site/backend 各 1/1 Ready；http://10.15.51.75:32083/atlas/ |
| Workspace | 67 | 0.10.38-dev-20261003-0206-native-selection | 1/1 Ready；http://astro.workspace.dev.72602.space:32080/ |

- Assets release/namespace：astro-survey-atlas-assets；Workspace release：asa，
  namespace：asa-workspace。Assets 的 API 和 health 在 host 根路径。
- /healthz、/api/v1/status 均 HTTP 200；public bundle：
  reviewed-mupsxe2v-c91be91f，603 files，105 published MOCs，catalog 132 layers。
- Bundle SHA-256：0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307。
- 活动 native group：
  8a7745f69bd2d87156933fe5c39d5407c79e333e533c76900fa68f193ea67e5f，
  generation 2，managed=true、verified=true，reverse 服务 available。
- 当前审核接受已知范围缺口；verified 不等于巡天库存完整。
- 此前 ERO alias 更新没有改变公开 bundle、MOC 或当时的 Workspace revision 62。
  /healthz 的 backend-proxy 字段不是实际活动 group；以 /api/v1/status 为准。
- Assets 319 发布 UI/API 代码；公开 bundle、MOC 与 native generation 未变。
  /healthz 和 /api/v1/status 均 HTTP 200，活动 bundle SHA 仍为
  `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，603 files；
  `api/v1/status` 为 105 published MOCs，native generation 2、managed/verified=true。

## Workspace 第二阶段 MVP（2026-10-03）

用户已授权实施第二阶段、部署 Workspace Dev 和真实下载验收。公开原生数据仍由
Assets 持有；Workspace 使用服务端 Key 临时查询，沿用冻结快照/cursor，不新增查询
会话资源。第二阶段没有更新 Assets 的 bundle、MOC 或活动原生索引。

Workspace 已实现无状态文件预览、显式勾选/确认、任务下载及 Connector 注册。
桌面先选择已返回的原生分块，默认每巡天一个，可从前 128 个中增加；改变分块选择
清空旧文件预览和勾选，完整区域及反查/导出分页不受限制。
同一快照重新校验后才能创建任务；持久化例外仅限用户选定的最小文件清单与进度，
重试复用审批集合，不追加新发现文件。CSST 私有覆盖、身份、映射和父目录留在
Workspace，不进入 Assets 请求、日志、仓库或归档。

真实 DESI、Legacy 和 HST FITS 下载完成，大小、磁盘 SHA、FITS 可读性与 Connector
已独立核验。HST 下载后登记资产并独立扫描生成真实 O10、estimated 用户 MOC，
父目录反查已通过。Euclid 当前候选约 1.47 GB，超过默认 512 MiB 单文件上限，
未开始该文件的科学传输。第二阶段成功不替代本文件下面的 ERO C01 映射缺口。

1440px 四巡天与用户覆盖的完整页面/JSON/CSV 核对保留 9,056 个公开记录和
3,893 个直接父目录，三者一致；分页配额等待后继续同一快照。Workspace revision 67
线上 synthetic 桌面检查 4/4；revision 66 完整基线 338 项中 336 通过、2 跳过、0 失败。
67 的 1024px 真实文件预览用 25 个公共产品层，从首屏 100 个原生分块中默认选四巡天
各一个，约 15.3 秒返回 92 个文件候选；全部未选，没有创建下载任务，快照/完整区域
一致，无页面错误或横向溢出，仍保留 selectionTruncated/inventory.truncated。
此前一次解析全部 100 分块在 450 秒内未返回；没有据此宣称大批量解析性能通过。
这次 25 层预览与上述 14 层导出是不同选择。28 个资源包（6 个已安装）
的版本/活动选择与原有用户资产身份均保持；新增的真实验收产物保留在 Workspace。

完整实现契约和实际验收记录位于相邻 Workspace 仓库的
`docs/download-plan-workflow.md`、`docs/api-reference.md` 和
`docs/phase2-mvp-verification-20261003.md`。后续先收集用户桌面反馈，再扩大组件范围。

## 尚未解决的 ERO 映射缺口：DESI + Euclid C01

用户点击的是 O4 C01、cell [190]，面积 13.4287 deg²，
RA 0–9°、Dec 57.3995–63.4483°。当前公开覆盖图命中 Euclid ERO 与 DESI，
但冻结的 ERO 原生映射在此区域没有命中：

- 空间分块只有 DESI DR1 Tile 82406，estimated，URI：
  https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/82406/20211118/ 。
- spatialPage.shown=1、hasMore=false；不是首屏或分页隐藏了 Euclid。
  辅助信息还有自己的分页，混合 omitted 数量不是剩余 Tile 数量。
- Euclid 的 source identity、覆盖依据和官方入口仍保留；页面已提示尚缺 7 个 target
  的空间映射，JSON/CSV 也保留这一缺口。快照为
  queryExhausted=false、inventoryComplete=false、resultTruncated=true。
  分页耗尽与库存完整性必须分开表达。
- **问题属于覆盖 MOC 与原生空间映射的完整性缺口，该组件的 MVP 尚未完成。**
  不能用 Q1 C04 的结果替代这个 ERO 场景的解释或验收。

ERO 当前锁定快照 ID 为
0a6b254384f5082dab056b81f98751805f68ca890c5cfb51da01f1f0941e32e3，文件 SHA-256 为
7f8b99523c7b3a07a9a3c6b5c1dcd9f40d80ed6b4ce2c8970a5c97467af3e323，共 10 条关联记录。
原 8 个排除 target 中，Messier78/M78 别名关联问题已修复；其 ESA Sky outreach footprint
命中 O4 cell [1429]，precision 为 estimated，不在 C01。仍有 7 个 target 没有从已核查的
官方 outreach 表找到可验证 footprint：Barnard30、Taurus、NGC6254、HolmbergII、IC10、
NGC2403、Fornax。这个结论仅限定于已检查来源。

Messier78 在 ESA 表中有 M78/M78_HighRes、object_name 为 Messier 78 nebula，
该明确别名已按来源关联规则纳入索引。IC10 的官方 XML 已有 VIS/NISP Stack/Catalog 包链接，
但当前 outreach 表没有可核实的 IC10 footprint；链接或天体中心不构成区域映射。
只读检查的 images.euclid_outreach 与 images.mv_euclid_outreach_fdw 都为 19 行，
images.mv_euclid_outreach_ext_fdw 为零行，未因此获取或激活新快照。

ERO 原生身份是 target；没有核实的 Tile inventory。继续补关联时仍需核实 footprint
与产品范围，不能编造 Tile 或以点坐标替代影像足迹。本次没有可靠 geometry 能确定
C01 应命中哪个 target，也没有据此增加空间单元。

公开诊断证据（临时文件，可能被系统清理）：
/tmp/assets-c01-details.json、/tmp/assets-c01-reverse.json、
/tmp/assets-c01-browser-before.log、/tmp/assets-c01-before.png、
/tmp/assets-mv_euclid_outreach_fdw.json。

## 已部署修复与已完成计划

| 项目 | 当前状态与限制 |
| --- | --- |
| 原生天空分块纳管 | 已实现来源/快照/候选增量索引/产品绑定/验证/审核/归档/恢复/CAS 激活及管理 UI/API。当前 18 来源、49 绑定、52/52 checks、36 查询样例；六项范围缺口已逐项接受。后续补数据沿用此流程。 |
| 原生管理 UI | Assets 316 已按巡天分组并折叠来源详情、整理索引摘要。1440px/1024px 桌面检查覆盖总览、18 个来源与筛选、ERO 来源操作、17 个任务、审核和激活；无横向溢出或浏览器错误。截图：`/tmp/assets-native-admin-316/`。 |
| HST 请求超时 | 普通及重合反查已共用锁定的本地 CAOM SQLite v4；Assets 请求期间不访问 MAST。 |
| HST 错误跳转 | 313 已将无效 Portal searchQuery=obsid 链接换为 Mast.Caom.Products API 链接。用户打开后看到 MAST 的 JSON 产品清单；不是 Portal GUI。obsid 24125502 实查 HTTP 200、32 products。 |
| C04 授权首屏只有 DESI | 314 已将新快照按巡天交替排列，授权 manifest 页返回独立 spatialPage/supportingPage；旧快照沿用旧排序以兼容续页。这个修复不补齐 C01 的 ERO 映射。 |
| Legacy DR10 South | 官方 366,912 个 roster 成员已全部索引；北区保留 DR9 North 身份，尚无权威 DR10 North roster/Coadd/Tractor tree。 |
| 数据模态 | Legacy DR10 color imaging 已经产品 revision 6 审核发布纠正为 imaging；其他产品尚需系统性复核。 |
| 首页与介绍材料 | 首页文案已更新；intro-edits.zip 已审阅并按四巡天及完整组件契约合并 Assets README。独立组织仓库未修改，outreach 未发送。 |
| 公开 API 页面 | /api-docs/、Swagger/OpenAPI、/api/v1/status 与指定 survey/order 的 HEALPix 分页 API 已实现。Assets 318 为兼容旧客户端保留无参数 `/api/v1/coverage` 全量响应，并支持按完整产品 footprint 分页；Swagger 默认 `pageSize=10`。管理员发 Key、region:query 鉴权及每分钟 30 次配额已实现；onlineBilling=false。 |
| 控制状态归档队列 | 312 已修复最新指针被旧快照整批上传阻塞的问题；最后检查原生控制 generation 370、发布任务 2623、API 管理 238 均 synced。565 个旧快照排队是该次历史检查数，本次未重测队列。 |
| Agent 设置 | .codex 主模型、默认 subagent、review model 和 builder 均已改为 gpt-6.1-sol。 |

归档、恢复、激活和无变化构建已经完成，续接时不要重新接管当前基线：
归档任务 native-mupvp914-33d3866c 完成 640/640 依赖；
restore 为 native-muq0vy0w-c1d3e07f；
激活 native-muq0zbfr-9dcb6278 已 completed 且通过运行时/网站 HTTP 验证；
native-muq141z5-18e90874 的 acquire/build 返回 noChange=true，索引哈希保持不变。
细节见 [原生分块管理流程](docs/native-unit-management.md)。

## 当前界面状态

Assets 315 已完成 C01/C02 反查桌面验收；Assets 316 保留这些主流程并部署原生管理页改版。
空间 cursor 耗尽后，缺口提示显示没有原生
映射的 survey/release、模态、官方入口及已核实的 ERO 关联缺口；提示不计入空间分块数。
页面、JSON、CSV 三者保留同一条 DESI Tile、Euclid ERO 来源和不完整状态。

Assets 319 将桌面 overlap drawer 固定在导航栏下方并延伸至视口底边；内容 viewport
max-height 为 405px，超出部分在 drawer 内滚动。线上 O4 C01 `[190]` 检查于 2430×1151：
drawer top=68、bottom=1151，content clientHeight=405、scrollHeight=1532；DESI Tile 82406、
Euclid 缺少 7 个 target 映射提示均显示，browser errors=0。截图：
`.tmp-screens/deployed-overlap-drawer-c01.png`。本次没有补造 ERO footprint 或修改缺口状态。

原生来源管理 UI 按巡天分组、逐来源折叠，并把索引状态显示为摘要指标。316 桌面检查
覆盖总览、来源筛选和详情、任务、审核、激活视图；1440px 与 1024px 均无横向溢出，
浏览器错误为 0。桌面截图保存在 `/tmp/assets-native-admin-316/`。

Assets 分支 main，HEAD 3bd59e0f409f7162e07727ebe42e9e0f3b9751f1
（feat: enhance overlap evidence handling and download plan merging）。
当前工作树有既存实现和文档修改，完整清单以 git status --short 为准。新增的实施历史与
ERO 审计文件保留在原位置。本轮不会整体暂存、回滚或清理，也不会提交这些改动。
Workspace 第二阶段实现与文档修改均保持未暂存，实际清单以该仓库 git status 为准；
本轮没有提交、整体暂存、重置或清理任何仓库修改。

## 验证范围：不能扩写为全局完成

| 版本与场景 | 已验证内容 | 实际范围 |
| --- | --- | --- |
| Assets 319，Dev rollout 与 DESI + Euclid O4 C01 `[190]` | Helm revision 319；site/backend 均 1/1 Ready。全屏抽屉从 y=68 到 viewport bottom，405px 内容区可滚动；Tile 82406 和 Euclid 缺少 7 个 target 映射提示均可见，无页面错误。`/healthz`、`/api/v1/status`、`/api/v1/assets`、`/api/v1/coverage` HTTP 200；coverage 响应 639,433 bytes。2MASS H-band MOC FITS `Range: bytes=0-15` 返回 206、16 bytes，SHA 与 manifest 一致。 | bundle 未变：reviewed-mupsxe2v-c91be91f，SHA `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`，603 files。C01 的 ERO 缺口仍存在；本次仅部署代码。截图 `.tmp-screens/deployed-overlap-drawer-c01.png`。 |
| Assets 318，Swagger `/api/v1/coverage` | 无参数旧响应保持 132 footprints / 639,433 bytes；`pageSize=10` 返回 10 条完整 footprint，cursor 可续页且 revision 相同。Swagger 实际发送 `?pageSize=10`，响应 JSON 正常显示，桌面 Chromium browser errors=0。 | 服务端旧响应约 17 ms；故障在 Swagger 渲染大响应。O4 overview footprints 不是原生 Tile/brick/observation 清单。 |
| Assets 315，DESI + Euclid O4 C01 [190] | 桌面页面、JSON、CSV 一致：DESI DR1 Tile 82406 一条空间单元；Euclid ERO 官方来源/覆盖依据保留，缺少 7 个 target footprint 映射提示可见；page errors=0。 | 空间页 hasMore=false，但 queryExhausted=false、inventoryComplete=false、resultTruncated=true；C01 原生映射仍不完整。 |
| Assets 315，四巡天 O4 C02 [637,639,725,958,959,1002,1003] | 桌面完整导出 22,772 条空间单元，页面 DOM、JSON、CSV 逐条一致，四巡天均有结果；7 次 Key 限流等待后在原快照续接成功，page errors=0。 | hasMore=false 只表示本次分页已耗尽；快照仍 resultTruncated=true、queryExhausted=false、inventoryComplete=false，并保留 HST/DESI/Legacy 来源范围与缺口。 |
| Assets 315，四巡天 O4 C01 [483,486,487,498]、C03 [787,790]、C04 [1944] | 匿名首屏预览，各区域均有下一页。 | 未耗尽分页，不据此推断未显示的巡天没有命中；C04 的 875 条是先前 DESI + Euclid Q1 选择。 |
| Assets 316，原生管理 UI 桌面 | 1440px/1024px 检查总览、18 个来源/筛选/ERO 操作、17 个任务、审核和激活视图；无横向溢出、浏览器错误为 0。 | 管理页验收不替代用户对 C01/C02 公共反查主流程的确认。 |
| Assets 314，DESI + Euclid C04 | 完整 O4 七 cells [637,639,725,958,959,1002,1003]，约 94 deg²；匿名 6 项与授权 20 项都有两巡天，续至 50 项无重复；完整页面/JSON/CSV 875 native records 逐条一致，CSV 二次导出额外分页 0。 | Q1 场景；875 是 layer/unitKind/unitId 记录数，不是唯一 Tile 数，不适用于 C01。 |
| Assets 314，DESI + Euclid + HST C04 | 全新桌面浏览器的匿名 6 项与授权 20 项首屏均有三巡天、续页可用、page errors=0。 | 首屏检查，未在 314 重做三/四巡天完整导出。 |
| Assets 311 / Workspace 62，固定完整 O4 七-cell 场景 | Assets 的 11 组合与授权流程记录 22,772 native records；Workspace 的 14 个公开产品层返回 9,056 native records，附 3,893 个直接父目录且 directoriesTruncated=false。页面/JSON/CSV 相符，版本固定，CSV 二次导出额外分页 0。 | 历史固定区域基线，不能证明全部 component 或全巡天 inventory 完整；Assets/Workspace 所选产品分别为 20/14 层。 |
| 311/62，公开 HEALPix API | O4 Euclid 44、DESI 1,385、Legacy 2,247、HST 2,262 个唯一 cells；分页、422/409/400 和配额等待续接通过。 | 已发布 MOC 的像元列表，与原生单位库存完整性独立。 |

Assets 319 的 `npm run build`、`npm test`（375 项：373 通过、2 跳过、0 失败）、
Helm lint（1 chart、0 failed）、revision 319 site/backend rollout、`/healthz` 与 `/api/v1/status`
检查均通过。`/healthz` 为 HTTP 200，
`/api/v1/status` 报告活动 native generation 2、managed/verified=true，public bundle 为
603 files / 105 published MOCs。此前 Assets 370 项/Workspace 308 项属于较早代码测试基线，
不是当前镜像的完整测试结果。辅助 `admin-browser-smoke.py --workflow` 曾因定位隐藏的
发布记录按钮超时；同一批管理视图已通过手动 Playwright 桌面检查。

关键日志：/tmp/assets-euclid-pagination-main-flow.jsonl、
/tmp/assets-three-survey-first-page.log、/tmp/assets-three-survey-first-page.png、
/tmp/assets-managed-active-assets-desktop.log、
/tmp/assets-managed-active-workspace-desktop.log、
/tmp/assets-managed-active-healpix.log、/tmp/assets-managed-active-stream-perf.log。
assets-euclid-pagination-desktop.log 末尾有一次追加三巡天驱动失败；
成功的两巡天结果已摘出为 main-flow.jsonl，成功三巡天另用全新浏览器验证。
私有响应、导出和偏好仅在内存中使用，保存的 Workspace 证据只有汇总。

## 尚未完成的计划与验收标准

| 优先级 | 待做 | 接续与完成标准 |
| --- | --- | --- |
| P0 | 完成 ERO C01 证据核查 | Messier78 别名已修复，其他 7 个 target 在已核查 outreach 表中没有可验证 footprint。继续寻找权威 target geometry 和对应产品范围；支持的获取、导入、候选、审核、归档、激活仍走管理流程。没有可验证几何时保留缺口，不造 Tile 或位置。 |
| P0 | 用户桌面验证最小 MVP | 由用户验证 Assets 保留的四巡天 C02 页面/JSON/CSV、C01 ERO 缺口及原生管理页布局，并在 Workspace 67 验证公共图层+用户覆盖求交、原生分块/直接父目录、所选文件预览确认、下载 Connector 和资产扫描流程。Euclid 超限文件与 ERO 缺口仍明确保留；收到反馈前不扩大到其余 component。 |
| P1 | 其余 component 检查 | 用户确认最小 MVP 后，再逐一检查当前 DESI + Euclid C01–C06 与四巡天 component。记录产品/order/cells/活动版本，区分原生命中、缺口、查询失败，验证首屏/续页/JSON/CSV。 |
| P1 | 查询与首次等待性能 | 保持完整七-cell 区域、真实精度和 Key 配额，测冷/热 geometry、native 查询、快照、分页/导出阶段。现已做 SSE、snapshot gzip/有界缓存和 Workspace 私有父目录聚合；下一步针对剩余阶段测量优化。 |
| P1 | 四巡天数据模态复核 | 逐产品核对 imaging/catalog/spectroscopy/redshift 等身份与实际输出；纠错走产品草稿、审核和发布，再核对公开图层/API/Workspace。DR10 color imaging 已完成，不再重复列为未修正。 |
| P2 | 按来源补数据及核验 URI | 按下表冻结范围选择增量任务，每批登记来源/快照/精度/完整性，评估流式/增量构建，再受管构建与激活。现有候选 URI 不等于所有文件存在性已确认。 |
| P2 | 公开 API 的商业化后续 | 鉴权、管理员发 Key、配额和 Swagger 已有；在线收费、自助购买/账单尚未设计或实施。待用户明确收费范围后规划，当前 status 的 onlineBilling 保持 false。 |
| P2 | 中文字体首屏传输 | 两个 NotoSansSC WOFF2 合计约 23.5 MB，历史 SSH 隧道冷加载约 2 分钟。评估字集拆分或系统字体回退，用桌面冷缓存验收；不能将字体传输直接当作反查等待的原因。 |
| P2 | 生产迁移与存储留存 | 正式迁移前冻结业务状态、列出权威依赖并验证目标恢复。反查快照一小时是 cursor 访问期限，不是对象删除；历史盘点没有生命周期清理，需单独设计留存策略，保留审核/任务与恢复依赖。 |

最近可用的性能基线是激活后的 Assets 首批 4.437 s / 完整查询 20.189 s，
Workspace 首批 4.692 s / 完整查询 33.495 s，geometry 冷 12.376 s /
复用 0.560 s。这些不含后续全部分页导出和 Key 配额等待；
50/87 秒等早期数字留在历史记录，不是当前基线。
扩充 Legacy 前先评估流式或增量构建，历史接近 4 GiB 的冷构建峰值未 OOM，
不应仅凭峰值扩容。

## 原生库存及链接仍有哪些限制

| 来源 | 当前范围及剩余工作 |
| --- | --- |
| Euclid Q1 | 仅锁定 BGSUB 清单 2,908 行、352 Tiles；不是完整 Q1。ERO 的缺口见 P0，不能由 Q1 替代。 |
| DESI | DR1/EDR Tile 是 estimated 候选，不是目标级光谱覆盖。用户部分 OSS 中 904 redrock 已扫描；约 904 spectra 压缩文件和 12,855 coadd 未扫描，也不代表完整 BGS/DR1。扫描走 Assets → Warehouse 标准任务。 |
| Legacy | DR10 South 366,912 个成员、Coadd 363,328 个正曝光候选；DR9 North roster 93,548 bricks。没有权威 DR10 North roster/产品树，不能从 all-sky grid、合并 Tractor 或 PSC 推断。DR5–DR9 URI 规则与所有代的逐文件存在性未全部核验。 |
| HST | CAOM 快照 1,201,094 行，SQLite v4 索引 916,116 observations、排除 18 条无法可靠解析 frame/geometry 的记录；inventory 仍不完整。复杂 footprint 使用保守候选、precision 为 estimated，原始 s_region 保留。只有上游修正或可验证 geometry 才能补齐；Products API 链接不等于本地有逐文件库存。 |
| HSC | 保留 tract/patch 和需登录 DAS Search，文件存在性/直链尚未确认；不扩入第一阶段四巡天范围。 |

HST 与 Legacy 来源补查结论见 [HST footprint 审计](docs/research/hst-unindexed-footprints-20261001.md)、
[HST 补查](docs/research/hst-footprint-supplement-20261001.md)、
[Legacy North 补查](docs/research/legacy-north-source-supplement-20261001.md)
及 [原生 URI 调研](docs/research/native-block-access-uris.md)。

## 存储、生产搬迁与暂缓事项

公开清单和两份 SQLite 的安装/恢复位置是 Assets evidence PVC；
当前受管输入与索引已按 authority 归档。两份库分别是通用 native source-unit
索引（Legacy/DESI/Euclid Q1/HSC 等）和 HST 专用 observation/footprint 索引，
不是两个重复库。ERO 使用锁定的 target 元数据。
用户偏好统一 SQLite，但明确“先这样”；统一库暂缓。

最近权威对象盘点：native 去重依赖加指针/manifest 为 943.69 MiB，
public 为 155.43 MiB，合计 1,152,509,295 bytes / 1.073 GiB。
加业务状态/其他证据的旧估算后，生产首次迁移约 1.26 GiB，可按 1.3 GiB 理解；
业务状态尚未重新冻结，不能当作精确复制清单。原始输入与两份索引恢复后约 2.904 GiB。
旧索引 2.10 GiB 备份、历史发布及 site/backend 的可重建 release 缓存不计搬迁。
详见 [存储盘点与生产迁移口径](docs/storage-inventory-20261001.md)。
旧的 3.25 GiB 估算是压缩归档前口径，当前不应直接引用。

既有 MOC 探索/LLM 可选增强已实现，见
[MOC 探索增强文档](docs/moc-discovery-enhancement-design.md)；
历史末尾“尚未实施”的旧描述已过期。
历史的 catalog ETag 和旧包 allowlist 问题在当前代码已有响应哈希及当前包白名单处理；
本次仅静态核对，未重跑发布测试。相关发布实现变化时再验证，不作为本轮新发现的未修复问题。

## 续接步骤与持续边界

1. 读本文件、git status --short 和 [MVP 契约](docs/four-survey-mvp.md)；
   修改相关代码前按 AGENTS.md 读取 coverage workflow 技能和
   [覆盖流程](docs/coverage-workflow.md)。
2. 开始补来源/快照/索引之前读 [原生分块管理流程](docs/native-unit-management.md)，
   从系统取得当前活动输入和缺口报告，优先处理 P0；支持的操作用管理 UI 或认证 API。
   新格式可以补采集/适配代码，但暂存元数据先导入系统，活动索引不原地覆盖。
3. 分别记录代码构建/部署、产品元数据发布、原生候选激活和实测场景。
   全部依赖归档并且激活任务通过 runtime/site HTTP 后才报告新版本 active。
   每个结论写清实际 region、版本、分页/库存状态，不以单一成功场景外推全部天空。

Assets 拥有公开 MOC、原生索引、证据及反查快照。
Workspace 只同步公开图层/几何包，API Key 只发送公开 layer IDs、order/cells、
公开单元身份及游标/快照选择器；
公开原生反查响应只在请求/浏览器内存使用，不存入 Workspace 的后端、缓存、
制品、配方或日志正文。用户确认后的下载任务可持久化所选文件的最小来源清单及进度，
不保存原始响应或未选候选，重试不追加文件。CSST 私有扫描、覆盖、分块映射和直接父目录只在 Workspace；
本仓库不记录其身份、路径或像元，不将其送入 Assets。
Runtime ES 只连接配置的 Warehouse；input manifests、normalized scans 和 task
snapshots 属于 evidence，浏览器初始请求只取汇总/引用。
下载计划是来源清单，Assets 不代用户下载科学数据；
保留 ICRS/NESTED、真实 order、输入哈希、exact/estimated/entrypoint-only/truncated，
根据来源实际证据展示身份和链接。

部署前阅读 deploy-astro-assets-k3s 技能。其旧 deploy/k3s-values.yaml 引用当前不存在，
此前用 Helm release 已有 values、reuse-values 仅覆盖 image.tag；需先核对实际配置。
凭据使用已有 Secret/管理会话，不复制此前用户贴出的 Cookie，不写日志或文档。
