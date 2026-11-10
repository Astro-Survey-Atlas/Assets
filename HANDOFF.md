# Assets 当前交接

更新：2026-11-10（0.0.12 部署后）。本文件只记录当前状态、待办和验证边界；文档入口见
[docs/README.md](docs/README.md)。已提交的部署时间线和旧实施计划从 Git 查询，
不要把历史的“当前”“仅 Dev”“未提交”当作今天的操作指令。

## 当前维护范围与代码

- **仅维护 72602 prod**：<https://astro.assets.72602.space/>。
  自 2026-11-08 起，zjlab dev 不再跟进（当时停在 0.0.4 / Helm rev 390）。
- 已正式发布并部署 **0.0.9 / Helm rev 14**：悬浮卡/DR 对齐与文档清理。
  `code-v0.0.9` 对应提交 `b34333492e2d2069202c6f8bbe35bc793f6f381c`；
  [Release CI #42563933995](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42563933995)
  成功，[GitHub Release](https://github.com/Astro-Survey-Atlas/Assets/releases/tag/code-v0.0.9)
  已发布。`release/code-v0.0.9` 已于 2026-11-09 快进合入 `main`；tag 不移动。
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
- **当前 prod 为 0.0.12 / Helm rev 17**（2026-11-10），在 0.0.10 之上新增矩形区域反查、区域面板对齐 HUD、
  区域/证据列表中英文切换、覆盖数据 IndexedDB 持久缓存与 HUD 刻度尺性能改动。路径：0.0.10(rev 15) → 0.0.11(rev 16) → 0.0.12(rev 17)。
  tag `code-v0.0.12` / 提交 `2b5d74b0353beb48f4f32f654c8ac5113dd99baa`；
  [发布 CI #42782118645](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42782118645) 成功，镜像摘要
  `sha256:e99a6523dd8d765cfe8f66942d1e78a1e18309b8da26f0a85c73ed676a555e66`。
  site/backend 均 1/1 Ready、零重启，health 0.0.12、目录 API 200；public bundle `reviewed-mupsxe2v-c91be91f`/603 files 与
  原生索引保持不变（未发布数据或激活索引）。预演 16 个资源不增不减，差异仅 chart 标签与应用/init 镜像 tag。
  回执 `~/.local/share/astro-assets-deployments/72602/20261110-release-0.0.1{1,2}/`（不入 Git）。
  发布说明：[0.0.11](docs/releases/code-v0.0.11.md)、[0.0.12](docs/releases/code-v0.0.12.md)。
  **0.0.11 部署后发现并在 0.0.12 修复**：矩形反查遇到原生阶数低于区域阶数的图层（prod 的
  `desi-dr1-redrock-bright-file-index`，O6）整体失败 `Unsupported projection order`；已改为在图层自身阶数求交，
  线上 16 图层请求、O8/O10/O12 与“图层内子单元匹配/图层外不匹配”均已复测。本地历史 release 不含该图层，当时未能复现。
  生产域名 Chromium：**中文字体约 11–12 MB ×2，在该链路约 330 KB/s，下完需约 35 秒**，使 `load` 迟迟不触发——这是此前
  “页面未 ready / API 与字体请求停滞”的已证实原因（`curl` 实测）。拦截字体后 Atlas 12–16 秒 ready、零 page error；
  这不等于完整生产交互验收（真实 Key、大区域完整分页、限流冷却、滚动动画仍待测）。
- 上一代：0.0.10 / rev 15（2026-11-09，Target Lock 滚动与抽屉区域拾取）：tag `code-v0.0.10` / 提交
  `d3bbcf7c3703710c6bebcb5e477013bcc2b1d2f0`，[CI #42591871648](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42591871648)；
  回执 `~/.local/share/astro-assets-deployments/72602/20261109-release-0.0.10/`，见 [发布说明](docs/releases/code-v0.0.10.md)。
  发布分支尚未合入各自 main；不移动已发 tag。
- sky-globe 已拆到独立仓库 `~/Repo/sky-globe`；Assets 使用
  `@astro-survey-atlas/sky-globe` 的 **v0.1.3 codeload tag**（区域拾取与矩形框选均 opt-in），不再有本地 `packages/sky-globe`。
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

## 0.0.10 Target Lock 与抽屉修复（已部署）

2026-11-09 用户反馈 0.0.9 仍回顶且无新请求，随后确认本地滚动修复有效，并要求修复抽屉区域交互、立即部署 prod。
代码由 `release/code-v0.0.10` 正式发布，生产已升级至 0.0.10 / rev 15；本地验收不扩大为生产全流程验收。

- 确认旧修复 `405ee87` 读写了不滚动的 `#coverage-detail-content.scrollTop`；实际滚动者是
  `.coverage-inspector-rail`。真实预览曾记录外层 550px、内层 0px，本地重绘后外层归零。
- O6+ 视野刷新可全部命中 overlap/display/evidence 缓存，却仍清空重建详情；中途布局读取
  会夹取已缩短 rail 的滚动范围。“无新增请求”不能排除本地重绘。面板顶栏/留白此前还允许
  pointer 命中背后 canvas；但纯正文滚动/拖动在本机静止场景未复现回顶，未取得用户现场完整触发链。
- 本地修复：按完整目标/内容身份保留未变化 DOM，仍同步 viewer 高亮；变化时离线构造后一次替换，
  同步恢复真实 rail，移除滞后 rAF。缓存证据同步渲染，不先换 skeleton；保留中断/失败查询的恢复入口。
  rail 接收指针事件，标题/留白不再穿透天球；目标 order/cells 变化不按相同 C01 误判为同目标。
- 新增浏览器负对照：旧代码在无 API 请求的缓存刷新中 `180 → [0, 0, 0]`；修复后逐帧保留，
  并测同目标重选、实际语言变化、非空缓存证据、卡片命中区域和确实执行的 O6 零请求视野刷新。
  抽屉中断侧栏查询后关闭，也已验证从缓存恢复非空列表、无遗留 skeleton。
- 验证通过：`npm run test:homepage`（含站点构建与完整首页/Atlas 回归）、站点 TypeScript、
  定位/阶数策略单测 5/5、`npm run catalog:build`、`npm run artifacts:validate`（160 产品/80 Core 层）、
  `git diff --check`。不把本地回归当作 prod 或认证大区域分页/导出验收。
- 抽屉打开时只拾取整个连通区域，本体/标签点击同步抽屉，不再触发单元详情；区域提示按实际区域来源显示 DR 和模态。
  关闭抽屉恢复单元查看。独立 sky-globe `v0.1.2` 已推送，类型与 27/27 单测通过；Assets 固定远端 tag，不留 file 依赖。
- Chromium 完整回归通过；真实公开数据预览操作 Euclid × DESI / C04 / O6 / 47 cells，page errors 为零。
  当前独立缓存预览 <http://127.0.0.1:5181/atlas/>；旧 5180 依赖缓存未刷新，终止该进程被拦截，未绕过。
  两者均不是 prod 验收通道。

## 2026-11-10 矩形区域反查（已随 0.0.11/0.0.12 部署）

- 设计：「天球框选/坐标精修 → 自适应多阶 HEALPix 保守覆盖 → 单/多巡天分别反查」，不是逐来源 footprint 严格矩形裁边。内部粗、边界细；边缘可能有额外候选；预算不足保留父单元而非裁掉区域。
- 入口：Atlas 工具栏与 `E`；四个 ICRS 度数输入、O8/O10/O12 目标边界；沿用当前产品/DR/模态选择。reverse-lookup 兼容旧 cells selector，新增 rectangle 与显式多阶 region selector，响应 schema 2，完整区域保持单 root snapshot/cursor，`matchingRegions` 避免不同阶 ipix 混合。输出 cover/面积超额/边界未决与预算状态，和来源精度分开。预览与解锁完整分页清单明确区分，JSON/CSV 保留多阶/来源/状态信息。
- **图层阶数低于区域阶数**：在图层自身真实阶数求交（请求只向上折叠、从不细化），匹配结果仍保持请求阶数（`layerCellsInRequest`）。曾因两处重复实现直接用请求阶数查图层 MOC 而在 prod 失败，0.0.12 修复；回归测试 `test/reverse-lookup-coarse-layer.test.ts`（O6 图层 + O8 区域，旧代码为红）。
- 面板：与图层面板/抽屉同一套 HUD 语言（`site/src/atlas/hud-atlas.css` 末尾“Region manifest panel”）；动态文案全部走 `i18n.ts` 词条（`region.*`、`ev.*`，带 `{var}` 的用 `tf()`），语言切换时重绘；失败时面板顶部显示失败原因而非停在 “Querying…”。
- 证据列表（`renderEvidencePlan`）与右侧抽屉共用；约 40 处原写死中文已改为词条。
- **覆盖数据持久缓存**：`site/src/atlas/block-store.ts`，IndexedDB `asa-coverage-cache`，覆盖块与瓦片索引按 `revision|displayRevision` 为 key，不设过期，目录出现新版本时才清理旧版本；不可用时静默降级。前端不再对带 revision 的块请求用 `no-store`；服务端对带 `displayRevision` 的瓦片索引下发 `immutable`。验证：禁用 HTTP 缓存后二次访问网络块请求为 0；prod 上已写入。
- **HUD 刻度尺**（`atlas/hud-overlay.ts`）：节点池复用、`transform` 定位、尺寸由 `ResizeObserver` 缓存。
- **未解决：转动天球卡顿的主要来源在共享仓库 sky-globe**：`#coverageViewRadiusRad` 每次相机变化只为取画布宽度调一次 `getBoundingClientRect`（约 340ms/60 步，CDP profile）。可用 `ResizeObserver` 缓存宽度；需在 `~/Repo/sky-globe` 修改并发新 tag，再升级 Assets 与 Workspace。无头软件渲染无法复现真实显卡帧率。
- 背面图层“等一会才出现”是 `includeFarSide` 的设计行为；改为预取是产品决策，尚未做。
- sky-globe **v0.1.3** 已发布（含框选 API，提交 `155d93a`，另有同步锁文件版本的 `0605b2a`，tag 不移动）；Assets 固定该远端 tag，已用干净安装（真实 tarball，非本地链接）完成类型/构建/浏览器回归/Node 测试。
- 验证（0.0.12）：Node 531 项（529 通过 / 2 跳过 / 0 失败）、站点与服务端类型检查、首页/Atlas Chromium 回归。认证浏览器用例使用 synthetic fixture，不算真实 Key 验收。

### 仓库与发布分支说明

- 发布线：`release/code-v0.0.11`（远端，含 0.0.11 与 0.0.12，tag `code-v0.0.11`/`code-v0.0.12`）。它从远端 `release/code-v0.0.10` 起，只带入框选功能提交与本轮改动；**未合并 main**。
- 本机 `release/code-v0.0.10` 与 `modelscope-copy` 混有 ModelScope 镜像提交与 `*.gz` 的 Git LFS 规则，**只作备份，不要推到 GitHub**。本机无 `git-lfs`，所以 `pre-push` 钩子会中止推送；发布时对单次推送使用 `--no-verify`（已确认发布分支内受 LFS 过滤的文件为 0）。
- `vendor/moc-core/*.tar.gz` 与 `artifacts/…/moc-core/*.tar.gz` 在本机会显示为“已修改”，是 LFS 过滤造成的假差异（磁盘内容正确），**不要加入提交**。

### 本功能后的优先步骤

1. **在 sky-globe 缓存画布宽度**（见上），发新 tag 后升级 Assets/Workspace，再复测转动。
2. **中文字体体积**：两个 NotoSansSC woff2 共约 23 MB，是 prod 页面慢的已证实原因；考虑子集化/按需分片/`font-display`，需单独设计。
3. **验收边界**：仍缺真实 Key、大区域完整分页、限流冷却及受管最新库存的端到端验收；不替换活动索引，不把来源清单当科学文件下载。
4. 临时本地预览 `http://127.0.0.1:5183/atlas/`（后端 4192）会话结束后可能停止；恢复方式：后端 `env -i`，环境变量为 `ASSET_RELEASE_ROOT`（历史 Assets PVC 的 `current`）、`ASSETS_PRODUCT_CATALOG_ROOT`、`ASSETS_CONTENT_ROOT`/`ASSETS_EVIDENCE_ROOT`/`ASSETS_UPLOAD_SPOOL_ROOT`（`/tmp/assets-rectangle-backend-4192/*`）、`ASSETS_SOURCE_UNIT_EVIDENCE_ROOT`，入口 `dist/server/server.js`（先 `npm run build:server`）；前端 `./node_modules/.bin/vite --config /tmp/assets-region-vite-5183.config.mjs`。注意变量名是 `ASSET_RELEASE_ROOT`（单数），写成 `ASSETS_RELEASE_ROOT` 会被忽略并回退到仓库根目录。该预览用历史五产品 release，不是 prod 目录。

## 待办与尚未核验

1. **生产交互验收**：线上 0.0.12 的 HTTP/运行状态已确认，生产浏览器完整交互仍须单独核验（拦截中文字体后的 Atlas 已通过，见上）；
   另须重测真实大重合区域解锁、续页、限流冷却、滚动与阶数切换动画。
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
