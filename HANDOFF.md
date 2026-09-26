# Assets 项目交接

续接：2026-09-26 10:03（Asia/Shanghai）。Warehouse overlap evidence 的 dev 验收与站点边界修复已完成。
site 进程不持有 Warehouse 证据，之前从 site NodePort 请求 `/api/v1/coverage/overlap/details` 会返回空的
`warehouseEvidence`；现在该只读详情请求由 site 转发到 backend，backend 保持唯一 Warehouse 读取边界。
批次证据还补充了 `scanRunCount`、`sourceSnapshotCount` 和冻结 `scanScope`（scope ID、scope snapshot、
expected/committed partitions、completeness），不会把多分区的输入 snapshot 冒充成一个 snapshot；单文件批次
继续返回具体 scan run 与 source snapshot。详情抽屉同步显示这些字段。

- dev Helm revision **250**，镜像
  `0.1.0-20260926-095338-overlap-scope-evidence`，容器 digest
  `sha256:8178f3cd02f77ac1b09b22b7bf70be5a466696dedcadcac6c2c7bf26027ee3f7`；site/backend 均 Ready、0 restarts。
  `/healthz` 仍为 bundle `reviewed-mugfs3x1-846ba75f` / SHA
  `5c9bde3801522ce35127d8d83152f0fee5970939ba9d55433b746ba369be0675`、526 files；没有重建资源包、修改 MOC
  或改变公开指针。
- backend 启动日志明确记录 coverage catalog 因 DESI 约 27 万条 edge 超过 200000 上限而使用 checked-in
  public geometry；随后加载 5 条 Warehouse layer metadata。大目录不会阻断公开图层或详情证据。
- 线上 Euclid × HST C31（O8、22 cells）从 site 请求详情返回 Euclid Q1 NISP.H/J/Y/VIS 四条 ACTIVE
  Warehouse 证据，每条 `352 files / 4044 edges / exact / O8`，`scanRunCount=352`、`sourceSnapshotCount=352`，
  scope `352/352 complete`，并带独立 scope snapshot SHA；HST 仍只显示公开覆盖/观测依据，没有伪造科学文件。
- Euclid × DESI 与 DESI × HST 详情均返回 DESI `exposures-iron.fits` 的 1 file / 4323 coverage、具体 scan run
  `batch-8f48029258d7-exposure-tile-centers-a720888c5890`、source snapshot
  `52a257569f9c0d7a5bda15b7b9bb87b47db7bd93d9ca212fa7722aaf6557a784`，且不受大 coverage catalog fallback 阻断。
- C31 匿名反查预览实测 HTTP 200：6 条预览、46 条 omitted、`hasMore=true`，返回四个 Euclid frozen scope；带 API
  Key 的完整分页契约未改。单文件 Euclid VIS 命中仍返回真实 FITS 文件名、Tile、OSS URI、ESA 链接、scan run、
  source snapshot 和 `downloadable=true`。
- `/api/v1/coverage/catalog` live smoke 保持 ICRS/NESTED、35 个显式 layer records 和 revision
  `6fa0606f0f6798f7c2f34efd5a6e3186`；公开 FITS byte-range smoke 返回 `206`、32 bytes 和匹配的
  `X-Content-SHA256`。资源包 catalog 仍为 11 packages。
- `npm run build`、`npm test`（319：317 passed、2 skipped、0 failed）、Core wheel 校验、Helm lint、
  `git diff --check` 通过；新增站点 overlap-details proxy 回归和批次 scope/多 snapshot 详情回归均通过。

本轮源码和文档仍未提交；继续保留所有已有 staged/unstaged 修改。没有发布 HST 新草稿、写入 Elasticsearch、
删除失败批次、修改 MOC 或读取用户科学文件。

续接：2026-09-26 00:49（Asia/Shanghai）。DESI DR1 exposure Tile 中心的正式单对象批次
`desi-dr1-exposures-iron-20260926-r4` 已由 Assets → Warehouse 正常流程完成，未修改或删除
此前的 r1/r2/r3 失败记录。Warehouse `ScanBatchRequest` 为 `SUCCEEDED`：精确对象
`oss://data-and-computing/projects/CSST/shared-data/desi/dr1/public/dr1/spectro/redux/iron/exposures-iron.fits`
冻结为 1/1 分区，roster SHA 为
`dc5b1efc17661cfb217f1b623568372c00c546d3f652a51ebbc713a4e14371ff`，scope snapshot SHA 为
`87b245aa44fe171ba8fd8549f08130f65c8683185a34cd4c12bc469675c52a26`。扫描 run
`batch-8f48029258d7-exposure-tile-centers-a720888c5890` 使用 scanner/operator 的
`0.2.0-20260926-exact-object-roster`（scanner digest
`sha256:4d889be9c67b6723b5862d3827dd52e7546dbce0928647db7084e8b499cc1d43`），读取
`EXPOSURES` HDU 的 `TILERA/TILEDEC`：9,176/9,176 行有效、0 invalid、0 errors，生成
4,323 条 O8 `catalog_radec` occupancy coverage。输入快照 SHA 为
`52a257569f9c0d7a5bda15b7b9bb87b47db7bd93d9ca212fa7722aaf6557a784`，证据位于
`/var/lib/atlas-evidence/desi-dr1-exposures-iron-20260926-r4`。

- `ast_partition_index_v1` 已提交该 scope 的 1 个 `ACTIVE` partition；对应
  `ast_file_observation_index_v1` 保存 `exposures-iron.fits`（57,162,240 bytes）及 scan run、
  source URI。该层 4,323 条边全部为 ICRS/NESTED、order 8、`catalog_radec`、`occupancy`、
  `exact`，无重复 HEALPix cell。
- 公开反查已验证该批次通过 `assets-batch-cc7665b2435c322ec3c9` 映射回
  `desi-dr1-spectra-footprint`；与 Euclid Q1 已提交覆盖的真实 O8 交集可返回
  `exposures-iron.fits`、Euclid MER 文件、各自 source snapshot 和两个 frozen scope 的
  有限性说明。DESI 当前公开证据仍只有 2 个扫描文件（另含 `zall-pix-iron.fits`），不代表
  完整 DR1，也不把 exposure Tile 中心当作目标级光谱覆盖。
- Assets dev 仍为 Helm revision 245、镜像 `0.1.0-20260926-exact-object-roster`；
  `/healthz` 返回 bundle `reviewed-mugfs3x1-846ba75f` / SHA
  `5c9bde3801522ce35127d8d83152f0fee5970939ba9d55433b746ba369be0675`、526 files。此次
  扫描没有发布 MOC、重建资源包或改变公开指针。

下一步按原计划推进 HST 有限子集的来源/观测反查与 DESI 真实文件组织补齐；若扩大 DESI，优先
在系统支持有界分块读取和长任务续租后扫描 canonical `zall-pix-iron.fits`，不要把 42 个
原始 byte shard 当作独立 FITS。所有新增结果继续保留实际 order、精度、source snapshot
和 frozen scope 限制。

续接：2026-09-25 20:49（Asia/Shanghai）。Euclid Q1 frozen batch
`euclid-q1-mer-images-20260924` 已由 Warehouse 正常完成：VIS、NISP-H、NISP-J、NISP-Y
均为 352/352，合计 1,408/1,408 partitions，0 failed；每个规则有 352 个 FITS 文件、4,044
条 order-8 `fits_wcs` coverage，available order 为 `[8]`。批次 phase 为 `SUCCEEDED`，没有
重提、修改 frozen roster 或发布新的 MOC；roster SHA 仍为
`2545cf6ee5a7cbea25484500c3e14a954c893259d9cb10ae8f5cfa381faf0aa3`。这只证明冻结 MER
清单范围完整，不代表完整 Euclid Q1。

- 终态索引核验：`ast_partition_index_v1` 有四个 batch logical layer 的 1,408 个 ACTIVE
  partition 指针，每层 352 个，scope hash 与 expected count 均匹配，全部 order 8；
  `ast_file_observation_index_v1` 有 1,408 个对应 FITS observation，VIS/H/J/Y 各 352，
  无重复 file ID；按这些 committed partition layer 过滤，`ast_coverage_index_v1` 有 16,176
  条 coverage edge，全部 `healpix_order=8`、`fits_wcs`、`footprint`，对应 1,408 个 source
  file/URI。partitioned batch 文件元数据按约定保存在 observation index，普通扫描仍使用
  `ast_file_index_v1`。
- 最终真实三方 O8 C06 反查已用 API Key 分页复验：10 页、58 条去重结果，其中 17 个已扫描
  Euclid/DESI 文件、33 个公开来源入口、8 条覆盖依据；末页 `hasMore=false`、`omitted=0`。
  结果含 NISP.Y 文件并保留四个规则 `352/352` 的 frozen-scope 说明；整体仍标记
  `truncated=true`，因为公开 MOC 范围不等于本次 MER 文件清单完整性。
- 资源包最高优先项仍已发布并核验：11 个 ZIP 的 catalog SHA 全部匹配，均含
  `healpix/order4.json` / `healpix/order8.json`；ACT O8 明确列出 native O7 的三层 omission，
  未升采样。DESI 目标级扫描、三个已授权 HST 产品和 Workspace caller 验证保持原记录不变。

续接：2026-09-25 17:25（Asia/Shanghai）。最高优先级资源包 O4/O8 HEALPix sidecar 已发布，线上仍为
bundle `reviewed-mugfs3x1-846ba75f` / SHA
`5c9bde3801522ce35127d8d83152f0fee5970939ba9d55433b746ba369be0675`，526 files；本次 dev
升级没有重新生成或发布资源包/MOC。Assets 测试 319 项（317 passed、2 skipped、0 failed），Core
wheel 与 `npm run build` 通过。dev Helm revision 243，镜像
`0.1.0-20260925-155015-desi-range-catalog`，site/backend rollout 与 `/healthz` 通过。

