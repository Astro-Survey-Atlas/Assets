# Assets 项目交接

更新：2026-09-23（Asia/Shanghai）。本文件为当前状态入口；旧版本记录见
[历史交接](docs/handoff-history-through-20260920.md)，不可将旧部署或待办当成现状。

## 当前修复：ACT 图层同步、重合分页与发布详情排版（2026-09-23）

- 线上 `/api/v1/surveys` 中 ACT 的 `modalities` 为 `radio`，coverage catalog 当前有
  3 个 ACT layer，Atlas 图层行可选并显示 Radio 图标。前端把 survey 声明的覆盖与目录
  图层分开处理：已声明覆盖但目录短暂未同步时显示“覆盖目录同步中”，保留可勾选状态，并
  在初始化、重新获得焦点、回到可见状态或点击该行时刷新 catalog；没有覆盖声明的巡天仍保持
  禁用。这样发布切换期间的旧目录不会把 ACT 永久显示为不可选。
- 重合结果区继续只展示匿名预览；“继续浏览”只挂在展开的 overlap drawer 中，位于
  `匹配的 Tile / 文件` section 后、`<h3>PUBLIC SOURCES</h3>` 前。按钮铺满抽屉内容宽度、
  高约 30px，点击后先要求带 `region:query` 权限的 Assets API Key，再按 cursor 分页。
- 参与覆盖产品条目按巡天图例色着色，公开 Atlas 底色使用 52% 色彩混合，产品名单行省略并
  通过 title 保留完整值；每个条目顶部显示对应模态的 Lucide 图标，并提供 tooltip/ARIA 标签。
- 覆盖目录刷新会识别“survey 已声明覆盖但当前 catalog 暂无 layer”的短暂状态；该状态下
  使用带时间戳且不带 `If-None-Match` 的 refresh URL 绕过旧 HTTP/浏览器缓存，并在目录
  revision 相同或响应 304 时仍重试未应用的目录，避免 ACT 等新发布巡天永久停在“覆盖目录同步中”。
- 管理台发布详情中超过 48 个字符的 Bundle、发布清单、目标站点、错误等值使用可点击的
  省略按钮，悬停可看完整 title，点击可展开换行；弹窗和双列 context 使用 `minmax(0, 1fr)`，
  不再被长值撑宽。
- Assets Helm revision **223**、镜像
  `0.1.0-20260923-150842` 已部署，site/backend 均 1/1 Ready、0 restarts。线上 bundle 为
  `reviewed-mudn3em1-aa5db98b`，SHA-256 为
  `499f0aabd7f0cb5f02301b47104290a58b3db6731912f0e774caac7ea46c745b`，508 files；
  未修改 Warehouse、MOC、资源包、扫描任务或发布数据。
- `npm run build`、251 项 Node 测试与 Core wheel、Helm lint、`git diff --check` 通过。
  Chromium 线上验收确认 ACT 可选、overlap 抽屉顺序和 30px 按钮、产品模态图标/底色、
  管理台长值展开以及桌面页面无横向溢出；健康、coverage catalog 和 FITS Range（206，
  `X-Content-SHA256`）通过。

## 当前清单入口：Euclid Q1 VIS 单 Tile 扫描（2026-09-23）

- 目前只有一个真实成功扫描：
  `euclid-q1-vis-mer-tile-102018211-retry-20260921083420`。原始失败任务
  `euclid-q1-vis-mer-tile-102018211` 仍保留，不能把失败任务当作清单。
- Warehouse 的 `ast_layer_index_v1` 显示该层为 `ACTIVE`，当前
  `file_count=1`、`coverage_count=10`。文件清单在 `ast_file_index_v1`，文件与
  ICRS/NESTED 像元的关系在 `ast_coverage_index_v1`；两者是查看文件和 Tile/像元
  关系的权威位置。
- 当前文件是
  `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits`，
  Tile 为 `102018211`，大小 `1,474,565,760` bytes；对应 10 条 O8、
  `fits_wcs`、`estimated` coverage edge。source snapshot SHA-256 为
  `877ae38cc85e7f97f210d939418536b89ed60e738a7f935ce79469ec4005aa6e`。
- Assets `/atlas/` 的重合抽屉只提供最多 6 条公开预览入口，方便确认当前区域，
  不是完整清单。要取得完整文件/Tile 反查结果，使用
  `POST /api/v1/coverage/reverse-lookup`，请求头带有 `region:query` 权限的
  `X-Assets-API-Key`；响应中的 `files[]`、`entrypoints[]` 和每个文件的
  `matchingCoverage[]` 分别表示文件、公开 Tile/目录入口和覆盖关系。
- Workspace 的 `/api/sky/reverse-lookup` 会把同一批 Warehouse 证据映射到
  `fileEvidence`，适合在 Workspace 页面核对文件名、大小和 Tile。具备 Warehouse
  访问权限时，也可以直接查看 `ast_file_index_v1` 与 `ast_coverage_index_v1`。
- `euclid-q1-mer-catalog` 指向整个 MER 前缀，但目前没有完整关联扫描；当前单个
  VIS Tile 不能代表 Q1 全量文件或 Tile 清单。后续必须按 VIS/NISP 波段和 Tile
  范围逐步扫描，并继续披露 `completeness=incomplete`，不得把前缀对象数当成科学
  文件清单。

## 当前修复：公开重合入口覆盖所有图层与 Cell Inspector 排版（2026-09-22）

- 反查预览入口改用公开覆盖目录，不再因 Warehouse 只扫描了部分图层而隐藏 Euclid 等
  entrypoint-only 产品。每个组件最多显示 6 个 Tile/文件/官方入口；先保留每个有结果的
  图层代表链接，再填充其他 Tile，超出部分明确显示“还有更多结果”。
- Cell Inspector 移除内层分隔线并向右统一，字段采用“名称左、值右”的单行布局，长值
  省略并通过悬停保留完整内容。公开来源卡片使用对应巡天图例颜色和可点击的官方发布页、
  覆盖 MOC/边界链接。
- 重合抽屉的 Atlas 覆盖索引区改为说明 MOC、查询投影和预览制品的用途；无制品时不再
  显示空区块。它们用于天球绘制、重合计算和版本核对，不是科学文件清单。
- Assets Helm revision **214**、镜像
  `1.0.0-20260922-public-overlap-representative` 已部署，site/backend 均 1/1 Ready、
  0 restarts。公开 bundle 仍为 `reviewed-muaxa1h2-cfe90933`、503 文件、SHA-256
  `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`。
- 线上验收：Euclid × DESI C02/C04 的 6 条预览均包含 Euclid 官方入口并保留 DESI Tile；
  C02 返回 `omitted=22`，C04 返回 `omitted=32`，超出结果标记为更多。健康、Range FITS
  （206，`X-Content-SHA256`）通过；未修改 Warehouse、MOC、资源包、扫描任务或发布数据。
- `npm run build`、247 项 Node 测试与 Core wheel、Helm lint、`git diff --check` 通过。本轮
  代码与交接文档仍未提交，所有既有修改保留。

## 当前修复：重合自动预览、展开面板与 API Key 导出（2026-09-22）

- 重合模式在组件选中后自动执行有界反查预览，不再显示“反查此区域”按钮或额外步骤；参与覆盖产品列表默认展开。展开的 `#overlap-drawer` 复用同一预览并显示 Tile/文件链接。
- 匿名预览请求使用 `preview=true`，每个组件最多返回 6 个 Tile/文件链接。结果被截断时显示“还有更多结果”；完整文件/Tile 清单只在下载或导出时请求。
- 预览摘要只显示实际存在的文件、Tile 或来源入口数量；没有文件但有 Tile 时显示“已展示 N 个 Tile”，不再显示一串零计数造成误导。
- 下载与导出仅接受具有 `region:query` 权限的 Assets API Key；旧下载密码入口和 Helm 密码注入已移除。Workspace 服务 API Key 仍用于服务端调用，公开 MOC、资源包和预览保持匿名。
- Assets Helm revision **211**、镜像
  `1.0.0-20260922-drawer-tile-results` 已部署，site/backend 均 1/1 Ready、0 restarts；公开 bundle 仍为 `reviewed-muaxa1h2-cfe90933`、503 文件、SHA-256
  `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`。
