# CASDC Euclid Q1 MER 目录与 ESA 锁定 Tile 集合联结

核对日期：2026-10-10（Asia/Shanghai）。CASDC 在本日代理复测返回的 MER 目录，
列出 **352 个唯一 Tile ID**；它们与锁定 ESA `q1.mosaic_product` 的
`Q1_R1` BGSUB 清单中 **352 个唯一 `tile_index` 完全一致**。
相对该锁定范围，缺失 ID 为 0、额外 ID 为 0，镜像目录重复 ID 为 0。

这次核对没有复现 Tile ID 集合差异。它只比较一个目录响应与一个固定官方元数据输入，
不证明完整 Euclid Q1 库存、逐产品文件存在、文件内容相同或天空 footprint 正确。
没有请求 FITS/科学文件，没有做 WCS 或空间相交，也没有修改活动索引或来源锁定文件。

## 输入来源与指纹

CASDC 来源是本轮之前已保存的公开目录 GET：
<https://casdc.china-vo.org/mirror/Euclid-Q1/MER/>。
请求于 **2026-10-10T02:19:20.911799Z** 开始，
`02:19:21.123939Z` 完成（北京时间 10:19），经本机代理，保持正常 TLS 校验。
receipt 记录 HTTP 200、curl exit 0、零跳转，最终 URL 与请求 URL 相同。
本项联结只读取该已保存响应，没有重新发起下载。

官方比较输入由
[source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json)
的 `euclidQ1.snapshot` 固定：逻辑引用
`source-units/euclid-q1-r1-bgs-mosaics.csv`。来源端点是
<https://eas.esac.esa.int/tap-server/tap/sync>，锁定查询为：

```sql
SELECT tile_index,file_name,file_path,datalabs_path,stc_s,
       data_set_release,published,instrument_name,filter_name,product_type
FROM q1.mosaic_product
WHERE data_set_release = 'Q1_R1'
  AND file_name LIKE 'EUC_MER_BGSUB-MOSAIC-%'
```

本轮重读 `/tmp/source-units/euclid-q1-r1-bgs-mosaics.csv`，完整 SHA 和字节数与锁定值
一致；按 CSV 正式解析得到 2,908 行、352 个不同 Tile。没有用不同日期的新表替换旧
输入，也没有将这个 BGSUB 选择扩写为完整 Q1。lock 的 `lastAttempt=2026-09-29`
是既有字段，不能当作本轮官方全表刷新时间。

| 对象 | 字节数 | SHA-256 |
| --- | ---: | --- |
| CASDC `euclid-mer.html`，HTTP 200 正文 | 40,657 | `d84e6709c3932a4123e47cb1b980b448ebedae526cf19843d4c6597b7dc367b2` |
| CASDC `euclid-mer.receipt.json` | — | `30934e732e296a362d2a68a0c8b3e0e265416748d1d899d8b40ba767bb725367` |
| ESA 锁定 Q1 BGSUB CSV | 1,133,113 | `0e8ac7f3148b0c5d55b71018ff251a162f40038f090bfaff8b87f34c31c6aa62` |
| 本轮读取的仓库 `source-unit-indexes.lock.json` | — | `4ae0729b8bebbf406fd300e51740b221abe0f703f2393bad49e2c3d0d3a373cb` |
| 两侧分别计算的唯一 Tile ID 集合 | — | 均为 `808b6d42d8266b67f34115a4112760c54b7ba51a1c28b1f051ad8af4ce995337` |
| 本轮 `euclid-mer-tile-directory-join.result.json` | 2,297 | `683c94522822856d7ab2338fa39d6d0fe9d7de7d52f6717ad9db65ace66bf4d7` |

CASDC HTML、receipt 与联结结果在仓库外
`/tmp/asa-casdc-proxy-recheck-20261010T021920Z/`。
这些是临时核验材料，不是已纳管输入、归档对象或活动索引依赖。
未将完整目录、2,908 行产品输入或完整 Tile 清单写入 Git。

## 解析与 exact ID join 方法

