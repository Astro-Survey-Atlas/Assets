# SPHEREx DR1 元数据与原生文件索引最小实施方案（2026-11-14）

本阶段仅研究和验证，**没有正式导入DR1、修改科学算法或生产policy、激活Native Unit、部署Warehouse或创建GCP资源**。代码基线、版本边界及本地测试见 [生产链审计](assets-moc-native-provenance-audit-20261114.md)。本方案代码位置固定为 Assets `8ff160f83d568221abe6cd771ab81b318dd85ea1`。

## 建议与准入条件

第一步优先 **DR1 All-Sky Cube的真实元数据库存和O5 NESTED原生分区索引**。官方已提供真实目录、URI与分块定义，不需要下载约TB级科学内容，不需要先上GCP或Warehouse。按已有Assets受管import→build→verify→review→archive→activate流程交付候选，激活留待下一阶段明确授权。

DR1 spectral images是另一产品，不能与Cube或旧QR2 observation混用。官方Cube MOC已找到，但真实12个O0全天单元不满足当前公开O4门槛；该产品策略必须单独处理，禁止伪装高阶。原生索引与MOC可以分阶段交付；若现有公开catalog门禁不允许无MOC的新DR1 binding，需在产品身份/coverage状态接线时显式验证，不承诺候选构建完就能在网站被选中。

## 官方来源与有界实测

调查日：2026-11-14；有界网络探测为 UTC 11:38–11:42（北京时间19:38–19:42）。原始响应与逐次请求 URL、HTTP 状态、时间、响应体字节数、SHA-256 均保存在 [evidence/20261114/spherex/](evidence/20261114/spherex/)，请求统计见 [summary.json](evidence/20261114/spherex/summary.json)。本次只读取文档、目录清单、SIA/TAP 元数据、覆盖 MOC；四次科学文件验证只用 HEAD，科学影像/光谱/Cube 内容读取为 **0 字节**，未做 FITS 科学文件 Range 读取。

### 官方发布与产品边界

