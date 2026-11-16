# 跨仓库边界与“正确”的定义

本文件是 Assets、MOC-Core-SDK、Warehouse、Workspace、sky-globe 的职责边界。与
[架构边界](architecture-boundary.md) 冲突时以本文件的“禁止”清单为准，并同步修正后者。

## 总原则：以 IVOA 标准和主流工具为“正确”

仓库内部自洽不等于正确。MOC 与 HEALPix 以外部标准和参考实现为准：

- 读取必须接受 IVOA MOC 1.0/1.1/2.0 的 FITS（NUNIQ 与 RANGE 排序、有无 `MOCVERS`），含 CDS MocServer 与 mocpy 的输出；
  写出的 FITS MOC 必须能被 `mocpy.MOC.from_fits` 读回且单元集合一致。
- ICRS + NESTED 的 ang2pix 与 healpy / astropy-healpix 逐点一致；单元边界上的浮点平局接受相邻单元。
- 已验证：MOC-Core-SDK `fixtures/conformance/healpix-v2.json`（healpy 生成，1344 条）被 SDK 与 Warehouse 测试共用；
  `python-tests/test_interop.py` 覆盖 mocpy 读写往返。
- 新增计算逻辑必须带来自外部库的已知答案，不能只对照自己生成的 golden 文件。

## 职责

| 仓库 | 只负责 | 禁止 |
| --- | --- | --- |
| MOC-Core-SDK | 全生态唯一的 MOC/HEALPix 计算与 Resource Package v3 契约，conformance 向量 | 引入产品、发布、部署逻辑 |
| Warehouse | 扫描文件 → 文件级天区覆盖证据，写 `ast_*` 索引；不存科学数据 | 理解巡天、产品、发布；决定官方覆盖 |
| Assets | 官方 MOC 的发布与公开 API；补充“HEALPix → 数据链接/前置路径”的证据 | 修改官方覆盖形状；依赖 Workspace；保存私有数据；自行实现 HEALPix 数学 |
| Workspace | 用户私有资产；消费 Assets 公开资源包；可选择不装 Warehouse，用自带本地扫描和 `astro_*` ES 索引 | 依赖 Assets 内部端点；把私有数据送入 Assets |
| sky-globe | 共享天球组件与 HUD 主题 | 带业务逻辑 |

要点：

1. **官方 MOC 是覆盖权威**。证据只补充链接，不改形状。官方 MOC 路径不经过 Warehouse 的算法。
2. **没有 Warehouse、没有数据源，Assets 也必须完整可发布**（`warehouse.elasticsearchUrl=""`）。
3. **Workspace 双 ES 是有意设计**：用户资源有限时可不装 Warehouse，所以 Workspace 自带扫描管线。
   代价是两套实现必须共用同一份 MOC-Core 参考向量，防止结果漂移。
4. **版本契约**：Assets、Workspace 同步升级 MOC-Core wheel 与 sky-globe；偏差在 HANDOFF 记录并尽快消除。
   当前 MOC-Core-SDK 为 1.2.0（之后有未发版的互操作改动），Assets 使用 wheel 1.2.0，sky-globe v0.1.4；
   Workspace 仍为 MOC-Core 1.0.0、sky-globe 0.1.1。

## 数据路径（Assets）

官方 MOC（`scripts/acquire-*`、CDS 收割）→ `artifacts/public-survey-footprints/*` →
MOC-Core 投影与打包 → `release-manifest.json`（文件级 SHA-256）→ bundle（`reviewed-<ts>-<hash>`）→
`server/public-release-publication.ts` 单写者发布（候选隔离 → CAS 切换 → 站点校验）→
`/api/v1/resource-packages/*`、`/api/v1/coverage/*`。每个 HEALPix 的数据链接：Warehouse 扫描证据或路径规则 →
`evidence-store.ts` / `path-healpix-moc-import.ts` → 覆盖块与 reverse-lookup。
