# CASDC 镜像入口与天空分块索引有界核对

检查日期：2026-10-09（Asia/Shanghai）。本轮只读取公开 HTML 目录、官方说明和
ESA TAP 元数据；没有下载科学文件、修改索引或调用管理 API。

本轮**未复现 CASDC Tile 身份或天空覆盖错误**。CASDC 十个 HTTPS 目录请求均连接
超时，独立的 IPv4 重试也未连接成功，因而不能完成镜像文件清单与官方空间证据的
逐项联结。已成功核对的 ESA Q1 Tile `102018211` 八条记录，与仓库锁定输入的
Tile ID、文件名、波段、原始 footprint 和内部目录五个字段完全一致。这个结果只覆盖
一个 Tile，不证明 CASDC 镜像准确、全 Q1 完整或其他巡天索引完整。

## CASDC 链接目前不承担空间索引权威

静态检查对象为 [survey-access.ts](../../server/survey-access.ts) 的
`casdcProviderStatuses` / `withSurveyProviderStatuses`，以及
[server.ts](../../server/server.ts) 的 `publicSpatialUnits`：

- 空间查询先由本地/受管原生索引返回单位；CASDC 信息随后附加到
  `sourceMetadata.providerStatuses`。该函数没有生成 Tile ID、footprint、HEALPix
  cells 或改变已有 `precision`。
- `https://casdc.china-vo.org/mirror/` 是 `entrypoint-only`；目录记录的
  `accessType=directory` 只表示它是目录入口。Euclid Q1 和 DESI DR1 本轮探测到的路径
  现在也是 `entrypoint-only`，不再附加历史 `HTTP 200` 作为当前响应。
- Gaia/GALEX 目标目录不在本轮十个请求内；其状态保留 2026-10-07 的历史目录检查，
  并明确这两个子目录本轮未复测。共用根目录超时不能推断这两个子目录的当前可达性。
  `verified` 表示曾观察到目录响应和目录列表，不是空间覆盖验证、逐文件存在性验证或文件 SHA 校验。
- Euclid Q1 以已经返回的数字 `unitId` 构造 `MER/<Tile>/VIS/` 或 `NISP/`。
  样本 `102018211` 保留历史 HTTP 200 的说明，但状态为 `entrypoint-only`，并说明最近
  超时；其他 Tile 的路径只作访问提示。文件身份和几何来自 ESA，镜像目录不是其替代输入。
- DESI DR1 只增加 `spectro/redux/iron/zcatalog/` 目录入口，并明确不证明
  Tile 专属镜像路径；历史 HTTP 200 与最新超时均在说明中保留，状态为 `entrypoint-only`。
  代码没有合成 CASDC 的 `tiles/<Tile>/...` 科学文件链接。

Euclid 原生来源登记见
[native-unit-sources.ts](../../server/native-unit-sources.ts)；
[source-units.ts](../../server/source-units.ts) 从 ESA `tile_index`、`file_name`、
`stc_s` 建立 Tile 和产品 footprint，空间候选仍标为 `estimated`。
DESI 来源使用官方 `tiles-iron.fits` / `tiles-fuji.fits` 元数据，并将焦平面候选范围
与目标级光谱覆盖区分。不能从一个 CASDC 目录可打开，推导某个 HEALPix 查询的
科学文件库存已完整。

## 本轮网络检查与响应指纹

第一批 GET 从 **2026-10-09T12:31:19Z** 开始，超时限制为 25 秒。
CASDC 第二批排队请求从 `12:31:44Z` 开始。IPv4 重试使用 6 秒连接超时和
15 秒总超时。所有请求保留正常 TLS 校验；失败请求没有可用于内容校验的响应正文。
`—` 表示没有 HTTP 响应，不是 HTTP 404，也不是确认源站停机。

