# 原生天空分块的管理流程

管理台沿用「数据源 → 探索与构建 → 审核 → 发布与验证」工作区，分别增加原生分块
来源、任务、审核和索引版本。MOC 表示覆盖范围；Tile、brick、tract/patch、target 和
observation 的身份、成员清单、原始几何及访问入口由原生索引管理。两者通过产品身份
关联，并各自审核和激活。

```mermaid
flowchart LR
  A[登记的官方元数据来源] --> B[获取或导入并校验 SHA 的快照]
  B --> C[隔离构建候选索引]
  C --> D[输入、产品绑定及真实查询验证]
  D --> E[审核内容并逐项接受缺口]
  E --> F[归档全部输入与索引]
  F --> G[CAS 激活原生索引指针]
  G --> H[通过网站 HTTP 验证查询]
  H --> I[当前活动版本]
```

## 管理对象

| 对象 | 系统保存的内容 | 变化约束 |
| --- | --- | --- |
| 来源 | 巡天/发布身份、适配器、官方 URL、范围、元数据查询、多文件输入 URL、revision | 编辑需提供当前 revision；修改后获取新快照 |
| 快照 | 来源 revision、捕获时间、SHA-256、字节数、行数、范围、输入引用 | 固定输入；相同来源 revision 和字节内容可复用 |
| 索引版本 | 通用 SQLite、HST SQLite、巡天元数据 SQLite、ERO 锁定元数据、输入及产品绑定 | 候选隔离，活动文件不原地改写 |
| 产品绑定 | product/layer/survey/release、模态、原生单位类型、输入来源、绑定 revision | 修改生成候选版本；需验证并重新审核 |
| 验证报告 | 输入哈希、成员/几何计数、实际查询样例、原始 footprint、URI、耗时、峰值 RSS、缺口 | 重验或恢复后撤销旧审核 |
| 审核 | 验证及绑定 digest、审核者/时间、逐项接受的缺口 | 内容变化使审核失效 |
| 任务/历史 | 操作、冻结输入、attempt、进度、错误、取消/恢复和激活记录 | 复用持久发布队列，单 backend 执行 |

现有固定适配器覆盖 Legacy 发布成员表及共享几何、DESI Tile 表、Euclid Q1 TAP、
Euclid ERO target 元数据、HSC tract/patch 表、HST public-image CAOM 快照、
Gaia 原生文件分区、SDSS field 表及 GALEX/JWST public-image CAOM 元数据。
新增一种未支持的来源格式时可以先实现适配器；获取、校验、审核、归档和激活随后
仍通过管理接口完成。Assets 获取官方元数据，不替用户获取科学文件。

Gaia、SDSS、GALEX 和 JWST 的来源定义位于
`src/layers/recipes/survey-native-sources.json`。这些来源先由外部元数据采集器输出带 SHA
的 manifest，再暂存到 evidence，通过认证 `import` 纳管；「获取」会提示这条导入路径。
首次接管已有索引时，尚无锁定输入的新来源不自动成为活动绑定。
候选的 `survey` SQLite 是独立受管依赖，不改写已有通用或 HST 数据库；所有 manifest、
原始表/分页、请求 receipt、规则文档及规范化 gzip NDJSON 都随版本归档、恢复。
SQLite 在 worker 的本地临时磁盘构建，通过完整性检查并关闭后，以独立临时文件完整
复制到 evidence 再原子安装，避免在 NFS 上逐页随机写入。临时构建文件不是活动版本
或恢复依赖；安装后的 evidence 文件仍需哈希核验、审核、全部归档和激活。
浏览器只接收来源汇总、显式查询命中的最小元数据及 manifest 导出。

| 来源 | 原生身份和空间依据 | 必须保留的范围说明 |
| --- | --- | --- |
| Gaia DR3 | 官方 `GaiaSource_<first>-<last>` 文件，ICRS/NESTED O8 inclusive range | 分区相交规则为 exact；source_id 位置近似、实际天体占据和科学文件校验未验证，空间结果为 estimated。O8 以上仍返回 native O8，不制造更细分区 |
| SDSS DR9 | 正常处理的 rerun 301 run/rerun/camcol/field，官方 window_flist great-circle 边界转换的 ICRS polygon | 是裁边 field-window 的 estimated 范围，保留原始坐标/逐波段质量标记；不是单幅影像 WCS、有效像素或 primary-only 库存。框架 URI 按官方规则生成，逐 URI 未验证 |
| GALEX | MAST obsid，原始 ICRS s_region、GR6/GR7 实际 dataURL 路径、project、filters | GR6 AIS 只接受 GR6 + AIS；FUV/NUV 按原始波段记录筛选。不同 dataURL 子类型原样保留，访问使用 Products API，不改写成推测的强度影像文件 |
| JWST | 已观测、公开、校准 image obsid 和原始 ICRS s_region | 现有 Carina 与 SMACS 产品分别限定 proposal 2731/2736、NGC-3324/SMACS-J0723.3-7327、NIRCam；不关联计划、其他仪器、其他目标或 Roman 测试记录 |

