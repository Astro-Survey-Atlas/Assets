# 选中 HEALPix 内部的距离展示：可行性结论

日期：2026-10-30。结论：**本地 DESI 真实数据已经支持原型，正式选区查询仍需补齐天体物理量提取与存储链路**。已登记本地只读 Connector，核实 v1 红移总表，从 32,768 行窗口得到 20,448 个符合展示条件的星系，并完成真实数据的分级聚合与浏览器验证。在线覆盖索引缺少物理量，不等于本地缺少数据；此前仅检查在线索引的结论不能用于否定这批本地目录。

## 使用方式与已交付内容

```bash
npm run prototype:distance
# 浏览器打开 http://127.0.0.1:5175/atlas/distance-prototype.html
npm run research:distance
npx tsx --test test/distance-feasibility.test.ts
npm run test:distance-browser
python3 -m unittest discover -s test -p 'test_extract_desi_distance_sample.py'
```

原型代码位于 `site/atlas/distance-prototype.html`，开发路由不进入 Vite 的生产构建入口，不修改线上 Atlas。只在选中的真实 NESTED HEALPix 内绘制散点/细柱，保留选区外球面。可以切换 O4/O6/O8/O10/O12/O13、密集/中等/稀疏/多区块/空样区、逐星系与聚合模式、径向轴及预算。多区块选项故意保留两个分离区域，以验证不会把中间未选中的天空填上数据。

默认输入是固定种子的**合成星系样本**：坐标由真实 O13 像元中心产生，包含构造的三个红移群，不代表实际宇宙结构或巡天完整性。也可通过「载入本地 DESI 样本」选择有界适配器生成的 evidence JSON；界面切换为实测来源、真实行数和有效星系数，按样本的实际 O6 天区提供选择。错误输入保留上一批显示；可恢复合成输入。原始观测数据不进入 Git、首页、浏览器初始请求或新 ES 天体索引。

## 本地 DESI Connector 与真实数据验证

`/mnt/data/desi-dr1/spectro/redux/iron/zcatalog/v1/zall-pix-iron.fits` 实际存在，大小 **22,371,272,640 bytes**，`ZCATVER=v1`，`ZCATALOG` 为 **28,425,963 行**的二进制表，每行 787 bytes。实际列包含 `TARGETID`、`TARGET_RA/TARGET_DEC`、`Z/ZERR`、`ZWARN`、`SPECTYPE`、`DELTACHI2`、`SURVEY/PROGRAM`、`OBJTYPE`、`ZCAT_PRIMARY`，已经具备本原型所需的输入。无须重新下载官方总表。

现有源卷只覆盖 `/mnt/data/catalogs`，因此按 Warehouse 支持的独立 source-volume 配置新增 `atlas-source-desi-dr1`。它通过已有 NFS 将 `/mnt/data/desi-dr1` 挂为只读，PV Retain，限制为 DESI 目录；[PV/PVC 配置](desi-dr1-local-source-20261030.yaml) 可复查。通过认证 Assets 管理 API 创建 **`desi-dr1-local`**，`pvcName=atlas-source-desi-dr1`、`basePath=spectro/redux/iron`，probe 返回 READY。`fuji` 没有混入 DR1 iron 的 Connector 范围。

单文件受管访问核验任务 `desi-dr1-local-catalog-check-20261030-r2` 在 eva7028 上读取同一只读源卷，使用当前 Scanner `0.2.0-20261029-fits-wcs-r2`：**SUCCEEDED、1 file、519 个有效坐标、16 个实际 O8 occupancy cells、0 errors**。源 inventory SHA-256 为 `1bb522aa6989b06bd8538edf2b7dbf7f24b0131a1cabe81b1e69d64d6ddc6c74`，evidence 位于 `atlas-evidence-smoke:/desi-dr1-local-catalog-check-20261030-r2`；验证层与公开 DESI 层分离。此任务证明文件访问与坐标提取，不声称扫描器已保存红移。

首次通过 Assets 管理台提交的任务失败：运行配置固定了旧 Scanner digest `415a731f…`，无法识别当前 Operator 序列化的 `source.inventory`。失败请求保留；r2 通过标准 Warehouse ScanRequest API 对本次验证显式指定当前镜像后成功。**Assets 默认 Scanner 配置尚未调整**，后续正常管理台扫描需要同步配置；没有为此次连接创建滚动应用部署。

