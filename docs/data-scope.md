# Data scope and evidence limits

This page holds the detailed, evidence-backed scope that used to live in the
README. Figures are as recorded on the stated dates; the live counts are
always available from `GET /api/v1/status` and `GET /api/v1/surveys`.

中文版本见下方 [数据范围（中文）](#数据范围中文)。

## Native-unit bindings (English)

The current product and native-unit mappings have explicit source limits. A
listed product is not proof that every file or public archive product has been
indexed; source files remain at their archive under its access policy.

| Survey | Native units and access | Captured scope |
| --- | --- | --- |
| Euclid | Q1 MER Tile IDs and calibrated image frames; ERO target and image-frame links | Q1's locked BGSUB roster contains 2,908 rows / 352 Tiles. A separate Q1_R1 calibrated-frame snapshot contains 2,449 rows (836 VIS, 537 NISP.H, 538 NISP.J, 538 NISP.Y); these are image units, not MER Tiles. ERO contains 17 named targets and 85 bounded FITS-header records; four published ERO frame layers cover VIS and NISP Y/J/H (17 frames per layer). Eight ERO/Q1 frame MOCs have native O10, with estimated bounds. They do not verify valid-pixel masks, complete archive inventories, or individual science files; ERO still has no verified Tile roster. No scientific pixels were downloaded. See the [frame coverage record](research/euclid-ero-q1-frame-coverage-20261012.md) and the [mirror audit](research/casdc-mirror-index-audit-20261009.md). |
| DESI DR1/EDR | Estimated Tile candidates and official directories | Proxied GETs on 2026-10-10 returned HTTP 200 for the CASDC DR1, iron and zcatalog directories; the sibling `iron/tiles/` path returned HTTP 404. This does not verify a Tile-specific mirror path or individual files. Circular focal-plane matches do not establish target-level spectral coverage or a complete science-file inventory. See the [bounded audit](research/casdc-mirror-index-audit-20261009.md). |
| Legacy Surveys | Release-specific bricks and candidate product URIs | The catalog spans DR1-DR10. DR10 South covers the official 366,912-member roster; northern imaging retains DR9 North identity. Candidate URIs still require per-file verification, and later releases are not implied by the DR10 roster. |
| Gaia DR3 | `gaia_source` HEALPix file partitions | The locked ICRS/NESTED order-8 ranges describe source-ID file partitions, not actual source occupancy or verified file contents. Other Gaia DR3 products are not represented by this binding. |
| HST | Observation IDs, original `s_region` and MAST entrypoints | The Assets Dev-only native index now includes two new public observations, `454130303` and `454130304`, alongside retained metadata for `26442812`; it has 916,119 indexed observations and still excludes eighteen unsupported-frame rows. This bounded supplement is not in the current public bundle and does not complete the HST inventory. MAST provides current products and source access policy. See the [Dev supplement record](research/hst-bounded-supplement-20261010.md). |

These are bounded, evidence-backed scopes rather than complete inventories of
the five archives. Coverage MOCs, native-unit mappings, source directories and
verified scientific file bytes are separate evidence. The 2026-10-10 proxied
CASDC recheck returned HTTP 200 for its index and the probed Euclid/DESI, Gaia
and GALEX directories; it returned HTTP 404 for DESI `iron/tiles/` and the guessed
Gaia `gdr3/` path. Gaia's linked `/Gaia/dr3/` and GALEX `/GALEX/GR6/` paths
returned HTTP 200. These responses establish only directory reachability at the
stated check time, not file bytes, survey inventory completeness or spatial
coverage. See the [bounded audit](research/casdc-mirror-index-audit-20261009.md).
Public bundle `reviewed-mv51kku3-a4f8d8e6` (SHA-256
`d197228230cfa34ce9a59f25de6991cb5875094f18278825eb8b5a856a113ae7`) contains
611 files and 28 resource packages. Its catalog records 67 releases and 159
products: 107 acquired, 11 overview-only and 41 awaiting geometry. The public
coverage API reports 140 layers, including 113 published MOC layers; the
publication record contains 162 coverage documents. These are catalog status
counts, not evidence that each archive's full inventory or every listed file
has been verified.

HSC-SSP's existing PDR2/PDR3 tract/patch adapter links to the corresponding
DAS Search, which requires an account; a match does not prove a file exists.
Coverage, native units and scanned file evidence retain separate precision
and completeness. If a real query is missing or unclear,
[open an Assets issue](https://github.com/Astro-Survey-Atlas/Assets/issues)
with the survey, release, product and a region you can share publicly.

## 数据范围（中文）

已登记的产品不代表档案中的每个公开产品或科学文件都已纳入索引。来源文件仍由
原档案按其访问政策提供；目录入口可用也不等于逐文件校验。

| 巡天 | 天区单位与来源 | 已捕获范围及限制 |
| --- | --- | --- |
| Euclid | Q1 MER Tile 与校准图像；ERO target 和图像范围入口 | Q1 锁定的 BGSUB 清单有 2,908 行 / 352 个 Tile。另有独立的 Q1_R1 校准帧快照，共 2,449 行（VIS 836、NISP.H 537、NISP.J 538、NISP.Y 538）；这些是 image 单位，不是 MER Tile。ERO 纳入 17 个具名 target 和 85 条有界 FITS 头记录；已发布 VIS、NISP Y/J/H 四个 frame 图层，每层 17 帧。八个 ERO/Q1 frame MOC 的最高原生阶为 O10，范围精度为 estimated；未验证有效像素掩膜、档案完整库存或单个科学文件，ERO 仍没有已核验的 Tile 清单。本次未下载科学像素。见[范围记录](research/euclid-ero-q1-frame-coverage-20261012.md)和[镜像审计](research/casdc-mirror-index-audit-20261009.md)。 |
| DESI DR1/EDR | 估算 Tile 候选与官方目录 | 2026-10-10 经代理 GET 检查，CASDC DR1、iron 与 zcatalog 目录返回 HTTP 200；同级 `iron/tiles/` 路径返回 HTTP 404。这不证明存在 Tile 专属镜像路径，也未核验逐文件可用性。圆形焦平面近似不等于目标级光谱覆盖或完整科学文件清单。[核对记录](research/casdc-mirror-index-audit-20261009.md)。 |
| Legacy Surveys | 按 release 区分的 brick 与候选产品 URI | 当前目录登记 DR1-DR10。DR10 South 对应官方 366,912 个成员；北区成像保留 DR9 North 身份。候选 URI 尚未逐文件核验，DR10 roster 不代表后续 release。 |
| Gaia DR3 | `gaia_source` HEALPix 文件分区 | 锁定的 ICRS/NESTED O8 范围描述 source-ID 分区，不证明实际天体占据或文件内容；其他 Gaia DR3 产品不在此绑定中。 |
| HST | Observation ID、原始 `s_region` 和 MAST 入口 | Assets Dev 原生索引新增两条公开观测 `454130303`、`454130304`，并保留 `26442812` 的元数据；目前索引有 916,119 个观测，仍排除 18 条不支持坐标框架的记录。这是有界补充，未进入当前 public bundle，也不代表完整 HST 清单；MAST 仍负责实时产品与访问政策。见[Dev 补充记录](research/hst-bounded-supplement-20261010.md)。 |

以上是有边界、基于证据的范围，不是五个档案的完整产品清单。MOC 覆盖、原生分块、
来源目录和已校验科学文件字节是不同证据。2026-10-10 经代理复测 CASDC 根目录及
本次检查的 Euclid、DESI、Gaia、GALEX 目录均有 HTTP 响应；DESI `iron/tiles/` 和
猜测的 Gaia `gdr3/` 路径返回 HTTP 404，实际由 Gaia 入口链接的 `/Gaia/dr3/` 返回
HTTP 200。目录响应只说明检查时入口可达，不代表文件字节、档案完整库存或空间覆盖已验证。
此前 2026-10-09 的超时仍作为历史结果保留，详见[核对记录](research/casdc-mirror-index-audit-20261009.md)。
公开 bundle `reviewed-mv51kku3-a4f8d8e6`（SHA-256
`d197228230cfa34ce9a59f25de6991cb5875094f18278825eb8b5a856a113ae7`）包含
611 个文件和 28 个资源包。目录记录 67 个 release、159 个产品：107 项 acquired、
11 项仅有 overview、41 项等待 geometry。公开 coverage API 有 140 个图层，其中
113 个已发布 MOC；该发布任务记录 162 份 coverage documents。这些是目录状态计数，
不代表档案完整库存或每个来源文件都已核验。

HSC-SSP 现有 PDR2/PDR3 tract/patch 适配器链接到对应的 DAS Search，需要账号；匹配结果
不证明文件存在。若真实查询缺失或含义不清，请[提交 Assets issue](https://github.com/Astro-Survey-Atlas/Assets/issues)，
附上巡天、release、产品以及可公开的天区。