- `npm test`（247 项 Node 测试与 Core wheel）、`npm run build`、Helm lint、`git diff --check` 和桌面/390px 浏览器回归通过。未修改 Warehouse、MOC、资源包或发布数据；本轮代码与文档仍未提交。

## 当前修复：天球重合按组件反查真实文件（2026-09-22）

- 根因是 overlap 主接口把所选巡天的全部产品复制到每个 component；现在按 component
  的真实 NESTED 像元筛选图层，重合面板只列出实际相交产品。自动预览与 API Key 导出行为见上方当前修复。
- Warehouse file evidence 继续由现有反查接口提供。对 Euclid Q1 标准
  `EUC_MER_BGSUB-MOSAIC-(VIS|NIR...)_TILE*.fits` 文件，Assets 解析 Tile 身份并生成
  ESA SAS-DD 官方下载链接；原始 `oss://` 只保留为定位符，未修改 Warehouse、MOC、
  Resource Package、扫描任务或发布数据。仅扫描子集，响应仍明确披露完整性未知。
- Assets Helm revision **209**、镜像
  `1.0.0-20260922-overlap-file-links` 已 Ready，site/backend 各 1/1、0 restarts。
  bundle 仍为 `reviewed-muaxa1h2-cfe90933`、503 文件、SHA-256
  `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`。
- 线上验收：Euclid × DES C02 返回 `TILE 102018211`、真实 VIS FITS、
  `https://eas.esac.esa.int/sas-dd/data?...RELEASE=q1...` 和原始 OSS 定位；Euclid ×
  DESI C01 返回 DESI DR1 `TILE 82406` 官方目录。健康、Range FITS、ESA HEAD 均成功。
- `npm run build`、247 项 Node 测试、Core wheel、site 类型检查、Helm lint 和
  `git diff --check` 通过。本轮只更新代码和交接记录，未提交 Git。

## Workspace Assets API Key 轮换（2026-09-21）

- 通过 Assets API 管理创建实例级 Key `workspace-region-query`，权限仅为
  `region:query`，有效期至 2027-09-21；明文只保存在创建响应和 Workspace 私有
  `system-secrets.json`，未写入 Git、镜像、日志或交接文档。
- Workspace 的 `/state/system-config/system-secrets.json` 已替换为新 Key；重启
  `asa-workspace` 后仍能读取，使用该值访问 Assets 受保护区域接口得到参数校验响应（不是
  401/403）。公开 Resource Package catalog 继续匿名读取。
- Assets 旧受管 `test` Key 已撤销。legacy `workspace-api-key` 已换成随机新值并重启
  site/backend，旧 legacy 值不再被接受；当前两个 Pod 均已加载新值。
- 当前 Workspace 镜像的公开资源包同步仍是匿名 catalog 路径；实例 Key 保存在服务端，供
  受保护 Assets 区域查询契约使用，不改变公开目录、资源包或发布数据。

## 上一轮修复：巡天图例与天球颜色一致（2026-09-22）

- 根因是 Atlas 图例优先读取 coverage layer 的旧通用蓝 `#376b9b`，再由
  `surveyDisplayColor()` 哈希成 Euclid 玫红 `rgb(224, 86, 195)`；Three.js 天球则读取
  survey item，所以显示蓝色。现在图例、详情和目录优先读取同一个 survey item 原始基础
  色；Three.js 以该基础色为每个产品生成稳定的同色相深浅变体，共享像元继续用扇区拼色。
  不再对图例做独立 HSL 转换，也不会因旧 layer 颜色改变巡天基础色。
- 线上用旧 layer `#376b9b` 和当前 Euclid survey `#a7d9ff` 的混合缓存场景回归：
  `.coverage-layer-swatch` 为 `rgb(167, 217, 255)`，勾选后天球覆盖同色，无 console 或
  page error。该修复兼容旧浏览器缓存，不修改 MOC、Resource Package 或发布记录。
- Workspace 资源包同步兼容 Assets 公共投影中的空模态、空描述、`null` 可选字段和站内相对
  来源 URL，并把 `surveyColor` 传给 `/api/public-surveys` 与天球层目录。Workspace Helm
  revision **42**、镜像 `0.10.38-dev-20260922-survey-display-color` 已 Ready；线上颜色与
  Assets canonical catalog 一致。公开目录仍匿名读取，未改发布数据或 Key。revision 42
  rollout 后已重新核验 `/api/public-surveys` 与 `/api/resource-packages`，Euclid、DESI、
  SDSS、Gaia、DES、SUMSS、JWST、GALEX、2MASS 等巡天返回各自颜色。
- Assets Helm revision **208**、镜像 `1.0.0-20260922-survey-product-shades` 已 Ready，site/backend
  均 1/1、0 restarts。Assets `npm run build`、244 项 Node 测试、Core wheel、Helm lint 和
  浏览器回归通过。线上 bundle 仍为 `reviewed-muaxa1h2-cfe90933`、503 个 manifest 文件、
  SHA-256 `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`；Range 下载返回
  206。本轮代码与交接文档仍未提交，所有既有修改保留。

## 当前闭环：Euclid Q1 VIS 单 Tile 扫描与 Warehouse 反查（2026-09-21）

- 修复旧 ScanRequest 重提兼容性：`resubmitTask()` 会移除历史 Warehouse v1
  `spec.plan.layer.product`，保留其余冻结计划、来源和失败证据。新建任务继续使用
  `backoffLimit=0` 与 Warehouse v2 `LayerSpec`。`build:server`、完整 **240 项 Node
  测试**和 Core 校验通过。
- 原始失败任务 `euclid-q1-vis-mer-tile-102018211` 与第一次非法 retry 均保留；仅从原始
  任务重提成功任务 `euclid-q1-vis-mer-tile-102018211-retry-20260921083420`。
  Warehouse 状态为 **SUCCEEDED**：1 个文件、10 条 coverage edge、O8、0 errors，
  source snapshot SHA-256 为
  `877ae38cc85e7f97f210d939418536b89ed60e738a7f935ce79469ec4005aa6e`。
- 已核实 Warehouse `ast_layer_index_v1` 为 ACTIVE（file_count=1、coverage_count=10），
  `ast_coverage_index_v1` 的 10 条边均为 ICRS/NESTED、`fits_wcs`、O8、estimated；
  `ast_file_index_v1` 记录真实 VIS FITS
  `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits`，
  1,474,565,760 bytes。该闭环只覆盖一个 MER Tile，不能代表整个 Q1 VIS 完整性。
- `/api/v1/coverage/reverse-lookup` 现在优先合并配置 Warehouse 的 coverage/file evidence，
  没有 ACTIVE evidence 的图层继续走原有 geometry/tile fallback。Euclid 真实验收返回 1
  个文件、10 个匹配 cell、`precision=estimated`、`completeness=incomplete`，内部
  `oss://` 仅作为定位符，不生成伪造下载地址；官方 ESA/CDS 入口仍单独列出。DESI
  Tile 反查回归保持原有官方目录结果。