采集器分别是 `scripts/acquire-gaia-partitions.py`、
`scripts/acquire-sdss-native-fields.py` 和 `scripts/acquire-mast-native-observations.py`。
它们只采元数据，捕获日期、SHA 和实际分页保存在各自 manifest；原始输入不进入 Git。
查询接受 O4–O12 显式 NESTED cells，使用真实文件 range 或原始 footprint；粗 O4 候选
桶不能代替几何相交。复杂 MAST polygon 延用保守 spherical cap，并标为 estimated，
提示附近假阳性；原始 s_region 仍在 JSON/CSV 中。
`queryPagesComplete` 表示声明的输入查询是否采齐，`inventoryComplete` 独立描述库存；
两者不能互换。本次没有生成、替换或发布新的公开 MOC。

ERO 支持两种锁定输入：旧版 ESA Sky outreach 关联快照，以及 `schemaVersion: 2`
的官方影像包 FITS 头快照。后者由 `scripts/acquire-euclid-ero-headers.py --output <目录>`
采集 XML 中明确列出的 VIS/NISP 包，以严格的 HTTP 206 字节范围读取 tar 成员头与
压缩 FITS 头前缀，跳过科学内容；只解码到 FITS `END` 所在头块，不解码或保存像素。
输出保留每个目标、仪器、波段、真实包内成员、ICRS TAN WCS、头文件 SHA、请求范围
及传输 receipt。将输出暂存到 evidence 后，使用 `import` 登记，随后构建、验证、
审核、归档和激活。采集脚本不会自动导入或更改活动版本；普通反查不访问 CDN。

FITS 头的覆盖是原生影像 **frame**，未读取有效像素掩膜、权重或曝光孔洞，因此
仍为 `estimated`；catalogue 的空间关联也不等于核实其完整对象范围。VIS 和 NISP
Y/J/H 各使用自身头文件；没有对应波段的头时不能借用其他波段的 footprint。
反查保留 `geometryEvidence[]`，JSON/CSV 包含成员、头 SHA 和各自的 polygon。
已核实 17 个 target 不代表获得 Tile 清单或完整科学文件库存。

2026-10-03 CDN 的证书时间校验失败；本次外部采集显式使用
`--allow-expired-certificate`，仍校验 CA 链与 hostname，并将该例外写入输入 receipt
和必需审核的 `euclid-ero-cdn-certificate-time-exception`。这是该采集器限定的例外，
未禁用运行时或其他 metadata endpoint 的 TLS 校验。常规采集默认启用完整校验。
「获取」仍采集旧版 XML/outreach 输入；更新影像头需要上述外部采集和受管导入，
不得把未变化的 outreach 获取误当成保留新影像头快照的更新。

## 从管理台更新一次分块索引

进入 `/admin/` 后，使用现有四个工作区完成更新：

1. 在「数据源」的「原生分块来源」检查来源范围、发布身份和官方 URL。需要修改时
   使用「编辑来源」，然后「核查」及「获取并校验」。已有外部采集结果可使用
   「导入清单」登记 evidence 中的文件引用、SHA 和大小。
2. 在「探索与构建」的「原生分块任务」选择「从快照构建候选」。每个更新来源选择
   一个已校验快照，其他来源沿用活动输入；查看同一任务的进度和错误。内容没有
   变化时，任务显示「输入内容无变化，复用原版本」。
3. 在「审核」的「原生分块索引审核」打开「详情与审核」，检查输入范围、产品绑定、
   真实查询样例及缺口。需要调整产品关联时使用「产品绑定」，随后重新验证。
4. 所有检查通过后逐项接受已知缺口并「审核此分块版本」。审核固定当前输入、绑定
   和验证摘要，不能用过去的审核批准新内容。
5. 在「发布与验证」的「分块索引激活与恢复」执行「归档」。任务完成、版本显示
   「已归档」后再「激活 / 回退到此版本」。分段上传进度只是传输阶段；任务仍需
   完整远端哈希校验。
6. 等激活任务从「查询验证中」变为「已完成」，再检查活动版本、generation、公开
   API 状态及区域反查。需要恢复时使用「恢复文件」，完成后重新审核。

