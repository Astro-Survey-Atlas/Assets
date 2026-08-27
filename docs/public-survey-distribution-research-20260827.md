# 公开巡天如何被发现、理解和取得

调研日期：2026-08-27  
用途：为 Astro Survey Atlas Assets 的公开产品页面、MOC 发布和外部系统契约提供一份可复核的解释。本文只讨论公开数据的发现与分发，不改变 Workspace 的私有数据边界，也不把 Assets 描述成科学数据镜像。

## 先给非专业用户的答案

一个公开巡天产品通常不是“下载一个 JSON”这么简单。用户实际需要完成四个问题：

1. **这是什么？** 版本、波段/模态、发布时间、科学产品和限制是什么。
2. **它覆盖哪里？** 在目标天区有没有数据，覆盖是图像、目录目标，还是观测足迹。
3. **能不能进一步查？** 能否按位置、时间、波段或数据集元数据筛选。
4. **如何拿到科学数据？** 从哪个官方档案、查询服务、文件目录或 cutout 服务取得原始文件。

因此 Assets 的对外产品应是一条可解释的路径，而不是一组孤立文件：

```text
公开产品档案
  -> 天球覆盖预览（人能看懂）
  -> FITS MOC（程序能计算）
  -> 官方查询/档案入口
  -> 官方文件、批量下载或 cutout
```

MOC 解决的是“哪里有覆盖”的空间索引问题；它不等于目录行、不等于图像文件，也不等于该区域的深度、完整性或科学质量保证。

## 协议各自解决什么问题

| 层 | 给谁使用 | 解决的问题 | 对 Assets 的含义 |
| --- | --- | --- | --- |
| 产品档案/注册元数据 | 人和目录聚合器 | 产品是什么、谁发布、版本和访问入口是什么 | 公开页面和稳定的产品/制品链接 |
| MOC 2.0 | 可视化器、空间索引和交叉匹配程序 | 覆盖区域的快速 union/intersection | 发布可验证的 FITS MOC；JSON 只作便利投影 |
| TAP + ADQL | 需要查询表的用户和程序 | 对目录或元数据表执行同步/异步、空间和多位置查询 | 只有真正拥有可查询表语义时才接入 |
| ObsCore（ObsTAP） | 跨档案发现观测数据 | 以统一字段描述观测的空间、光谱、时间、数据产品类型 | 不应把普通产品 catalog 冒充 ObsCore |
| SIA 2.0 | 图像/数据立方体发现与取得 | 用标准参数发现和检索多维图像数据 | 需要真实 image/datacube 数据服务后再实现 |
| DataLink | 查询结果到具体文件、关联资源或处理服务 | 对单个数据集提供 drill-down 链接和服务描述 | 可借鉴“结果记录 -> 官方文件/服务”的链接模型 |
| HiPS | 交互式浏览器和天球地图 | HEALPix 分层瓦片，支持渐进缩放和平移 | 可作为覆盖/图像预览入口；不是 MOC 的替代品 |

依据：MOC 2.0 的目标是对任意覆盖进行快速比较；其存储是层级 HEALPix cell。VODataService 描述数据集合及访问服务，并可描述天空、频率和时间覆盖。TAP 提供表元数据、实际表数据、ADQL、同步/异步查询和空间查询。ObsCore 定义跨数据中心发现观测所需的最小统一元数据，并与 TAP 组成 ObsTAP。SIA 基于 ObsCore 描述并发现多维图像。DataLink 将发现元数据连接到数据文件、相关资源和对数据执行操作的服务。HiPS 使用层级 HEALPix 文件结构实现多分辨率浏览。