- 已完成一个可复核的天球闭环：公开 Euclid Q1 VIS MOC 与该文件的 WCS coverage edge 在
  O8 像元 **549012** 相交。Workspace `/api/sky/reverse-lookup` 线上返回该公共来源、
  `fileEvidence`、真实 FITS 文件名
  `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits`
  和 1,474,565,760 bytes；`oss://` 仅作为服务端定位符，因没有公共 HTTP 下载地址仍标为
  不可直接下载。该结果证明反查链路已通，但只覆盖一个 MER Tile，不能代表整个 Q1 VIS。
- 已部署 revision **203**，镜像
  `1.0.0-20260921-warehouse-reverse-lookup-clarity`，site/backend 均 Ready、0 restarts。
  健康 bundle 仍为 `reviewed-muaxa1h2-cfe90933`、503 文件、SHA-256
  `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`；没有修改公开 MOC、
  Resource Package、发布记录或 Workspace/Warehouse 源码。
- 后续扩展仍应按 VIS/NISP 波段和 Tile 范围逐步扫描，不把整个 MER 混合前缀当作科学影像，
  不把当前单 Tile 结果升级为全量文件清单；每个新增范围都要保留 source snapshot、真实
  order 和 completeness 限制。

## 当前修复：Connector 删除与 Euclid MER 核实（2026-09-21）

- 已部署 revision **198**，镜像 `1.0.0-20260921-connector-delete`；site/backend 均
  1/1 Ready、0 restarts。沿用拆分架构，Helm --reuse-values；未改 Warehouse/Workspace。
- 数据来源详情新增带图标的“删除连接”和确认提示；DELETE 管理接口只移除 Assets
  管理的连接 ConfigMap、探测/盘点缓存。未完成扫描或无法读取任务状态时拒绝删除。
  Warehouse 原生连接在来源系统管理。本轮没有实际删除任何线上 connector。
- 源文件、桶/PVC、扫描历史、覆盖与发布数据保留；Secret 也保留供冻结任务/共享引用。
  重新创建同名连接使用新 Secret，不覆盖旧凭证。删除不等于撤销存储访问凭证。
- `euclid-q1-mer-catalog` 实际指向整个 MER 前缀，目前零关联扫描。只读完整列举
  17,597 个对象条目，包含 VIS BGSUB-MOSAIC 352 个、NISP H/J/Y 各 352 个，以及
  地面辅助影像、背景、PSF、RMS、FLAG；未找到普通源星表命名对象。
  CATALOG-PSF 抽样是 IMAGE；VIS 科学影像抽样包含 ICRS/TAN 和完整 WCS。
  当前 Warehouse catalog-radec 读取文本星表，不能据此声称支持 FITS BINTABLE。
- 下一步应以科学影像/Tile 为单位建立 WCS 覆盖和文件反查，按波段筛选并披露扫描范围，
  让重合区域返回必要文件及大小；不是将整个 MER 当星表扫，也不是新增一张无文件关联的 MOC。
  未启动扫描/构建/发布；建议保留 Euclid 连接。详见
  [Connector 与 Euclid 核实](docs/connector-cleanup-and-euclid-mer.md)。
- build、240 项 Node 测试、Core、site tsc、Helm lint、diff check 通过。回归覆盖任务
  占用/状态不可用、状态清理、外部资源保护、同名重建不覆盖凭证。修正既有 globe toast
  的浏览器定时器类型。线上浏览器验证确认/取消、409、成功刷新、外部连接禁用，
  1440/900/390px 与明暗主题通过；所有浏览器写请求 mock。
- 部署前后公开 bundle 均 `reviewed-muaxa1h2-cfe90933`、503 文件、SHA256
  `d69e3366aaeb7c72c7f176a09a41f666c7dd49ad9805494b785355160d2e18e8`，未改发布数据。
  实际 connector GET 200，原五个连接均保留。代码与本文未提交；会话开始 worktree 干净。
- 临时验证：`/dev/shm/assets-connector-*`、`/dev/shm/assets-euclid-mer-inspection.jsonl`；
  `/tmp/verify-connector-delete.py` 与 `/tmp/inspect-euclid-connector.mjs`。无凭证日志。

## 当前修复：多图层重合下载计划（2026-09-21）

- 用户 Euclid × DESI 请求含 13 个产品图层、O8 的 21 个像元；所有 layerId 均存在。
  实际线上返回 400 `Provide 1–8 concrete sources`，Key 鉴权已通过；前端 catch 又将
  原因吞掉，统一显示“下载计划不可用”。后台用量中对应请求也为 400。
- 反查下载计划允许最多 64 个产品图层，普通 region-query 仍最多 8 个来源。
  保留请求像元、区域面积、总几何/索引结果、响应大小、超时和身份配额，不切掉产品。
  CSV/JSON 下载显示具体后端错误并保留 8 秒；详情错误也显示原因。
  “下载全部区块”改顺序查询，避免单次操作 Promise.all 撞两并发限制。
- 用户这 13 层只有 DESI EDR/DR1 登记了反查索引；11 个 Euclid 产品只有覆盖 MOC，
  不可当作科学文件清单。此修复不补造数据文件或索引，不修改发布数据。
- build、237 项测试、Core、site tsc、Helm lint/diff check 通过。
  新增 13 层下载计划回归，默认 8 来源仍拒绝、64 上限及像元/结果限制保留。
  浏览器实际天球验证 API Key 解锁后错误具体显示，写请求均 mock。
- 已部署 revision **197**，镜像 `1.0.0-20260921-multilayer-download`，site/backend Ready。
  用用户原 13 层/21 像元请求重放：200、available=true、truncated=false，DESI DR1
  返回 1 个 Tile 目录入口；DESI EDR 此区无交集。Euclid 11 层仍无科学文件索引。
  线上浏览器验证错误详情显示通过；公开 bundle/hash/497 文件与部署前一致。
  部署重启清空短期解锁会话，用户需刷新并重新输入 Key；Key 本身及用量未丢失。
  日志 `/dev/shm/assets-multilayer-*`，只读重放脚本
  `/tmp/replay-assets-multilayer.mjs`，浏览器 `/tmp/verify-multilayer-error.py`。
  没有使用/记录用户粘贴的会话凭证；重放用后台已有服务身份，不变更业务数据。

## 上一修复：API 按钮反馈与天球 Key 解锁（2026-09-21）

- API 设置按钮复用 admin-primary/admin-quiet 与 Lucide 图标，删除局部按钮圆角覆盖。
  原测试请求已成功，但结果在页面顶部，手机上点击后位于视野上方约 200px；
  现在加载转圈、成功、模型未列出和失败均在按钮下方显示，最多等待 25 秒。
  保存/清除、创建/撤销分别在对应区域反馈；公开下载解锁按钮不受管理页样式影响。
- `region:query` 统一授权区域查询和 `/api/v1/coverage/reverse-lookup` 下载计划。
  天球下载解锁框仅接受已签发的 `region:query` API Key，使用请求头提交，明文不写浏览器存储。
  Key 解锁得到最长一小时的 HttpOnly/SameSite 会话；后台只保存关联 Key ID，查询时
  重新检查有效期、撤销、scope、限流并记统计，撤销立即影响已解锁会话。
  解锁也计入 Key 次数；旧下载密码不再接受，Workspace 服务 Key 只用于服务端调用。
  Key 会话重启后需重新解锁。
- site 将 managed Key/会话请求转发 backend，并保留原 Host 供同源检查；不再处理普通密码会话。
  区域查询与反查共用授权检查，反查仍保留 layerIds/order/cells 输入
  和 downloadPlan 输出，不能误按 region-query 请求体处理；授权不补造缺失文件索引。
- build、236 项测试、Core、site 类型检查、Helm lint/diff check 通过。
  HTTP fixture 覆盖代理同源、密码兼容、Key 会话实际下载计划、已解锁后撤销/限流与
  过期检查；追加完整 HTTP 回归通过。浏览器实际解锁模块验证密码/Key、错误、清空明文。
  API 浏览器验证 pending/success/warning/error × 1440/900/390 × 明暗主题，结果在视野内。
