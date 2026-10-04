# GALEX、JWST 与 Roman 的公开原生 observation 元数据

本次针对 **Assets Dev 原生天空分块**，不创建或修改公开 MOC、HiPS、产品或资源包。
采集只访问官方元数据 API 与说明文档，不请求科学 FITS、ASDF、影像像素、光谱、
源目录或 preview 的内容。外部采集文件仍须通过原生管理 API 导入、构建、验证、
审核、归档、激活，并由网站 HTTP 验证；暂存元数据本身不代表已部署。

## MAST 接口与身份

官方 [`Mast.Caom.Filtered`](https://mast.stsci.edu/api/v0/_services.html) 支持按
`obs_collection`、`dataRights`、`dataproduct_type`、`project`、`proposal_id` 等字段
筛选，并提供 `COUNT_BIG(*)`、分页及 `freeText` 通配符筛选。使用 POST 表单
`request=<JSON>`，明确标识元数据客户端；维持 CA 链、hostname 与时间校验。

[`CAOM fields`](https://mast.stsci.edu/api/v0/_c_a_o_mfields.html) 定义 `obsid` 为
Products API 使用的 observation/group 身份，`obs_id` 为来源 observation 名称，
`s_region` 为 ICRS circle 或 polygon。本次保留原始 `s_region`，包括 JWST 没有显式
`ICRS` token 的 `POLYGON` 字符串；坐标系依据 CAOM 文档，不能通过更改 footprint
坐标来补齐证据。原生单位为 observation，不是任意 HEALPix cell，也不重命名为 Tile。

[`Mast.Caom.Products`](https://mast.stsci.edu/api/v0/_services.html) 返回指定 `obsid`
的产品元数据，包括 source URI、文件名、类别、reported size 和访问策略。
本次只取三份 Products 元数据样例，未访问其 data URI。反查可链接 Products API，
由用户向 MAST 请求当前的清单和访问策略；不能把锁定的 observation 查询称为
完整科学文件库存。

采集器为 [`scripts/acquire-mast-native-observations.py`](../../scripts/acquire-mast-native-observations.py)。
输出统一 `schemaVersion: 1`、`adapter: mast-observation`，声明 ICRS/NESTED；每个
原始分页及 receipt 有 SHA-256，每份 normalized NDJSON.gz 有独立 SHA、大小和行数。
manifest 保留完整 query、真实上游页数与实际取得页号，`inventoryComplete` 为 false。
脚本不会修改运行时、管理状态或活动索引，也不会读取行中的访问 URI。

## GALEX：AIS 与发布范围必须分开

官方 [GALEX mission](https://archive.stsci.edu/missions-and-data/galex) 说明其视场
直径为 1.25 度，具有 FUV 和 NUV 成像，FUV 在 2009 年停止运行。CAOM 的 `CIRCLE
ICRS ... 0.625` 与该视场半径相符，但不是有效像素掩膜，也不证明整个圆内有
完整科学观测。因此原生几何保持 estimated。

2026-10-03 的官方 API 查询得到以下 **元数据行数**，不等于唯一 observation：

| 查询范围 | 元数据行数 | 收据 |
| --- | ---: | --- |
| `obs_collection=GALEX, dataRights=PUBLIC` | 330,914 | `probe-public-all-page1.receipt.json` |
| 上述范围 + `project=AIS, dataproduct_type=image` | 62,992 | `ais-count.receipt.json` |
| AIS image + `dataURL freeText=%/data/GR6/%` | 61,948 | `ais-gr6-count.receipt.json` |
| AIS image + `dataURL freeText=%/data/GR7/%` | 1,044 | `ais-gr7-count.receipt.json` |

收据和原始响应位于
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/galex/`。
GR6 与 GR7 两个已验证路径筛选的行数之和为 AIS image 行数，说明本次可以保留
官方归档路径所支持的发布成员子集；这仍不能证明锁定的 CDS HiPS progenitor
清单完整。

现有 GR6 AIS FUV/NUV/color 产品不能直接绑定全部 GALEX。非 AIS 例子
`NGA_NGC5398_580_F5_19_158` 的 `project=NGS` 且路径属于 GR7。AIS 例子
`AIS_0_1_1` 的 `project=provenance_name=AIS`，路径属于 GR6，`obsid=9039`，
`obs_id="6370915756560875520"`。该 64 位身份必须保持字符串，不能转为 JavaScript
number。其 NUV 与 FUV 行共享 `obsid`，由 `objID`、`filters` 等字段区分。

匹配 GR6 AIS 产品至少需要 AIS scope、官方 `/data/GR6/` 路径证据及对应 `filters`。
NUV 与 FUV 不能互借 membership；color 可以表示已有 AIS band observations 的
联合候选，但不能发明 color 科学文件。绑定 GR6/GR7 通用产品时保留每行真实
project 与路径，不把 NGS、MIS、DIS 等改成 AIS。

CDS 的 [GALEX GR6 AIS FUV 记录](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6%2FAIS%2FFUV&get=record&fmt=json)
标题为 `GALEX GR6 AIS (until March 2014)- Far UV`，`prov_progenitor=STScI (NASA)`，
HiPS 实际位置为
[`GALEX/GR6-03-2014/AIS-FD`](https://alasky.cds.unistra.fr/GALEX/GR6-03-2014/AIS-FD/properties)。
其 `HpxFinder` 在本次探查返回 HTTP 403；未取得 progenitor roster，不能以相交
MOC 代替缺失的原始文件成员清单，也不能把现代 GR7 路径标成 GR6。

`dataURL` 不能无条件视为当前 band 的 intensity image：例如 `obsid=9041` 的
NUV image 元数据指向 `-xd-mcat.fits.gz`，其他行指向 `-exp`、`-rr` 等 ancillary
类型。采集器保留这些原始值和 Products API 入口，不通过替换后缀构造 `-int`
链接。Products 样例 `9039` 与 `9041` 各返回 414 行元数据，包含 SCIENCE、
AUXILIARY、INFO、PREVIEW；该数量不是 observation 查询的科学文件库存声明。

已完整取得两个声明 query：AIS public calibrated image 为 **62,992 行 / 34,285 个
observation**（63 页，每页 1,000），GR7 public calibrated image 为 **5,965 行 /
5,488 个 observation**（6 页，每页 1,000）。两份查询保留独立 filters、实际分页、
捕获时间、原 manifest 和全部 page receipts；未取得非 AIS 的 GR6 库存。

合并输入共有 **68,957 证据行**，其中重复的 AIS/GR7 元数据为 1,044 行；按完整
normalized 内容去重为 **67,913 条元数据记录 / 38,729 个唯一 observation**。
source URI 路径分别为 GR6 61,948 条、GR7 5,965 条；band 分别为 NUV 38,660 条、
FUV 29,253 条。没有缺失的 `s_region`。这些是元数据成员计数，不是科学文件数。

| 保留的实际 project | 去重后的元数据记录 |
| --- | ---: |
| AIS | 62,992 |
| MIS | 3,234 |
| DIS | 545 |
| NGS | 254 |
| CAI | 13 |
| GII | 875 |

冻结合并输入：

- 文件：`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/galex/native-combined/manifest.json`
- manifest SHA-256：`4d0600778b0994c4d658deadc511bfbf45056cf968eb200786b05c286049e22e`，41,854 bytes。
- 162 个依赖包含两份原始 manifest、两份 normalized row file、原始 page/receipt 和
  官方 GALEX/CAOM/CDS 来源说明与 Products 元数据样例。
- 顶层 `queryPagesComplete=true`，只说明上述两个声明 query 全部分页已取得；
  `inventoryComplete=false`，非 AIS GR6 库存、CDS HiPS progenitor roster 及科学文件
  完整性仍未核实。

## JWST：只绑定已经公开的 Carina 与 SMACS 产品

`obs_collection=JWST, dataRights=PUBLIC` 的初始探查有 339,100 行，包含
`provenance_name=APT, calib_level=-1, t_min=null` 的**计划** footprint。
因此 `PUBLIC` 不足以证明已观测。已校准范围 `calib_level in [1,2,3,4]`
的 image count 为 108,981，spectrum count 为 157,066；这些宽范围计数只作调研，
本次没有把全 JWST 自动绑定到两个公开图片产品。

官方 [JWST-ERO HLSP](https://archive.stsci.edu/hlsp/jwst-ero) 直接列明目标与 program：
Carina/NGC 3324 对应 **2731**，SMACS J0723.3-7327 对应 **2736**。同页说明 ERO
首批公开产品在 2022-07-12 发布，以及 MIRI Release 1 的图像与滤镜。
[2731 program](https://www.stsci.edu/jwst-program-info/program/?program=2731) 和
[2736 program](https://www.stsci.edu/jwst-program-info/program/?program=2736) 当前均
显示 program 已完成。

本次完整的目标元数据 query 固定：`obs_collection=JWST`、`dataRights=PUBLIC`、
`dataproduct_type=image`、`calib_level=[1,2,3,4]`、`proposal_id=[2731,2736]`、
`target_name=[NGC-3324,SMACS-J0723.3-7327]`。取得 **22 行、22 个唯一 observation**：

| Program / CAOM target | NIRCam image | MIRI image | NIRISS image | 总数 |
| --- | ---: | ---: | ---: | ---: |
| 2731 / `NGC-3324` | 6 | 4 | 0 | 10 |
| 2736 / `SMACS-J0723.3-7327` | 6 | 4 | 2 | 12 |

只按 program 2736 筛选会得到 24 行，其中另外 12 行是 `NIRSPEC/MSA` 的
`MPTCAT-MORESTARS` / `MPTCAT-NIRCAM-ACS` acquisition targets。本次实际目标查询
排除这些行；它们不能自动成为 SMACS 的公开 NIRCam 影像。

产品若明确是 NIRCam，则分别绑定 **6 个** observation；若有明确 MIRI 或 NIRISS
产品，再依据 instrument、filter、target 和 program 选择。一个目标的所有观测
不能被称为特定 instrument/filter 产品的完整文件清单。Carina 的原始多顶点
CAOM polygon 必须保留；保守 spatial matching 需要说明 estimated precision，
不能凭目标名套用一个统一圆或另一目标的几何。

冻结输入：

- 文件：`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/jwst/native-ero/manifest.json`
- manifest SHA-256：`08f00892909653dccc6a40e54e8cbf8c7f854467a4d5af740ee2e879f9e4f54f`，4,524 bytes。
- row file：`observations.ndjson.gz`，SHA-256
  `dc2e38590c19506e0e51509fa3e7d965bf104d8faacdc48917fa1513d03289ec`，12,494 bytes。
- 9 个依赖包含原始 page、POST receipt、normalized rows 和已捕获的官方 HLSP/program
  文档及收据；`inventoryComplete=false`，完整的是上述声明 query，不是 JWST 全巡天。

## Nancy Grace Roman：归档测试记录不作为观测覆盖

不能依赖旧资料断言 Roman 尚未发射。当前
[NASA mission 页面](https://science.nasa.gov/mission/roman-space-telescope/) 写明
发射日期为 **2026-08-30**；[NASA commissioning 页面](https://science.nasa.gov/missions/roman-space-telescope/roman-commissioning/)
在 2026-10-02 更新，说明正在前往 L2 的三个月旅程中开启、校准仪器并为科学运行
做准备。NASA 的 commissioning 观测消息不等于 MAST 已公开科学 survey inventory。

官方 [MAST Roman mission](https://archive.stsci.edu/missions-and-data/roman) 当前特色
数据明确为 **Wide Field Instrument Triplet Test Data**；该页仍保留旧的
`Planned Launch Late 2026` 文案，发射状态应以较新的 NASA mission 页面为准。

2026-10-03 的官方 CAOM 验证：

| 精确筛选 | 行数 |
| --- | ---: |
| `obs_collection=ROMAN, dataRights=PUBLIC` | 72,961 |
| 上述范围 + `provenance_name=ROMAN TEST` | 72,961 |
| 上述范围 + `provenance_name=CALROMAN` | 0 |

原始探查行虽然显示 `intentType=science`、PUBLIC、观测时间与 polygon，仍明确
标为 `provenance_name=ROMAN TEST`；仅凭这些字段不能将模拟/测试 footprint 标为
observed。两份计数相等支持“本次查得的公开 collection 全部为测试 provenance”，
不代表不存在未公开或其他渠道的真实 commissioning 数据。

收据保存在
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/roman/`。
本次不将 Roman 测试行导入 observed native index。保留官方入口及当前未核实
公开科学分块清单的说明，未来有明确观察来源、有效 metadata 和产品绑定后再受管导入。