| 精确 URL | 本轮 GET 结果 |
| --- | --- |
| <https://casdc.china-vo.org/mirror/> | 连接超时；IPv4 重试同样超时，curl exit 28 / HTTP 000 |
| <https://casdc.china-vo.org/mirror/Euclid-Q1/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/Euclid-Q1/MER/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/Euclid-Q1/MER/102018211/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/Euclid-Q1/MER/102018211/VIS/> | 连接超时；IPv4 重试同样超时，curl exit 28 / HTTP 000 |
| <https://casdc.china-vo.org/mirror/Euclid-Q1/MER/102018211/NISP/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/DESI-DR1/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/DESI-DR1/spectro/redux/iron/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/DESI-DR1/spectro/redux/iron/zcatalog/> | 连接超时 |
| <https://casdc.china-vo.org/mirror/DESI-DR1/spectro/redux/iron/tiles/> | 连接超时 |
| <https://www.cosmos.esa.int/web/euclid/q1-data> | HTTP 200，85,008 bytes；响应 Date `2026-10-09T12:31:20Z` |
| <https://irsa.ipac.caltech.edu/data/Euclid/docs/overview_q1.html> | DNS 解析失败，没有 HTTP 响应 |
| <https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/> | 读取超时，没有确认 HTTP 状态 |
| <https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/zcatalog/> | 读取超时，没有确认 HTTP 状态 |
| <https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/> | HTTP 503；错误正文未保存/计算 SHA |
| <https://data.desi.lbl.gov/doc/releases/dr1/> | 读取超时，没有确认 HTTP 状态 |

成功响应及独立复核的锁定输入 SHA-256：

| 对象 | 字节数 | SHA-256 |
| --- | ---: | --- |
| ESA Q1 data 官方说明 HTML，本轮 HTTP 200 | 85,008 | `91caa8b5601c45c3e3471aa70ea3cf3cd8cc02b62a975519e2f9e4c8818dc326` |
| 下述 ESA 单 Tile 查询 CSV，本轮 HTTP 200 | 2,600 | `4899f69f8a45546aec7b0e507ecb5b84bff267ae1a3cdce9f1280ea6bba5c2fd` |
| 既有 Q1 BGSUB 锁定 CSV，本轮重读核对 SHA | 1,133,113 | `0e8ac7f3148b0c5d55b71018ff251a162f40038f090bfaff8b87f34c31c6aa62` |

本轮响应、无凭据 receipt 和比较记录保存在仓库外
`/tmp/asa-casdc-index-audit-20261009/`。这是临时审计材料，不是已纳管快照或发布依赖。
未把原始目录正文、完整输入清单或科学文件写入 Git。

历史 HTTP 200 的边界：此前记录保存了 2026-10-09 的 CASDC Tile `102018211`
VIS/NISP 目录和 DESI DR1 iron zcatalog 目录检查；最新状态说明同时标出随后的超时，
`httpStatus` 不再冒充当前响应。较早的
[来源研究](survey-download-sources-20261004.md) 记录 Gaia、GALEX 和 Euclid-Q1
目录于 2026-10-07 返回 HTTP 200；本轮十个请求覆盖共用根目录及 Euclid/DESI 路径，
不含 `/Gaia/` 或 `/GALEX/`。本轮失败不推翻这些带日期的历史观察，也不能把历史 HTTP 200
当成本轮重新验证；历史目录正文没有 SHA，因此本轮不为其补造响应指纹。

## Euclid：官方单 Tile 证据核对