后续 Agent 与人工操作使用同一管理台或等价的认证管理 API。系统支持的来源获取、
快照登记、构建、验证、审核及激活都应留在这条流程中。外部脚本只补充暂未支持的
适配或采集能力，结果必须导入系统；直接下载到卷上不代表已受管或可激活。

## 操作与审核

首次用 `baseline` 接管已安装的公开清单和两份索引：核验原有文件并登记来源，
保留原始路径与旧文件，候选通过审核和归档后再激活。ERO target 元数据在受管任务中
锁定；普通反查只读锁定快照，HST 普通反查只读本地 observation 索引。

`discover` 检查官方来源是否可达；`acquire` 获取元数据；`import` 校验已暂存在
evidence 存储的输入。HST 导入一个 manifest，其全部分页文件必须按原目录存在并
通过 SHA 校验。浏览器只取得输入引用、范围和汇总，不取得完整清单、扫描正文或
任务 payload。

HST 还支持 `schemaVersion: 2`、`refreshMode: bounded-supplement` 的组合输入。
`baseline` 引用原始 v1 manifest 的相对 root/manifest、完整 SHA 和大小；原 manifest
及其全部页保持原字节和日期。`supplement` 明确自己的捕获日期、ICRS `s_region` 查询、
真实上游 pageSize/pageCount/rowsFiltered/rowsTotal，以及实际取得的页号、SHA、大小和行数。
允许选取非连续页，不能重编号或把它们标作全量新快照；顶层 rowCount 是两批证据行之和，
包含重复行，不是新增 observation 数。仅导入公开 HST image 的允许元数据字段。

组合输入仍先暂存到 evidence，然后通过同一 `import → build → review → archive → activate`
流程纳管。安装的 v4 SQLite 与 baseline SHA 一致时，复制到隔离候选并按记录内容去重合并；
否则从两批输入重建。旧 observation、原始几何和元数据变体均保留，不据有限新页删除旧记录。
验证必需报告 `hst-partial-refresh`，逐项接受后才能激活；反查与 JSON/CSV 保留历史输入
日期、SHA、补充行数和未完成全量刷新说明，`inventoryComplete` 仍为 false。
未来全量更新仍需独立完整输入及候选审核，不能仅凭上游总行数不变证明库存已完整。

`build` 选择每个来源的一个已校验快照，未选来源沿用活动版本。通用索引的变更按
发布范围构建增量，合并到隔离的 SQLite 副本；原索引不变。没有内容变化时复用已有
版本。构建前检查存储余量及资源，不能只因过去的瞬时内存峰值扩容。

验证样例必须以原始几何相交为准，不能把粗索引候选桶当作命中。HST observation
可以存在于早期的已发布产品快照而不在当前全量快照中。报告保留其产品绑定，列出
`hst-binding-not-in-snapshot:<layerId>`；审核接受后，这一绑定仅显示来源身份和入口，
不会被标为已有本地 observation 映射。其他已验证绑定可以继续激活。

系统不把已知缺口伪装成完整库存：DESI Tile 是 estimated 候选，Euclid Q1 仅包含
锁定 BGSUB 范围，ERO 没有核实 Tile 清单，HSC DAS 需要登录，Legacy 候选 URI 未全部
逐文件核验，HST 未解析坐标框架记录保留为排除证据。每项报告缺口均需明确接受。

产品模态可在产品详情编辑，属于产品草稿内容；保存会撤销当前审核，随后走产品审核
和公开发布。提取方式和模态独立。产品公开信息修正后，原生索引绑定也应重新生成、
验证并审核，以使查询及导出保留同一模态。

## 存储、激活与恢复

控制状态位于 content PVC 的 `native-units/state.json`，按 `native-units` namespace
归档。任务使用已有 `publication/tasks.sqlite` 的 claim、heartbeat、fencing、重试、
取消和重启恢复。原生子执行器做同步 SQLite 提交/完整性检查时可能无法发出 IPC
heartbeat；父执行器仍每 15 秒续期，条件是自己持有活着的子进程、任务仍为 running
且 attempt 未改变。子进程退出、取消或 attempt 被替换后停止续期，结果仍须通过
原有 IPC fencing。索引激活与公开 MOC/资源包发布共用单执行器，使用独立 authority：

| 对象 key | 用途 |
| --- | --- |
| `native-units/files/<sha256>` | 去重的清单、分页和 SQLite，标记 `deliveryClass=evidence` |
| `native-units/files/<archiveSha256>.gz` | 大型原始清单/SQLite 的压缩表示；保留原文件和压缩对象各自的 SHA/大小 |
| `native-units/versions/<groupId>/<manifestSha>.json` | 不可变索引版本及归档引用 |
| `native-units/current.json` | CAS 更新的活动版本与 generation |