- [IVOA MOC 2.0 Recommendation](https://www.ivoa.net/documents/MOC/20220727/REC-moc-2.0-20220727.html)
- [IVOA VODataService 1.2 Recommendation](https://www.ivoa.net/documents/VODataService/20211102/REC-VODataService-1.2.html)
- [IVOA TAP 1.1 Recommendation](https://www.ivoa.net/documents/TAP/20190927/REC-TAP-1.1.html)
- [IVOA ObsCore 1.1 Recommendation](https://www.ivoa.net/documents/ObsCore/20170509/)
- [IVOA SIA 2.0 Recommendation](https://www.ivoa.net/documents/SIA/20151223/REC-SIA-2.0-20151223.html)
- [IVOA DataLink 1.1 Recommendation](https://www.ivoa.net/documents/DataLink/20231215/)
- [IVOA HiPS 1.0 Recommendation](https://www.ivoa.net/documents/HiPS/20170519/)

### MOC、geometry、evidence 的白话解释

- **FITS MOC**：一张机器可读的“天空格子清单”。程序可以快速回答“两个产品是否重叠”“某个坐标是否落在已发布覆盖内”。FITS 是互操作发布格式；JSON 是给网页或脚本使用的方便表示，不能成为唯一权威格式。
- **Geometry**：这张格子清单从哪种空间事实计算出来。例如观测 tile 的边界、图像 footprint、多边形区域或目录对象坐标。geometry 的类型决定结论是观测足迹、图像可用性还是对象存在，不能混为一谈。
- **Evidence**：让别人能复核结论的一组来源和校验：官方来源 URL、输入快照 hash、坐标系（ICRS）、HEALPix 排序（NESTED）、实际 order、cell 数/面积、算法、输出 hash、检查结果和限制。Evidence 不是把内部 manifest 倾倒给浏览器，而是把“为什么相信这张图”讲清楚。

## 官方公开巡天的实际模式

### CDS/Aladin：覆盖发现和可视化层

CDS 的 Aladin Lite 官方文档说明，它是可嵌入网页的轻量天球图，能够显示多分辨率 HEALPix 图像调查，并叠加 VOTable 和 STC-S footprint；其底层库也支持解析、操作和序列化 MOC。CDS MocServer 为具体数据集提供 `record` 元数据和 `smoc` MOC 导出，常见的 HiPS/MOC 链接把“可视化产品”和“覆盖索引”放在同一发现路径中。

- [Aladin Lite overview and embedding](https://aladin.cds.unistra.fr/AladinLite/doc/)
- [CDS MocServer Gaia DR3 record](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=record&fmt=json)
- [CDS MocServer Gaia DR3 FITS MOC](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=smoc&order=10&fmt=fits)

这说明 Assets 的覆盖图应该服务于发现和交叉匹配，并链接到产品的真正档案；不应把一个 CDS MOC 的存在解释成 Assets 拥有该巡天的全部科学文件。

### Gaia：人类说明、TAP 查询、档案文件并存

ESA Gaia DR3 官方页面把 release contents、处理文档、data model、known issues、credits 和 previews 分开，并明确指出 DR3 数据可从 Gaia Archive 及 partner data centres 获取。Gaia Archive 的 TAP capability 文档公开了 TAP endpoint、ADQL 2.0/2.1 和服务能力。因此同一公开巡天同时拥有：面向人的 release 说明、面向程序的 TAP/ADQL 查询，以及档案/伙伴中心的文件获取。

- [Gaia DR3 official release overview](https://www.cosmos.esa.int/web/gaia/data-release-3)
- [Gaia Archive](https://gea.esac.esa.int/archive/)
- [Gaia Archive TAP capabilities](https://gea.esac.esa.int/tap-server/tap/capabilities)
- [Gaia data access/license navigation](https://www.cosmos.esa.int/web/gaia-users/archive)

Assets 可以提供 Gaia 的覆盖索引和产品档案链接，但不能只因为能生成 MOC 就声称提供 Gaia Archive 的 TAP 服务。

### Euclid：release 页面、文档、ESASky 预览和科学档案

ESA 关于 2025 年 Euclid Q1 的官方发布说明指出：Q1 包含三个深场共 63.1 平方度、约 3000 万个对象，以及图像、光谱、测光和 mask 等产品；同时说明深场可在 ESASky 探索，并将 ESAC 的 Astronomy Science Archive 作为数据提供位置。Euclid Q1 官方站点进一步把 Contents、Documentation、Data Access、Data Model、Known Issues、License/Credits 分成独立入口。

- [ESA Euclid Q1 public release announcement](https://www.esa.int/Science_Exploration/Space_Science/Euclid/Euclid_opens_data_treasure_trove_offers_glimpse_of_deep_fields)
- [Euclid Q1 official contents and access navigation](https://www.cosmos.esa.int/web/euclid/euclid-q1-data-release)
- [Euclid Q1 explanatory supplement](https://euclid.esac.esa.int/dr/q1/expsup/)
- [Euclid Q1 data product definitions](https://euclid.esac.esa.int/dr/q1/dpdd/)

对 Assets 来说，Q1 的 63.1 平方度是 release 叙述和几何证据的一部分；只有取得并锁定真实 field geometry 后，才应发布精确产品 MOC。新闻稿中的面积或预览图不能代替 geometry。

### DESI：release 入口和可预测的数据树

DESI 官方数据模型文档把每个 release 的 `DESI_ROOT`、processed spectra、catalogs、target selection、raw data 和 value-added catalogs 分开描述，并将 DR1 public root 指向 `https://data.desi.lbl.gov/public/dr1`。这类数据发布强调稳定目录树、文件命名和数据模型文档；用户先从 release 文档确认版本与目录，再按文件路径或官方服务取得科学数据。

- [DESI data model: DESI data tree and release roots](https://github.com/desihub/desidatamodel/blob/main/doc/index.rst)
- [DESI data model: DESI_ROOT](https://github.com/desihub/desidatamodel/blob/main/doc/DESI_ROOT/index.rst)
- [DESI public data root](https://data.desi.lbl.gov/public/)
- [DESI release documentation entrypoint](https://data.desi.lbl.gov/doc/releases/)

DESI 还清楚地区分 DESI 光谱和 Legacy Surveys 成像。Assets 的 layer registry、`coverageRole` 和 `sourceTier` 也必须保留这种产品语义，不能用成像覆盖替代光谱 tile 覆盖。

## 建议的 Assets 对外体验

### 页面先讲结论，文件放在技术详情

每个公开产品应有一个稳定的产品档案，而不是先展示 JSON：

1. **一句话结论**：例如“该层表示已观测光谱 tile 的天空足迹”，并标出覆盖面积、数据版本和更新时间。
2. **真实覆盖预览**：显示 MOC 的可视化结果，标注预览 order；不把 order-4 示意图说成 order-8 精度。
3. **证据旅程**：官方来源 -> geometry -> ICRS/NESTED 归一化 -> MOC -> 校验/使用。每一步显示人能理解的输入、输出和检查结果。
4. **下一站**：官方 release、官方查询、官方数据入口和交互式天球图。Assets 只负责把用户带到正确的下一站。
5. **开发者详情**：FITS MOC、Resource Package、provenance、SHA-256、FITS header 和机器链接放在可展开区域。

### 当前阶段应该发布什么

- **现在**：稳定产品/层 ID、产品档案、FITS MOC 下载、order-4/8 预览、类型化官方链接、Resource Package v3 和 provenance。JSON 是兼容性或调试输出，不是首页信息架构。
- **下一阶段**：为产品注册 VODataService 资源记录，提供粗粒度 inline MOC 和高分辨率 footprint URL；这解决“别人如何发现产品”，但仍不等于提供数据查询服务。
- **有真实表语义后**：若 FileAsset 元数据满足 ObsCore 字段和可查询表契约，再实现 TAP/ObsTAP；若没有，不要伪造 `ivoa.ObsCore` 表。
- **有稳定数据集和文件语义后**：再考虑 SIA 图像发现和 DataLink 文件/服务描述。HiPS 适用于持续交互浏览或大规模影像瓦片，不是所有 catalog MOC 都必须制作 HiPS。

### 明确的状态和限制

界面分开表达两类状态：

- `verification.status`：`complete`（来源、过程和输出均可复核）、`partial`（覆盖可用但部分证据缺失）、`entrypoint-only`（只有官方入口，尚无可验证覆盖）。
- `coverage.precision`：`exact`、`estimated`、`entrypoint-only` 或 `truncated`。这是空间结论的精度，不是证据完整度。

覆盖必须注明它代表什么：`footprint_extent`、`image_availability`、`object_presence` 等。覆盖图不能推断深度、cadence、质量、完整目录行数或每个 highlighted cell 都有相同产品。

## Assets 的边界声明

Assets 是公开巡天的**发现、覆盖、证据和发布资源包层**。它读取 Warehouse 提供的规范化扫描状态，并把经过审查的公开制品组织成稳定的产品档案。Workspace 安装 Resource Package v3 后管理用户自己的数据；Warehouse 负责扫描执行和当前 FileAsset/SpatialCoverage 状态。

当前 Assets **不**：

- 代理下载完整科学文件或替代官方档案；
- 对外承诺 TAP/ADQL、ObsCore/ObsTAP 或 SIA 服务；
- 把输入 manifest、normalized scan、任务快照或内部 Elasticsearch 暴露给浏览器初始请求；
- 用示意面积、中心点、相邻产品或低阶 overview 制造精确覆盖；
- 把一次失败/未完成的 Warehouse 扫描当作公开成功结果。

这一边界与 IVOA 的协议职责一致：MOC 是快速空间覆盖比较机制，TAP/ObsCore/SIA 是不同的数据发现/查询契约，DataLink 是从结果到文件和操作服务的链接机制。Assets 可以逐步采用这些公开接口，但每次采用都必须以真实数据、字段和服务能力为前提。

## 参考资料

规范原文：

- [MOC 2.0](https://www.ivoa.net/documents/MOC/20220727/REC-moc-2.0-20220727.html)
- [VODataService 1.2](https://www.ivoa.net/documents/VODataService/20211102/REC-VODataService-1.2.html)
- [TAP 1.1](https://www.ivoa.net/documents/TAP/20190927/REC-TAP-1.1.html)
- [ObsCore 1.1](https://www.ivoa.net/documents/ObsCore/20170509/)
- [SIA 2.0](https://www.ivoa.net/documents/SIA/20151223/REC-SIA-2.0-20151223.html)
- [DataLink 1.1](https://www.ivoa.net/documents/DataLink/20231215/)
- [HiPS 1.0](https://www.ivoa.net/documents/HiPS/20170519/)

项目内相关契约：

- [Coverage workflow](coverage-workflow.md)
- [MOC core contract](moc-core-contract.md)
- [Resource Package v3 integration](resource-package-integration.md)
- [Existing public MOC source research](public-moc-source-research-20260826.md)
