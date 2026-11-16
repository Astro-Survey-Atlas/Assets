# Assets 当前交接

更新：2026-11-16。只记录当前状态、待办和验证边界；文档入口见 [docs/README.md](docs/README.md)，
跨仓库职责见 [docs/boundaries.md](docs/boundaries.md)。部署时间线、旧实施计划和历史发布从 Git 与
[docs/releases/](docs/releases/) 查，不要把历史的“当前”当作今天的操作指令。

## 定位

公开巡天的覆盖以**官方 MOC 为准**；Assets 只补充“每个 HEALPix 对应什么数据、链接在哪里”。
数据源（Warehouse 扫描历史）是可选补充证据：文件 RA/DEC → HEALPix → 区域 → 前置路径。没有数据源也必须完整可用。

## 当前状态

- 代码版本 **0.0.13**（`package.json`、lockfile、`Chart.yaml`、`values.yaml` 默认 tag、`server/server.ts` health 五处同步）。
- sky-globe 固定 **v0.1.4**（codeload tag）；修改共享组件先在 `~/Repo/sky-globe` 发 tag，再升级 Assets 与 Workspace。
- 仅维护 72602 prod：<https://astro.assets.72602.space/>。最近一次文档记录的线上版本为 0.0.12 / Helm rev 17，
  之后的提交（SPHEREx、Euclid MOC 等）是否已部署，以 `helm list` 与 `/api/v1/healthz` 为准。
- zjlab dev 自 2026-11-08 起不再维护。GCP 部署尚未开始，见下方待办。
- 当前项目处于开发阶段，没有真实用户；可直接提交，仍需显式 staging，见 [CLAUDE.md](CLAUDE.md)。

## 待办（按优先级）

1. **MOC 自动探查与监控（核心已建，未接调度/管理页）**：
   - 已完成：`server/moc-source-monitor.ts`（纯函数，9 项测试）与 `npm run moc:monitor [-- --state=PATH]`。
     对 registry 每个源取 record+MOC，解码后比对注册基线（`sourceSnapshotSha256`/`sourceRecordSha256`/`maxOrder`）；
     变化只标 `drifted` 并保留已审核基线与候选字节，**不自动构建或发布**；取数失败只记 `failed` 与连续失败次数，
     不当作漂移；连续失败 ≥3 次进入 `alerting`（命令行退出码 2）。
   - **未做**：按周期运行并持久化状态（建议复用 `publication-scheduler.ts` 心跳，状态存内容盘）；管理页“待审核更新”
     与告警横幅；`drifted` → `MocBuildRequest` 的一键生成；用 CDS MocServer 检索新巡天（可复用 `moc-discovery.ts`）。
   - **外部阻塞（2026-11-16 实测）**：CDS MocServer 的 `get=smoc|moc`（任意 fmt/order，GET 与 POST）一律返回 HTTP 413，
     `get=record` 正常；`alasky.unistra.fr`（7 个源）DNS 解析失败；HiPS 原生 `Moc.fits` 路径 404。所以 83 个源里仅 3 个
     IRSA 源（SPHEREx、Euclid×2）能取到，其余 80 个全部显示 `failed`，无法检测漂移。
     已排查并放弃：本地代理 127.0.0.1:7890 对出口 IP 无影响，仍 413；mocpy 官方 `MOC.from_ivorn` 同样返回 502，
     说明是 CDS 服务端当前故障/变更，不是我们的参数或网络。等 CDS 恢复后重跑 `npm run moc:monitor` 即可，无需改代码；
     若长期不恢复，再决定 registry 的 `mocUrl` 是否迁移；registry 的 `get=smoc` 仍与
     2MASS6X 记录的 `moc_type=stmoc` 并存，需逐源核对。
2. **管理台重构（进行中）**：已完成：产品生命周期映射抽到 `site/admin/product-state.ts`（有测试），删掉客户端重算
   revision 的不可达分支，删掉无人读取的 `/catalog/status` 每轮请求。其余待做：`qualificationReadout`/`productSkyStatus`/
   `productPublicationRun` 三套词汇合并，MOC build 四个渲染器合一，native-units 五处重复渲染，重复入口，`main.ts` 拆分。
   目标：一个产品只显示一个生命周期状态（未登记 → 已获取 → 待审核 → 已发布 → 已退役）加正交警告；
   一个 MOC build 一个渲染器；只展示“线上 bundle / 候选 bundle”。线索见
   [冗余审计](docs/audit-redundancy-and-admin-flow-20261108.md)，开工前逐项对照代码。
   巨型文件 `server/server.ts`（约 5400 行）、`server/admin.ts`、`site/admin/main.ts` 需按职责拆分。
3. **内核简化**：合并三条证据摄入路径（官方源 / native-units / 证据；`evidence-moc-import` 与
   `path-healpix-moc-import` 重复）、三套发布状态机（`publication-task-store`、`public-release-publication`、
   native-unit 暂存激活）和三条版本轴（bundle id / native index generation / code tag）。
   补“无 Warehouse（`warehouse.elasticsearchUrl=""`）也能完整发布”的测试。
4. **GCP 部署（阻塞）**：本机无 gcloud、terraform 与 GCP 凭据。推荐 GKE Autopilot；需要项目 ID/计费、域名、
   GCS S3 互操作 HMAC 密钥（兼容性未验证）、`regionAccess` 的 `workspace-api-key`、镜像来源（公开 ghcr.io 即可）。
   部署规则（见记忆）目前只允许 Assets 到 72602，需用户确认放开。
