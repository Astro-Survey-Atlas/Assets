# Assets 0.0.11（code）

日期：2026-11-10。此代码版本不发布 public bundle、不激活原生索引，也不下载科学数据。
部署与实际验收状态见 [HANDOFF](../../HANDOFF.md)。

## 变更

- **矩形区域反查**：天球框选/ICRS 坐标精修 → 自适应多阶 HEALPix 保守覆盖 → 单/多巡天分别反查；
  reverse-lookup 新增 rectangle 与显式多阶 region selector（响应 schema 2，完整区域保持单 root snapshot/cursor）。
  边缘可能含额外候选，预算不足时保留父单元而不是裁掉区域；结果标明真实阶数与 exact/estimated/truncated，
  导出仍是 JSON/CSV 来源清单，不是科学数据。
- **区域面板对齐 HUD**：标题条、发光导轨、斜切按钮、聚焦态与抽屉/图层面板一致。
- **中英文切换**：区域面板元数据、按钮、状态行，以及与抽屉共用的证据列表（约 40 处原先写死的中文）
  均改为词条，切换语言时重绘。
- **覆盖数据本地缓存**：解码后的覆盖块与瓦片索引写入浏览器 IndexedDB，key 含 `revision` 与 `displayRevision`，
  不设过期；目录出现新版本时才清理旧版本。前端不再对带 revision 的块请求使用 `no-store`，
  服务端对带 `displayRevision` 的瓦片索引下发 `immutable`。IndexedDB 不可用时静默降级。
- **HUD 刻度尺**：节点池复用、`transform` 定位、尺寸由 `ResizeObserver` 缓存，转动时不再每帧重建与强制重排。
- 共享组件升级为独立仓库 `sky-globe` 的 `v0.1.3`（rectangle 绘制 API，默认关闭，兼容原使用方）。

## 验证边界

- 干净安装（真实 `v0.1.3` tarball，非本地链接）下：站点/服务端类型检查、构建、Node 530 项（528 通过 / 2 跳过 / 0 失败）、
  首页/Atlas Chromium 回归、`catalog:build`、`artifacts:validate`（160 产品 / 80 Core 层）。
- 认证浏览器用例使用 synthetic fixture，不算真实 Key 验收。
- 本地预览使用 2026-09-18 历史公开 release，不是 prod 目录。
- 不证明 prod 大区域完整分页/导出、限流冷却或受管最新库存；转动帧率仅在无头软件渲染下测过。

## 生产部署结果

2026-11-10 已从 0.0.10 / rev 15 升级至 **0.0.11 / Helm revision 16**；site/backend 各 1/1 Ready、零重启，
线上 health 返回 0.0.11、目录 API 与 `/atlas/` 返回 200，public bundle 与原生索引保持升级前值；未发布数据或激活索引。
[正式 CI #42774795985](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42774795985) 成功；
tag `code-v0.0.11` 对应 `77f2e7c8437ffa2697d0bbeb6c807c85adfc9872`，镜像摘要
`sha256:9d30a8ca161e337002cc9ae92f101fcb74b0390656af5c7fe4f8f0537f55dbf6`。
预演 16 个资源不增不减，31 行差异只有 chart 标签与应用/init 镜像 tag。
回执 `~/.local/share/astro-assets-deployments/72602/20261110-release-0.0.11/`（不入 Git）。

## 已知缺陷（部署后发现，已在 [0.0.12](code-v0.0.12.md) 修复并于线上复测）

- **矩形反查在同时勾选 `desi-dr1-redrock-bright-file-index`（原生最大阶数 6）时整体失败**，
  返回 `Unsupported projection order`；单独查其余 15 个图层均正常，不勾该图层则整次查询正常。
  可稳定复现（prod，`rectangle` RA150→151/Dec0→1，boundaryOrder 10）。0.0.10 没有该功能，不是回归，其余功能不受影响。
- 该图层是 `path-healpix` 配方、`sourceUnitIndex.status=exact`、`availableOrders=[4,6]` 的发布 MOC；
  本地历史 release 不含它（maxOrder 4 的图层可正常查询），所以本地验收未发现。
- 抛错点只可能是 `server/native-moc.ts:66`（`projectMoc`）或 `server/display-coverage.ts:48`（`mocPixelRanges`）；
  已排除 `region-access.ts`（已按 `moc.maxOrder` 夹取）、`overlap.ts` 的两处（有 `<= maxOrder` 保护）与 `localSpatialUnits`（吞掉异常）。
- 失败时 UI 显示结果区的"文件反查失败，请重试"，但元数据行仍停在 "Querying…"，这点也应一并改善。

## 生产浏览器验收边界

- 线上 `/atlas/` 的中文字体（NotoSansSC 约 11–12 MB ×2）在该链路上约 35 秒才下完，会让页面 `load` 迟迟不触发；
  这与此前"API/字体请求停滞"现象一致，用 `curl` 测得约 330 KB/s。拦截字体后 Atlas 12–16 秒 ready、零 page error、API 无 ≥400，
  中英文切换与 IndexedDB 缓存（132 块）在线上生效。**拦截字体不等于完整的生产交互验收。**