- Euclid frozen batch `euclid-q1-mer-images-20260924` 仍 RUNNING：VIS、NISP-H、NISP-J 各
  352/352；NISP-Y 172/352；总计 1228/1408 partitions，0 failed、180 pending；当前有 2 个 Y
  子任务运行中。批次仍由 Operator 按 maxConcurrent=2 继续调度。Roster SHA
  `2545cf6ee5a7cbea25484500c3e14a954c893259d9cb10ae8f5cfa381faf0aa3` 未修改。只代表冻结 MER
  规则范围，不代表完整 Q1。
- Warehouse FITS BINTABLE 有界 range 读取实现与验证已完成，scanner JAR 中确认包含该解析器。
  Assets 当前 `warehouseScannerImage` pin 为 pullable digest
  `sha256:766c7d95c75b984964568f0c2d2b5411248dbba7fec9b1846b79ee60a55a94c8`。
- DESI 目标级任务 `desi-dr1-zall-target-catalog-20260925-r3` 已 `SUCCEEDED`：1 个 FITS、
  28,425,963 个有效目录行、266,051 条 O8 coverage、0 errors；source snapshot
  `0511a614c4268cf86688612cac695156aa122fa9736e556bb7e96496ecd5d44e`，证据路径和
  `ast_file_index_v1`、`ast_coverage_index_v1` 均已核实。r1/r2 失败任务保留，不删除或改写。
  结果只覆盖这个已扫描的 `zall-pix-iron.fits`，不代表完整 DR1；42 个原始 byte shard 仍不作为独立 FITS。
- 已核验三个获授权的 HST 产品均已发布并 ACTIVE：ACS archive、WFC3 archive，以及 MAST
  obsid 24796973；它们仍明确标记为覆盖/观测证据的有限子集，不代表完整 HST。
- Euclid Q1 的公开 VIS/H/J/Y 图层已经绑定到批次证据层，带 API Key 的 O8 反查可返回真实
  FITS 文件、Tile、OSS URI、大小和 `fits_wcs` 证据；VIS/H/J 当前各 352/352，Y 在最近一次
  反查时为 172/352。结果同时保留 frozen scope 和不完整性说明，未将公开 MOC 当作文件索引。
- Warehouse caller 验证已通过：Workspace sourceVolume（1 file/2 coverage）和 Workspace
  remote connector（1 file/1 coverage）均 `SUCCEEDED`、0 errors，测试请求保留供审计；未读取用户科学数据。

更新：2026-09-25 13:08（Asia/Shanghai）。本文件为当前状态入口；旧版本记录见
[历史交接](docs/handoff-history-through-20260920.md)，不可将旧部署或待办当成现状。

续接：2026-09-25 15:11（Asia/Shanghai）。Euclid Q1 原批次仍使用同一 frozen roster，VIS、NISP-H、
NISP-J 已各完成 352/352，失败 0；NISP-Y 已启动并完成 12/352（1,068/1,408 partitions），
其余 340 个 Y 分区待调度。没有重提批次、修改 roster、发布 MOC 或改变公开包。对 DESI DR1 做了
一次只读 FITS 头探查（每个对象最多读取 128 KiB，未读取科学行、未写 Warehouse 索引）：完整
`zall-pix-iron.fits` 和 `part-00000` 均声明 `ZCATALOG` BINTABLE、`NAXIS1=787`、
`NAXIS2=28425963`、`TARGET_RA/TARGET_DEC`；`part-00001` 没有 FITS 头，42 个 `part-*` 是
原始字节切片而非独立 FITS。当前 scanner 的单文件 FITS catalog 读取和 64 MiB 行数据限制不能
直接安全地扫描这些分片，因此尚未提交目标级 DESI 扫描；已完成的 `tiles-iron.csv` Tile
覆盖仍是唯一真实 DESI 文件扫描结果。

续接：2026-09-25 14:10（Asia/Shanghai）。dev Assets Helm revision 241 已完成 rollout，
前后端均 Ready、0 restarts；镜像为 `0.1.0-20260925-135717`。健康接口返回 bundle
`reviewed-mugfs3x1-846ba75f` / `5c9bde3801522ce35127d8d83152f0fee5970939ba9d55433b746ba369be0675`，
当前 manifest 为 526 files；本次仅包含扫描提交契约修复，未改变公开包、MOC 或历史数据。

- DESI DR1 首个真实单文件扫描已通过 Assets 管理 API 提交并完成：任务
  `desi-dr1-tiles-catalog-20260925`，connector `desi-dr1-spectro-oss`（OSS endpoint
  `http://oss-cn-hangzhou-zjy-d01-a.res.cloud.zhejianglab.com`，bucket
  `data-and-computing`，配置根 `projects/CSST/shared-data/desi/dr1/public/dr1/spectro/redux/iron/`）。
  输入为 `tiles-iron.csv`，使用 `catalog-radec`、ICRS、`TILERA/TILEDEC`、O8，Warehouse
  返回 `SUCCEEDED`、1 file、1 HDU、4,323 coverage documents、0 errors、available order 8；
  run ID `desi-dr1-tiles-catalog-20260925-20260925060447`，source snapshot SHA
  `382d84e58303906f2bfb66bb86b01ae5217f7cbb3262fd83936525310aa6e0e3`，evidence path
  `/var/lib/atlas-evidence/desi-dr1-tiles-catalog-20260925-20260925060447`。反查已在
  Euclid Q1 × DESI C04 真实区域返回 `tiles-iron.csv`、精确 O8 `catalog_radec` occupancy
  记录和 DESI 公开入口；结果只代表这一个已扫描目录文件，不代表完整 DR1 光谱文件集或完整
  footprint。公开反查还保留扫描文件有限、覆盖 MOC 更广的完整性说明。
- Euclid Q1 原批次 `euclid-q1-mer-images-20260924` 仍 RUNNING，最新查询为 VIS 352/352、
  NISP-H 352/352、NISP-J 294/352（2 running）、NISP-Y 0/352，0 failed；总完成 998/1408。
  未重提、未改变 frozen roster；仍只代表冻结 MER 文件规则范围，不是完整 Q1。

续接：2026-09-25 14:30（Asia/Shanghai）。同一 Euclid 批次继续推进到 VIS 352/352、
NISP-H 352/352、NISP-J 320/352（2 running）、NISP-Y 0/352，0 failed；总完成 1024/1408。
未重提或修改任务。公开覆盖验收确认 Euclid×HST 有 138 个 O8 像元、DESI×HST 有真实重合
组件，三方 Euclid×DESI×HST 有 15 个 O8 像元；反查按证据层级区分已扫描文件与覆盖依据。
三方示例中 Euclid 扫描文件可返回真实 FITS、OSS URI 和 ESA 获取链接；没有对应扫描命中的
DESI/HST 结果仍保留覆盖来源和完整性限制，不伪造文件或链接。验收证据保存在
`/tmp/assets-three-way-c06-reverse.json`、`/tmp/assets-desi-q1-reverse.json`。

续接：2026-09-25 13:08（Asia/Shanghai）。HEALPix sidecar 后的历史包修复 run
`mugfs3x1-846ba75f` 已发布并通过 authority/site 核验，当前 bundle 为
`reviewed-mugfs3x1-846ba75f` / `5c9bde3801522ce35127d8d83152f0fee5970939ba9d55433b746ba369be0675`。
11 个上一版本固定 URL 均仍可下载，SHA 全部与原包一致；新目录仍只有 11 个当前包，Euclid
3.17.0 与 ACT 3.5.0 均带 O4/O8 sidecar，旧包不在当前目录中。dev Assets Helm r239，镜像仍为
`0.1.0-20260925-114800-historical-package-retention`。Q1 批次未重提，已由 Warehouse operator
分页/OOM 修复恢复调度；最新 Warehouse 快照为 VIS/H 各 352/352、J 238/352（2 running）、
Y 0/352、0 failed，942/1408。

- 2026-09-25 13:08：Warehouse 原生 smoke、Assets caller smoke 和 Workspace PVC caller smoke
  均已通过。原生 smoke session `84945` 的 S3/local/MOC 请求分别成功；Assets caller
  `warehouse-caller-assets-scan-20260925050233-703c8fb28f63baf9` 成功并返回 1 文件/1 覆盖及
  51 个截断候选；Workspace caller `warehouse-caller-workspace-scan-20260925050444-5f35ae69932ab6f8`
  成功并返回 1 文件/2 覆盖。请求资源按 `KEEP_REQUESTS=1` 保留，未读取用户科学数据。

## 最新验收与数据进度（2026-09-25）

- **资源包 O4/O8 HEALPix 列表已正式发布到 dev，最高优先项完成。** Reviewed run
  `mugdqevw-ddf6b6d5`，release `reviewed-mugdqevw-ddf6b6d5`，bundle SHA
  `395ce15d091a8e93181b259f07550f739ffbb0e926e0db8807cb870ca1adf09f`，515 files/11
  packages。11 个当前公开包均有 `healpix/order4.json`、`healpix/order8.json`；逐包从
  dev 下载、校验 catalog size/SHA、manifest support-file SHA、ICRS/NESTED/order/version，
  并使用包内原生 MOC 重算每层像元及 union，全部通过。ACT 的 3 层和 SDSS 的 2 层因原生
  MOC 阶数低于 O8，在 O8 sidecar 显式 omitted；没有由 O4 升采样。证据
  `/tmp/assets-published-healpix-verification.json`、`/tmp/assets-healpix-after-catalog.json`。
  site/backend 最终 `/data/current` 均指向新 bundle；管理发布 run 的当前 site verification
  为 `verified` 且 observed SHA 与新 bundle 一致。
- 本次为 package-only 重建，冻结当前 approved products/native MOCs，没有选入工作草稿或退休项。
  镜像 `0.1.0-20260925-110300-healpix-upload-timeout`，Helm r238，values 将
  `objectStore.requestTimeoutMs` 设为 300000；对象客户端从该配置取超时。首次上传在默认
  60 秒时多次超时并失败，权威指针未动；修复后同一基线 package-only run 成功。authority
  更新后 site PVC 一度仍用旧 symlink，已由正常 init sync 重启 site/backend 并核验新指针；
  不是直接改写 PVC。build、319 Node tests（317 pass/2 Core-image skips）、Core wheel、site
  TypeScript、Helm lint/render 和 diff check 通过。日志 `/tmp/assets-healpix-timeout-*`、
  首次失败和成功 run 分别为 `mugcqmn5-a4ebc400`、`mugdqevw-ddf6b6d5`。旧 bundle 与包文件留在
  immutable release/cache；不要据此恢复旧公开指针。
