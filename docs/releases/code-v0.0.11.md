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