`scripts/extract-desi-distance-sample.py` 是有界、手动诊断适配器，直接读取已存在的本地总表；没有向 ScanPlan 塞入任意脚本或扩展 Warehouse 的生产接口。它从 FITS 头获得真实存储布局，只读取所选行窗口，保留 64 位 TARGETID 字符串、真实 FITS logical primary、原始质量值与行号；不经 Astropy 整列转换读取 2,842 万行。当前样本为 0-based `[4700000,4732768)`，读取约 25.8 MB 行字节，规范化 JSON 12,454,426 bytes。

```bash
npm run research:distance:desi -- \
  --source-root /mnt/data/desi-dr1/spectro/redux/iron \
  --start-row 4700000 --max-rows 32768 \
  --output /tmp/desi-dr1-distance-sample.json

npm run research:distance -- \
  --input=/tmp/desi-dr1-distance-sample.json \
  --output=/tmp/desi-real-aggregation
```

适配器拒绝将真实行写入本 Git checkout 或源目录。当前样本与 receipt 已放在 **`atlas-evidence-smoke:/distance-prototype/desi-dr1-local-20261030.json`**，宿主路径为 `/mnt/data/atlas-warehouse-atlas-evidence-smoke-pvc-2fd8450f-2ab4-4684-9bfa-10f3015ca328/distance-prototype/desi-dr1-local-20261030.json`；可在开发原型中手动选择该文件。样本 SHA-256 为 `f2b19da700f5dbb0576e7f5f807ef09ec06d8d6ef5f1f2834528f08132260413`。头与所读行字节各自哈希锁定；本地 checksum 清单给出的整文件 SHA 只记作 expected，**本轮没有重新验证 22 GB 整文件哈希**。诊断样本不属于已审核、归档、激活的生产索引版本。

同一文件的便捷选择路径为 `/tmp/asa-distance-feasibility-20261030/desi-sample.json`（指向 evidence 的符号链接，不复制数据）。

32,768 行中，20,448 行进入距离视图；5,712 行因 z<0.02（含负红移）排除，6,559 行因 Main/primary/分类等展示条件排除，49 行超出 z≤2 的模型范围。排除原因按首次命中计数，不是可重叠的分类总量。对样本内对象仍执行同版 primary 去重/冲突隔离。红移参考系根据 DR1 官方定义设为 barycentric，不能从坐标 ICRS 推断。

这段连续行窗口**不是随机抽样，不是完整天区，不能外推全巡天有效率、面密度或结构保真度**。在窗口内有效对象最多的 O6 分区 10087 下，逐级选择最密子格得到：

| S | 选中像元 | 窗口内有效星系 | A=S+4（限 O13）、64 箱的非空体元 |
| --- | ---: | ---: | ---: |
| O4 | 630 | 4,198 | 2,235 |
| O6 | 10087 | 403 | 370 |
| O8 | 161400 | 32 | 32 |
| O10 | 2582278 | 4 | 4 |
| O12 | 41318433 | 2 | 2 |
| O13 | 165265766 | 1 | 1 |

三个窗口内 O6 样区、各 S/A 与径向箱的 135 组实验全部计数及径向直方图守恒，用时约 177 ms；不能当作源读取吞吐或线上查询延迟。实测窗口中的最高阶常常只有少数对象，应如实显示稀疏，不为酷炫填充光点。统计明细见 [真实样本聚合记录](desi-dr1-distance-real-results-20261030.json)。

## “距离”依据与展示契约

界面固定说明：**由观测红移按 Astropy Planck18 推算的视线共动距离估计 / Mpc**。可切回观测红移 `z`，此时没有距离单位。

| 输入信息 | 本轮能做什么 | 不足与处理 |
| --- | --- | --- |
| 有质量标记的 DESI 星系光谱红移 | 固定模型下的红移空间共动坐标 | 保留太阳系质心参考系；未做 CMB 或本动校正，不能称独立测得的真实距离 |
| 红移拟合误差 | 在同一模型下传播成测量误差项 | 不含本动、参考系与宇宙学系统误差；缺失时显示未知，不能补零 |
| 低/负红移 | 保留原始值与排除原因 | 原型距离视图排除 z<0.02；这个展示阈值不是物理可靠性保证 |
| 独立距离估计 | 后续可单独适配实际目录方法、单位及区间 | 不从一个名叫 distance 的字段猜测定义；本原型尚未实现此适配 |
| Gaia 视差 | 后续使用可靠距离后验和来源说明 | 不用恒星红移换算宇宙学距离，不对所有视差简单取倒数 |
| 仅坐标/文件分区 | 保留在天球或来源信息中 | 没有距离证据就不放进距离点云，不按图层半径或随机数填补 |