- 下一最高项：Euclid Q1 原 Warehouse ScanBatchRequest
  `euclid-q1-mer-images-20260924` 仍 RUNNING，未重提。最新快照 VIS 352/352、NISP-H 352/352、
  NISP-J 238/352（2 running）、NISP-Y 0/352（352 pending），0 failed；总完成 942/1408
  partitions。只有冻结 MER 文件规则范围可视为已完成，非完整 Q1。roster SHA
  `2545cf6ee5a7cbea25484500c3e14a954c893259d9cb10ae8f5cfa381faf0aa3`，bucket/prefix 为
  `data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER/`。
- 按用户授权对 `projects/CSST/shared-data/` 做了限量只读 OSS `ListObjectsV2`，没有读科学文件。
  顶层发现 `desi/`；DR1 下有 `desi/dr1/public/dr1/` 与 `desi/aws-mirror/dr1/`，镜像有
  `spectro/`、`vac/`；公开目录包含 `spectro/`、`survey/`、`target/`，另有 `dr1/bgs_coadds/`。
  接下来应限量列举这些谱文件子目录，确认文件组织和命名，再通过 Assets→Warehouse 正式提交
  DR1 扫描；目前不得把目录存在等同于扫描或目标关联完成。DESI 目录发现临时使用 Euclid
  connector Secret，仅用于用户授权的路径列举，凭据未输出。六个前缀的受限目录快照保存在
  `/tmp/assets-desi-dr1-directory-probe.json`（SHA `2966e9536978e6ee0f24fc998debda03f07226dda4ab52e31e718c44267bf7d0`）。
- 2026-09-25 13:14 的后续只读布局探查保存为
  `/tmp/assets-desi-dr1-layout-probe.json`（SHA
  `c693395e1ab87175c98003452215c3fa077028b004ae3789a111a4effa995442`）。公开 DR1
  `spectro/data/20200201/00045677/` 仅含 GFA、请求和校验清单，而
  `00045681/` 含 `desi-00045681.fits.fz`（约 272 MB）及请求/校验清单；代表性的
  `redux/iron/exposures/20210106/00071051/` 含 44 个对象（13 个 frame、30 个 PSF、
  1 个校验文件），没有读取对象内容。`zall-pix-iron.fits` 的
  22.4 GB 单文件及 42 个 512 MiB 分片只作为目录事实保留，不能直接当作已扫描的
  目标目录。AWS mirror 的 DR1 目前只列出 `spectro/redux/iron/zcatalog/` 和
  `desi_spectro_calib/0.4.0/` 子树，未发现独立的可扫描目标清单。
- **本次 dev：Assets Helm revision 239**，镜像 `0.1.0-20260925-114800-historical-package-retention`，
  site/backend Ready，0 restarts；线上包目录仍为 11 项，版本：2mass 3.5.0、act 3.5.0、
  des 3.4.0、desi 3.4.0、euclid 3.17.0、gaia 3.3.0、galex 3.7.0、hst 3.4.0、
  jwst 3.4.0、sdss 3.6.0、sumss 3.3.0。活跃入口 `http://10.15.51.75:32083/`。

- H累计164/352时，再验同一Euclid×DESI C04反查：185个文件，前次153/153全保留，
  新增32；8页、138个来源入口、8项覆盖依据，分页计数与去重数量一致，末页hasMore=false。
  H仍incomplete，VIS352/352仅冻结规则范围complete。证据
  `/tmp/assets-q1-desi-expanded-h-{pagination,comparison}.json`。首屏14325ms，后续666–1088ms，
  间歇延迟仍存在；Warehouse owner继续只读分项诊断fetch/资源等待/存储，不重启或调参。

- 在同一已保存Warehouse snapshot内，经Assets moc-builds API串行新增4条HST观测草稿，
  全部201/STAGED，未新查源、未下载科学文件、未发布：obsid26379957（ACS F775W，
  product332b1034ce84c2c0961d）、26323986（ACS F850LP，74673f7010e5669fb4a8）、
  23848193（WFC3/IR F160W，b797812498d2a9b60d02）、26517950（WFC3/UVIS F336W，
  0f8e3541e2e726388a8c）。build命名均为 `hst-observation-<obsid>-155b688c`。
  4条均native O10，与冻结Q1/WFC3范围分别相交5/5/2/4 cells；来源快照、原生MOC、
  build/product/executionEvidence绑定及estimated/incomplete声明全部验证通过。
  证据 `/tmp/assets-hst-snapshot-small-batch.jsonl`、`/tmp/assets-hst-footprint-<obsid>.json`。
  加上原F105W观测现有5条真实观测草稿，仍是有限子集，不代表完整HST。
  公开响应hash与r236基线完全一致（`/tmp/assets-after-hst-small-batch.json`）。
  这4条不自动加入之前待用户确认的3份发布范围；继续保持草稿。

- 续接核实：Q1原批次仍RUNNING，VIS352/352、NISP H144/352、2个运行中、0失败，
  J/Y待调度；未重新提交。Assets当前connector清单只有Euclid MER、smoke和本地来源，
  没有真实DESI连接。已向用户请求DESI DR1 connector或endpoint/bucket/prefix及授权连接关系，
  不读取用户私有connector或用测试源代替。HST三份草稿的发布确认也仍待答复。
  `docs/scan-batches.md` 已从“仅本地开发”更新为当前dev状态，并明确Workspace消费公开
  反查证据、私有扫描独立，以及remote connector caller gate尚未覆盖的限制。

- **当前 dev：Assets Helm revision 236**，镜像 `0.1.0-20260925-055534-hst-native-order`，
  digest `sha256:4f153d75e1a785422fac49dac0233d9eaaf1d8ae5c83327a90f37a23bbcc455d`。
  修复 regions wrapper 将请求计算上限O10错误地要求为输出原生最大阶；实际合法O9现可导入，
  仍要求native不低于queryOrder8/公开最低4且不高于请求上限，不制造O10。另修复JVM启动参数
  `ExitOnOutOfMemoryError` 被诊断为OOM的误报，live GET现为unknown（就绪但未独立证明执行循环）。
  317 tests/0 skips、build、site tsc、Core pin、Helm lint/render通过；镜像内断网合成导入及
  真实obsid24796973锁定region复跑通过，实际O9/hash与原输入生成物一致。manifest仅image变化，
  site/backend Ready、0 restarts、实际digest一致。公开health/assets/coverage/catalog/packages
  响应hash均与部署前一致；Q1 MOC Range206/32bytes/source SHA未变；真实反查43cells匿名+Key
  6页200、26不同文件、原4/4文件存在、末页hasMore=false。相关日志/证据
  `/tmp/assets-hst-native-{build,tests,types,helm-lint,image-build,image-push,rollout}.log`、
  `/tmp/assets-{before,after}-hst-native-rollout.json`、`/tmp/assets-hst-native-live-pagination.json`、
  `/tmp/assets-hst-native-range.json`。live values/rendered/manifest是0600配置，不输出或提交。
- 同一Warehouse快照的正式HST导入现已201：`hst-observation-24796973-155b688c`，
  product `9334e8aecae1d80a40b9`，STAGED/unpublished，native O9/[9]/1cell，MOC SHA
  `5b268f896d391ed32404bfafec62e133b9b9737eb29b75f4fbcbaa1caf0c8630`。
  `/tmp/assets-hst-native-live-import.json`。真实几何已核对：冻结O10的69cells降到O9有24
  parents；Q1/CDS范围两输入均覆盖24/24，新观测cell2299879命中其中1个。未升采样O10。
  verifier所有检查通过（ok=true/failures=[]），包含product.mocBuild/executionEvidence绑定、
  CR身份、快照三方hash和三份MOC hash；`/tmp/assets-hst-native-live-footprint-proof.json`。
  没有重新发现源、没有科学文件下载、
  没有发布草稿。已向用户提交3份HST草稿的具体发布确认，尚待答复，不视为已授权发布。
- Warehouse r11基础与Assets caller gates通过；Workspace sourceVolume caller通过。
  Workspace remote connector未覆盖：没有已识别的合成远端凭据，未使用用户connector。
  详细run IDs/evidence见Warehouse HANDOFF；不能称全路径验收完成。

- r235 真实匿名浏览器验收通过：Euclid/DESI/HST 均可选择；Euclid×DESI O8
  总587 cells，C04为506 cells，详情200。抽屉显示真实Q1 VIS/NISP H文件、OSS URI、
  DESI/Euclid来源及继续浏览按钮；点击打开空API Key框后取消，未提交Key或解锁请求。
  桌面1440/手机390均无页面横向溢出、console/page/API错误；WebGL初始化成功。
  证据 `/tmp/assets235-euclid-desi-c04-browser-acceptance.json` 与同前缀 desktop/mobile PNG。
  此验收不证明新HST观测已发布或三方交集存在。

- HST CRD 的空候选 default `[]` 已上线。原失败请求由正常 controller 从原 Job
  证据重新投影，Assets GET 现在显示真实 FAILED/DiscoveryTransportError，保留
  candidates=[]、queryExhausted=false，不再被 ReconcileError 遮蔽；未重提、删除或手工
  修改旧 CR/Job。证据 `/tmp/assets-hst-original-after-schema.json`。新的 typed-failure
  worker 已随 Warehouse r11 部署；原尝试不能追溯恢复已经丢失的异常类型。

- 真实重合→来源分页闭环补验：公开 Euclid × DESI O8 的 C04（506 cells、8 个实际
  参与图层）经匿名预览 + Key 续页，共 8 页/153 个不同文件/138 个不同来源入口/
  8 项覆盖依据；页计数与去重后计数相同，最后 hasMore=false。文件包括 Q1 VIS/NISP H，
  DESI EDR/DR1 保留 Tile footprint 与实际来源入口，不宣称已核实光谱科学文件。
  此时 H 仍 incomplete，VIS 的冻结规则范围 complete；未制造三方交集。
  证据 `/tmp/assets-q1-desi-{live-overlap,component-details,component-reverse,pagination-proof}.json`，
  分页脚本 `/tmp/assets-q1-desi-pagination-proof.mjs`。这是对真实公开重合区域的验证，
  不是使用孤立已知 cell 代替重合链路验收。

