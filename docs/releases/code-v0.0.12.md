# Assets 0.0.12（code）

日期：2026-11-10。此代码版本不发布 public bundle、不激活原生索引，也不下载科学数据。
修复 [0.0.11](code-v0.0.11.md) 部署后在 prod 发现的矩形反查缺陷。部署与验收状态见 [HANDOFF](../../HANDOFF.md)。

## 变更

- **修复矩形/多阶区域反查在同时勾选“原生阶数低于区域阶数”的图层时整体失败**（`Unsupported projection order`）。
  prod 上触发图层为 `desi-dr1-redrock-bright-file-index`（`path-healpix`，原生最大阶数 6）。
  `publicReverseEntrypoints` 与 `buildCoverageReverseLookup` 各有一份相同的相交逻辑，直接用请求阶数查询图层 MOC；
  现抽成共用的 `layerCellsInRequest`：图层比请求网格粗时，在图层自身的真实阶数上求交（请求向上折叠，**从不细化**），
  匹配结果仍保持请求阶数，不制造更细的单元，也不过度匹配。
- 区域查询失败时，面板顶部不再停留在 “Querying…”：元数据行与状态行显示失败原因，并随中英文切换更新。
- 新增回归测试 `reverse-lookup-coarse-layer`：O6 图层 + O8 区域，断言 200、区域内单元匹配且保持 O8、区域外单元不匹配；
  在修复前的代码上该测试为红（HTTP 500，同一报错）。`reviewedFixture` 增加可选 `mocCells`，默认行为不变。

## 验证边界

- Node 531 项（529 通过 / 2 跳过 / 0 失败）、站点与服务端类型检查、首页/Atlas Chromium 回归通过。
- **本地没有该 O6 图层**（本地历史 release 的最低阶数为 4 且均可正常查询），所以本地验收不能证明线上已修复；
  以部署后对 prod 同一请求（含该图层的 16 图层矩形查询）的复测为准。
- 认证浏览器用例使用 synthetic fixture，不算真实 Key 验收；不证明 prod 大区域完整分页/导出。

## 生产部署结果

2026-11-10 已从 0.0.11 / rev 16 升级至 **0.0.12 / Helm revision 17**；site/backend 各 1/1 Ready、零重启，
线上 health 返回 0.0.12、目录 API 200，public bundle `reviewed-mupsxe2v-c91be91f` 与原生索引保持升级前值；未发布数据或激活索引。
[正式 CI #42782118645](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42782118645) 成功；
tag `code-v0.0.12` 对应 `2b5d74b0353beb48f4f32f654c8ac5113dd99baa`，镜像摘要
`sha256:e99a6523dd8d765cfe8f66942d1e78a1e18309b8da26f0a85c73ed676a555e66`。
预演 16 个资源不增不减，差异仅 chart 标签与应用/init 镜像 tag。镜像拉取经一次性 Pod 实测（容器内版本 0.0.12）。
回执 `~/.local/share/astro-assets-deployments/72602/20261110-release-0.0.12/`（不入 Git）。

### 线上复测（缺陷修复确认）

- 此前失败的 `desi-dr1-redrock-bright-file-index` 单图层请求与 16 图层请求（RA150→151 / Dec0→1）均返回 200，
  不再出现 `Unsupported projection order`；`boundaryOrder` 8 / 10 / 12 均正常。
- 该图层（904 个 O6 单元，与目录 `cellCount` 一致）：其 O6 单元的 O8 子单元匹配且 `matchedCells` 保持 O8 网格；
  不在图层内的 O6 单元的 O8 子单元不匹配；混合请求只匹配图层内的子单元（未过度匹配）。
- 线上浏览器（拦截中文字体）：勾选两个巡天共 16 个图层后查询得到 `lookupState: complete` 与真实结果列表。
- 边界：拦截字体不等于完整的生产交互验收；认证大区域完整分页/导出、真实 Key 与限流冷却仍未验证。