IRSA 新闻宣布 DR1 于2026-11-12发布。DR1重新处理原QR2 spectral images，应与QR3共同构成新的统一处理数据集；不能给QR2既有快照换名作为DR1。官方概览：[DR1 Overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html)，[IRSA News](https://irsa.ipac.caltech.edu/news.html)，[Archive User Guide](https://irsa.ipac.caltech.edu/spherex-archive-documentation/)。

DR1至少有两种必须分开建模的科学产品：

| 产品 | 原生单元 | 官方定义/实测 |
|---|---|---|
| Spectral image MEF | observation × detector × processing version 的 frame | 每次pointing最多6个detector，质量筛选可导致缺失band；约70MB/frame；实测DR1版本`l2b-v27-2026-196`，官方notebook还存在`l2b_retry`，不能锁死QR2版本正则 |
| All-Sky Cube | HEALPix **order5、NESTED** tile | 官方定义12,288个，约1.8°×1.8°，512×512空间像素、102光谱通道；S3样例每个320,909,760bytes |

依据：[Data Products](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-products/)。Cube通道51、52没有数据（可视化frame50、51为0-based），完整空间tile域不能证明所有波长/所有像素均有有效科学数据。HiPS PNG是可视化产物，不可代替科学Cube文件或其有效像素掩膜。

### 官方 DR1 MOC：存在，但现有 Assets policy 阻塞正式 MOC 发布

直接可用的官方空间覆盖元数据存在：

- properties：`https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties`，HTTP200，3,504bytes，`creator_did=ivo://IPAC/P/SPHEREx/DR1/cube`，`obs_collection=SPHEREx DR1`，`hips_frame=equatorial`，`hips_tile_format=png`，`moc_sky_fraction=1.000000`。
- MOC：`https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Moc.fits`，HEAD200；GET200，8,640bytes。原件`hips_moc.body`；完整receipt `hips_moc.json`。
- FITS声明`MOCVERS=2.0`、`ORDERING=NUNIQ`、`COORDSYS=C`、header `MOCORDER=11`，但实际12个UNIQ记录是12个O0全天单元。SDK独立规范化验证实际最大阶为0。

**实测阻塞：** Assets `decodeNativeMoc` / `assertPublicCoverageOrder` 以规范化后实际阶数判断，要求native order≥4，因此这个真实官方全天MOC不能直接通过现有正式包发布链。不得篡改为O4、相信header11而忽略实际内容、伪装细分cell或绕过审核。下一阶段应讨论如何准确表达全天覆盖和native partition order，保留官方MOC字节和原始provenance，再改明确的policy；本阶段不改生产policy。

这个MOC只证明DR1 cube/其HiPS的空间覆盖，不能作为DR1逐detector spectral image覆盖，不能证明原生文件清单完整。CDS MocServer本次`ID=*SPHEREx*&get=record&fmt=json`返回7条，均为QR2 D1–D6/color；未见DR1条目。它不等同于全网不存在DR1 MOC。另有IRSA `spherex.plane.moc.fits`标为Weekly rollout，是滚动plane集合，不应作为DR1特定release快照。

### 真实目录和 URI 的证据

官方cloud文档：[Cloud Data Access](https://irsa.ipac.caltech.edu/cloud_access/#spherex) 指向AWS公开bucket `nasa-irsa-spherex`、region `us-east-1`、prefix `dr1/`；匿名ListObjectsV2实测HTTP200。

Cube的真实层级清单：

1. `prefix=dr1/hips5_cube/&delimiter=/`返回`dr1/hips5_cube/hips_20261026/`，`IsTruncated=false`。
2. `prefix=dr1/hips5_cube/hips_20261026/&delimiter=/`只返回`Norder5/`，`IsTruncated=false`。
3. `prefix=dr1/hips5_cube/hips_20261026/Norder5/&max-keys=5`返回实际存在的Npix0、1000、1001、1002、1003对象，`IsTruncated=true`并含NextContinuationToken。这是字典序，不是整数顺序，不能由这些编号推断中间文件缺失。

每条Contents含真实Key、Size、LastModified、ETag、存储类；这些是库存元数据，ETag不是通用SHA-256/科学文件checksum。S3清单必须逐页追随原始ContinuationToken直到`IsTruncated=false`，再验证唯一键、允许的路径、order/pixel范围、重复版本和缺口，才能说该prefix清单分页完整。本次**没有**遍历完整cube或level2库存。

SIA给出的真实cube示例（不是从模板猜测）：

```text
https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir0/Npix9822_cube.fits
s3://nasa-irsa-spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir0/Npix9822_cube.fits
```

该IRSA URL和cloud_access对应AWS HTTPS URL均HEAD200、Content-Length=320909760。DR1影像示例同样两地HEAD200、Content-Length=63492480：

```text
https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W18_1B/l2b-v27-2026-196/1/level2_2025W18_1B_0162_1D1_spx_l2b-v27-2026-196.fits
```

HEAD证明观察时单URI可访问和元数据长度，不证明文件字节checksum或科学有效性；IRSA/AWS LastModified不同，不能据此断言两地内容完全相同。HTTP目录根`/ibe/data/spherex/dr1/`在本环境404，但以上具体文件200，因此目录浏览失败不是科学对象不存在的证据。

### SIA/TAP：实测与分页限制

官方API文档：[Data Access](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-access/)，[SIA2](https://irsa.ipac.caltech.edu/ibe/sia.html)。当前五种SIA COLLECTION：`spherex_dr1`（wide）、`spherex_dr1_deep`、`spherex_dr1_cube`、`spherex_qr3`、`spherex_qr3_deep`。QR2不再能以SIA搜，直链计划保留至2027-02。官方称SIA较目录/某些TAP ingest可能滞后约一天。

本次两个有界小天区查询（同一POS，半径0.01°）：

```text
https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1_cube&POS=circle+127.69444+-39.17760+0.01&MAXREC=2
https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=circle+127.69444+-39.17760+0.01&MAXREC=2
```

- Cube：1行，`QUERY_STATUS=OK`，真实tile9822。
- Spectral image：2行，`QUERY_STATUS=OVERFLOW`，同一observation的D1/D4；不是该小天区完整结果，更不是DR1库存。
- 字段包括`access_url`、`cloud_access`（AWS bucket/key/region JSON）、`obs_publisher_did`、`obs_id`、`s_region`、`energy_bandpassname`、`t_min/max`、`access_estsize`（kbyte）。原始VOTable保留，避免CSV丢失OVERFLOW证据。
- SIA MAXREC是截断上限，不是可枚举稳定分页机制；不能循环加offset来假定完整。应拆分明确查询域、去重并检查每次QUERY_STATUS，或用TAP/官方bucket库存；SIA与库存必须对账。

TAP `TAP_SCHEMA.tables`实测发现：`spherex.obscore`、`spherex.observation`、`spherex.plane`、`spherex.artifact`、`spherex.provenance_input`。`TAP_SCHEMA.columns`元数据可查询URI、geometry、byte size、checksum、processing provenance；官方notebook通过`artifact a JOIN plane p ON a.planeid=p.planeid`和`p.poly`查影像。

实测`obscore TOP3`返回DR1 image，`obs_collection=spherex_dr1`，但`access_url`是DataLink链接，**不是直接FITS URI**。不能将一切TAP access_url当科学文件下载地址；应用应识别DataLink语义，或选择明确的artifact URI。

实测受限三表join：`artifact a JOIN plane p ON a.planeid=p.planeid JOIN observation o ON p.obsid=o.obsid WHERE o.observationid='2025W18_1B_0162_1'`、`TOP2/MAXREC2`，返回DR1 D1/D2的真实`a.uri`、`a.contentlength`和`p.poly`，`o.collection=spherex_dr1`，`p.provenance_version=7.0.5`。D1 URI和byte count与SIA/HEAD一致；`poly`在CSV中是hex EWKB（SRID4326），不是STC-S字符串，需要显式解码和校验。filename processing版本`v27`和pipeline provenance版本`7.0.5`也应分别保留。这些TOP样例不证明完整库存、稳定排序或分页完整性。

**不能把SIA所有collection可用性推广到TAP：** 本次 `SELECT TOP 2 ... FROM spherex.obscore WHERE obs_collection='spherex_dr1_cube'`返回0行，虽然SIA cube有成功样例。Cube是否进入该CAOM集合、release过滤、稳定keyset分页和总量都需要独立验证；不能在计划中写成已经验证的Cube全库存TAP方案。

### 最小索引方案（下一阶段，当前不正式导入）

优先选择有限、官方原生分区清楚的 **DR1 All-Sky Cube**，独立release/product和新adapter，保留QR2 observation adapter。用S3真实库存列出Cube对象，以官方order5 NESTED定义提供精确分区几何；SIA小样本交叉检查URI、定位、collection。无需下载Cube数据或扫描FITS/WCS。

推荐manifest至少保留：survey/release/product、snapshot/version、native_id（order5/ipix）、native_order=5、ordering=NESTED、frame=ICRS、official key、official HTTP/S3 URI、byte_size、ETag/checksum类型、inventory observed_at/raw_response_sha256、URI HEAD时间/状态、geometry_kind=`healpix-cell`、geometry来源、query_status/pagination状态、inventory_scope、science_validity说明。geometry snapshot与库存snapshot分开；Coverage MOC与Native Unit Index分开。

NESTED O5分区投影到O8时，每tile的64个子cell可直接由`[ipix*4^3,(ipix+1)*4^3)`确定，预计12,288×64=786,432条映射（如果完整12,288库存成立）。O4 parent为floor(ipix/4)。这些是数学投影，不是猜测文件存在；ipix必须来自实际清单。Cube的HPX边界有曲边，不能把SIA四角great-circle polygon当精确HEALPix分区。native order5不能与全天MOC规范化order0混为一谈。

spectral image的后续方案应从官方TAP/SIA按实际release、detector、processing version采集frame/URI/官方polygon；保留polygon近似精度，不假称WCS有效像素精确覆盖。仅在确实缺失几何且另获授权后考虑小量FITS header Range，当前没有必要。

### 规模和GCP/Warehouse判断

官方文档声明12,288个Cube，不能据此说本次验证了12,288个文件。5个S3样例均320,909,760bytes；若每个文件大小相同且都存在，乘积约3.943TB（3.587TiB）是**科学数据体积估算**，不是本次数据传输，也不是索引大小。

完整Cube库存预计13次每页1000keys的ListObjectsV2（可能再有版本/标记项需实际判定），按样例XML约数MB元数据；manifest、SQLite与O8映射仍是现有环境可承担的有限任务。索引大小和耗时应由下一阶段dry-run测量；全量spectral image数尚未量测，不能拿Cube规模代表影像库存。

本阶段GCP新资源费用为0，未来Cube元数据采集和确定性分区计算没有使用GCP的必要。Warehouse也无不可替代任务：官方库存+原生分区足够提供公开native索引证据。继续复用Assets manifest/import/build/verify/review/archive流程，先解决order0全天MOC policy blocker，再由用户决定是否实施。仅当更大影像库存实测超出现环境资源/时限时，再估算短任务计算；不为消耗额度先部署平台。

### 四种完整性必须分别报告

| 维度 | 本次状态 | 不能推导 |
|---|---|---|
| 单次查询分页 | Cube SIA小域OK；image SIA明确OVERFLOW；S3几个浅prefix完整、科学库存prefix均截断 | 小域OK不能推导全Release完整 |
| 已发现文件库存 | 有S3真实5个Cube+3个影像样例；SIA另1个Cube+2个影像结果；未全量枚举 | 12,288是官方定义/目标，不是实测库存计数 |
| 空间几何 | Cube原生O5 NESTED定义明确；官方MOC实际O0全天；SIA提供polygon | 文件分区域/MOC不证明有效像素、有效波长或深度 |
| 单URI可用性 | 选取1个Cube和1个影像，IRSA/AWS共4个HEAD200，科学body0字节 | 不证明其他URI可用、远端checksum正确或全Release发布完成 |

## 对照现有代码的最小改动文件

### DR1最小实现建议（本次未实施）

根据上面的官方来源实测，目前已证实两个不同原生产品：DR1 spectral images（observation/detector/processingVersion/足迹）与DR1 all-sky cubes（NESTED O5 tile, 官方设计12,288块）。不要把QR2红外 spectral image/frame或不同product合并为同一“索引”。

第一阶段优先cube元数据小库存，新增独立adapter（建议`spherex-dr1-healpix-cube`）；按真实S3列举或官方SIA/TAP返回的URI、bucket/key及tile_id关联，从完整metadata roster而不是命名规则生成files。HEAD样例属于availability证据，ETag不可宣称科学MD5。对每次收集保留QUERY_STATUS/OVERFLOW或S3 IsTruncated/token、查询排序/页数/行数/SHA/捕获时间；本次官方只有限样例，不能承诺全量已完成。

| 最小文件 | 必要改动 / 可保留 |
|---|---|
| 新`scripts/acquire-spherex-dr1-metadata.py`、对应Python测试 | 只取metadata listing/SIA/TAP与HEAD，流式冻结原文和normalized NDJSON；明确cube/image分scope、stable key分页、重复/缺页/结束验证。**不复用QR2 header读取作为大规模工作** |
| `src/layers/recipes/survey-native-sources.json` | 新DR1 cube sourceId/releaseId/scope/official endpoint；QR2记录保持独立 |
| `server/native-unit-model.ts` | 新NativeAdapter union与metadata host/path allowlist；现有unitKind=`healpix-range`可承载partition，不必增造cube unitKind，产品modality独立 |
| `server/survey-native-index.ts` | 新adapter set、DR1绑定、manifest validator、row validator；把仅Gaia分区分支泛化为有显式nativeOrder的受证partition：build候选、sampleCells、lookup、nativePartition输出、URI hydration。现在`:2334`,`:2381`,`:2403`,`:2422`,`:2443`,`:2458`均有Gaia/O8假设。可以保持表结构以payload.nativePartition存nativeOrder，或更清楚添加native_order并提升SCHEMA及独立重建candidate；无论哪种都必须改变build identity/构造版本，防旧SQLite误复用 |
| `server/native-unit-sources.ts` | 加DR1 sourceIdsForBinding分支；现有source registry装载可复用 |
| `server/native-unit-worker.ts` | 新adapter gap/统计（unknown-valid-pixel-coverage、metadata pagination/status、URI availability抽样），复用import→isolatedBuild→verify→review→archive→activate，不必改controller/CAS/archive |
| `server/server.ts` 等公共注册 | 已在公开survey allowlist有spherex；确保新DR1 native binding通过catalog和sourceUnitCoverage加载；优先产品管理创建DR1正式public identity。无需新反查endpoint、无需Warehouse |
| `test/survey-native-index.test.ts`、`test/native-unit-management.test.ts` +新增collector测试 | O5/O4/O8边界、RA wrap/poles、同tile多processing/URI、未列出文件拒绝、重复页/漏页/OVERFLOW、hash损坏/identity不符、候选隔离、跨激活cursor冻结 |
| DR1 public MOC recipe/registry/plan或admin product record | 只有已确认真正coverage语义才建立独立resource package；复用SDK和existing publish流程，不把Native SQLite当MOC。**官方cube fullsky MOC实测被现有gate拒绝，发布策略必须单独决定；不在本轮实现、不伪造O4**。官方MOC捕获SHA与DR1 registry/recipe留作另一条product publication |

精确O5查询应通过NESTED祖先/后代相交判断，并返回原nativeOrder=5；不能把官方四角POLYGON当精确HEALPix曲边，也不能把O5格网当更细科学有效覆盖。

**已实测的发布门槛冲突**：官方cube FITS MOC只有8640B，SHA256=`369098ba758dd74f8bec6d895d94df95807bffc500605830781cba2abe373564`，header MOCORDER/MOCORD_S虽为11，实际UNIQ只有4..15（12个O0 fullsky）。SDK1.2严格validate通过，但本次审计以现有`decodeNativeMoc`+`assertPublicCoverageOrder`执行确认被“实际decoded maxOrder>=4”门槛拒绝（证据`evidence/20261114/dr1-actual-publication-gate.json`）。**原始官方源已O0，并非SDK误合并**。须明确这是retrieval分区域而非valid pixels/band/channel覆盖，不能upsample或改header绕门槛。可先建设Native Unit Index；要将allsky partition-domain作为public coverage产品，需另行产品/发布策略决策或官方有效覆盖证据，不能在本轮审计擅改算法。即使全量文件分区确认有12,288个O5 tiles，把它们canonical union也会退化为fullsky O0；本次仍未全量盘点文件。

此规模仅metadata与SQLite，本地普通CPU足够；可复用Assets worker/管理器，不需要新Warehouse或GCP。image全库规模以官方count/metadata字节测量后再评估，不能用300美元额度倒推必须上云。

## 建议目标 schema：库存、几何、URI可用性分开

以下是**下一阶段设计**，不是声称当前importer已接受的schema。仍须通过新增DR1 adapter的明确验证，不能把它塞进QR2严格manifest。

```json
{
  "schemaVersion": 1,
  "surveyId": "spherex",
  "releaseId": "spherex-dr1",
  "productId": "<reviewed-cube-product-id>",
  "adapter": "spherex-dr1-healpix-cube",
  "coordinateFrame": "ICRS",
  "ordering": "NESTED",
  "scope": {
    "bucket": "nasa-irsa-spherex",
    "prefix": "dr1/hips5_cube/hips_20261026/Norder5/",
    "inventoryObservedAt": "<capture-time>",
    "queryPagesComplete": false,
    "inventoryComplete": false
  },
  "rowFiles": [{"ref": "<normalized.ndjson.gz>", "sizeBytes": 0, "sha256": "<actual-capture-hash>"}],
  "metadataDocuments": [{"ref": "<raw-list-page.xml>", "sizeBytes": 0, "sha256": "<actual-response-hash>"}]
}
```

| 规范化row字段 | 约束与证据 |
| --- | --- |
| identity | survey/release/product、unit kind、实际tile ipix、nativeOrder=5、processing/cube version；相同tile的多版本按明确政策选择或分别保留，不静默覆盖 |
| spatial | ICRS/NESTED、geometryKind=healpix-cell、nativePartition order5/firstIpix/lastIpix；精确的是分区相交，不是科学有效像素或所有102通道 |
| official object | 从实际listing/SIA/明确artifact URI取得bucket/key/HTTP/S3 URI、size、lastModified；不凭模板制造存在性；DataLink另标entrypoint且不当直接FITS |
| input proof | raw page ref/SHA、source revision、capture time、continuation chain、record/page count、原始状态及排除行；实际写值，不填示例size0/假hash |
| URI availability | unknown或HEAD检查时间/HTTP状态/Content-Length；只对实测URI标verified；ETag带类型，不默认MD5/SHA256，未取science body无内容checksum验证 |
| geometry proof | 原生格网定义URL与锁定文档SHA、提供方MOC source hash另存；inventory scope、valid-pixel/channel未知分开 |

Cube无需展开存储786432条O8 edge：建议先保存每文件原生O5分区，用祖先/后代区间相交实现查询；O8映射数只作上限估算。保持实际O5返回，不能把O8子格说成更细科学覆盖。若schema增加native_order应提升版本与build identity，在新候选中重建，禁止原地替换活动SQLite。

spectral-image后续row另带observation/detector、filename processing version、pipeline provenance version、官方polygon/WKB及坐标契约。输入几何的原文必须保留，复杂polygon在现有保守cap路径仍为estimated，不把四角或球冠结果标为精确有效像素coverage。

## 已有能力、缺口与复用矩阵

| 能力 | 当前已有 | 缺失/下一步 | 可复用代码 | 新实现 |
| --- | --- | --- | --- | --- |
| 官方覆盖MOC | IRSA DR1 Cube有MOC，SDK已验证 | 全天O0与当前O4 gate冲突、cube/HiPS与科学有效覆盖语义需明确 | moc-build worker、decodeNativeMoc、审核发布器 | 若决定发布全天产品，单独policy/契约变更和回归；本次未改 |
| 真实Cube库存 | S3 ListObjectsV2与SIA样例已验证 | 未全量翻页/对账，12288不是本次实数 | staged manifest / SHA evidence | 小规模metadata collector、continuation与唯一性校验 |
| O5 NESTED反查 | 数学分区明确；已有Gaia O8专用分区路径 | 当前O8/adapter硬编码 | SQLite builder/readonly worker、range交集思路 | 显式nativeOrder5的DR1 adapter及manifest/binding |
| 真实URI | 样本IRSA/AWS HEAD200；SIA提供cloud_access | 其他URI未逐一验证、库存版本策略待定 | existing URI/member hydration、source evidence字段 | 原始listing→真实对象映射、availability状态；不遍历科学内容 |
| 受管生命周期 | import/build/verify/review/archive/CAS/site-pending已有 | 新adapter统计、完整性gap及product可选性需接线 | NativeUnitController/worker/archive/task fencing | DR1 source/binding及验证样例，通常不需新controller |
| 全库spectral images | TAP实际artifact join可得URI/poly | 全量大小、release过滤、stable分页、EWKB规范化未验证 | collector骨架、managed native polygon索引 | 独立image adapter/采集器，不能复用QR2固定观测正则 |
| 私有比较 | Workspace保存extent和公开MOC | 主图/overlap只用点，需要独立产品任务 | 已有artifact projectionRanges、public footprintRanges | 下一阶段分角色接线与文件extent关联，不属于DR1导入前置 |
| 云计算 | 现环境可跑全部有界验证 | 无已证必要的GCP任务 | 本地Assets工具链 | 不创建资源；大image inventory量测后再决策 |

## 采集与成本预算

| 任务 | 规模依据 | 建议执行位置/资源 | 本阶段GCP费用与限制 |
| --- | --- | --- | --- |
| Cube真实库存 | 官方12288格为目标；当前仅5对象样本，预计约13页1000keys，数MB元数据 | 现环境1进程串行/有限并发、断点保存token与raw XML | $0新GCP资源；不要读取任何Cube正文 |
| SQLite候选与分区查询 | 目标约12288对象×每条约1–4KiB，规范化row约12–48MiB；SQLite含索引保守预算128MiB（估算，待dry-run） | 现环境1–2CPU/1–2GiB即可先试，临时盘256MiB预算；实际managed group共享旧库存，总量另计 | 本地已有资源；不将历史1.6GB大native库成本算为新增Cube本体 |
| 官方MOC标准化 | 已验证原件8640B；O8全天projection786432格若物化会显著大于原件 | 本地SDK；优先native表示和按需projection，正式发布受policy阻塞 | 无需云；不为投影主动制造高阶证据 |
| 全库spectral images | 尚未量测rows/bytes/耗时，不用Cube规模外推 | 下一阶段先有界pilot；记录行率、字节率、内存，再估算 | 现在不创建Cloud Run Job/Spot VM；若pilot证明必要，再按地区当日报价和输入字节计算 |

128MiB/256MiB及1–2GiB是工程预算假设，不是已建索引的测量，也不是云商承诺。若Cube collector网络原始响应体累计超过10MiB（不含规范化row和SQLite）、出现未知prefix/重复版本、分页不稳定或有科学GET/Range，先停止该候选并保留错误证据，重新评估；不自动扩大任务。GCP约$300试用额度与Gemini/Vertex无关，本方案不使用它们，也不以烧完额度为收益目标。

如后续全影像任务确需云端，费用公式应分别计vCPU秒、GiB秒、对象存储GiB月、请求量及跨云出口；IRSA/AWS→GCP传输还需确认源端政策和可能成本。当前没有足够规模证据报精确美元数，不能虚构Cloud Run/Spot成本。Cube方案本地费用结论明确为**新增GCP $0、无需Warehouse**。

## 下一阶段测试与验收清单（当前未实施）

1. **Collector**：离线XML/VOTable/EWKB fixtures；跟随ContinuationToken、缺页/重复页/截断/HTTP重试/畸形路径/版本混用拒绝；无科学GET或Range的网络断言；保存原始response SHA。
2. **库存**：全prefix走到IsTruncated=false；校验唯一真实keys、order5/ipix范围、版本scope、对象计数/排除计数。与官方12288定义对账，有缺口如实保留；不因key命名整齐而填补不存在对象。
3. **空间**：O4父区、O5自身、O8后代与不相交格的精确分区查询；RA0/poles位置→ipix独立对照；返回nativeOrder5；多产品/版本/双URI不丢失。不用SIA四角近似当精确曲边。
4. **SHA/管理**：manifest/row/raw page大小和SHA损坏拒绝、相同snapshot幂等、独立SQLite candidate、review失效、全部依赖归档、恢复后查询一致、激活CAS陈旧基线拒绝、site-pending。产品必须真实可选，跨版本cursor冻结旧查询。
5. **MOC策略**：保留本次官方O0 fixture作为回归；若下一阶段决定支持合法全天，明确分开“canonical order/partition order/科学精度”，覆盖allsky、低精度局部、空覆盖、不足阶假细分等负例；不单纯移除最低阶gate。
6. **实际验收**：用户授权后才运行正式采集/import。先交付reviewable候选报告，分别列query exhausted、inventory complete、geometry precision、URI availability；只读抽查官方URI HEAD，科学body仍0。受管发布/激活完成后另验真实Key、大区域完整分页/导出/版本身份，单测不代替此项。

交付候选报告至少含：scope/source/version、总rows/unique keys、exclusions/gaps、全部输入/SQLite SHA、资源/时长实测、HTTP字节、URI抽样覆盖、MOC policy状态、rollback/restore依据和site验证状态。下一阶段是否实施由用户确认；本次PR不启动collector全量作业或任何生产写入。