- 前次工作记录（下述422已由r236修复，以上方结果为准）：Warehouse operator r11 已部署，两个 controller Ready；discovery worker
  digest `sha256:a1ddf6de697b015b6648c408fe9c98a8f8aab16283a0e3f558489cfdb88d2a3f`。
  通过 Assets API 唯一重试
  `hubble-space-telescope-moc-discovery-20260-retry-20260924213213` 已成功，100 个候选，
  truncated=true/queryExhausted=false；snapshot SHA
  `155b688ce20a0e48aa7227d326201eb417fb79c5e916e42e60ef0d5ed9ad6f87`，52866 bytes。
  证据 `/tmp/assets-hst-system-discovery-retry{,-poll}.json`；原失败请求与证据保留。
  导入真实 WFC3/IR F105W obsid24796973 经 Assets moc-builds API 返回422
  `MOC Core rejected the locked MAST observation footprint`，尚未形成成功草稿；
  `/tmp/assets-hst-system-import.json`。owner `/root/hst_metadata_assets` 正定位实际
  snapshot/Core 转换，不以换候选或忽略错误掩盖问题。候选中心锥命中不等于实际 footprint
  相交；导入成功后还需验证冻结范围交集。verifier 也需分开校验输入CDS MOC与新观测
  输出MOC，不能要求两者SHA相同。两份CDS草稿仍未发布，DESI真实来源仍待提供。
  最新Q1批次VIS352/352、NISP H90/352（1032 edges）、J/Y待调度，0失败，RUNNING。
  Warehouse owner 正补核 r11 caller smoke gates。Assets executor OutOfMemory 已定位为
  启动日志 `-XX:+ExitOnOutOfMemoryError` 被宽松正则误中，assets_batch_api 正最小修复
  与回归。controller/worker无OOMKilled；operator一次重启为启动探针503触发SIGTERM。

- **前次 dev：Assets Helm revision 235**，镜像
  `0.1.0-20260925-043333-hst-identity`，registry digest
  `sha256:2686bc2ba209433509d80c2dc4d44633a31e1f694d2d3bf6e7e31e3a7c58534e`。
  修复 HST discovery 的 work/release identity 仍硬编码 `hst-mast-observations-2026`、
  与 importer `hst-mast-observations` 不一致的问题；旧 CR 保留原身份，不改写历史。
  build、313 tests（0 skipped）、Core pin、site tsc、Helm lint/render 通过；manifest
  仅 image 变化，site/backend Ready、0 restarts，实际 digest 一致。公开 bundle/512 files、
  coverage/catalog（除生成时间）、resource package catalog 未变。部署后固定 43 cells
  分页返回 26 个文件，原 4/4 都存在，6 页 HTTP200，22–73ms，末页 hasMore=false；
  Q1 VIS MOC Range206/32 bytes 与 source SHA 一致。证据
  `/tmp/assets-hst-identity-{build,tests,types,helm-lint,image-build,image-push,rollout}.log`、
  `/tmp/assets-after-hst-identity-rollout.json`、`/tmp/assets-hst-identity-live-pagination.json`、
  `/tmp/assets-hst-identity-range.json`。live values/rendered/manifest 为 0600 配置文件，不提交。

- **Q1 VIS 冻结范围已完成**：原批次 `euclid-q1-mer-images-20260924` 的 VIS 352/352，
  352 files/4044 O8 estimated edges，0 failed；NISP H 已自动开始（2 running），
  J/Y 待调度，整个 batch 仍 RUNNING。这只代表冻结 MER 科学影像规则范围，不是完整 Q1。
  完成后的固定 43 cells 真实分页再次通过：26 个不同文件，原 4/4 文件均保留，6 页
  HTTP200，最终 hasMore=false，每页 23–97ms；
  `/tmp/assets-q1-vis-complete-pagination.json`。间歇 ES 延迟仍未证明已解决。
- NISP H 已有真实反查正例：从本批次 ACTIVE partition pointer 选择实际 O8 cell163705，
  公开 API 返回 Tile102158272 的 `EUC_MER_BGSUB-MOSAIC-NIR-H_TILE102158272-...fits`、
  原 OSS URI、实际 O8 estimated/fits_wcs、run/snapshot/partition 关联；此时 scope22/352
  incomplete。证据 `/tmp/assets-q1-nisp-h-committed-proof.json`；另测 cell549012 无文件，
  仍披露已扫描范围，未断言该区域没有数据。这里只读系统已生成的索引和公开 API，
  没有绕过 Warehouse 枚举或读取源科学文件。

- **前次 dev：Assets Helm revision 234**，镜像
  `0.1.0-20260925-033952-hst-evidence`，registry digest
  `sha256:1607388d5d416a09f1d2d0bf30a2c9c2f7100f1b5cf030fd6dd0fae8b8c54f1b`。
  网站与 backend 均 Ready。完整 build、313 tests（0 skipped）、Core pin、site tsc、
  live-values Helm lint/render 通过。最终镜像以 UID 10001、network=none、真实默认 Core
  runner 完成合成 HST import→STAGED；使用与 Helm 一致的 MOC_BUILDER_SCRIPT 配置。
  日志 `/tmp/assets-hst-integrated-{build,tests,site-types}.log`，镜像验证
  `/tmp/assets-hst-final-image-smoke.json`；这是合成 importer 验证，不是 MAST 真实获取。
- r234 已部署公开图层 allowlist 和 metadata-only 草稿状态查询，启动只加载 1 个批准的
  Warehouse layer/11 edges，不再出现此前 200000-document catalog overfetch 警告。
  公开 bundle `reviewed-muedpg06-8e4a45a0` / SHA
  `4f76e8e726ac31457edc320de105fe867b8f4f9c2c0594c6528a50f46d36e8b7`、512 files、
  32 layers，以及 coverage/catalog/package 响应均与部署前一致；证据
  `/tmp/assets-{before,after}-hst-rollout.json`。旧普通 VIS layer/11 edges 的保护 SHA 未变。
- r234 固定 43 个 O8 cells 的真实匿名预览/API Key 分页返回 22 个不同文件，原始 4/4
  目标存在，6 页全部 200，最后 hasMore=false。首请求 14867ms，其后 22–81ms，
  `/tmp/assets-hst-live-pagination.json`。目录过量读取已修复，但间歇延迟尚未解决，
  不能将两者混为同一根因；只读诊断正在区分 API 外围与 ES/Store 用时。
- 本次续接 Q1 原批次仍 RUNNING：VIS 310/352，310 files/3559 O8 edges，2 running、
  0 failed，H/J/Y 尚未调度。仍使用原 roster，不重新提交或重启，不代表完整 Q1。
- HST scope resolver、Warehouse snapshot 校验/import 和无链接 footprint 来源展示已在
  r234 部署。Warehouse 新 operator/discovery 镜像已构建验证；部署前 CRD dry-run 发现
  radius exclusiveMinimum 类型错误，已改为 minimum:0/exclusiveMinimum:true，完整静态
  gate 通过。Warehouse rollout/live gate 尚在进行；真实 MAST 请求需经 Assets API 提交。
  两个 CDS HST 草稿仍未发布。以下 r233 及更早的计数和“尚未部署”是过程记录。
- Warehouse operator 已更新至 Helm r10，MOC CRD 已接受新 policy；两个 controller Ready，
  scanner pin 与现有 Q1 batch 保留。首个真实请求通过 Assets API 返回 201：
  `hubble-space-telescope-moc-discovery-20260924201028`，范围为 WFC3/Q1 O10 C16 的
  69 cells。其 Job 使用已验证的新 discovery digest，但 worker 业务结果为
  FAILED/DiscoveryTransportError（request stage，0 response pages/0 bytes，无 snapshot）。
  不能将进程退出 0 / Kubernetes Job Complete 当成发现成功或零候选科学结论。
  Operator 回写空 candidates 又被 CRD 拒绝，掩盖原始错误为 ReconcileError；Warehouse
  owner 正修复并保留原任务/evidence，不盲目重试。提交与 CR 证据分别在
  `/tmp/assets-hst-system-discovery-submit.json`、`/tmp/assets-hst-first-discovery-resource.json`。
- 反查慢的同参诊断已纠正早期不等价探测：只查普通 VIS 层的几十毫秒不能代表包含批次
  alias 的实际请求。同一 public layer + batch binding/43 O8 cells/limit 6 的 Store 查询
  实测 11673ms，其中 ES layer 查询 took9266ms，file observations took2285ms；
  partition/coverage 查询仅 1/2ms。完整无凭据请求与分项计时保留于
  `/tmp/assets-hst-batch-alias-same-args-timing.json`，尚未确定这两个 ES 慢查询的根因。
  后续 Lucene profile 与 `_source` 对照及限制见
  [延迟诊断](docs/warehouse-reverse-lookup-latency-20260925.md)；最新快请求不能证明慢点已修复。
- Workspace 已部署 Helm `asa` / `asa-workspace` revision 47，镜像
  `0.10.38-dev-20260925-assets-reverse-evidence`，digest
  `sha256:21915eb3e89c2b7a3ae03095fa99269a2b7b565593c6c250c4bab498bd47019f`，
  Pod Ready/0 restarts。实际镜像与当前构建 hash 一致，Helm manifest 仅 image 变化，
  原 state/evidence PVC 与 11 packages/4 active packages 保留。公开 Q1 VIS/O4 cell637、
  includeWorkspace:false 的真实 Workspace 反查 HTTP200，0 files 但保留 1 项覆盖依据，
  scope 336/352 incomplete。未读取私有 CSST、未安装/激活包、未运行改变状态的 e2e。
  build、284 tests/2 optional skips 通过；详细记录在 Workspace
  `docs/resource-package-compatibility.md`，临时证据目录
  `/tmp/asa-workspace-reverse-evidence.7DtThpzP/`（含配置快照，不输出或提交）。