5. **sky-globe 转动卡顿**：`#coverageViewRadiusRad` 每次相机变化调 `getBoundingClientRect`，应用 `ResizeObserver` 缓存；
   在 sky-globe 仓库改，发 tag 后升级 Assets 与 Workspace。
6. **中文字体**：已按 unicode-range 分片（见 CLAUDE.md），冷缓存实测仍待验证。
7. **生产交互验收**：真实 Key、大区域完整分页、限流冷却、滚动与阶数切换动画，生产浏览器端到端仍未验收。
8. **数据补全**：IPHAS QC、ZTF 冻结 DR7 清单等旧缺口见
   [残余来源复查](docs/research/phase2-residual-native-surveys-followup-20261007.md)。
9. 暂缓：历史存储治理（[Dev 存储快照](docs/storage-plan-dev-20261007.md) 仅供参考）、统一 SQLite、自助计费。

## 上游已完成（2026-11-16）

MOC-Core-SDK 已能读取 mocpy/CDS 的 RANGE 排序与 MOCVERS 1.x/缺省的标准 MOC，并带 `PIXTYPE=HEALPIX` 输出；
healpy 生成的 1344 条 HEALPix 参考向量（`fixtures/conformance/healpix-v2.json`）已被 SDK 与 Warehouse 测试消费，
两个实现对 order 0–12 均一致（边界平局点接受相邻单元）。Assets 使用的 SDK wheel 仍是 1.2.0，升级前核对
`docs/moc-core-contract.md`。

**上游尚未处理**（记录在案，不阻塞 Assets 主线）：
- Warehouse `fits-header-position` 不看 CTYPE/RADESYS，银道坐标会当赤道坐标；
- Warehouse 不支持 `.fz` 压缩 FITS；一行坏数据（NaN、RA=360.0）使整个星表文件失败；
- Warehouse `fits-wcs` 按约一个单元宽度网格采样，边缘/角上的单元可能漏；锥形查询环采样可能漏内部单元，
  大半径锥形会超 ES `terms` 上限；`catalog-healpix` 不检查 NESTED；反查要求阶数完全相等；
- MOC-Core 多边形方向（大于半球或含极点）、凹多边形、锥形/多边形边界保守程度未验证；
  precision 词表与 fixture 不一致（`entrypoint-only`/`truncated`）；
- Workspace 仍用 MOC-Core 1.0.0 与 sky-globe 0.1.1（带源码补丁），需对齐；本地扫描需消费同一份参考向量。

## 发版与验证约定

- 代码版本同步五个文件：`package.json`、`package-lock.json`（含根包字段）、`Chart.yaml` 的 version/appVersion、
  `values.yaml` 默认 tag、`server/server.ts` health 版本。
- 部署流程见 [CLAUDE.md](CLAUDE.md)。使用实际 prod release 已有 values；生产升级由用户在终端执行。
- 修改被 release-manifest 收录的文档会改变 hash：在已 hydrate 的工作区运行 `npm run catalog:build` 并验证；本地重建不等于发布。
  **本机现状（2026-11-16 核对）**：`release-manifest.json`（bundle `public-survey-footprints-2026-09-27`）485 个文件中 481 个哈希一致，
  不一致的 4 个是已入库的控制文档（`survey-catalog.json`、`public-build-plan.json`、`source-registry.json`、`layer-registry.json`），
  因 SPHEREx/Euclid 提交改过它们而 manifest 未重建；因此服务启动报 `Public asset SHA-256 mismatch`，
  `test/server-http.test.ts` 等 7 项集成测试在干净基线上同样失败。`catalog:build` 另报缺
  `layers/spherex-dr1-allsky-cube-moc/provenance.json`：新增图层的 gitignored 产物没生成。
  用户已手工替换 `packages/public-{euclid,spherex}-footprints-3.1.0.zip`，SDK `validate_resource_package` 校验通过，
  但它们是否与仓库图层产物一致尚未核对。修复方式（舍弃或重新生成）见待办，**未执行**。
- 本机无 git-lfs：`vendor/moc-core/*.tar.gz` 与 `artifacts/…/moc-core/*.tar.gz` 显示为已修改是假差异，不要提交；
  推送必要时 `--no-verify`。

## 不可突破的边界

先读 [AGENTS.md](AGENTS.md)、[pipeline](docs/pipeline.md)、[boundaries](docs/boundaries.md)、[coverage workflow](docs/coverage-workflow.md)、
[原生单元管理](docs/native-unit-management.md)、[存储](docs/public-artifact-storage.md)、
[发布运行架构](docs/publication-runtime-split.md)。

- 下载计划是 JSON/CSV 来源清单，Assets 不代下载科学数据。无链接仍保留来源身份。
- 只连接配置的 Warehouse ES；输入清单、扫描正文和任务快照属于 evidence，不进浏览器初始请求。
- CSST 私有内容仅属 Workspace，禁止恢复到 Assets。
- 保留 ICRS/NESTED、真实 order 与 exact/estimated/entrypoint-only/truncated；分页耗尽不等于库存完整。
- 原生索引使用受管候选，审核后归档全部依赖，再 CAS 激活并通过 runtime/site HTTP；不原地覆盖活动索引。
- v3 HUD 基线 `.tmp-screens/mockup/atlas-v3-{dark,light}.png` 保留。
