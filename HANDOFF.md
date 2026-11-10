# Assets 当前交接

更新：2026-11-10。本文件只记录当前状态、待办和验证边界；文档入口见
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
- **当前 prod 已升级为 0.0.10 / Helm rev 15**（2026-11-09），包含 Target Lock 滚动和抽屉区域拾取修复。
  tag `code-v0.0.10` / 提交 `d3bbcf7c3703710c6bebcb5e477013bcc2b1d2f0`；
  [正式发布 CI #42591871648](https://github.com/Astro-Survey-Atlas/Assets/actions/runs/42591871648) 成功。
  site/backend 均 1/1 Ready、零重启，health 0.0.10、公共目录 HTTP 通过；bundle/原生索引与上述基线完全一致。
  生产预演 16 个资源不增不减，15 处差异仅 chart 标签和应用/init 镜像；存储、服务、Secret、配置未变。
  生产域名 Chromium 限时 30 秒仍未 ready（无 page errors），交互验收未完成；独立 HTTP 正常，不继续阻塞部署收尾。
  回执 `~/.local/share/astro-assets-deployments/72602/20261109-release-0.0.10/`，见 [发布说明](docs/releases/code-v0.0.10.md)。
  Assets 发布分支与 sky-globe 功能分支尚未合入各自 main；不移动已发 tag。
- sky-globe 已拆到独立仓库 `~/Repo/sky-globe`；Assets 使用
  `@astro-survey-atlas/sky-globe` 的 **v0.1.2 codeload tag**（区域拾取 opt-in），不再有本地 `packages/sky-globe`。
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

## 2026-11-10 矩形区域反查（本地实现，未发布）

- 用户确认第一版采用「天球框选/坐标精修 → 自适应多阶 HEALPix 保守覆盖 → 单/多巡天分别反查」，不是逐来源 footprint 严格矩形裁边。内部粗、边界细；边缘可能有额外候选，预算不足保留父单元而非裁掉区域。
- 新增 Atlas 工具入口、四个 ICRS 度数输入和 O8/O10/O12 目标边界选项；沿用当前产品/DR/模态选择，不要求重合。修复普通 `E` 缺少 `evidenceLookup` 的断链，无选区打开框选；普通点击仍不查文件。
- reverse-lookup 兼容旧 cells selector，新增 rectangle 和显式多阶 region selector。新响应 schema2，完整区域按真实阶数分批但保持单 root snapshot/cursor；`matchingRegions` 避免不同阶 ipix 混合。输出 cover/面积超额/边界未决角尺度与预算状态，和来源精度分开。
- survey-native 新增按 unit ID 的完整区域成员补齐，防止跨批同单元 URI 丢失；通用聚合 URI 和批次扫描佐证仍保留候选/成员未核实、batch scope，不宣称完整库存。JSON/CSV 保留相同多阶/来源/状态信息，预览与解锁完整分页清单明确区分。
- **按用户要求仅在原分支本地提交，不合并 main**：Assets 功能提交留在 `release/code-v0.0.10`（见该分支最新 `feat(atlas): add adaptive rectangle region manifests` 提交）；共享 `~/Repo/sky-globe` 在 `feat/overlap-component-picking`，提交 `e7ea2b5286fef49d3559850be3443fd126775461`。共享 viewer 新增默认关闭的 rectangle drawing API、真实经纬边界轮廓和 draft/commit/cancel。交接确认后两个仓库工作树应 clean；本地 ignored 依赖链接不计入 Git。
- **依赖尚未正式交付**：Assets package/lock 仍固定远端 v0.1.2；当前 ignored `node_modules/@astro-survey-atlas/sky-globe` 临时 symlink 到 `~/Repo/sky-globe` 供本地构建/验收，原安装目录移至 `/tmp/assets-sky-globe-0.1.2-before-region-20261110`。新代码需要新 viewer API，干净安装旧 tag 尚不能构建。必须经单独授权发布新 immutable tag，再显式升级 package/lock；不提交 file 依赖，不把本地链接算可复现交付。本轮仅本地 commit，未 merge main/push/tag/deploy，未升级 Workspace。
- 已通过：前后端/测试 TypeScript、Node 全量 528 通过/2 跳过、sky-globe 类型与 56/56、完整首页/Atlas Chromium 回归（含新框选/导航恢复/单多巡天/输入焦点/E/近似提示/预览与解锁/同快照续页/JSON-CSV/取消与迟到响应）。认证浏览器测试使用 synthetic fixture，不算真实 Key 验收。
- 本地预览 **<http://127.0.0.1:5183/atlas/>** 在 2026-11-10 提交交接时已恢复并检查 frontend/backend HTTP 200；会话结束后临时进程可能停止，接手时先检查端口，不把此记录当永久在线承诺。Vite 配置 `/tmp/assets-region-vite-5183.config.mjs`，代理隔离 legacy backend `4192`。后端使用 env -i，只有 `/tmp/assets-rectangle-backend-4192/{content,evidence,spool}` 为可写业务根；历史 Assets release/evidence PVC 只用于读取已装公开目录/原生索引，无 ES/object store/admin，未冷建或激活索引。
- 此预览使用 **2026-09-18 五产品历史公开 release `reviewed-mu6tefsx-bc07840a`**、imported-baseline managed:false/verified:false，**不是 prod 目录/验收**。真实 HTTP/浏览器 RA150→151、Dec0→1 单巡天返回 DESI Tile；另选 DESI + Legacy 共 22 层返回 Tile 与 brick/成员 URI，schema2 JSON 下载成功，零 page errors/overlap 请求；截图 `/tmp/assets-region-historical-public-preview.png`。当前生产大区域/真实 Key 导出、受管最新 survey-native 库存仍须另验。

### 本功能交接后的优先步骤

1. **先解决可复现依赖**：另获发布授权后，为上述 sky-globe 提交发布新 immutable tag，显式更新 Assets package/lock，再从干净安装执行类型、构建和浏览器回归。当前本地链接能预览，不代表远端 v0.1.2 已支持新 API；不移动旧 tag，不自动升级 Workspace。
2. **验收边界**：已有 fixture 认证/分页/取消与公开历史库存验收；仍缺当前 prod 目录、真实 Key、大区域完整分页、限流冷却及受管新库存的端到端验收。不替换活动索引，不把来源清单当科学文件下载。
3. **维持分支边界**：用户已看到效果并只要求本地提交和交接；没有 main 合并、push、tag 或部署授权。当前生产仍为原 0.0.10，未包含本功能。
4. **临时预览恢复信息**：frontend `./node_modules/.bin/vite --config /tmp/assets-region-vite-5183.config.mjs`；backend 使用 `env -i`、`HOST=127.0.0.1 PORT=4192 ASSETS_ROLE=legacy`，release root 为上述历史 Assets PVC 的 `current`，product catalog 为本仓库，content/evidence/spool 为上述独立 `/tmp` 目录，source-unit evidence root 为历史 Assets evidence PVC。保持 admin 关闭、ES/object-store 未配置，Kube 指向本地不可达端口，不沿用生产凭据或启动 request-time 构建。

## 待办与尚未核验

1. **生产交互验收**：线上 0.0.10 的 HTTP/运行状态已确认，生产浏览器完整交互仍须单独核验；
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
