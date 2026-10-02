# Assets 数据存储盘点（2026-10-01，2026-10-02 续记）

统计时间为 2026-10-01 20:13–20:19（Asia/Shanghai），对应 Assets Dev revision 305。
通过线上容器文件 stat、SQLite 只读查询、配置中的对象存储前缀清单及 Warehouse
Elasticsearch 索引统计取得数据。没有修改部署、归档或清理数据。

2026-10-02 受管归档及激活已完成。当前公开发布和原生索引的去重 authority 依赖
实测 **1.073 GiB**；再加业务状态与关联证据的旧估算约 194.23 MiB，生产首次迁移
估算约 **1.26 GiB，预估按 1.3 GiB 理解**。业务状态尚未重新冻结一致快照，所以
总数不是精确迁移清单。原始清单与两份 SQLite 恢复后仍约 **2.90 GiB**。
下文约 3.25 GiB 是归档完成前按原文件复制的历史口径。旧索引、历史发布缓存及
过期查询快照不计首次迁移；复用现有 Warehouse 时其 ES 不需要复制。

下文 **18.92 GiB** 是本次统计范围现有存储条目的磁盘/对象占用，包含历史版本和
重复副本，不能当作生产迁移量。

MiB = 1,048,576 bytes；GiB = 1,073,741,824 bytes。目录按普通文件逻辑长度加总，
不跟随内部符号链接；`/data/current` 已包含在 `/data` 中，不重复加入总数。对象存储
按 ListObjectsV2 返回的当前对象大小统计，不包含非当前对象版本、底层副本或文件系统
元数据。开发机副本、镜像、科学数据、Warehouse 其他存储和未挂载的旧 PVC 不计入
上述 18.92 GiB。缓存、快照和 ES 数值会随运行变化。

## 受管归档后的生产首次迁移（2026-10-02 05:09）

从对象存储读取当前原生指针及不可变 manifest，核对 manifest SHA 和归档 receipt，
按被引用的对象 key 去重。活动 group 为
`7934212d371634751fc1119c3a9a5ccccb10e8061dce5d930988c50bf8b7d7b6`，generation 1；
manifest SHA 为 `2c183daeedd2bdf28a0769f7ab1fbf5a2f153e83a62c2abb9713423087cfd775`。
归档任务已完成全部远端字节校验，激活任务也完成了运行时及网站 HTTP 验证。

| 当前必需数据 | 迁移 bytes | 大小 | 统计依据 |
| --- | ---: | ---: | --- |
| 受管原生输入清单 | 571,741,095 | 545.25 MiB | 638 个引用，637 个去重对象，含 HST 分页、ERO 锁定元数据及既有 HSC 来源 |
| 两份原生 SQLite 的 gzip 对象 | 417,510,844 | 398.17 MiB | 通用 v5：131,578,710 bytes；HST v4：285,932,134 bytes |
| 原生活动指针及版本 manifest | 278,917 | 272.38 KiB | 429 + 278,488 bytes |
| **原生 authority 小计** | **989,530,856** | **943.69 MiB** | 639 个依赖对象，加指针和 manifest；历史及 archive-cache 不计 |
| 当前公开 release authority | 162,978,439 | 155.43 MiB | 131 个去重对象，含仍被引用的旧格式基础归档 |
| **两套 authority 实测合计** | **1,152,509,295** | **1.073 GiB** | 当前活动依赖，各复制一次 |
| 业务状态及其他关联证据 | 旧估算约 203.7 MB | 约 194.23 MiB | 不是本轮重新冻结后的精确值 |
| **Assets 首次迁移估算** | **约 1.36 GB** | **约 1.26 GiB** | 实测 authority + 业务状态旧估算；实际迁移需再冻结和盘点 |