- 现有公开 HST COSMOS 的来源契约已单独实测：
  `hst-mast-cosmos-obs-26442812` / O8 cell436132 的匿名预览 HTTP200，0 files，
  但保留 `observation-footprint`、MAST obsid/proposal/target、ACS/WFC、filter、snapshot
  SHA、estimated/incomplete/not-scanned。Workspace 当前 HST 包未安装，因此未改用户
  激活状态去强行测试；跨端字段透传和展示只有合成测试证据，不能宣称该 HST 行已完成
  live Workspace 链路。这也不是 HST/Q1 新范围补齐的验收。

- 本次续接核实 Q1 原批次仍为 RUNNING：VIS 196/352，196 files/2243 O8 edges，
  2 running/0 failed；NISP H/J/Y 待调度。冻结 roster SHA 未变；未重复提交任务。
- 公开图层 allowlist 与草稿 metadata-only 查询的源码修复已完成一轮 build/test：
  308 passed、1 skipped，尚未部署；HST API 接线仍在修改，此测试不是最终集成门禁。
  skipped 项为未设置 `ASSETS_MOC_CORE_REGIONS_TEST_IMAGE` 的 Core regions 镜像集成测试。
  真实 Warehouse 只读复核已通过：首个查询的 32 IDs 与当前公开目录严格一致，两次查询
  合计 48.4ms，返回 1 layer/11 edges，ES took 分别 1ms/0ms；未请求被排除图层或私有记录。
  查询轨迹与断言保存于 `/tmp/assets-scoped-catalog-smoke.json`。
- HST 上线前审阅发现必须补齐的契约/运行问题：整份 MOC 投影 4097 上限会误挡小交集；
  编译后的 Python converter 路径需匹配镜像；Warehouse 必须解析实际 MAST JSON，并输出
  Assets 使用的 `Tables[].Columns[].dataIndex` 为列名字符串的规范表，不能用数字列索引；
  `dataRights` 大小写索引需一致。两端 owner 正修复，完成跨端与镜像内成功路径验证前不部署。
  已用保留的真实 Q1 VIS 原生 MOC（SHA `7f8906442664691417d5314b7cbaf2dbdeafabc4fe9f7aa32b560280cb9af5f6`）
  复现投影问题：O10 实际有 21269 cells，4097 上限确实 truncated；并非假设性边界情况。
  范围交集修复后已通过真实数据对照：WFC3 的 22 个区域、ACS 的 11 个区域，每个区域的
  完整 cells 和查询 cone 均与独立完整投影结果一致；两者各有 160 个 O10 交集 cells。
  证据 `/tmp/assets-hst-resolver-real-scope-proof.json`；这是本地 resolver 验证，尚非 live API 验收。
- 累计扫描到 212 个 committed VIS 分区时再次检查原固定 43 个 O8 cells：真实匿名预览和
  API Key 续页返回 21 个去重文件，原 4/4 目标均存在，最终 hasMore=false；证据
  `/tmp/assets-progress-pagination-smoke.json`。仍明确 incomplete scope，不作为全 Q1 验收。
- HST 来源展示还发现旧反查 mapper 将 `observation-footprint` 归为 `published-moc`，
  overlap details 未传递 source identity/hash/completeness。backend 契约与测试正在补齐。
  前端已支持 `publicSources[].coverageEvidence`：无可访问链接也显示来源、仪器、滤镜、
  声明的精度/扫描范围和快照 SHA；site 类型检查通过。合成 HST fixture 的真实浏览器
  1440/390px 检查通过，无卡片横向溢出和 pageerror；证据 `/tmp/assets-hst-source-card-browser.json`
  与 `/tmp/assets-hst-source-card.png`。该 fixture 验证不是 HST live 发布或真实元数据获取。

- **前次 dev：Helm revision 233**，镜像 `0.1.0-20260925-013751-reverse-retry`，
  registry digest `sha256:2627763942b517b341c0b6cbe29833d47a41b18707de4eb3462ba3a58553f5b7`。
  站点/backend 均 Ready。已修复确定的错误处理缺陷：Warehouse 查询暂时失败或解析异常时，
  反查首屏/续页不再伪装成 HTTP 200 空结果，而返回 503 + Retry-After；原游标可重试。
  只有明确 no-ACTIVE 的 409 保留正常覆盖来源 fallback。之前单次漏文件的根因仍未证实。
- 本镜像全量 build、298 tests（0 skipped，包含断网 Core regions 集成）、Core pin、
  Helm live-values lint/template 全通过。日志 `/tmp/assets-retry-{build,suite,image,push,rollout}.log`。
  values/rendered 文件含运行配置，权限 0600，不输出内容或提交 Git。
- 部署后真实 Q1：固定 4 个 committed 分区/43 cells，匿名 + Key 续页 4 页全部 HTTP 200，
  返回 14 个去重文件，4/4 预期文件均找到，最终 hasMore=false；每页 24–68ms。
  `/tmp/assets-live-reverse-pagination-smoke.mjs` 为复测脚本（Key 从 Pod 环境读取，不输出），
  结果 `/tmp/assets-retry-live-pagination.json`。无关 cell 0 仍无文件；旧 VIS 的 1 layer/11 edges
  两项保护 SHA 与前序基线完全一致。
- 公开 bundle、coverage 响应、32 个 catalog layer 全字段与部署前一致：
  `/tmp/assets-{before,after}-retry-rollout.json`。启动时仍有 Warehouse coverage catalog
  超过 200000 文档限额的警告；本次公开图层未改变，不把此警告当成已修复或忽略其潜在性能影响。
- 这次检查 Q1 RUNNING：VIS 92/352，92 files/1054 O8 edges，2 running/0 failed，
  H/J/Y 尚待调度。不是完整 Q1；不重复提交或重启 batch。
- Warehouse catalog 超限已定位：`loadCurrentCoverageCatalog` 先拉取所有 ACTIVE
  层 coverage，`coverageCatalogFromWarehouse` 才排除 denied survey/未公开辅助层。
  只读聚合显示单个禁止纳入 Assets 的私有巡天有约 716 万条覆盖，导致 20 万限额触发；
  不记录其 layer ID、原始 coverage 或输入/输出快照。正在把限制提前到 ES layer query，
  并从当前公开图层身份约束 coverage 请求；不会提高限额或迁移/删除原始索引。
  该缺陷尚未部署修复。另做 8 次新连接对照：DNS 0–4ms、HTTP 6–48ms，均 green，
  没有支持修改 DNS 的证据；超限与间歇连接超时不能直接视为同一根因。
- DESI 来源继续只读核实：Warehouse 现有 `atlas-minio-desi-credentials` Secret 的存在
  不能证明有真实 DR1 来源；当前 ScanRequest 没有 DESI 请求，配置的 ES 中只找到
  `desi-overlap-catalog` / `desi-merger-catalog` 两个 `desi-public-catalog-demo` 层和失败 selftest。
  已知入口是内部 MinIO 的 `astro-artifacts/demo/desi/`，不把它当成用户的 DR1 光谱目录。
  用户的真实 connector/OSS 根路径仍待提供。查询中一次 tiny layer search 超时 5s，紧接的
  复测 54ms、ES took=0；间歇延迟原因未定，不能仅靠增加超时掩盖。
- HST 后续系统能力正在开发：Warehouse 通过现有 MocDiscoveryRequest 增加有界 MAST
  观测元数据 policy，复用现有 S3/MinIO 保存摘要命名的不可变快照；Assets 只读取、校验摘要并
  本地转换冻结 footprint。已完成通用本地 converter/Core regions worker 并包含在 r233，
  但 discovery→artifact→STAGED API 接线与 Warehouse policy 尚未完整，不可视为 live 可用。
  不增加独立 query 服务，不获取科学文件，不写 ast_*，不自动发布覆盖。

- 当前源码 `npm run build && npm test` 全量通过：294 项 Node tests 与 Core pin；
  日志 `/tmp/assets-live-export-{build,suite}.log`。部署仍为下述 revision 232；
  部署后新增的独立导出 CLI 不改变运行时服务。
- 只读当前公开接口导出 11 个巡天、32 个图层，逐层验证原生 revision 并核对导出前后
  bundle/catalog 身份。33 个 JSON 保存在
  `.assets-local/public-healpix/4f76e8e726ac31457edc320de105fe867b8f4f9c2c0594c6528a50f46d36e8b7/`，
  同级 `public-healpix-4f76e8e726ac.zip` 仅包含编号清单与 provenance，不含科学数据。
  每巡天有 `healpix/order4.json`、`order8.json`、`provenance.json`。
  ACT 的 3 层和 SDSS 的 2 层原生最高 O7，O8 导出明确标记 omissions，不伪造 O8。
- 原生合成 batch `warehouse-selftest-batch-20260925003405-d17858` 已成功，
  2 规则 × 2 分区，4 文件 observation/4 coverage，无全局文件元数据写入；
  实际部署的 store 反查命中 4 文件，无关区域 0 文件，scope 均 2/2 complete。
  证据 `/tmp/warehouse-native-batch-live-verification.json`。
  Warehouse 静态 Maven/quality/Helm/shell gate 通过。Assets caller 合成扫描
  `warehouse-caller-assets-scan-20260924170026-aa2a1febad997cd7` 成功，1 file/1 edge/0 errors，
  source SHA `c9e2d3fcbb3acb8bbf8c44de78af3ef9829976b212a6f0d33c238bbaf539c384`；
  对应 `warehouse-caller-assets-moc-20260924170026-aa2a1febad997cd7` 成功，51 个候选、
  truncated=true、evidence-only。Workspace caller 的授权合成本地 source PVC 路径成功，
  1 file/2 edges/0 errors；这不是 Workspace 远程 connector 路径验收。
  实际 Assets API → Warehouse 来源提交证据由下面真实 Q1 batch 提供。
- 真实 Q1 batch `euclid-q1-mer-images-20260924` 已由 Assets 管理 API 提交（HTTP 201），
  Warehouse 发现并冻结 352 个 Tile × VIS/H/J/Y 四规则，1408 个子任务，并发 2。
  roster SHA `2545cf6ee5a7cbea25484500c3e14a954c893259d9cb10ae8f5cfa381faf0aa3`。
  本次检查 RUNNING，VIS 完成 20/352，20 文件/230 条 O8 coverage，2 running，0 failed；
  NISP 尚待调度。此计数是时间点，不是 Q1 完整性声明，不重启或重复提交批次。