- 部署 revision **196**，镜像 `1.0.0-20260921-api-access-feedback`；site/backend Ready、0 restarts。
  线上 API 浏览器状态矩阵通过，实际 models 测试 200/modelAvailable=true；实际天球
  Euclid × DESI 重合 → Key 解锁框 → 下载计划请求链路通过（解锁/下载查询由 fixture 截获）。
  部署前后公开 bundle `reviewed-muao1rvy-d64c1360`、497 文件，SHA256
  `421649f5af909a892d0409223d97d78110cbbae5dee083d0b66e5986a4a98480` 不变。
  未修改 Warehouse/Workspace 或发布数据，未创建线上测试 Key，保留全部 Git 修改。
- 日志 `/dev/shm/assets-api-feedback-*`、`/dev/shm/assets-api-access-*`；浏览器脚本
  `/tmp/verify-api-feedback-states.py`、`/tmp/verify-download-key.py`、`/tmp/verify-globe-api-key.py`。

## 上一部署：API 设置与探索结果展示（2026-09-21）

- 本轮实现后台 `/admin/api`，导航“API 设置”：LLM 地址、模型、启停、替换/清除凭证、
  已保存配置的模型列表连通测试，以及模型调用次数、失败、耗时与 token 统计。
  统计从模块启用开始，不追溯历史；缺失用量单独标明，未估算费用。
- LLM 配置从已有 Secret 首次导入，之后以数据库配置为准；停用/清除不回退环境密钥。
  新配置只影响后续探索；CDS 成功完整零候选才增强，表单默认关闭不变。
  凭证加密保存在 content PVC 的 `api-management.sqlite`（WAL/FULL），主密钥为独立
  `assets-api-management` Secret 的 master-key，仅 backend 注入。保留该稳定 Secret，
  不可直接重建/轮换。配置及统计通过 `api-management` 命名空间归档。
- 对外 Key 首期仅 `region:query`：`POST /api/v1/access/region-query` + X-Assets-API-Key。
  名称、有效期、每分钟限额、立即撤销、调用/失败统计已实现；明文仅创建时显示，
  关闭弹框清空，数据库仅保存哈希。限流计数可重启恢复；原区域计算保护仍生效。
  原 Workspace 服务 Key、浏览器解锁和匿名公开目录/包保持兼容。
- 探索详情按结论、来源性质、缺口、下一步展示；使用主题底色/文字，原始引用折叠，
  长查询地址改为安全来源链接。仅有线索时不再显示“候选可审核”，构建仍禁用。
  新结果保存 identityMatch；旧线索缺此字段时如实提示匹配未确认。
- SDSS DR1 `sdss.jhu/services/siapdr1-images` 是影像服务线索，不能认作目标 catalog。
  本轮只读核查 CDS record 可读取，但 get=smoc 在 O4/O8/O12 均 HTTP 413 “MOC not found”。
  没有自动构建或修改产品，只有线索时需继续找同 DR/同产品真实 MOC。
- build、235 项完整 Node 测试、Core 校验通过；新增配置冻结测试等 11 项针对性测试通过。
  site 类型检查、Helm lint/render、diff check 通过。浏览器验证 API 保存/测试/创建/撤销、
  一次性凭证清空及探索线索禁构建，1440/900/390px 明暗主题无溢出/pageerror，写操作 mock。
- 部署：revision **195**，镜像 `1.0.0-20260921-api-settings`；site/backend Ready、0 restarts。
  实际 API 脱敏配置读取 200/no-store，已导入 token.72602.space / glm-5.3，keyConfigured=true，
  加密存储可用；已保存配置的 models 测试 200/modelAvailable=true，未进行推理。
  对外 Key 数量为 0，匿名目录 200，未知 managed Key 经 site 转发后 401。
  线上浏览器 fixture 通过 API 操作与探索结果明暗/多尺寸验收，无真实管理写请求。
  部署前后 bundle 均 `reviewed-muao1rvy-d64c1360`，497 文件，SHA256
  `421649f5af909a892d0409223d97d78110cbbae5dee083d0b66e5986a4a98480`。
  未改 Warehouse/Workspace、未触发业务探索/发布、未创建测试业务 Key。
  保留全部暂存与未暂存修改，未提交。操作说明：[API 设置](docs/api-management-design.md)。
- 日志 `/dev/shm/assets-api-{build,tests,targeted,image,push,helm}.log`；截图
  `/dev/shm/api-settings-*`、`/dev/shm/moc-results-*`；浏览器脚本
  `/tmp/verify-api-settings.py`、`/tmp/verify-moc-detail.py`（临时文件重启可能丢失）。

## 上一部署：MOC 表单可选 LLM 增强（2026-09-21 13:25）

- Assets revision **194**，镜像 `1.0.0-20260921-llm-fallback-2`；site/backend 均 Ready、0 restarts。
  Warehouse / Workspace 无源码、接口或部署改动。保留所有已有暂存与未暂存修改，未提交。
- 现有新建 MOC 探测表单显示只读可复制 CDS URL，并增加默认关闭的“启用 LLM 增强”，
  hover/键盘聚焦有提示；未配置时灰色禁用。没有新增 LLM 管理页面或对外 API Key 模块。
- llmEnabled 仅保存于 Assets，不修改 Warehouse CR。仅 CDS 成功、候选明确为 0、摘要完整
  且未截断时增强；有候选/失败/超时/摘要不完整均不触发。旧任务不会自动追加增强。
  Assets 后台五秒检查并串行推进，执行标记持久化；重启中断不自动重复付费调用，重新探查
  创建新尝试并继承开关。详情、构建、重试/恢复/注册/重新校验已兼容 LLM 候选来源。
- 模型 token.72602.space / glm-5.3 使用两阶段 Chat Completions，非思考模式；Assets 自己
  实际查询 CDS 和读取公开页面，不依赖网关内置搜索。每次最多 2 次模型调用、5 次 CDS 查询、
  10 页面、180 秒，单来源 2 MiB / 合计 10 MiB。凭证位于独立 `assets-llm-provider` Secret，
  仅后台注入；`.info` 已由 Git/Docker ignore 排除，权限 0600，运行时不读取。
- 引用必须来自实际取得的材料；MOC 地址必须出现在该材料中。没有文件、身份不匹配、
  planned/simulated/unknown 均仅作线索并禁用构建。公开来源读取每跳验证并固定公共 IP，
  防私网/metadata/重定向绕过；CDS 原下载规则保留。原生 order>=4、人工审核发布门禁不变。
- 状态/候选在 content PVC 与 authority 的 llm-discovery 命名空间保存；页面、模型响应、
  用量与错误写 evidence 并排队归档。大证据不进入初始浏览器载荷或公开包。
- build、230 项测试、Core、site 类型检查、Helm lint、diff check 通过；最终提示和触发
  收口后 8 项针对性测试通过。线上浏览器 mock 验证 1440/900/390px 表单与默认开关、
  未配置状态、引用展示和线索禁构建，无 pageerror；管理写请求被 fixture 截获。
- 真实服务隔离验收：SDSS DR9 color imaging 取得 3 条引用线索（CDS DR9 记录、DR9 imaging
  页面、DR9 官网），无足够证据认定为可构建 MOC；部分页面读取失败如实提示。未创建/修改
  用户业务任务，未构建/审核/发布。首次验收思考耗尽 token，改非思考模式后通过；截断错误
  仍有明确失败提示，无自动付费重试。记录位于 `/dev/shm/assets-llm-live-result.json`。
- 部署前后公开 bundle 均 `reviewed-muao1rvy-d64c1360`，497 文件，SHA256
  `421649f5af909a892d0409223d97d78110cbbae5dee083d0b66e5986a4a98480`。
  日志 `/dev/shm/assets-llm-*`，浏览器 fixture `/tmp/verify-llm-{form,results}.py`。
