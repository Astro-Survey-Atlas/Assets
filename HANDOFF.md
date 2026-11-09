# Assets 当前交接

更新：2026-11-09。本文件只记录当前状态、待办和验证边界；文档入口见
[docs/README.md](docs/README.md)。已提交的部署时间线和旧实施计划从 Git 查询，
不要把历史的“当前”“仅 Dev”“未提交”当作今天的操作指令。

## 当前维护范围与代码

- **仅维护 72602 prod**：<https://astro.assets.72602.space/>。
  自 2026-11-08 起，zjlab dev 不再跟进（当时停在 0.0.4 / Helm rev 390）。
- 已正式发布并部署 **0.0.9 / Helm rev 14**：悬浮卡/DR 对齐与文档清理。
  `code-v0.0.9` 对应提交 `b34333492e2d2069202c6f8bbe35bc793f6f381c`；
  [Release CI #42563933995](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42563933995)
  成功，[GitHub Release](https://github.com/Astro-Survey-Atlas/Assets/releases/tag/code-v0.0.9)
  已发布。代码在 `release/code-v0.0.9`，尚未合入 `main`；tag 不移动。
- 升级后 site/backend 各 1/1 Ready、零重启，`/healthz` 为 0.0.9，公共目录 API 通过。
  public bundle 保持 `reviewed-mupsxe2v-c91be91f` / 603 files /
  SHA `0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`；
  native index 保持 `803023a36a8d489d951717214b92d0df4c3d4b7b36607a3634843bb0621d29d5`
  / generation 4 / managed、verified。未发布数据或激活索引。
- 镜像摘要已核对：运行时 `sha256:dea4175a2158d05ca1c0b070575d519a880dd1ff705f268bb4457dfcccccdc97`
  是镜像索引；其中唯一 amd64 子镜像为发布回执的
  `sha256:2af2d099633878a5434ebac5a7ed1ad1e586e2642f29508b3caea17b306f1b87`，不是版本错配。
- 生产域名 Chromium 交互验收**未通过/未完成**：API/字体请求停滞，页面未 ready；
  独立 HTTP 请求正常，原因未定，不能归因为已确认的本机问题。
  经精确授权尝试 SSH 转发，但本地 5199 被既有 Python 进程占用，隧道启动失败；
  未停止占用进程或另开端口，不把本地 fixture 回归算作生产交互验收。
- 升级前基线为 **0.0.8 / Helm rev 13**；复用既有 values，保留存储、凭据与恢复配置。
  升级前后 values/manifest/workloads/health/status 与验证回执保存在
  `~/.local/share/astro-assets-deployments/72602/20261109-release-0.0.9/`（不入 Git）。
  发布说明见 [code-v0.0.9](docs/releases/code-v0.0.9.md)。
- sky-globe 已拆到独立仓库 `~/Repo/sky-globe`；Assets 使用
  `@astro-survey-atlas/sky-globe` 的 **v0.1.1 codeload tag**，不再有本地 `packages/sky-globe`。
  修改共享组件先在该仓库检查/发 tag，再显式升级 Assets 与 Workspace 的依赖。
- 原生索引、public bundle 与代码镜像独立发布。当前活动数据版本应从运行时状态与
  受管任务核验，不沿用历史 Dev 的 generation、数量或 SHA 作为 prod 当前值。

## 本次 0.0.9 UI 工作：悬浮卡与 DR 对齐

2026-11-09 已完成并随 0.0.9 部署；生产 HTTP/运行状态通过，生产交互验收仍未完成。涉及 `site/src/main.ts`、
`site/src/styles.css`、`scripts/homepage-carousel-smoke.py` 及本交接。

- 悬浮卡离开巡天行/卡片 **2 秒**后关闭，移回或保留区域内键盘焦点可取消关闭。
  快速切换清除旧计时器，同一行重复进入不重建；勾选产品主动刷新卡片内容。
- 卡片可接收鼠标并滚动。阅读期间暂停图层列表 10 秒自动收起，结束后恢复剩余时间。
  重建、搜索隐藏、HUD 隐藏、roster 折叠、重置和窄屏/定位失效立即清理。
- 详情改为「DR 标识｜产品名称」两列，下一行显示真实原生最高阶与可用阶数；
  长名称换行，错误重试保留。悬浮/persistent 共享结构；不改实际 DR 勾选列表或筛选语义。
- 验证通过：站点 TypeScript、定位单测 2/2、`npm run test:homepage`
  （站点构建、原有首页/Atlas 回归及新增定时/焦点/布局专项）、`git diff --check`。
- 本地预览 <http://127.0.0.1:5180/atlas/> 已用 Chromium 操作 Euclid ERO/Q1 VIS frame
  产品并检查两列布局、卡片停留，page errors 为零。它使用既有
  `/tmp/asa-mock/vite.hud.config.mjs`，**不作为生产验收**。临时截图
  `/tmp/assets-hover-alignment-real-two-dr.png` 不保证长期保留。

## 待办与尚未核验

1. **生产交互验收与分支整合**：线上 0.0.9 已确认，但浏览器初始化停滞待定位，悬浮卡生产交互尚未验收；
   发布分支尚未合入 main。另须重测真实大重合区域解锁、续页、限流冷却、滚动与阶数切换动画。
   0.0.6 时未复现用户完整场景，不能因后续代码修复便默认验收完成。
2. **管理台流程重构（低优先级）**：当前六步导航与四个任务面板，未来收敛为
   「来源与发现 → 生成 → 审核与发布」。以
   [近期冗余审计](docs/audit-redundancy-and-admin-flow-20261108.md) 为线索，逐项对照代码；
   不削弱候选审核、全部依赖归档或激活 HTTP 验证。
3. **版本同步缺口已修**：0.0.9 已统一 package、lockfile 顶层/根包、Chart、默认 tag 和 health；
   后续发版继续检查这五个文件，避免 lockfile 根包再次落后。
4. **更广业务验收**：冷/热启动、geometry/native 查询、多 component 完整分页与
   JSON/CSV 一致性、中文字体冷缓存；不能将已有局部 smoke 扩写为全局完成。
5. **数据补全与实际产品审核**：UI 就绪不等于业务审核完成；以当前候选/缺口报告为准，
   补足来源后逐产品复核模态。IPHAS QC、ZTF 冻结 DR7 清单等旧缺口见
   [残余来源复查](docs/research/phase2-residual-native-surveys-followup-20261007.md)。
6. **历史存储治理（暂缓/待重新定范围）**：引用感知留存、独立备份、容量报警及硬配额
   尚无全量完成记录。[Dev 存储快照](docs/storage-plan-dev-20261007.md) 仅供历史依据，
   不授权继续部署 Dev 或把旧配额/用量直接用于 prod。进行中任务和共享依赖仍需保护。
7. Warehouse/PVC inventory 接口、历史证据迁移和真实写入型发布 E2E 的旧未完成项，
   开工前重新核验状态。旧管理台计划不是现行操作依据。统一 SQLite、自助购买/计费暂缓。
   旧资源包 audit 假定 collection 存在，repair 工具未核验单写者兼容性，见
   [集成指南](docs/resource-package-integration.md)。
8. Workspace 曾有一份维护前已失败的覆盖制品，属于下游仓库自身跟进；Assets 不保存私有正文。

巡天简介/背景图仅为可选想法，未实现，不作为当前必做项。

## 发版与验证约定

- 代码版本同步五个文件：`package.json`、`package-lock.json`（含根包字段）、
  `Chart.yaml` 的 version/appVersion、`values.yaml` 的默认 tag、`server/server.ts` health 版本。
- 部署使用实际 prod release 已有 values 和显式覆盖；先核对 site/backend 独立镜像配置，
  不照抄旧 Dev 命令。发布/推送/部署仍需相应明确授权，本交接不代替授权。
- 修改 release-manifest 收录的文档会改变 hash：在已 hydrate 工作区运行
  `npm run catalog:build` 并验证，不能声称与旧 bundle 字节相同；本地重建不等于发布。
- 本轮文档清理保留上一轮 UI 记录和未完成事项，删除重复交接时间线、旧管理/S3 实施计划
  及两张无引用旧图片；来源研究、审计收据、许可证、README 截图和 v3 设计基线保留。
  经用户目录级确认，已删除 `.tmp-screens/cur/` 的 17 张 ignored 旧截图（5.21 MiB）。
- 文档清理验证：77 份 Markdown 的本地文件链接零缺失，`git diff --check`、
  `npm run catalog:build`、`npm run artifacts:validate`（160 产品/80 Core 层）及站点构建通过。
  仅重建本地制品元数据，不发布或激活。
- 0.0.9 发版前复验：`npm run validate`（Node 512 通过/2 跳过，Core wheel 通过）、
  Python 71/71、站点 TypeScript、首页/Atlas Chromium 回归、两套示例 Helm lint 和 diff check 均通过。

## 不可突破的边界

先读 [AGENTS.md](AGENTS.md)、[coverage workflow](docs/coverage-workflow.md)、
[原生单元管理](docs/native-unit-management.md)、[存储](docs/public-artifact-storage.md)
及 [发布运行架构](docs/publication-runtime-split.md)。

- 下载计划是 JSON/CSV 来源清单，Assets 不代下载科学数据。无链接仍保留来源身份。
- 只连接配置的 Warehouse ES；输入清单、扫描正文和任务快照属于 evidence，不进浏览器初始请求。
- CSST 私有内容仅属 Workspace，禁止按历史快照恢复到 Assets。
- 保留 ICRS/NESTED、真实 order 与 exact/estimated/entrypoint-only/truncated；分页耗尽不等于库存完整。
- 原生索引使用受管候选，审核后归档全部依赖，再 CAS 激活并通过 runtime/site HTTP；不原地覆盖活动索引。
- v3 HUD 基线 `.tmp-screens/mockup/atlas-v3-{dark,light}.png` 与原型暂保留；不随旧回归截图删除。
