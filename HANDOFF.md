# Assets 项目交接

更新：2026-09-20（Asia/Shanghai）。本文件为当前状态入口；旧版本记录见
[历史交接](docs/handoff-history-through-20260920.md)，不可将旧部署或待办当成现状。

## 当前状态：CSST 已从 Assets 运行侧退役（2026-09-20）

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
- 镜像：`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:1.0.0-20260920-csst-retired`。
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