控制状态的异步镜像使用 `state/native-units/current.json`，与上表的活动索引指针
分别管理。管理接口的 `syncStatus=synced` 表示最新完整控制快照已经上传并推进了
该镜像指针；活动索引归档成功不能代替这个检查。上传 worker 每轮最多上传一个对象，
随后核验并推进各 namespace 的最新已上传 generation，不等待整个历史队列清空。
各 namespace 轮流优先上传自己的最新完整快照；旧快照继续归档，指针不会倒退。
完整快照包含该 namespace 的历史记录，跳过中间指针不删除审核或操作历史。

`archive` 上传所有输入及索引，校验远端字节数和 SHA。归档不改变被审核的科学内容。
未审核、摘要过期或文件未全部归档的版本不能激活。
大型未压缩元数据使用流式 gzip 归档，已经压缩的输入保持其字节内容；压缩临时文件
位于 evidence 存储的 `managed/native-units/archive-cache/`，可重建，不属于迁移必需集。
一个任务最多使用四条并行流，相同原文件 SHA 只上传/校验一次；全部成功后才写回
版本及可复用快照的归档引用。取消或失败保留已上传对象和本地文件，活动指针不变。
后续版本复用由已完成归档任务写入的 receipt：重新核对本地 SHA，以及远端不可变
对象的 SHA/大小。缺少 receipt 或远端身份不匹配时仍执行完整上传和读取校验；
新输入必须验证全部远端字节。恢复始终验证下载的对象和解压后的原始字节。
大型对象分为 5 MiB 分段上传，以避免整个文件传输撞上单次请求期限；完成时使用
条件写入，保持不可变对象约束，随后读取全部对象核对 SHA。进度分别显示上传字节
和读取校验，上传完成不等于归档通过。
恢复先校验压缩对象，再流式解压并核对原始文件的 SHA/大小，最后原子安装到锁定路径。

激活后先核对查询运行时，再通过配置的网站 `/api/v1/status` 和实际预览反查核验。
authority 已激活而网站尚未核验时保持 `site-pending`；缺少网站验证 URL 也不能
冒充完成。每个请求固定其开始时的版本，活动版本改变不切换正在执行的请求；旧运行时
在最后一个请求结束后释放。分页复用 Assets 已冻结的反查快照。

`restore` 从归档恢复缺失文件，拒绝覆盖内容不同的现有文件，随后重新验证并撤销旧
审核。服务冷启动也核验 authority manifest 和本地文件 SHA，缺失时从归档恢复。
回退到保留的历史版本需使用同一审核、归档及 CAS 激活流程，不覆盖新业务状态。
查询路径只打开已有 SQLite，缺失或不兼容时报告不可用，不在请求中冷构建。

## 数据边界

Assets 持有公开原生索引、证据、活动指针及反查快照。匿名反查只返回小型预览；有效的
`region:query` API Key 可读取限定范围的完整分页结果。Workspace 必须使用服务端 Key，
不得回退为匿名预览。每个新查询读取当前 Assets 索引并冻结一个查询快照；cursor 只续读
该快照。`page.hasMore=false` 仅表示该 cursor 页链已没有后续页。
`querySnapshot.queryExhausted` 表示底层有界查询/搜索是否完成，查询限制或缺口可使其仍为
false。`truncated` 表示来源/查询限制或省略证据，页链耗尽后仍可为 true。`inventoryComplete`
独立表示声明的来源库存是否完整。因此完整续页导出也可能同时为
`page.hasMore=false`、`querySnapshot.queryExhausted=false`、`inventoryComplete=false` 和
`truncated=true`。

Workspace 只同步公开图层/MOC 信息，并向 Assets 发送公开 layer IDs、HEALPix
order/cells 和公开 cursor/snapshot 选择器。CSST 私有扫描、ID、MOC、文件路径和父目录
留在 Workspace，不进入 Assets 请求或本流程的归档。公开反查、footprint、原生索引和
快照响应仅在请求或浏览器内存中使用，不写入 Workspace 持久缓存、制品或配方。

就 Assets 响应元数据而言，唯一的 Workspace 持久化例外是用户确认后的下载任务：该任务
可保存用户选定的最小文件清单（来源身份、URI、大小、checksum、相对目标路径）及进度。
清单固定该任务当时确认的文件集合；后续公开查询发现更多文件也不会追加。原始响应、未选
候选或共享公开索引不得写入任务记录。Workspace 按来源访问策略获取完整科学文件，并将其
写入任务目标；Assets 不代用户下载。