- 当前行为详见 [增强说明](docs/moc-discovery-enhancement-design.md)。此前“Warehouse 执行
  所有 LLM 探索”的设计已被用户否定；独立 API 管理与对外 Key 需求推迟，不应自行扩展范围。

## 上一修复：撤下专用文案与 LLM 管理需求（2026-09-21）

- Assets revision **193**，镜像 `1.0.0-20260921-withdraw-status`；site/backend 均 Ready、0 restarts。
- 撤下任务使用 operation=withdraw，混合变更为 mixed；运行记录从冻结选择推导旧任务类型，
  不根据后来变化的草稿猜历史。UI 显示撤下排队中/准备撤下/同步撤下结果/核验网站撤下/
  撤下完成，详情解释更新公开目录并保留历史；实际队列与网站核验不变。
- 完整 224 项测试与 Core 校验通过；追加 scheduler/完整恢复循环 3 项测试、site tsc、
  Helm lint 和本地/线上浏览器上传阶段文案验证通过。
  部署前后公开 bundle `reviewed-muao1rvy-d64c1360`、497 文件，SHA256
  `421649f5af909a892d0409223d97d78110cbbae5dee083d0b66e5986a4a98480` 不变。
  该任务只读核实 operation=withdraw、published。
- SDSS 最新任务 `sdss-moc-discovery-20260921031030` 为成功零候选。CDS 原查询重放为空，
  SDSS+DR9 对照能找到测光目录 MOC 和影像服务线索；不等于已找到 color imaging 的 MOC。
  详情见 [查询对照](docs/sdss-dr9-discovery-20260921.md)。未自动选择/构建/发布。
- 用户要求推进联网 LLM 探测，并提出独立 API 管理模块：LLM 服务凭证管理，以及 Assets
  对外 API Key 的授权/使用统计。用户已确认公开目录和资源包继续匿名，仅受限接口需要 Key。
  [API 管理设计](docs/api-management-design.md) 已记录边界；用户已提供 token.72602.space / glm-5.3 / OpenAI 兼容配置，凭证在被忽略的 `.info`。
  模型列表与推理请求成功；两种 web_search 工具参数均没有实际搜索执行证据，
  等待网关联网搜索协议示例或开启透传。详见 [服务验证](docs/llm-provider-verification-20260921.md)。
  尚未实现或启用 LLM/API Key 模块。Warehouse 业务部署没有模型或搜索供应商配置。

## 上一修复：退休产品恢复与重新发布（2026-09-21 10:57）

- Assets revision **192**，镜像 `1.0.0-20260921-product-restore`；site/backend 均 1/1 Ready、0 restarts。
- 退休详情区分“待发布撤下 / 已撤下”，提供独立的“发布撤下”和“恢复为草稿”入口。
  仍在公开快照或有相关发布任务执行时不能恢复，按钮明确灰色禁用。
- 新增管理 POST `/api/v1/admin/products/:id/restore`，要求当前 revision 与恢复原因。
  恢复保留产品身份、历史和证据，递增 revision，清除旧审核及当前退休标记；不会自动公开。
  历史记录保留退休/恢复原因和时间。禁止公开的巡天不能恢复。
- 恢复产品必须绑定真实可校验的原生 MOC，最高实际 order >=4；缺失几何时审核、发布计划
  与候选构建均拒绝。不能沿用旧的空几何审核或把 O4 预览当原生覆盖。
- 完整循环回归发现撤下整个巡天后包版本可能重用：批准快照现在保留每个巡天的包版本
  递增记录，在撤下后仍保留，后续发布使用更高版本。未重新发布现有业务数据。
- build、224 项 Node 测试、Core 校验、site 类型检查、Helm lint、diff check 通过。
  新回归覆盖恢复条件/历史/旧审核失效、HTTP 鉴权与版本校验、真实撤下恢复重新发布、
  缺原生几何的多层拦截；本地及线上浏览器验证 1440/900/390px、待撤下/已撤下/任务执行中
  按钮、恢复回到草稿与原生门禁。浏览器写请求全部 mock，无线上测试业务操作。
- 线上 DR9 color imaging `ea03d5d1f33933e0106c` 仍 revision 5，退休时间
  `2026-09-21T02:33:02.346Z`，状态 **待发布撤下**。用户需先撤下再恢复；未替用户恢复。
  color 的旧 O4 概览不是原生 MOC；天球 DR9 g-band 是另一产品，不能混用身份。
- 部署前后 bundle 均 `reviewed-muamw0rn-ca75d9e2`，496 文件，SHA256
  `fa01380ae7149c0647a93b85b2caa408be5369945f587dd86cc281fbfe8e5477`。
  Workspace 未改动。操作说明见 [管理清单说明](docs/admin-product-inventory.md)。
- 保留全部用户暂存与未暂存修改，未提交。日志 `/dev/shm/assets-restore-*`；
  浏览器 fixture 脚本 `/tmp/verify-product-restore.py`，临时证据重启可能丢失。

## 上一修复：禁用审核按钮灰色样式（2026-09-21 10:02）

- Assets revision **191**，镜像 `1.0.0-20260921-disabled-buttons`；site/backend Ready、0 restarts。
- 主按钮 disabled 状态现在使用灰色背景、文字、图标与边框，cursor=not-allowed；
  悬停不会恢复主色，无点击高亮。覆盖审核/发布等主按钮，浅色与深色主题分别配色。
  解除禁用后恢复原蓝色；未通过不能审核的现有门禁逻辑未修改。
- build、221 项测试、Core、site 类型检查、Helm lint 和 diff check 通过。
  线上浏览器 mock 覆盖检查中/通过/不通过/请求失败 × 明暗主题 × 1440/900/390px，
  验证实际 computed background/color/border/cursor、悬停前后颜色不变、勾选接受限制
  不能绕过原生门禁；无 pageerror，无业务写请求。
- 用户继续发布后，部署前后实际 bundle 均为 `reviewed-mual3q9n-c0de009b`，491 文件，
  SHA256 `ef6128cd1dd9f67d211f72d57f779747e326edd61c09156d227887f5368da42d`；本次样式部署未改变公开数据。
- 日志 `/dev/shm/assets-disabled-style-*`，截图 `/dev/shm/disabled-button-*.png`。
  保留用户已有暂存与修改，未自行提交。

## 上一修复：原生阶数门禁排版与状态图标（2026-09-21）

- 原因：门禁检查完成后仅有一个 div，但沿用通用三列 grid，文本落入预留图标的
  18px 第一列。线上浏览器回归复现 row=638px、copy=18px、height=360px。
- revision 189 先修正文误占 18px 的问题；revision 190 统一为图标/正文两列，
  通过显示绿色 circle-check，未通过/请求失败显示 circle-alert，检查中 loader-circle 转圈。
  异步完成后调用图标渲染；请求失败也保留统一标题/正文容器。
  删除“来源与输出检查已满足；仍需通过原生精度检查”后半句，避免检查通过后仍提示未完成。
  加载中、通过、不通过、请求失败在 1440/900/390px 均验证，无溢出或 pageerror。
  桌面成功行正文 611px / 高 51px；390px 屏幕使用完整 O12 提示时正文 243px / 高 68px。
- build、221 项测试、Core 校验、site 类型检查及 Helm lint 通过。
  Assets revision **190**，镜像 `1.0.0-20260921-preflight-icons`，site/backend 均 Ready、0 restarts。
  线上浏览器验证四种状态的 SVG 图标、两项通过图标颜色一致、宽度与无溢出；
  公开 bundle/hash/489 文件与部署前一致，未修改发布数据。
  日志 `/dev/shm/assets-preflight-{layout,icons}-*`，截图 `/dev/shm/preflight-layout-*.png`。