1. 先核对 CASDC receipt 中的 URL、HTTP 200、curl exit、正文 SHA，以及
   `responseBytes=downloadBytes=40,657`。HTML 的 `<title>` 与 `<h1>` 均明确为
   `Index of /mirror/Euclid-Q1/MER/`，正文完整结束于 `</html>`。
2. 用 Python 标准库 `HTMLParser` 读取实际 `<a href>`，不从页面标题、文本摘要或
   目录时间推导身份。只接受无 scheme/host/query/fragment 的
   `^[0-9]{8,12}/$` 相对目录链接，并要求显示文本与 href 完全一致。
   唯一的 `../` 父目录排除，不计作 Tile。
3. 解析全部 353 个 anchor：352 个数字 Tile 目录和 1 个父目录；没有其他链接、
   label/href 差异、未闭合 anchor 或 JavaScript 目录生成。另按该静态页面逐行
   `<a href="<ID>/"><ID>/</a>` 独立提取，结果顺序和内容与 HTML parser 完全一致。
   页面没有额外导航/分页链接；结论仍限定为这份 HTTP 响应实际列出的成员。
4. 用 `csv.DictReader` 解析完整锁定 CSV，检查每行 `tile_index` 都是纯十进制字符串、
   `data_set_release='Q1_R1'`，且 filename 属于 `EUC_MER_BGSUB-MOSAIC-`。
   行数与唯一 Tile 数分别与 lock 的 2,908 / 352 一致。
5. 两边按字符串精确比较 ID；不截位、不转成近似数值、不从文件名另造 Tile。
   设 `E` 为 ESA 唯一 ID 集合，`C` 为 CASDC 目录 ID 集合：
   matched=`E ∩ C`，missing=`E − C`，extra=`C − E`。
6. 分别把两侧唯一 ID 按字符串排序，每个 ID 后附一个 LF，编码为 UTF-8，再计算
   集合 SHA-256。两侧指纹相同；原始响应与输入 CSV 自身仍保留各自完整 SHA。

## 计数与差异

| 项目 | 结果 |
| --- | ---: |
| CASDC 全部 anchor | 353 |
| 排除的 `../` 父目录 | 1 |
| CASDC Tile 目录链接 / 唯一 ID | 352 / 352 |
| CASDC 重复 ID / 无法解释的链接 / label-href 差异 | 0 / 0 / 0 |
| ESA 产品行 / 唯一文件名 / 唯一 Tile ID | 2,908 / 2,908 / 352 |
| ESA 完全重复产品行 / 重复文件名 | 0 / 0 |
| matched 唯一 Tile ID | 352 |
| missing：ESA 有、CASDC MER 列表没有 | 0 |
| extra：CASDC MER 列表有、ESA 锁定选择没有 | 0 |

`missing=[]`、`extra=[]`、CASDC `duplicateIds={}`。
ESA 的 `tile_index` 在 2,908 行中有 2,556 次重复出现，是同一个 Tile 对应不同产品的
正常关系，不是重复目录或重复输入行。每个 Tile 有 4–9 行锁定产品；集合联结先对
Tile ID 去重，不能拿 2,908 行产品数与 352 个目录数直接相减，声称镜像缺失产品。

## 结论适用范围

这份 CASDC MER 列表与**已锁定 BGSUB 范围**的 Tile ID 集合一致，已有理由保留该
目录作为访问入口，没有此项成员核对所支持的空间索引修正。先前
[2026-10-09 单 Tile 核对](casdc-mirror-index-audit-20261009.md) 检查的是 ESA 八行
官方元数据的一致性；本次扩大的是 ID 清单联结范围，不是产品文件或覆盖精度验证。

仍未检查 352 个目录的逐个 HTTP 状态、各波段子目录、2,908 个科学文件的实际存在性、
镜像文件 SHA、产品/处理版本对应关系、有效像素或 WCS。目录 ID 相同，也可能存在
空目录、缺产品、旧处理版本或不同 bytes；本轮没有这些问题的证据，不能据此推断。
不据目录名修改官方 `tile_index`、`stc_s`、ICRS/NESTED 空间索引或 `estimated` 精度。

本项没有更改代码、来源锁定输入、管理状态、活动 native generation、部署、公开 MOC
或 public bundle，也没有声称 Euclid Q1 库存已完整。