- 真实公开 reverse-lookup 已返回新增 VIS 文件、OSS URI、run/snapshot/partition 身份、
  实际 O8 estimated 和 incomplete scope。早期一次空结果尚在复核输入与时序原因。
  后续更强的真实分页验收失败：取按 partition_id 排序的 4 个 committed 分区、43 个
  数值 cells，匿名预览后用服务 API Key 续页到 hasMore=false，仍未返回已提交文件
  `ec3405d46fd047fc2df0aff99c313aa754a31a87ed169eb8518a92c11f26da28`。
  随后相同数字 cells 的真实分页重跑成功：预览 + 3 次 Key 续页返回 11 个去重文件，
  包含上述缺失文件，全部原始 4 分区目标均返回；未复现稳定漏文件。原先失败根因未证实，
  不能归因于并发新文件入库或声称已修复。正在回归 Warehouse 暂时不可用时是否误报分页结束。
  无关 O8 cell 0 无文件、匿名 cursor
  续页返回 400 均已验证。旧 VIS 1 layer/11 coverage 的两项保护 SHA 再核对完全未变。
- HST ACS/WFC3 仍为 STAGED 草稿，未自动审核发布；DESI 仍缺 connector/DR1 根前缀。
  Workspace 本地适配通过 282 tests、2 skipped，未部署。三巡天总体目标尚未完成。

## 共享连接批次与累计反查（revision 232 部署及实施记录）

- **前次部署：Assets Helm revision 232**，镜像
  `0.1.0-20260924-235812-batch`，registry digest
  `sha256:78787033a9c4a1c6f8e91979819bf77f03b435c9e62aa6cd1d660982a31273ac`。
  scanner pin 为 `0.2.0-20260924-235142-batch-capacity-v2`，registry digest
  `sha256:34987407da9eec4b4b6a24ca9a76b682bd1f50e3e0f0984ba4fcf3cec49ba745`。
  site/backend 均 Ready；批次管理 GET 已返回 200。公开 bundle SHA 和 32 个图层的
  完整摘要与部署前相同；旧 VIS layer/11 条 coverage 文档 SHA 均未变，O8 549012
  仍命中 1 file，无关 O8 0 返回 0 file。对比文件 `/tmp/assets-before-batch-rollout.json`、
  `/tmp/assets-after-batch-rollout.json`，部署日志 `/tmp/assets-batch-rollout.log`。
  最终权限修正版全量 build、289 Node tests、Core pin、Helm lint/template 均通过；
  日志 `/tmp/assets-batch-authorized-pagination-{build,suite}.log`。
  匿名仍最多 6 项且不能 cursor 续页；其游标仅供鉴权后接续，后续绑定 Key。
  单文件 `matchingCoverageTruncated` 保留；cursor 通用上限 10,000 keys/1 MiB，
  通过 1,408 个最长文件 ID 和 10,000 个正常长度 ID 回归。
  Warehouse infra r4/operator r9 已部署，批次 CRD/增量映射和空的新索引就绪，
  部署时原有记录数未变；其后合成批次成功，真实 Q1 已提交并运行，见顶部最新进度。下列 v1/v2/v3 镜像和失败测试说明为部署前过程记录，不是线上状态。

- Assets 新增原生 `ScanBatchRequest` 的创建/列表/详情 API，以及扫描页的多规则表单。
  一个 connector/root 配多个产品规则，目录发现、冻结 roster、子任务调度由 Warehouse
  执行；完整开发契约见 [scan-batches.md](docs/scan-batches.md)。`scanMode` 独立于产品
  MOC recipe：线上 Euclid Q1 VIS/NISP 产品是 `native-moc`，不能要求修改它才允许科学
  文件扫描。原有单任务逻辑层不能被新批次静默接管。已实现独立的
  `assets-batch-<productId>` 证据层及服务端产品关联：保留旧 ACTIVE 扫描，反查同时读取
  原层和新批次，响应仍使用公开 layerId，同时披露实际 evidenceLayerId。该命名空间不进
  公开覆盖目录、不替换 MOC。此新增关联的合并 build/test 已通过（286 项 Node 测试及
  Core pin），包含旧 ACTIVE + 新 PARTITIONED 同查、别名缺失、候选/失败排除和仅别名
  命中。公开目录 ES 查询直接排除批次证据命名空间，避免拉取无用的全量扫描几何。
  真实 VIS 扩展在合成验收通过后已经开始。
  已经通过 Assets API 提交四规则请求 `/tmp/euclid-q1-mer-batch-request.json`：同一 MER connector、
  全部直接子目录冻结范围、并发 2、输出 O8，仅匹配
  `EUC_MER_BGSUB-MOSAIC-{VIS,NIR-H,NIR-J,NIR-Y}_TILE*.fits`。规则相对目录留空，
  在每个 Tile 内按文件名筛选，避免未经核实的子目录假设；Warehouse 本次真实发现并冻结 352 个 Tile；此数不等于文件扫描完整性。
  四个 productId 已通过当前管理 API 再核实，产品仍为 native-moc/imaging；不修改其公开 recipe。
  扩展前只读基线：旧 VIS 仍 ACTIVE，run=`euclid-q1-vis-mer-tile-102018212-20260924`、
  1 file/11 edges。按 `_id` 排序后的 `{id,..._source}` JSON SHA-256：layer
  `338ecf35f46ba860cc602ba822a6618c5d110ac73f7aea926a5951d9985b2af7`，coverage
  `7049eae1d09347da2aefe6d64d5ce8f06be0d9c242e535da28e0cf95266fdab6`；后续可验证旧记录未变。
- 反查按逻辑层固定 scope → committed partition pointer → candidate coverage/file
  observation 读取；拒绝混合 scope hash/count，排除候选层，保留失败重试前的成功版本。
  `scanScopes` 披露 frozen scope 的 committed/expected，`files[].observations` 保留同一
  文件不同扫描记录；CSV/JSON 与抽屉保留快照、实际 order 和范围限制。空批次不覆盖已有
  公开 footprint。没有 file observation 时保留来源 URI/边，不回退到可变全局文件元数据。
- 本轮已验证 backend/site 构建、site 类型检查、286 项 Node 测试及最终 Core pin；专门的证据/CSV/覆盖
  测试 33 项通过。浏览器 mock 验证两条规则共享连接、native-moc 产品显式选 fits-wcs、
  partial 进度与 390/1200px 无溢出。证据在 `/tmp/assets-batch-*.log`、
  `/tmp/assets-batch-browser.py`、`/tmp/assets-scan-batches.png`；该浏览器验证阶段没有提交真实批次。
  FITS 星表规则支持互斥的 `hduName` / 零基 `hduIndex`，选择 HDU 时必须声明
  `coordinateFrame=ICRS`。浏览器实际表单提交 FIBERMAP、TARGET_RA/TARGET_DEC，并经
  backend parser 核验通过；脚本 `/tmp/assets-fits-batch-browser.py`，完整测试日志
  `/tmp/assets-batch-integrated-tests.log`。别名关联后的最新完整日志为
  `/tmp/assets-batch-final-build.log`、`/tmp/assets-batch-final-suite.log`；这尚不是实际 DESI 文件扫描验收。
- 实际 DESI DR1 产品为 `tile-table / spectroscopy / footprint_extent`；以它提交
  `catalog-radec` 批次时，必须为本次扫描派生 `object_presence → occupancy`，公开 Tile
  recipe 不变。已修复并加 FIBERMAP/TARGET_RA/TARGET_DEC 回归，生成层保留 `spectrum`
  模态。最新完整 build/test 日志 `/tmp/assets-batch-role-build.log`、
  `/tmp/assets-batch-role-suite.log`。当前 Assets 没有 DESI connector，已向用户询问 OSS
  前缀或 Workspace 连接名；随后也经两个线上应用的连接列表 API 只读核实，Workspace
  同样没有 DESI connector 或 DR1 根前缀。未枚举科学文件，不从 Q1 或私有连接猜测 DESI 路径。
- 线上只读复测：backend 的 `CoverageEvidenceStore` 查询 Euclid Q1 O8 cell 549012
  连续三次返回 1 edge/1 file，耗时 351/13/10ms；公开匿名 reverse-lookup 返回 HTTP 200、
  1 file/1 edge/estimated、56ms。本次没有复现旧 ES 超时，没有改超时或伪称已修根因。
- Warehouse 原生批次 controller/roster 验证仍由子 agent 实现，必须以其源码、测试和 live
  校验为准，不能仅凭 Assets 接口已经存在就开始真实扫描。Workspace 已保留 scanScopes、
  observations、来源 URI 和精度限制，后续也已适配 evidenceLayerId、scope/partition ID、
  publishedLayerId 与显式 observationLayerId。最新完整 build/test 为 282 passed、2 skipped；
  单文件截断字段适配后的完整 build/test 仍通过：日志 `/tmp/workspace-final-build.log`、
  `/tmp/workspace-final-test.log`；两项跳过因未配置 live Assets catalog/PostgreSQL test URL。
  尚未部署或 live 验收（会改变激活状态的既有 e2e 未执行）。下一步：完成 Warehouse 验收
  与跨项目消费，再通过系统扩大真实来源。