从模型角度，计算 `D_C(z)=c/H0 × ∫ dz/E(z)`；但输入的观测红移还可能包含源与观测者运动。本图是红移空间，星系团沿视线拉长可能来自本动，并不证明其真实几何形状。距离、光行时间、光度距离和角直径距离不混用。

模型表由完整 Astropy Planck18 生成，含光子辐射与有质量中微子：H0=67.66、Om0=0.30966、Ob0=0.04897、Tcmb0=2.7255 K、Neff=3.046、m_nu=[0,0,0.06] eV。适用范围 z=0–2，1,025 个节点；范围外拒绝外推。4,097 个对照位置的最大插值误差约 **0.00105 Mpc**，远小于本轮展示箱宽；这是数值误差验证，不是物理距离准确度。

可复现生成命令为 `python3 scripts/generate-distance-reference.py`，需要 numpy、astropy、scipy。本轮使用 Astropy 7.2.0；系统缺少 SciPy，已在 `/tmp/asa-distance-python` 独立安装后生成，没有替换系统依赖。详细物理依据、质量条件与官方引用见 [物理与来源核验](healpix-distance-science-and-sources-20261030.md)。

## 数据盘点与接口缺口

2026-10-30 02:40 UTC，从 Assets backend 环境读取**配置的 Warehouse ES**，只执行 mapping 和小范围只读查询。五个索引 mapping 均 HTTP 200、`dynamic=strict`：

- file 与 file-observation 索引包含文件身份、URI、大小、run/layer 等信息；没有天体级红移或距离。
- coverage 索引包含 layer/file、ICRS/NESTED、order/ipix、方法、角色和精度；没有逐天体 RA/Dec、Z、ZERR 或质量标记。
- layer/partition 索引包含状态、快照与计数；不存天体物理量。
- `desi-dr1-spectra-footprint` 实时仍是 ACTIVE、1 file、266,051 个 O8 occupancy cells。该计数不能换算为星系数，也不能证明有效红移数量。

源码核对的 Warehouse `FitsBinaryTableCatalogReader.RowConsumer` 只接收 `rowNumber, ra, dec`；`CatalogHandler` 将目录行归并成文件的覆盖集合。历史约 2,842 万行扫描不是逐天体物理量查询服务。904 个 redrock 文件的历史记录只证明当时的路径库存/映射，不能当作本轮逐文件或红移行验证。

官方 redrock 包含 `Z/ZERR/ZWARN/SPECTYPE/DELTACHI2/TARGETID`，行匹配 FIBERMAP 包含真实 ICRS 坐标；但单个 redrock 不建立跨文件的全局 primary。此次已核实本地官方推荐 v1 zcatalog 的版本和实际列，并优先使用它的 primary。公开数据库另有官方入口，本轮没有执行科学 SQL。

本轮规范化接口已经在 TypeScript 中可运行，接口输入保留 object/survey/release identity、RA/Dec、redshift/error/frame、Main/primary/quality 字段；输出保留推算方法、模型、误差项、限制、O13 索引。缺失 primary/分类/参考系等必要依据的记录拒绝进入距离视图。采用 DR1 官方总览条件再限定 Main/GALAXY，不套用统一的 DELTACHI2>40 科学筛选。完全一致的同版 primary 去重；相互冲突的 primary 全部隔离计数，不猜测保留一条。不同巡天/版本不自动当同一天体合并。

后续生产链路：在现有本地 Connector 上，为所需物理量确定受支持的有界执行契约 → evidence 中保存哈希锁定的派生快照及质量/去重报告 → Assets 在选区请求后读取受管派生结果。任务与运行状态由 Warehouse 持有，不能把手动适配器说成现有坐标扫描器已具备的能力。Assets 不在用户点击时远程下载科学文件。本轮没有新增生产 API、天体索引映射、受管版本或发布操作。