- 保留已有暂存与修改；本次样式/错误文案修改尚未暂存或提交。

## 上一部署：发布加载提示、原生精度门禁与后台归组（2026-09-20 17:32）

- Assets revision **188**，镜像 `1.0.0-20260920-admin-inventory`；site/backend 均 Ready。
  Workspace 未变；公开 bundle 仍 `reviewed-mu9kif5d-f6b1a87a`，489 文件，SHA256
  `ce37e251f4185f6ce854641448aff944368f0b516ce6a20223e3c27f1a997b1d`。
  6 个资源包的版本/hash 均与部署前一致，本轮没有提交发布、审核或重新扫描任务。
- 发布计划首次加载、刷新均展示转圈和 aria-busy，加载期间禁用刷新/提交；保留旧结果、
  勾选和失败提示。计划读取与其他页面数据并发开始，避免先等待慢总览才出现转圈。
- 产品详情新增实际“原生 MOC order ≥ 4”门禁。只读 preflight API 按需读取并核对
  MOC SHA、解码 NUNIQ；可读取 STAGED 构建，不准备/发布候选。未完成、缺几何、校验错误
  或精度不足不显示“门禁已通过”，也不能靠勾选接受限制启用审核按钮。
  原有后端审核/计划/构建门禁仍生效，前端不是发布权限来源。
- 原漏项原因：审核页把未匹配公共目录的记录放在 unmatchedProducts，总览摘要只复制
  releases，导致兜底组为空。现在两者共用按登记 surveyId/releaseId 归组的后台索引，
  包含草稿与退休记录，独立于公共目录。新巡天文案编辑也可用，不因未公开返回 404。
- 线上 162 个产品、30 个后台巡天、69 个集合，unmatched=0。JWST 3 个草稿自动归入
  jwst 下的 dr1/public 集合，实际 MOC 均 O12；AKARI 1 个退休记录归入 akari-fis，
  实际 O0，preflight 明确 blocked。保持原身份/revision/退休状态，未宣称 dr1 为官方 JWST DR。
- 审核页新增折叠指引；新巡天从不绑定已有产品的 MOC 探索、构建、登记形成后台分组，
  之后仍需审核与发布。现有 JWST 无须重复生成。详见 [管理清单说明](docs/admin-product-inventory.md)。
- build、221 项测试、Core 校验、site 类型检查、Helm lint、diff check 通过。
  回归覆盖真实 O0/O4、STAGED 预检、只读性、总览/审核一致、退休状态、未发布分组文案
  编辑，以及后台组不泄漏到公共目录。线上浏览器 mock 验证慢加载/失败保留/按钮门禁、
  Tab 回归及 1440/900/390px，无 pageerror；测试写请求均被拦截，真实 API 只读验收。
- 日志 `/dev/shm/assets-admin-*`，临时截图 `/dev/shm/admin-{loading,gate}-*.png`。
  本轮源码已被外部暂存，未自行提交或撤销暂存；保留用户当前 Git 状态。

## 上一部署：发布 Tab 与最低原生精度（2026-09-20）

- Assets revision **187**，镜像 `1.0.0-20260920-order4-tabs`；site/backend 均 1/1 Ready。
  Workspace 未部署变更，仍 revision 31。
- 天球整体变粗的根因：最新 AKARI 产品的真实 NUNIQ 最高阶数为 0；globe 以全部
  图层的最小 overviewOrder 建共同预览，把其他 O4 图层也投影成 O0。不是原包回退，
  也不是 CSST 清理改变了其他公开几何。最小回归复现中 O4 的 [900,901] 被压成 O0 [3]。
- 按用户要求，公开 MOC 的真实原生最高阶数必须 >=4。productGeometry、发布计划、
  提交与冻结候选构建均拦截低阶几何；错误明确说明 order 值和门槛，审核接口返回 422。
  混合阶 MOC 可以含更粗的内部像元，按最高实际阶数判断；不得靠放大预览达标。
  globe 同时排除历史目录中低于 O4 的预览，不再由它们拉低其他图层精度。
- 已通过正规队列撤下 AKARI 产品 `6360764e42fba3abad35`，保留后台退休记录与原因。
  任务 `mu9kif5d-f6b1a87a`：published + verified。最新 bundle
  `reviewed-mu9kif5d-f6b1a87a`，489 文件，SHA256
  `ce37e251f4185f6ce854641448aff944368f0b516ce6a20223e3c27f1a997b1d`。
  其余 6 个包版本与 SHA 均未改变，公开覆盖为 14 层，没有 O4 以下预览。
- `/admin/releases` 的“发布计划／发布记录”改为互斥 Tab，默认计划，当前浏览器会话
  记住上次 Tab；支持方向键/Home/End，切换保留勾选，提交成功自动进入记录。
  发布按钮仅在计划 Tab 显示，详情弹框不被隐藏面板遮蔽；复用任务页 Tab 交互。
- build、218 项 Node 测试、Core 校验、site 类型检查、Helm lint 和 diff check 通过。
  新回归覆盖真实 FITS O0/O3 拒绝、O4/O8 接受、计划/提交/构建阻断与天球全局降阶。
  本地及线上浏览器用模拟数据验证 80 条发布记录、1440/900/390px、键盘、状态保留
  和提交切换（所有管理写请求均被浏览器 fixture 截获，不产生真实测试发布）。
- 真实线上天球全选 Euclid/DESI/Gaia/SDSS/DES/SUMSS 时为 NSIDE16/O4；Euclid × DESI
  重合为 NSIDE256/O8，当前 Euclid 3.10.0 对应 585 像元、5 连通区；无 pageerror。
  部署容器使用 AKARI 原 FITS 再次验证返回精度错误 422。Workspace 同步实测 200，
  6 包、available=true/stale=false；AKARI 未安装，未改其他安装版本和激活选择。
- 本地重建因上一轮清理产生新的历史记录，修正旧测试“历史永远只有两条”的固定假设，
  改验累计历史、顺序及各集合的完整性。未恢复旧快照或重新发布旧包。
- 当前源码/文档尚未提交，保留用户已有修改和暂存。日志 `/dev/shm/assets-order4-*`、
  `/dev/shm/assets-publication-tabs-*`；截图同目录，临时文件重启会丢失。

## 已完成：CSST 从 Assets 运行侧退役（2026-09-20）

- Assets revision **186**，镜像 `1.0.0-20260920-csst-retired`，site/backend 均 Ready。
  Workspace 未部署变更，仍为 revision 31；未改 Workspace 私有数据或激活选择。
- 用户明确要求删除 Assets 后台副本，替代下方上一阶段“保留后台/备份”的策略。
  已删 4 条 CSST 产品及对应历史，保留全部 162 条其他产品；新产品状态已同步 S3。
  evidence PVC 的 `/var/lib/assets-evidence/csst`（约 196 MiB）已删除，重启后未恢复。
- 已删除仓库外的 `~/.local/share/astro-assets-private/csst-cleanup-20260920` 备份，
  本地旧 CSST 包、图层、临时构建/验证副本和含 CSST 的两份旧迁移备份 tar。
  已清理旧未使用 release PVC 中 9 个含私有数据的缓存版本；PVC 本身保留。
- 对象存储中 151 个旧产品状态快照去除 CSST 后重新计算哈希，保留其他巡天历史。
  清理 evidence/content 归档的私有成员和中性文件名中的内嵌预览、目录、记录；
  更新归档指针、对象 SHA/size 和本地 evidence-index。原混合快照不再可原样恢复。
  255 个旧对象 HEAD 确认不存在，5 个归档指针和 28 份混合元数据校验通过；
  桶未启用对象版本保留。删除记录仅保留非敏感对象键/hash，见 [退役收据](docs/csst-retirement-receipt-20260920.json)。