- Core 本地分发 pin/Dockerfile 已更新 1.2.0：最小公开源码快照 SHA-256
  `cb656ef9edc383c5a57a7d3e70f8ec4ad9c986cfb4da889d596a82b53b2ddf89`；wheel SHA-256
  `2bc99645aa3685c7a1509b2cc8cd52cce9d15717187a4bd48903572ee393af9e`。
  `baseCommit` 仅表示 dirty 源码基线，准确构建来源是快照；旧 1.1.0 wheel 保留。
  最终 wheel 在 Python 3.11.2 image 中安装并逐个校验 22 个最新包通过。此前完整 image
  重建曾受 PyPI 下载阻塞；现已成功构建 `0.1.0-20260924-batch-evidence`，image ID
  `8e46698a6f7a963b5bda0b1e580b83c9a0739aa382e611e9c39a22446b3cc7ca`，并用其非 root
  runtime 在断网模式下校验 Euclid 新 sidecar ZIP 通过。日志在
  `/tmp/assets-batch-image.log` 和 `/tmp/assets-image-package-validation.log`。
  该镜像之后 UI glob 长度上限从 512 对齐后端 256，并补齐批次证据层关联。
  最终 `0.1.0-20260924-batch-evidence-v2` 已构建、push 成功；image ID
  `6c19feb6f4301ea087878f3510e846bc71a189de30f3129d59284dd06130dadd`，digest
  `sha256:f9d8dff6cf41ccd07ced65fa5921e0bfb415751adc1c49244d2c368d71fd9f16`。
  日志 `/tmp/assets-batch-final-image.log`、`/tmp/assets-batch-final-push.log`。
  **最新待部署镜像改为** `0.1.0-20260924-batch-evidence-v3`（包含 DESI occupancy 修复），
  已构建并推送；image ID `27a5a4f37f5940503712d3611ba61495c6adf9eb2676d51bffdbaea3d72c0ff2`，
  digest `sha256:76fc96389011338f8b5229be2db42fe559af422bf39471359dcf18f996590daa`。
  日志 `/tmp/assets-batch-role-image.log`、`/tmp/assets-batch-role-push.log`；v2 保留但不用于最终 rollout。
  **v3 也还不是最终 rollout 候选**：随后已补运行隔离的 `warehouse-selftest-` /
  `warehouse-caller-` 合成层前缀排除（11 项 coverage 测试通过），并在修真实文件分页：
  当前 edge limit 与已展示文件数耦合、1000 边前缀和 16KiB cursor 会阻止大清单继续。
  需让受保护分页能推进到未展示文件，并保留每文件匹配关系截断限制；匿名仍最多 6 条。
  分页实现/测试完成后重新完整构建测试、生成新 immutable image，再部署。
  消费端已预先适配 `files[].matchingCoverageTruncated` 和文件 warnings：Assets 抽屉、
  跨页累计、CSV 的 `matching_coverage_truncated` 列及 Workspace 接收/展示保留该限制。
  最终文件清单结束不能抹掉单文件覆盖匹配截断。Assets 8 项 CSV 测试及 site 类型检查、
  Workspace server/viewer 类型检查及 6 项消费测试通过；后端分页实现仍由其 owner 完成，
  尚未重跑整体验证或部署。线上只读核实仍为 Assets revision 231、镜像
  `0.1.0-20260924-021018`。
  部署前公开基线已保存 `/tmp/assets-before-batch-rollout.json`：32 个公开图层及 revision/
  摘要，bundle SHA 仍为 `4f76e8e726ac31457edc320de105fe867b8f4f9c2c0594c6528a50f46d36e8b7`。
  本轮全量 build/289 Node tests/Core pin 已过，但审阅发现匿名 cursor 可续页、鉴权后反而
  无法接续，违背最多 6 条匿名预览规则；正在修该权限回归与 1408 keys 过窄上限。
  日志 `/tmp/assets-batch-pagination-build.log`、`/tmp/assets-batch-pagination-suite.log`
  仅对应修正前版本，不能作为最终 rollout 门禁。修后重新验证。
  尚未 Helm rollout，等待 Warehouse CRD/operator/增量 mapping 部署和验收；现有索引仅更新
  template 不会获得批次字段，Warehouse 正补幂等字段追加及候选层身份保护。
  **部署还需联动 scanner pin**：Assets 线上 `admin.warehouseScannerImage` 仍为
  `0.2.0-20260829-pvc1`，会覆盖 Warehouse operator 默认镜像。必须在 Assets Helm rollout
  同时设为 Warehouse 本轮验证并推送的新 scanner tag；只更新 operator 默认值不够。
  部署门禁新增容量修复：目录发现须有分页预算；operator 当前会为全部 rule×partition
  预建携带完整 roster 的 children，合法 32×2048 上界约复制 1.34 亿个 member 条目。
  已要求 Warehouse 改为轻量身份/状态遍历，仅为实际并发槽生成完整计划。完成并复验前不 rollout
  或提交真实目录扫描。最终 Assets image 已在非 root、断网模式下再次校验 Euclid ZIP，
  日志 `/tmp/assets-final-image-package-validation.log`；批次 helper 的 runtime import 也通过。
  已定最小容量修复边界：分页读取已创建的 child CR，释放每页完整 spec，只保留状态摘要；
  不新增 child CRD 引用模型。API/etcd 总字节仍存在 roster 重复，须如实披露并在首批约
  4×352 的真实规模观察查询耗时，不能将内存有界解释成没有存储/传输放大。
  本地 manifest 更新为 484 files、SHA-256
  `a3a9fe3e8472bf34d61e6c356defe2c41a7e0e9ed70fa417895e013521480b3a`，含源码快照和wheel。
  所有原有修改与数据保留，本轮未部署、未公开发布或修改已发布 MOC；新候选见下节。

## HST 扩展候选：已验证与 Q1 相交，尚未发布

- 经 Assets 管理 API 提交发现任务 `hst-moc-discovery-20260924131237`，成功返回受限的
  50 条候选（探测到 51 条，truncated=true），不能解释为完整 HST 目录。
- 经正常 MOC build API 准备两个 STAGED 候选：
  `esavo-p-hst-acs-blue-moc-build-20260924132027` 和
  `esavo-p-hst-wfc3-moc-build-20260924132027`。来源分别为 CDS MocServer 的
  `ESAVO/P/HST/ACS-blue`、`ESAVO/P/HST/WFC3`；完整输入与 build manifest 保留在
  evidence root 下对应 `moc-build/<name>/`，没有放入公开初始请求或 Git。
- ACS source SHA-256 `e26e6e77fdfef8b38d1a81f5b94e5c709494ceca561b283edb5195b46d6ac3e7`，
  输出 MOC `1d0913edb83b09f3b8391b42cff9e22e69ba35ddfa499501247ece7d4f213ed3`；
  WFC3 source `5144a22e550b9e47b37f378c0b50615cd85887c0912e81b1534508d51379326e`，
  输出 MOC `1d8406bde74a6a86c8c00dfd1d6ecaf13e521dc8d73fb56c15abe43a02010bbb`。
- 只读解码 backend evidence 的候选与当前公开 Q1 VIS 原生 MOC，在 O8 显式投影且确认
  未截断：ACS 为 8605 cells，与 Q1 相交 **28**；WFC3 为 4604 cells，相交 **44**。
  两个 HST 候选 native max O12，Q1 native max O10、O8 共 1476 cells，Q1 MOC SHA-256
  `7f8906442664691417d5314b7cbaf2dbdeafabc4fe9f7aa32b560280cb9af5f6`。
  进一步按双方均支持的 O10 验证，Q1 为 21269 cells；ACS 为 25735 cells、交集 160，
  WFC3 为 11707 cells、交集也为 160（两组像元不相同）。所有投影均未截断。
  这些是声明阶数下的覆盖资料交集，不是科学文件命中或精确有效像素交集。
- 已经正常 `register-product` API 绑定到 `hst-archive-coverage` 的两个产品草稿：
  ACS `225cb52106f79c98fcbc`，WFC3 `d862290e2bc8a845aa3f`。描述明确记录 CDS 来源、
  仅覆盖依据、档案完整性未知及未建立逐文件/观测索引。两个 build 仍 STAGED、published=null。
  公开 HST 仍是先前 COSMOS 三条 observation，草稿尚未审核或发布。
  下一步通过正常审核流程补充覆盖，文件/观测来源反查仍需单独建立。

## 当前施工：O4/O8 资源包清单（本地验证完成，未分发）

- 静态、动态和审核包增加 `healpix/order4.json` / `healpix/order8.json`，列出每层及
  survey union 的排序去重 NESTED 像元。输入为冻结原生 FITS MOC，保留身份、实际精度、
  completeness 和低阶层的 `omittedLayers`；使用说明见 `docs/resource-package-integration.md`。
- 本地生成并用候选 Core 1.2.0 wheel 校验了 **22 个巡天的新包版本**；原有 **34 个 ZIP
  哈希全部未变**。79 份冻结 MOC 的 Python/Assets coverage revision 一致。ACT 原生最高
  O7，O8 明确省略三层；AKARI 登记 O5 但实际只有 O0，整包重建被暂缓并保留旧目录项/ZIP。
  未改写 MOC、发布线上资源、恢复 raw evidence 或提交科学扫描。
- `packages:rebuild` 的包生成阶段已完成；其后 provenance 刷新曾因本地缺少
  `raw/moc/index.json` 失败。现已修复为保留合法的原输入哈希并明确未本地重验；随后
  provenance/catalog 阶段成功。本地 manifest 为 483 files，bundle SHA-256
  `bf818abfc9f565f07fda1c3d63c79c1079d2e399925042bc7f710b9ced93bffd`。
  这不是线上 bundle，且生成制品仍在忽略目录中。
- `npm run build`、后续服务端构建和最终 `npm test`（260 项 Node 测试、现行 wheel 哈希
  校验）通过；临时包/新包验证日志在 `/tmp/assets-sidecar-final-validation.log`，最终测试
  在 `/tmp/assets-priority-tests-stable.log`。历史包相关测试改为验证实际目录/历史集合，
  不再固定版本总数；旧离线 repair 工具剔除输入版本 sidecar，保持历史最小结构，测试仅
  写临时目录，没有执行实际历史恢复。
- Workspace 已补 sidecar 身份、哈希、union、省略资格及 precision/completeness 聚合
  校验，34 项定向测试及服务端构建通过。sidecar 尚不参与 Workspace 覆盖/反查计算。
- **分发状态更新见顶部**：消费 pin 已固定为 Core 1.2.0 源码快照及可复现 wheel，
  最终 22 包在 runtime Python 下通过校验。旧临时候选 wheel 不是当前分发 pin；
  完整镜像的最新验证见顶部；公共发布仍未执行。