公开 pointer 仍指向 `reviewed-mupsxe2v-c91be91f`，bundle SHA 为
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`。
604 个逻辑成员展开为 227,422,166 bytes / 216.89 MiB。两个发布缓存由 authority
同步重建，不需要复制 Dev 中各端的历史目录。

原生输入去重后的原始大小为 697,870,451 bytes / 665.54 MiB；两份 SQLite
仍为 2,420,781,056 bytes / 2.25 GiB。合计 3,118,651,507 bytes / 2.904 GiB，
属于恢复后的文件大小，不应再叠加到上述传输量。十五个大型未压缩输入/索引使用
额外 gzip 表示；已经压缩的分页/FITS 保持其字节内容。HSC 两个输入引用内容相同，
对象只计一次，但恢复时保留各自引用路径。

生产可复制这两套 authority 的活动依赖，并让原生恢复流程校验、解压和安装索引。
真实 Euclid 清单的隔离恢复已验证压缩对象和原文件两组 SHA；整组 `restore` 重验
以及实际 `acquire → build` 无变化复用也已通过，两份原始 SQLite SHA 未变。
业务状态应另外迁移当前控制状态、最新 namespace snapshot、任务/审核/API 管理状态
及其引用证据。单独的原生 authority 不能替代完整业务状态迁移。

旧索引 2.10 GiB、两个发布缓存、可重建的 gzip archive-cache、诊断对象、未引用
历史版本和过期反查快照均不计首次迁移。若迁移时存在尚未到期、需要继续使用的
反查游标，另带其冻结快照；本表不假设生产继续 Dev 的临时查询。
Dev 与生产使用独立的可变 current 指针及业务状态。复用 Warehouse 不复制其 ES；
独立 Warehouse 的历史 store.size 约 1.28 GiB，实际快照传输量需单独实测。

## 控制状态镜像与迁移一致性（2026-10-02 续记）

05:44 的只读诊断发现 778 个完整控制快照积压在 upload spool，逻辑 payload 合计
1,746,419,887 bytes / 1.63 GiB，全部没有上传失败。最新原生控制快照 generation 369
已上传，但 `state/native-units/current.json` 仍在 generation 180：原 worker 要等整批
串行上传结束后才推进镜像指针。这个积压属于控制快照，不是原生索引 authority
归档缺失；`native-units/current.json` 的活动 generation 1 及全部依赖已经归档验证。

worker 改为每轮最多上传一个对象，各 namespace 轮流优先同步其最新完整快照，
并及时确认各 namespace 最新已上传 generation。原有排队快照继续归档；历史记录
包含在完整状态中，不要求依次经过每个旧指针。首次生产迁移统计当前最新一致状态
及其引用证据，不累加这个历史队列的所有完整副本。迁移前仍应冻结写入，核验各
namespace 的 `syncStatus=synced`，再固定业务状态和两套 authority 的复制清单。

Assets 312 上线后的窄验证通过：原生控制状态 generation 370、发布任务 generation
2623、API 管理 generation 238 均为 `synced`；原生控制快照隔离恢复与本地完整状态
一致。565 个旧快照仍排队归档，最新状态未确认数和失败数均为 0；活动原生 authority
及公开 release 指针保持原值。上述约 1.3 GiB 仍是迁移估算，没有执行生产迁移或
重新冻结所有业务状态。证据 `/tmp/assets-snapshot-batch-verify.log`。

## 归档前按原文件迁移的历史口径（2026-10-01 21:30）

用户关心生产要复制多少数据。排除旧索引 2.10 GiB、两个历史发布缓存、过去的
反查快照和旧 state generations；保留当前应用使用的源清单、索引、业务状态及
关联证据。当前公开指针仍指向相同 bundle。

| 迁移项目 | 数量/大小 | 迁移方式 |
| --- | ---: | --- |
| 下载清单及锁定的原始快照 | 665.64 MiB | evidence PVC 中 `source-units/` 和 `geometry/` |
| 当前两份 SQLite | 2.25 GiB | 仅通用 v5 和 HST v4；生产直接使用以避免冷构建 |
| 当前公开发布的权威依赖 | 154.54 MiB | 当前指针、当前 object manifest 及全部被引用对象/基础归档，各复制一次 |
| 业务状态与关联证据 | 约 194.23 MiB | content 卷、其余构建/来源证据、每个 namespace 的最新 state snapshot/指针；不搬所有旧 generations |
| **Assets 合计** | **约 3.25 GiB（3.48 GB）** | 当前文件逻辑长度与对象大小估算，未额外压缩 |

这是一份保留现有业务状态的保守估算，保留当前状态引用的历史记录和候选证据，
没有按功能删减它们。实际迁移时应冻结一次一致的业务状态和 authority 指针，再
验证复制清单；本轮没有执行迁移或导出运行中的 SQLite。

公开发布的当前 object manifest 有 604 个逻辑成员、展开大小 226,490,918 bytes。
其中 138 个成员引用 SHA 对象，466 个成员引用仍必需的旧格式基础归档（48,273,253
bytes）。对对象 key 去重后，当前指针的完整依赖共 131 个对象、162,047,181 bytes。
基础归档虽然是旧格式，仍被当前发布引用，必须保留；其他历史 release 不需要搬。

Site/backend 的 `/data` 是由这些权威对象同步、校验、解压出来的本地缓存，不是
额外输入。生产可以从空缓存启动，每端形成约 216 MiB 的当前 release；两端落盘
合计约 432 MiB，但不需要手工复制 Dev 的两个 4.7 GiB 历史缓存。清单与原生索引
不会因此自动从公开 bundle 获得，仍须迁入 evidence 卷。

两份 SQLite 都可以从锁定的原始清单重建。选择不迁 SQLite 时，复制量降为约
**0.99 GiB**，但必须在生产开放查询之前完成构建：通用索引可在加载时构建，HST
需要显式执行 `build-hst-observation-index` 脚本，当前运行时只打开已有 HST SQLite。
重建后的运行磁盘占用与直接迁索引相近，并需预留构建临时空间和内存。

如果生产接入现有对象存储，公开权威对象和最新 state snapshots 可直接读取，无需
复制到新 bucket；若建立独立对象存储，只迁当前依赖集。生产 backend 必须拥有
独立业务状态/current 指针，不能让 Dev 与生产两个写入进程共用同一组可变指针。

如果还要部署独立 Warehouse，五个相关 ES 索引的现有 store.size 约 1.28 GiB，
两部分数据规模合计约 **4.52 GiB**。ES 的迁移应通过快照/恢复或重新导入，不能
直接复制运行中的索引文件；这里的 1.28 GiB 是索引逻辑占用，实际快照传输量需
导出后统计。Warehouse 自身其他运行状态/存储和容器镜像不包含在这个估算中。

## 下载清单与输入快照

线上根目录为 `/var/lib/assets-evidence`，来自
`astro-survey-atlas-assets-evidence` NFS PVC。原始文件保留，索引由这些文件派生。

| 来源 | 文件位置（相对证据根目录） | 数量与格式 | bytes | 实际大小 |
| --- | --- | --- | ---: | ---: |
| Legacy DR1–DR10 | `source-units/legacy-*` | 13 个 FITS / FITS.gz；含 release rosters 和 DR10 all-sky geometry | 419,340,533 | 399.91 MiB |
| HST 公共 image observation 快照 | `source-units/hst-public-image-pages/` | 601 个 JSON.gz 分页 + 1 个 manifest；1,201,094 行 | 186,719,430 | 178.07 MiB |
| HSC PDR2/PDR3 | `source-units/hsc-*` | 19 个 tract/patch 文本清单 | 89,272,428 | 85.14 MiB |
| Euclid Q1 BGSUB | `source-units/euclid-q1-r1-bgs-mosaics.csv` | 1 个 CSV；2,908 行、352 Tiles | 1,133,113 | 1.08 MiB |
| DESI DR1/EDR | `geometry/desi-dr1-tiles-iron.fits`、`geometry/desi-edr-tiles-fuji.fits` | 2 个 TILE_COMPLETENESS FITS | 1,509,120 | 1.44 MiB |
| DESI geometry 引用 | `geometry/index.json` | 1 个 JSON | 2,617 | 2.56 KiB |
| 合计 | | 638 个文件 | **697,977,241** | **665.64 MiB** |

Legacy DR10 South roster 本身为 104,480,980 bytes（99.64 MiB），366,912 个
brick 成员；Coadd 正曝光候选为 363,328 个。DR10 all-sky 文件提供几何，不能据此
补造 DR10 North 成员。HST 快照是 observation metadata 和 `s_region`，没有下载
科学图像或文件级产品库存。DESI 表也不是科学光谱数据。

## 派生反查索引

| 索引 | 路径（相对证据根目录） | bytes | 实际大小 | 使用状态 |
| --- | --- | ---: | ---: | --- |
| 通用原生分块 SQLite v5 | `derived/source-unit-indexes/native-units.sqlite` | 1,821,573,120 | 1.70 GiB | 当前使用；DESI、Euclid、Legacy、HSC |
| HST observation SQLite v4 | `derived/hst-observation-indexes/d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8.v4.sqlite` | 599,207,936 | 571.45 MiB | 当前使用；916,116 observations |
| 通用索引旧 v4 | `derived/source-unit-indexes/native-units.sqlite.v4-2026-10-01` | 1,660,219,392 | 1.55 GiB | 历史备份 |
| HST 旧 v3 | `derived/hst-observation-indexes/d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8.sqlite` | 598,310,912 | 570.59 MiB | 历史备份 |

当前索引合计 **2,420,781,056 bytes / 2.25 GiB**，旧索引合计
**2,258,530,304 bytes / 2.10 GiB**。

通用索引包含 36 个原生匹配层（8 个 Tile、7 个 tract/patch、21 个 brick）、
1,143,015 条共享几何记录和 4,786,804 条产品层成员映射；另有 27 个 runtime coverage
层。这些映射可重复引用同一分块，不能当作唯一 brick/Tile 数。SQLite 保存几何、
原生身份、产品关联和空间候选桶；URI 可依照锁定的来源规则在命中时生成。

HST 当前索引使用锁定的 CAOM manifest SHA，保留原始 `s_region`。18 条未确认
坐标 frame 的记录未建映射，库存仍不完整。旧 v3 不在当前查询路径上。

## 线上持久卷

| PVC / 挂载位置 | 存储类型 | 声明容量 | 实测文件大小 | 用途 |
| --- | --- | ---: | ---: | --- |
| `…-evidence` → backend `/var/lib/assets-evidence` | NFS、PV reclaim=Retain | 256 GiB | 5.10 GiB | 原始清单、当前/旧 SQLite、构建证据 |
| `…-backend-cache` → backend `/data` | local-path | 8 GiB | 4.66 GiB | 后端发布缓存、40 个历史 release 目录 |
| `…-site-cache` → site `/data` | local-path | 8 GiB | 4.68 GiB | 网站独立发布缓存、40 个历史 release 目录及临时 staging |
| `…-content` → backend `/var/lib/assets-content` | local-path | 64 MiB | 92.78 MiB | 产品/审核状态、发布任务 SQLite、API 管理 SQLite、MOC 候选和发布记录 |
| `…-upload-spool` → backend `/var/lib/assets-upload-spool` | local-path | 1 GiB | 819 bytes | 上传队列状态；本次没有排队对象正文 |
| 旧 `…-assets` | NFS | 256 MiB | 未统计 | 当前 site/backend 均未挂载，不计入合计 |

以上已挂载 PVC 的普通文件合计 **15,606,599,040 bytes / 14.53 GiB**。
PVC 声明容量不等于实际占用或强制磁盘配额，例如 content 实测大小已超过其 64 MiB
声明值。这里没有按申请容量计算已用空间。

证据卷内，原始清单和当前索引占 2.90 GiB，旧索引占 2.10 GiB，其余约 97.84 MiB
为 MOC 构建、发现记录、HST 导入和 DESI 扫描关联等证据。

当前 release 每端为 **226,490,918 bytes / 216.00 MiB**。二者是同一个公开
bundle 的独立缓存，不是两份不同业务数据；历史目录还保存了旧版本。运行时 release
历史自动删除已禁用。目录中有 604 个普通文件：嵌入的 release manifest 的 `files`
数组列出 602 个成员，另有 manifest 自身和一份没有列入该数组的历史 DESI 3.4.0 ZIP。
该目录文件数与健康接口的 603 个发布成员计数口径不同。

当前 release 包含 70 个 ZIP（97.43 MiB，包括保留包和 collection）、80 个
`.moc.fits`（19.91 MiB）、80 个 HEALPix query JSON（59.71 MiB）和 80 个
preview JSON（326.16 KiB）；其他文件包括元数据和 approved FITS。它们是覆盖数据和
资源包，不是源巡天科学图像/光谱。

## Assets 对象存储

正常发布的公开对象、不可变 manifest 和 current 指针以配置的对象存储为权威；
site/backend 从中验证并建立独立缓存。这里只统计 Assets 配置前缀，不公开凭据或
连接配置。

| 命名空间 | 对象数 | bytes | 实际大小 | 内容 |
| --- | ---: | ---: | ---: | --- |
| `state/` | 3,118 | 2,211,503,000 | 2.06 GiB | 业务状态历史快照；其中 publication-tasks 约 1.40 GiB |
| `public/` | 475 | 787,467,488 | 750.99 MiB | SHA 对象、manifest、current 指针及历史 release 归档 |
| `reverse-lookups/` | 98 | 181,681,497 | 173.26 MiB | 公共区域反查的不可变快照，含旧 JSON 和新 gzip |
| 其他 evidence/content/lookup 命名空间 | 936 | 159,593,492 | 152.20 MiB | 历史归档、发现证据、旧 HST/ERO lookup 和内容 |
| 合计 | **4,627** | **3,340,245,477** | **3.11 GiB** | |

线上反查快照通过配置的对象存储直接写入 `reverse-lookups/<sha>.json.gz`，不是
默认落在 evidence PVC。其 ID 是未压缩 JSON 的 SHA。游标有效期为 1 小时；进程
缓存最多 16 份、序列化预算 64 MiB。1 小时是访问有效期，不是对象自动删除期。
代码路径未发现反查对象清理；本次存储服务返回 NoSuchLifecycleConfiguration，
没有配置 bucket lifecycle，因此不能将这些对象当作自动到期删除的临时文件。

本次还读取了当前 evidence 归档清单：`repo-evidence/evidence` 没有上述原生输入
引用；`authority/evidence` 和 `evidence` 仅含两份 DESI Tile 表引用，均没有新增
Legacy/HSC/Euclid 清单、HST 全量分页快照或派生 SQLite。当前已核实的这些新增数据
持久化位置是 evidence PVC；不能把公开 bundle 和旧 evidence 归档视为它们的备份。

## Warehouse Elasticsearch

Assets 只读配置的 Warehouse endpoint，使用以下五个索引获取扫描文件、覆盖 edge
及 committed partition 状态。它们归 Warehouse 管理，没有复制成 Assets SQLite。

| 索引 | ES docs.count | 主分片/总 store bytes | 实际大小 |
| --- | ---: | ---: | ---: |
| `ast_file_index_v1` | 622,116 | 265,928,549 | 253.61 MiB |
| `ast_coverage_index_v1` | 7,459,121 | 1,101,073,438 | 1.03 GiB |
| `ast_layer_index_v1` | 1,710 | 882,100 | 861.43 KiB |
| `ast_partition_index_v1` | 1,649 | 1,175,897 | 1.12 MiB |
| `ast_file_observation_index_v1` | 2,317 | 2,218,213 | 2.12 MiB |
| 合计 | | **1,371,278,197** | **1.28 GiB** |

本次各索引为 green，store.size 与 pri.store.size 相同。此表是整个相关 ES 索引的
大小，含其他发布、扫描和历史记录，不是四巡天 MVP 独占大小，也不代表完整巡天的
文件库存。没有读取 Workspace Elasticsearch 或真实 CSST 私有记录。

## Git 和开发机副本

Git 保留代码、public metadata、recipe/lock 和哈希引用。83 个 recipe lock JSON
合计 197,731 bytes（193.10 KiB）；`source-unit-indexes.lock.json` 为 34,376 bytes，
HST lock 为 1,461 bytes，layer registry 为 91,830 bytes。大型原始清单和生成索引
没有放入 Git；相关原始数据目录被 `.gitignore` 排除。

开发机另有 `artifacts/public-survey-footprints/raw/`，本次为
2,379,442,564 bytes / 2.22 GiB，其中当前通用 SQLite 为 1.70 GiB、source-units
输入为 530.35 MiB；这里没有 HST 的全量分页快照和 HST SQLite。
`.assets-local/` 为 87.38 MiB，`.assets-content/` 为 796.86 KiB。这些是开发机副本，
不参与线上运行，不计入线上合计。其他构建目录和镜像未盘点。

公共原生分块索引和反查快照归 Assets；Workspace 通过 API Key 临时读取公开结果。
真实 CSST 扫描、覆盖和文件父目录映射归 Workspace，不属于本报告中的 Assets 数据。

原始统计汇总位于 `/tmp/assets-storage-{backend,site,local,sqlite,objectstore,warehouse,archive-references,current-release}-20261001.json`。