- 已删除三个一次性脚本 `scripts/history/{import_csst_w234,migrate_csst_evidence,register_csst_w2_w4}.py`
  及 CSST 展示图片、后台图片映射；运行容器中脚本也已移除。保留公开拒绝规则和合成测试。
  将旧真实 CSST 产品 ID 的 HTTP 测试改为公开 Euclid 产品；补回 provenance 脚本缺失的路径变量。
- 213 项测试、Core 校验、build、site 类型检查、provenance 合成输入执行检查通过。
  最终本地生成目录/预览清理后的 4 项边界测试通过；线上 FAQ 浏览器验收通过，
  公开 bundle 和全部 7 包版本/hash 与清理前完全相同。
- Workspace `POST /api/resource-packages/sync` 多次实测 200，7 包下载/SHA 校验全部通过，
  catalog 为 available=true/stale=false。未复现用户报告的 502，不能断言根因或归因于 CSST。
  现有应用日志未取得这次历史 502 的细节；如再次出现，需捕获具体请求路径和响应 error。
- Git 历史/标签仍未重写，旧提交仍含数据；当前清理修改以 `git status` 为准，保留用户暂存。
  两仓库 GitHub baseline Release 已撤下。不得恢复本次已清除的私有混合快照。

## 历史第一阶段清理（已被顶部退役策略替代，2026-09-20 15:13，Asia/Shanghai）

- Assets revision **185**，镜像 `1.0.0-20260920-private-data-faq`，site/backend 均 1/1 Ready。
  Workspace 未变，revision **31**。没有迁移、恢复快照或修改线上发布数据。
- 线上 bundle `reviewed-mu9fssb3-70a9ba96`，491 文件，7 个资源包；SHA256
  `bebb1908a4f76b4ca699b1eb453f04e9b5423d4875de46aa8f04db8ae07a3e9a`。
  部署前后目录（含全部包版本/hash）完全相同，公开目录无 CSST。
- CSST 真实 FITS、provenance、conformance 数据及锁定配方已移出工作树；
  公共 survey/layer/preview/build plan 中的 CSST 条目已移除，加入 Git ignore。
  私有备份位于 `/home/aaron/.local/share/astro-assets-private/csst-cleanup-20260920`
  （目录权限 0700），包含被移除的元数据与本地 provenance。不要提交该目录。
- 保留后台/evidence/Workspace 数据及公开拒绝规则；测试使用合成私有条目。
  推荐 Workspace 从原始来源重新扫描、生成并验证成功后，再退役 Assets 后台副本。
  本轮未启动重新扫描，也未删除后台记录、证据或 PVC。
- 两仓库 `baseline-2026.09.20` GitHub Releases 均已撤下；Git 标签和历史未重写。
  当前源码清理尚未暂存或提交，旧 HEAD/历史仍含 CSST，不能声称已完成历史清除。
- `/releases/` 新增默认折叠的前端资源包 FAQ（中英文），涵盖目录发现、版本/hash、
  下载与校验、逐层预览、原生 MOC 重合、CORS 和 Workspace 激活；详见
  [前端接入指南](docs/frontend-resource-package-guide.md)。来源流程图仍始终展开。
- 修正旧 keeper、archive-only/schema-2、固定版本示例等文档；保留标明历史的迁移记录。
- build、Core 校验、site 类型检查、Python 编译和 Helm lint 通过；完整 213 项测试
  （含新增源码数据边界检查）通过。线上 FAQ 的键盘/点击、中英文、明暗主题和
  1440/900/390px 均通过，无页面错误或横向溢出。
- 临时证据：`/dev/shm/assets-cleanup-*`、`/dev/shm/assets-faq-live-browser.log`。

## 历史固定基线（2026-09-20 14:18，已撤下 GitHub Release）

- Assets revision **184**，镜像 `1.0.0-20260920-baseline`；site/backend 均 1/1。
  首页名称、原生阶数、模态、DR/产品数量同一行，ZH/EN、1440/900/390px 验证通过。
- Workspace 仍为 revision **31**，镜像 `0.10.38-dev-20260920-native-overlap`。
- 最新公开 bundle `reviewed-mu9eqjrr-d2bb9a87`，SHA256
  `aa211a5004c482144eec85b2b9bd5cd73afcb19a3c74c6d4e61ad03ec0c53ecc`，484 文件；
  4 包：DESI 3.2.0、Euclid 3.9.0、Gaia 3.1.0、SDSS 3.2.0，11 层 MOC。
- 用户新增发布后的 Euclid ERO/Q1 × DESI EDR/DR1，两端及冻结包离线计算均
  order 8、570 像元、5 连通区。原来的 81/4 仅对应当时 Euclid 3.6.0。
- 最近 4 个发布任务均 published + verified、attempts=1，未记录执行失败；
  不能把用户看到的瞬时提交报错归因于打包失败。详情和验证见
  [基线说明](docs/releases/baseline-2026.09.20.md)。
- 两仓库的 `baseline-2026.09.20` GitHub Release 均已撤下；标签及历史仍保留。
  以下旧基线数据只供查证，不可覆盖后续业务数据。

## Euclid × DESI 重合精度修复（2026-09-20）

- Workspace `asa` / `asa-workspace` 已升级 revision **31**，镜像
  `0.10.38-dev-20260920-native-overlap`；Assets 仍为 revision **183**。
- 原因是 Workspace G 模式固定使用 overview NSIDE 16/order 4，Assets 使用
  order 8。相同 order 4 的像元完全相同；不是资源包版本不一致。
- Workspace 现在从已安装且校验 SHA 的原生 FITS MOC，通过 Assets Core 离线
  投影到共同查询阶数；不从预览放大。混合低精度来源保守限制在 overview，
  界面显示实际阶数。详情/反查继续使用结果 NSIDE 和具体图层身份。
- 线上 API 实测两边均 order 8、81 像元、4 连通区，像元及各区 cells 一致；
  显式 order 4 仍为 9 像元、5 连通区；4 个区的 Workspace details 均一致。
- Workspace build、262 项测试（2 skip）及真实包原生投影对照测试通过。
  线上 Chromium 实选 Euclid/DESI 后按 G：请求不再固定 NSIDE，界面显示
  order 8 / NSIDE 256、81 单元、4 区块，无 pageerror；Deployment 1/1 Ready。
  未改公开发布数据、包版本、用户激活选择；所有既有暂存/未暂存修改保留。
- 本轮源码及文档尚未提交。Workspace 详情见其
  `docs/resource-package-compatibility.md`；临时日志/截图为
  `/dev/shm/workspace-overlap-*`、`/dev/shm/workspace-native-overlap.png`。

## 本轮修复（2026-09-20 13:22，Asia/Shanghai）

- Assets revision 183；Warehouse operator revision 8，worker/operator 镜像分别为
  `0.1.0-20260920-diagnostics` / `0.2.0-20260920-diagnostics`。
- Workspace Helm `asa`（namespace `asa-workspace`）revision 30，镜像
  `0.10.38-dev-20260920-package-compat`。已修复空来源/缺省描述字段和
  新版逐层 NESTED 预览的消费兼容；线上三个包 DESI 3.2.0、Euclid 3.6.0、
  Gaia 3.1.0 均完成安装，原生 7 层 MOC 可读取。未改变用户激活选择。
- 公开 bundle/hash/479 文件未变。未恢复旧快照、降级资源包或接入 LLM。
- SDSS 原任务 evidence 为连接 CDS 超时；见
  [诊断记录](docs/sdss-discovery-diagnosis-20260920.md)。原任务未重跑。
  新 worker 输出可读结构化错误并通过 status.summary.failure 传到 Assets；
  历史记录明确提示详细摘要缺失，不再将通用错误解释为协议不符合约定。