官方端点：<https://eas.esac.esa.int/tap-server/tap/sync>。
完整的本轮 GET 请求为
[ESA Tile 102018211 查询](https://eas.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+TOP+30+tile_index%2cfile_name%2cfilter_name%2cstc_s%2cfile_path+FROM+q1.mosaic_product+WHERE+data_set_release%3d%27Q1_R1%27+AND+tile_index%3d102018211)。
响应 Date 为 **2026-10-09T12:33:34Z**，HTTP 200；返回 8 行，小于 `TOP 30` 上限。

```sql
SELECT TOP 30 tile_index,file_name,filter_name,stc_s,file_path
FROM q1.mosaic_product
WHERE data_set_release='Q1_R1' AND tile_index=102018211
```

按文件名联结仓库
[source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json)
锁定的 CSV，八行均存在，五个查询字段的值全部相同，无缺失或差异。既有锁定清单
仍为 2,908 行 / 352 Tiles；本轮没有进行全表刷新。

代表性官方文件身份（仅元数据，没有请求 FITS 文件正文）：

| 波段 | ESA 返回的完整文件名 | 官方内部目录后缀 |
| --- | --- | --- |
| VIS | `EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits` | `MER/102018211/VIS` |
| NIR_H | `EUC_MER_BGSUB-MOSAIC-NIR-H_TILE102018211-42F1AD_20241018T142558.469987Z_00.00.fits` | `MER/102018211/NISP` |
| NIR_Y | `EUC_MER_BGSUB-MOSAIC-NIR-Y_TILE102018211-E5CAE1_20241018T142558.172837Z_00.00.fits` | `MER/102018211/NISP` |
| NIR_J | `EUC_MER_BGSUB-MOSAIC-NIR-J_TILE102018211-E044A1_20241018T142600.459089Z_00.00.fits` | `MER/102018211/NISP` |

另四行是同一 Tile 的 DES-G/R/I/Z 产品，不属于上述 VIS/NISP 镜像入口样本。
八行的 `stc_s` 均保留官方 `Polygon J2000` 原文，四个顶点为：

```text
58.42991215393952 -51.76584951599632
57.56819116411332 -51.76584935192312
57.573203703161674 -51.2325625514857
58.424900136972276 -51.23256271245406
```

这是产品元数据的 frame 范围；不是读取科学像素或有效像素掩膜得到的精确覆盖。
ESA 的内部 `file_path` 也不是用户可直接下载的 HTTP 文件 URL。由于 CASDC 本轮
不可达，只能核对官方身份与现有锁定证据，无法声称这些完整文件名在镜像目录中
逐一存在，或镜像 bytes 与 ESA 相同。

## DESI：目录和空间依据仍需分别验证

[DESI DR1 recipe](../../src/layers/recipes/desi-dr1-spectra-footprint.lock.json)
锁定来源是
<https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles-iron.fits>，使用
`TILE_COMPLETENESS` 的 `TILERA` / `TILEDEC`、`NEXP >= 1` 和声明的焦平面半径
`1.6280324520485583` 度。锁定文件记录为 1,339,200 bytes，SHA-256
`99320a3a8940cb1c98d36526233e14bafcd1e137d6e2a0c0563e7b9c4f83d71a`。
这是现有 recipe 的证据引用；本轮没有重新获取该 FITS 元数据文件。

本轮官方及 CASDC iron/zcatalog/tiles 目录均未得到可比较的有效列表，不能报告
Tile roster 或文件名差异。尤其不能用 release 级 zcatalog 目录，替代
Tile/processing/product 的原生身份及目标级空间证据。现有目录说明保留这个边界。

## 当前可以据实做的修正与下一步

目前没有已复现的几何或 Tile 身份差异，因此**不修改活动空间索引**，也不把目录
入口状态提升成已验证科学文件、精确覆盖或完整库存。Euclid/DESI 本轮未响应的路径在
接口中标为 `entrypoint-only`；Gaia/GALEX 则保留其 2026-10-07 的历史验证及明确的未复测说明。

剩余核对需要在 CASDC 可达时取得带 SHA 的目录元数据，先以 Euclid 上述四个完整
文件名做 exact-name join，再扩展到其他 Tile；DESI 则分别联结官方 `tiles-iron`
身份和镜像的实际 Tile/处理目录。只有复现具体“查询 region → 官方单位 → 镜像目录
或文件”差异后，才调整访问规则或提交受管候选索引。目录缺文件、路径规则错误和
空间 footprint 错误是不同结论，需要各自证据。

本轮没有更新 Dev/生产、公开 MOC、public bundle 或原生 generation；没有完成全镜像
盘点、逐文件 HEAD、文件 SHA 对比、有效像素覆盖或全巡天完整性验证。