完整接口见 [API reference](api-reference.md)，空间精度与来源语义见
[coverage workflow](coverage-workflow.md)。

## 当前 Dev 的受管接管验证（2026-10-02）

受管接管与完整桌面验收在 Assets 311 / Workspace 62 完成，使用活动原生 group
`7934212d371634751fc1119c3a9a5ccccb10e8061dce5d930988c50bf8b7d7b6`、generation 1。
18 个来源、49 个产品绑定、52/52 检查和 36 个真实查询样例已登记在系统中。
六项已知缺口在真实管理页面逐项审核接受。

- `native-mupvp914-33d3866c`：attempt 1 完成 640/640 输入和索引归档，远端字节
  完整校验通过，归档 receipt 已写回。
- 真实 Euclid Q1 gzip 清单在全新临时目录中恢复，通过压缩及原始内容两组 SHA，
  随后清理临时目录；现有原文件保留。
- `native-muq0vy0w-c1d3e07f`：整组 `restore` 完成并重新验证，撤销旧审核后通过
  管理页面重新审核六项缺口。
- `native-muq0zbfr-9dcb6278`：CAS 激活完成，任务从 `site-pending` 进入 `completed`，
  `/api/v1/status` 返回 `managed=true`、`verified=true`、generation 1 和实际活动版本。
- `native-muq141z5-18e90874`：选择已获取的 DR10 快照执行 `build`，返回
  `noChange=true`、同一个活动 group，两份原始 SQLite SHA/大小保持不变，审核仍有效。
- 跨激活分页保留旧快照的 `imported-baseline` 版本、56 个原生条目和四个来源身份；
  新请求固定为活动 group。该旧选择中 Euclid 没有原生命中，其来源身份仍然保留。
- 激活后的两端完整 O4 七-cell 桌面验收通过：Assets 22,772 条原生记录，Workspace
  9,056 条公开原生记录和 3,893 个完整父目录；两端选择的产品层分别为 20 / 14。
  页面与 JSON/CSV 内容一致，CSV 二次导出额外分页为 0，错误和直接 MAST 请求为 0。
  Workspace 私有内容仅在请求/浏览器内存使用，验证保存汇总数量。

活动 native authority 依赖去重后为 989,530,856 bytes / 943.69 MiB；迁移口径及
压缩恢复后的磁盘大小见 [存储盘点](storage-inventory-20261001.md)。

以下是 revision 312 的控制状态修复记录，镜像为
`0.1.0-20261002-054741-snapshot-batches`；当前部署见 [HANDOFF](../HANDOFF.md)。
该版本修复了控制快照整批串行上传阻塞镜像指针的问题。原生控制镜像 generation 370、
发布任务镜像 generation 2623 和 API 管理镜像 generation 238 均为 `synced`；
原生完整控制快照隔离恢复后与本地状态一致。窄验证时 565 个旧快照仍继续归档，
最新状态未确认数和失败数为 0。活动原生 group、generation 1 和 authority manifest
SHA 均保持原值，网站反查服务为 available。证据 `/tmp/assets-snapshot-batch-verify.log`。
312 的 build、Helm lint 和 site/backend rollout 通过；未重复完整桌面场景或仓库测试。

## ERO target alias update on Assets Dev 315 (2026-10-02)

The exact `Messier78` to `M78` identity alias was added through the managed
native-index workflow. The candidate was verified, reviewed, archived and
activated as generation 2. The active index is
`8a7745f69bd2d87156933fe5c39d5407c79e333e533c76900fa68f193ea67e5f`; status
reports 18 sources, 49 product bindings and 52/52 checks passed.

The locked ERO snapshot is
`0a6b254384f5082dab056b81f98751805f68ca890c5cfb51da01f1f0941e32e3`, SHA-256
`7f8b99523c7b3a07a9a3c6b5c1dcd9f40d80ed6b4ce2c8970a5c97467af3e323`, with
10 linked target records. The Messier78 outreach polygon is estimated and
matches cell `[1429]`; it does not repair DESI + Euclid O4 C01 `[190]`. Seven
targets still have no verified footprint association in the inspected outreach
table. ERO remains a target-level mapping with no verified Tile inventory.
Assets 315 C01 desktop JSON/CSV retain the one DESI Tile, the Euclid source
entrypoint, the seven-target mapping gap and incomplete inventory state. See
the [ERO footprint audit](research/euclid-ero-target-footprint-audit-20261002.md)
and [HANDOFF](../HANDOFF.md) for the bounded evidence and acceptance ranges.