- Assets build、212 项 Node 测试、Core 校验、site 类型检查通过；浏览器实测
  历史错误与真实 Warehouse 错误 fixture 的 1440/390 布局，无 pageerror。
  Workspace build、261 项测试通过（2 跳过），真实包消费合同及线上安装通过。
  Warehouse test/verify/quality、Helm/Compose/mapping/diff 静态门禁通过。
- Warehouse live 不是全绿：Workspace caller 在实际 asa-workspace namespace
  PASSED（1 文件、11 coverage、0 errors）；Assets S3 scan 成功（12 coverage），
  MOC 因 CDS 连接超时 FAILED；本地 fixture 缺 `/data/gz_desi_merger_samples.csv`。
  新自测的错误码为 DiscoveryConnectTimeout，耗时约 20048 ms，预算 20000 ms。
- 三仓库本轮修改未提交；Workspace/Warehouse 原有 dirty changes 全部保留。
  日志位于 `/dev/shm/{assets-diagnostics,workspace-preview,warehouse-*}*`；
  这些为临时证据，重启丢失。仓库当前 HEAD 是 61082bb，上一轮交接已提交。

## 当前部署与数据

- dev Helm release/namespace：`astro-survey-atlas-assets`，最新部署见顶部。
- 镜像：`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:1.0.0-20260921-disabled-buttons`。
- 网站和 backend 均 1/1 Ready、0 restarts；旧 publisher Deployment 已移除。
- 用户入口：<http://astro.assets.dev.72602.space:32080/>；直连备用：
  <http://10.15.51.75:32083/>。集群内网站 Service 使用端口 80。
- 前轮只读核实：5 个公开巡天、9 个公开产品、7 层覆盖、3 个资源包；
  管理端 166 个产品、14 条发布记录，无 queued/building/uploading/verifying 任务。
- 前轮 bundle（已被顶部最新发布替代）：`reviewed-mu9992i3-7e599e9b`，479 个 manifest 文件；SHA256：
  `6becd38832c1f7550b05138ae84ed02fb52d9724ff86e35a367a4edcbafd1d71`。
  manifest 文件数与受发布边界过滤的公开资产数不同。以上数量为检查时快照，用户继续发布会改变它们。

## 已完成的运行架构

网站 `ASSETS_ROLE=site` 仅读取经验证的公开 release，管理 API 鉴权后代理到
backend；backend 独占业务写入。两者使用独立的 8Gi local-path release cache
PVC，启动核对 S3 authority，运行时同步；站点可使用经过验证的缓存离线启动。
旧 content/evidence/spool/release PVC 均保留，不能随意清理。

发布队列采用 local-path 上的 SQLite WAL/FULL、单 backend 和生命周期 flock。
子进程通过受 fencing 保护的 IPC 上报，父进程独占 authority CAS；租约、心跳、
有限自动重试、取消和重启恢复均已实现。审核选择被冻结；变更版本需重新审核提交。
上传、状态快照、release 同步和站点核验使用独立循环。完整 release.tar.gz 仅供
导出或恢复；单产品发布上传增量对象。网站核验通过才显示发布完成。

这是单写者架构，不支持多 backend 副本并发写入。详细流程、迁移与回滚见
[发布运行架构](docs/publication-runtime-split.md)。

## 已完成的界面与问题修复

- 首页巡天名称、原生阶数、模态并集图标、DR/产品数量现在同一行显示。
  API 返回及语言切换后均执行局部 Lucide 渲染，不能只在启动时渲染图标。
- `/releases/` 流程始终展开，无折叠控件；已有 MOC 与来源数据扫描是同级卡片。
  MOC 源头链接为 <https://alasky.cds.unistra.fr/MocServer/query>。
- LLM 支路明确标注“规划中，尚未启用”，没有实际模型调用或搜索供应商配置。
- 用户任务 `mu97fn25-02edfb19` 实际首次执行成功；“上传中／失败”源于
  verification.overall 被错误初始化为 failed，revision 180 已改成 pending。
- 已修复历史失败任务覆盖较新已发布产品状态、跨命名空间快照计数覆盖，以及
  schema-3 首次恢复 CLI 动态导入死锁。backend 启动不再自动重打资源包。

## MOC 探索现状与下一步

当前 Warehouse `cds-public-moc-v2` 只调用 CDS 目录 API，按名称和可选 DR/产品
关键词匹配，最多展示 50 条候选，以第 51 条判断截断。不是 LLM，也不是网页爬虫。
发现候选后，人工选择，再由 Assets 下载锁定来源、Core 校验构建、审核和发布。

Roman 最近检查的任务成功执行但返回 0 候选，查询完整名称
`Nancy Grace Roman Space Telescope`；不能据此判断没有公开 MOC。
别名 Roman/WFIRST 的临时外部查询曾 TLS 握手超时，未取得新的结果证据。

[增强设计](docs/moc-discovery-enhancement-design.md) 已完成，尚未实施：受控别名
查询后，由用户显式启动联网 LLM 提取带引用候选；区分观测、计划、模拟与未知，
科学校验和人工审核不变。下一步只有在用户要求实现增强时才进入 Warehouse
接口/供应商配置与实现；当前无需重复改造发布队列。

## 验证基线与操作证据

revision 182 已通过 build、211 项 Node 测试、Core wheel 校验、site TypeScript、
Helm lint 和 diff check。`scripts/public-workflow-browser.py` 验证延迟加载图标、
名称图标同行、语言切换、空/错误目录、显式 CDS 链接、同级来源、无折叠以及
EN/ZH、明暗主题、1440/900/390px 布局。线上实际目录与下载验收通过，
资源包 Range 为 206（32 字节）。上一轮交接整理只修改文档；本轮部署与测试见文件顶部。

- 日志：`/dev/shm/assets-flow-layout-{build,tests,image,push}.log`。
- 截图：`/dev/shm/assets-flow-live-{home,releases}.png`、`/dev/shm/release-flow-*.png`。
- 历史迁移一致性记录：`/dev/shm/assets-split-migration/`；两份含 CSST 的 content/spool tar
  已在本次退役中删除，下列 SHA 仅供历史查证，不再是可恢复备份。
  `quiesced-content-spool.tar.gz` SHA256：
  `616b19e5cd2961177ec57b98e826512fc230098cfcfac1c82726aa1f7edc66f4`；
  `quiesced-current.json` SHA256：
  `4efb1b9434d5c9b7abf8121b00e3c20094c8a1405ba9bdfc25c26fd47eb38166`。
- 发生新业务写入后，回滚必须先停止 backend，保留 SQLite/WAL/业务记录和当前
  authority，再使用 `scripts/export-publication-rollback.ts` 导出最新历史；不能恢复旧快照覆盖用户新写入。
- 外部 HTTPS 曾有证书主机名不匹配；内部网站核验使用
  `http://astro-survey-atlas-assets:80`，没有禁用 TLS 验证。

## 工作区与继续工作约束

Assets / Workspace 的 `baseline-2026.09.20` 标签仍保留，但对应 GitHub Release 已撤下。
当前 Assets 清理修改尚未提交；后续修改以 `git status` 为准，保留任何新产生
的修改；Warehouse 的独立未提交修改不属于本次两仓库发布。部署与验证详情见顶部。

保留现有修改、历史发布与 PVC。凭据仅使用已有 Secret，不写日志或文档。
运行时仅连接配置的 Warehouse ES；旧 ES 只允许显式的一次性迁移。
input manifest、normalized scan、task snapshot 属于 evidence，不进入浏览器初始
请求；CSST input-manifest 不可加入 Git 公共发布白名单。保留 ICRS/NESTED、真实
原生精度、来源 hash，不从低阶预览伪造高阶覆盖。