- 下一优先级是 Warehouse 原生多规则批次与 Assets 提交/状态/反查适配，随后通过系统扩展
  Euclid VIS/NISP Tile、DESI、HST。Warehouse 当前已有未提交 partition/CAS 实现，不能
  假设原生 batch 已完成；应检查 `ScanBatchRequest` 实际源码和测试。方案为共享 connector、
  Warehouse Job 枚举并冻结直接子前缀、规则 relativePrefix/文件名 glob、限并发子任务，
  failed candidate 文件 observation 独立保存。单任务同 layer 的旧覆盖替换问题仍不可忽略。

## 新增真实扫描：Euclid Q1 VIS Tile 102018212（2026-09-24）

- 通过 Assets 管理 API 提交 Warehouse ScanRequest
  `euclid-q1-vis-mer-tile-102018212-20260924`。范围仅为
  `MER/102018212/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE102018212-` 前缀下的 `.fits`，
  使用 `fits-wcs`、O8、`image_extent`。Warehouse 状态为 **SUCCEEDED**：发现 1 个文件、
  处理 1 个 HDU、写入 11 条 coverage edge、0 个错误，`availableOrders=[8]`。
- 实际文件为
  `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018212-2D6DD0_20241018T201846.882686Z_00.00.fits`，
  1,474,565,760 bytes。11 条边均为 ICRS/NESTED、O8、`fits_wcs`、`estimated`。
  source snapshot SHA-256 为
  `da4fa597e9e516dbd7a4a3bbeff7f4efaf310e662523fcc848eee5498027b780`。
- 扫描没有发布产品或改写 MOC FITS。**发现同一 layer 不支持逐 Tile 累计**：本任务复用了
  102018211 的 `layerId`；完成后 `ast_layer_index_v1` 为 `file_count=1`、
  `coverage_count=11`，当前 `ast_coverage_index_v1` 有 Tile 102018212 的 11 条边，旧 Tile
  102018211 的 FileAsset 仍在 `ast_file_index_v1`，但其 `source_file_id` 当前 coverage 命中为
  0。不要用相同 layerId 继续逐 Tile 提交并假设索引会追加；需先确定批次层身份/累计反查策略。
- 用户可见反查尚未闭环：O8 cell `549012` 的公开 reverse-lookup（匿名预览和 Workspace
  full-key）均返回空 `edges`/`files`，而 backend 直接调用 `CoverageEvidenceStore` 曾命中该
  文件。已确认 `server/evidence-store.ts` 默认单次 ES 请求超时 15 秒；按生产请求形态实测，
  `ast_layer_index_v1` 查询 16.270 秒、coverage 查询 14.716 秒、file 查询 27.330 秒。超时会被
  `tolerateUnavailable` 降级为 geometry-only，需修复/验证后才能声称反查可用。
- 此扫描范围只有一个 VIS Tile，不代表 Q1 VIS/NISP 全量。旧任务
  `oss-euclid-q1-vis-tile102018212-20260826` 仍是 `FAILED/BackoffLimitExceeded`，保留原样。
  继续其他波段或 Tile 前，先处理 reverse-lookup 的 ES 超时，以及 Warehouse 同 layer 的覆盖
  替换语义；不恢复旧索引快照，不发布或修改 MOC。

## 当前补齐：HST MAST COSMOS 三条 observation footprint（2026-09-24）

- 已通过正常审核并发布三条明确选定的 MAST observation 覆盖：26442812（ACS/WFC）、
  26554761（WFC3/IR F125W）、26704909（WFC3/IR）。它们是 CAOM `s_region` 生成的
  estimated footprint，不是科学文件扫描结果，也不代表完整 HST archive。
- 三层均为 ICRS/NESTED，支持 O4/O8 查询，声明 native max O10；当前每层各有一个 O8
  cell。输入 source snapshot SHA-256 为
  `0ddeefa369484a91b74856cc61fa6ef3fed2673ee2f29b07d9da2dc36eac1fca`。产品详情的
  geometry precision 为 `estimated`，file reverse lookup 为 `entrypoint-only`，完整度未知；
  `scienceFileScan=not-scanned`，没有 region-to-science-file 索引。
- `/api/v1/coverage/overlap` 的真实验收：HST × DESI 返回 O8/C01，ipix `436132`；详情
  包含三条 HST MAST observation 和 DESI EDR/DR1 公开来源。HST×Euclid 当前无相交组件，
  原因是本次 HST release 只选了 COSMOS observation，而 Euclid Q1 官方区域输入是
  EDFF/EDFN/EDFS。直接解码当前发布的 MOC 后，两边在 O4/O8/O10 的 cell 交集均为 0；
  没有宣称三方交集。详情的整体 reverse lookup 精度为 `entrypoint-only`，不能解释成
  科学文件级命中；HST 的 estimated footprint 限制保留在产品描述与 readiness 中。
- 对同一 cell 的匿名 reverse-lookup preview 返回 `sourceFiles=[]`、`edges=[]`，总体标为
  `precision=estimated`、`truncated=true`，显示 6 条并提示另有 25 条。DESI EDR 有官方
  Tile 目录候选入口，目录内容未核实为科学文件；DESI DR1 仅有发布页，HST 仅有 MAST
  observation 来源页。无文件命中不代表源站没有数据。无 region-to-file index 的 source
  现标记 `completeness=incomplete`，不再错误显示 `complete`。
- Assets Helm revision **231**、镜像 `0.1.0-20260924-021018` 已部署，site/backend 均
  1/1 Running、0 restarts。开发站点为 `http://10.15.51.75:32083/`。线上健康接口报告
  bundle `reviewed-muedpg06-8e4a45a0`、SHA-256
  `4f76e8e726ac31457edc320de105fe867b8f4f9c2c0594c6528a50f46d36e8b7`、512 files；公开
  assets 中三条 HST MOC 均可见。HST MOC Range 返回 HTTP 206，`X-Content-SHA256` 与
  manifest 一致。没有提交 Warehouse 扫描任务或修改 DESI/Euclid 数据。
- 这只是 HST×DESI 的覆盖到公开来源入口闭环，不代表三巡天文件索引补齐完成。后续继续按
  冻结范围分批扩展 Euclid Q1 VIS/NISP Tile；DESI DR1 需核验实际科学文件并建立目标坐标与
  文件关联。每批保留 source snapshot、真实 order、扫描范围与 completeness 限制。
- `npm run build`、完整 `npm test`（258 项 Node 测试及 Core wheel）、Helm lint、
  `git diff --check` 通过；相关浏览器验收通过。代码、发布状态和本文仍未提交，原有
  工作树修改均保留。

## 当前文档原则：下载计划是来源清单（2026-09-23）

Assets 帮助用户定位数据、理解覆盖依据和追溯来源，绝不代替用户下载科学数据。
下载计划文件是 JSON/CSV 来源清单，列出重合区域关联的巡天、Tile/block/文件、
匹配依据与可用链接，不含科学数据。API Key 授权完整反查及清单导出，不授予源站权限。
无链接也应展示已有来源依据；当前 CSV 缺少无文件/入口时的独立依据行，属于待补能力，
本轮仅澄清文档，没有修改导出实现。术语和限制见[覆盖工作流](docs/coverage-workflow.md)
与 [API 导出说明](docs/api-reference.md#csv-and-json-exports)。历史“下载全部区块”指清单导出。

2026-09-23 文档修订更新了现行契约、README、规则与历史说明，保留有证据和契约价值的
文档；该轮未部署，也未修改扫描、MOC 或发布数据。下方部署数字属于各次验收记录。

## 当前修复：ACT 图层同步、重合分页与发布详情排版（2026-09-23）

- 线上 `/api/v1/surveys` 中 ACT 的 `modalities` 为 `radio`，coverage catalog 当前有
  3 个 ACT layer，Atlas 图层行可选并显示 Radio 图标。页面先直接读取公开巡天目录，再读取
  当前覆盖目录并按 `surveyId` 关联；没有对应公开覆盖的巡天显示“暂无公开覆盖”并保持禁用。
- 重合结果区继续只展示匿名预览；“继续浏览”只挂在展开的 overlap drawer 中，位于
  `匹配的 Tile / 文件` section 后、`<h3>PUBLIC SOURCES</h3>` 前。按钮铺满抽屉内容宽度、
  高约 30px，点击后先要求带 `region:query` 权限的 Assets API Key，再按 cursor 分页。
- 参与覆盖产品条目按巡天图例色着色，公开 Atlas 底色使用 52% 色彩混合，产品名单行省略并
  通过 title 保留完整值；每个条目顶部显示对应模态的 Lucide 图标，并提供 tooltip/ARIA 标签。
- 公开目录改为直接读取接口：页面先请求 `/api/v1/surveys`，成功后再请求
  `/api/v1/coverage/catalog`；不再写入或读取 `localStorage` 目录快照，也不发送 ETag
  条件请求，因此公开巡天和覆盖图层始终来自同一次页面加载的当前响应。覆盖区块仍只保留
  页面内存缓存和单层失败后的重试按钮。
- 管理台发布详情中超过 48 个字符的 Bundle、发布清单、目标站点、错误等值使用可点击的
  省略按钮，悬停可看完整 title，点击可展开换行；弹窗和双列 context 使用 `minmax(0, 1fr)`，
  不再被长值撑宽。
- Assets Helm revision **224**、镜像
  `0.1.0-20260923-164927` 已部署，site/backend 均 1/1 Ready、0 restarts。线上 bundle 为
  `reviewed-mudn3em1-aa5db98b`，SHA-256 为
  `499f0aabd7f0cb5f02301b47104290a58b3db6731912f0e774caac7ea46c745b`，508 files；
  未修改 Warehouse、MOC、资源包、扫描任务或发布数据。
- `npm run build`、251 项 Node 测试与 Core wheel、Helm lint、`git diff --check` 通过。
  Chromium 线上验收确认请求顺序为 surveys → coverage catalog、无目录 localStorage/ETag、
  ACT 可选、overlap 抽屉顺序和 30px 按钮、产品模态图标/底色、管理台长值展开以及桌面页面
  无横向溢出；健康、coverage catalog 和 FITS Range（206，`X-Content-SHA256`）通过。

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