拟议查询输入为快照、order/cells、质量选择、模式与预算；响应必须提供实际 A、径向边界、距离依据、总数、完整/抽样/截断状态。coverage 精确、坐标精确、红移精确和距离准确是不同维度，不能共用一个 `exact` 标签。

## 聚合策略：不以显示阶数假装物理精度

S 决定选择的天空；A 决定内部角向统计单元；径向箱宽单独决定显示量化。A 的坐标归属从真实天体坐标计算，不能从粗 MOC 或路径分区制造高阶存在性。同一 S 在各径向层复用同一批角向格；面积与格数不会因为换了距离箱而自动增加。

默认规则：散点 ≤20,000、细柱 ≤4,000 优先逐天体；超过预算使用完整聚合。候选 A 为 S+4、S+2、S，限 O13，选择满足 32,768 个非空体元预算的最细方案。用户可显式提高实验预算，状态会显示实际模式和数量。连 S 都超预算则要求缩小区域，不返回部分伪完整结果。细柱的 4,000 默认值可在实机 GPU 测试后调整。

| S | 近似角尺度（面积平方根） | 候选 A，从细到粗 | 优先策略 |
| --- | --- | --- | --- |
| O4 | 3.66° | O8 / O6 / O4 | 根据对象数，通常先聚合 |
| O6 | 55′ | O10 / O8 / O6 | 允许在单个文件分区内部细分 |
| O8 | 13.7′ | O12 / O10 / O8 | 数量允许时直接画天体 |
| O10 | 3.44′ | O13 / O12 / O10 | 对稀疏样区保留逐天体坐标 |
| O12 | 51.5″ | O13 / O12 | 不为填满画面而造点 |
| O13 | 25.8″ | O13 | 最细显示级，实际误差另列 |

默认径向 64 箱；固定 0–5308.19 Mpc 时，32/64/128 箱宽分别约 165.88/82.94/41.47 Mpc。这些是**展示箱宽**，不是天体距离误差；箱中心会量化径向位置。聚合位置使用子格中心和箱中心，并明确为聚合体元。逐天体散点没有此分箱量化。

当前固定范围用于公平对比和切换时稳定比例，不能认定 64 箱适合真实星系团尺度。真实样区接入后应在用户选定距离范围内提高分辨率，结合谱线误差、本动及目标结构尺度选择箱宽；先保留点模式作参照。测试中统计峰与细节损失不能由合成分布外推真实数据。

## 实验结果与下一步边界

60,000 条合成记录、三类密度、六个 S、候选 A 和 32/64/128 径向箱共 **135 组**，总计数及径向直方图全部守恒。固定选择同一范围时，提高 A 改变角向表达，不改变径向总分布。实验约 1.5 秒，Node 进程 RSS 约 198 MiB；RSS 包含运行时、原始/派生对象等，不是每星系存储估算。完整工程结果见 [机器可读记录](healpix-distance-feasibility-20261030-results.json)。

三类密度下，选中最密子格进行对照；以下数量只属于构造的样本：

| S | 密集样区有效对象 | A（S+4 限 O13） | 64 箱非空体元 |
| --- | ---: | ---: | ---: |
| O4 | 45,000 | O8 | 164 |
| O6 | 45,000 | O10 | 2,225 |
| O8 | 11,174 | O12 | 1,882 |
| O10 | 2,797 | O13 | 514 |
| O12 | 741 | O13 | 36 |
| O13 | 376 | O13 | 9 |

Chromium WebGL 在容器 **SwiftShader 软件渲染**、1440×1100 页面上实测。浏览器脚本记录版本、画布尺寸、更新耗时、旋转帧时间和截图；数值不外推到用户硬件。散点与细柱的差距说明应采用不同默认预算，而不是无限铺柱。小区域高阶显示可优先逐天体；大区域仍须聚合。默认预算内的浏览器本地更新低于一秒；没有测到真实网络查询时延。

| 实际显示对象 | 散点平均 FPS | 细柱平均 FPS |
| --- | ---: | ---: |
| 3,750 | 60.0 | 39.1 |
| 7,500 | 58.1 | 24.7 |
| 37,500 | 32.7 | 5.4 |
| 75,000 | 27.3 | 3.3 |

已验证：O4–O13、双区块/空样区、三种展示、红移/距离轴、完整计数、超预算无部分结果、排除无效测量/负红移/缺参考系、重复身份处理、390px 手机布局与零 JS 页面错误。11 项 TypeScript 数值/边界/导入测试与 3 项真实 FITS 解码测试通过。真实 DESI 样本导入后复核各阶数、三种模式、径向轴、空样区、错误输入保留与恢复合成，桌面/手机均通过；截图为 `/tmp/asa-distance-feasibility-20261030/desi-real-*.png`。

本轮已验证真实行窗口内的有效数量与聚合守恒；**完整天区**的密/稀分布、全量吞吐、后端选区查询延迟、生产存储成本、径向峰科学保真度、选择函数校正及完整红移空间畸变处理仍未验证。没有进行超出原型 32,768 上限的 64,000 体元渲染承诺；超预算路径已验证。现阶段不能直接承诺上线性能或科学精度。

下一阶段应从已可读的本地 v1 输入选取**完整天区**，完成物理量执行契约与受管快照、按实际 RA/Dec 的 HEALPix 查询及质量报告，再接入正式选区 UI。同时同步 Assets 的默认 Scanner 配置。候选索引、审核、归档、激活及 HTTP 验证仍按现有管理流程，不修改已安装索引或将本轮原型当作已发布能力。

## Connector 变更的验证记录

Assets 的 `npm run build`、`npx tsc -p tsconfig.site.json --noEmit`、11 项距离专项测试、3 项 FITS 适配器测试、合成及真实样本浏览器回归、`git diff --check` 均通过。没有用样本窗口计数冒充完整天区计数。

按 `warehouse-validation` 执行以下静态门禁，全部通过；未修改 Warehouse 工作区源码或其原有未提交文件：

| 命令 | 结果 |
| --- | --- |
| `mvn -B -q test` | 通过 |
| `mvn -B -q verify` | 通过 |
| `mvn -B -q -Pquality verify` | 通过 |
| `helm lint deploy/helm/atlas-warehouse-infra` | 通过 |
| `helm lint deploy/helm/atlas-warehouse-operator` | 通过 |
| `helm template atlas-warehouse deploy/helm/atlas-warehouse-infra` | 通过 |
| `helm template atlas-warehouse-operator deploy/helm/atlas-warehouse-operator --include-crds` | 通过 |
| `docker compose -f deploy/compose/compose.yaml config -q` | 通过 |
| `scripts/sync-index-mappings.sh --check` | 通过 |
| `bash -n scripts/warehouse-smoke-test.sh scripts/warehouse-caller-smoke-test.sh` | 通过 |
| Warehouse `git diff --check` | 通过 |

Operator、MOC discovery、ES、MinIO rollout 检查通过。当前实际 Workspace namespace 是 `asa-workspace`，而不是技能早期文案中的 `astro-data-workspace`。在线脚本使用已安装的专用可写 synthetic fixture PVC（不是只读 DESI 卷）以及项目文档中的 MinIO client 镜像镜像站地址。

- Warehouse baseline `20261030034609-c0f8c50a91780646`：本地/S3 各 SUCCEEDED，1 file、1 coverage、0 errors，层为 ACTIVE；MOC 请求 FAILED/`DiscoveryTlsError`，因此脚本整体 **FAILED**。
- Asset caller `20261030034805-50c89358cbcd96ca`：ScanRequest SUCCEEDED，1 file、1 coverage、0 errors，层为 ACTIVE；MOC 请求同样 `DiscoveryTlsError`，整体 **FAILED**，失败请求保留。
- Workspace local caller `20261030034911-7e8e3487286c3a2c`：**PASSED**，1 file、2 coverage、0 errors，层为 ACTIVE；按脚本清理成功的 request，保留 evidence。
- Workspace remote caller `20261030035137-9dc1d9678998b6aa`：**PASSED**，1 file、1 coverage、0 errors，层为 ACTIVE；按脚本清理成功的 request，保留 evidence。

CDS TLS 失败与 Warehouse HANDOFF 中的现存问题一致，不影响 DESI 本地文件访问，但不能把 Warehouse 整体在线门禁报告为全通过。初始缺 fixture 参数/旧 MinIO client 拉取失败的前置尝试、后续配置完整的实际结果均保留在 `/tmp/asa-desi-connector-validation/`。本次 DESI 自身受管任务的结果已单独核对配置 ES 中验证层的 ACTIVE 状态；没有改写已发布 DESI 层。
