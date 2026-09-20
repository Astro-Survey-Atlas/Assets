# Assets 项目交接

更新：2026-09-20（Asia/Shanghai）。本文件为当前状态入口；旧版本记录见
[历史交接](docs/handoff-history-through-20260920.md)，不可将旧部署或待办当成现状。

## 当前部署与数据

- dev Helm release/namespace：`astro-survey-atlas-assets`，revision **182**。
- 镜像：`crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:0.1.0-20260920-flow-layout`。
- 网站和 backend 均 1/1 Ready、0 restarts；旧 publisher Deployment 已移除。
- 用户入口：<http://astro.assets.dev.72602.space:32080/>；直连备用：
  <http://10.15.51.75:32083/>。集群内网站 Service 使用端口 80。
- 本次只读核实：5 个公开巡天、9 个公开产品、7 层覆盖、3 个资源包；
  管理端 166 个产品、14 条发布记录，无 queued/building/uploading/verifying 任务。
- 当前 bundle：`reviewed-mu9992i3-7e599e9b`，479 个 manifest 文件；SHA256：
  `6becd38832c1f7550b05138ae84ed02fb52d9724ff86e35a367a4edcbafd1d71`。
  manifest 文件数与受发布边界过滤的公开资产数不同。以上数量为检查时快照，用户继续发布会改变它们。

## 已完成的运行架构

网站 `ASSETS_ROLE=site` 仅读取经验证的公开 release，管理 API 鉴权后代理到
backend；backend 独占业务写入。两者使用独立的 8Gi local-path release cache
PVC，启动核对 S3 authority，运行时同步；站点可使用经过验证的缓存离线启动。
旧 content/evidence/spool/release PVC 均保留，不能随意清理。

发布队列采用 local-path 上的 SQLite WAL/FULL、单 backend 和生命周期 flock。
子进程通过受 fencing 保护的 IPC 上报，父进程独占 authority CAS；租约、心跳、
有限自动重试、取消和重启恢复均已实现。审核选择被冻结；变更版本需重新审核提交。
上传、状态快照、release 同步和站点核验使用独立循环。完整 release.tar.gz 仅供
导出或恢复；单产品发布上传增量对象。网站核验通过才显示发布完成。

这是单写者架构，不支持多 backend 副本并发写入。详细流程、迁移与回滚见
[发布运行架构](docs/publication-runtime-split.md)。

## 已完成的界面与问题修复

- 首页巡天名称后同行显示模态并集图标；第二行显示最高原生精度。
  API 返回及语言切换后均执行局部 Lucide 渲染，不能只在启动时渲染图标。
- `/releases/` 流程始终展开，无折叠控件；已有 MOC 与来源数据扫描是同级卡片。
  MOC 源头链接为 <https://alasky.cds.unistra.fr/MocServer/query>。
- LLM 支路明确标注“规划中，尚未启用”，没有实际模型调用或搜索供应商配置。
- 用户任务 `mu97fn25-02edfb19` 实际首次执行成功；“上传中／失败”源于
  verification.overall 被错误初始化为 failed，revision 180 已改成 pending。
- 已修复历史失败任务覆盖较新已发布产品状态、跨命名空间快照计数覆盖，以及
  schema-3 首次恢复 CLI 动态导入死锁。backend 启动不再自动重打资源包。

## MOC 探索现状与下一步

当前 Warehouse `cds-public-moc-v2` 只调用 CDS 目录 API，按名称和可选 DR/产品
关键词匹配，最多展示 50 条候选，以第 51 条判断截断。不是 LLM，也不是网页爬虫。
发现候选后，人工选择，再由 Assets 下载锁定来源、Core 校验构建、审核和发布。

Roman 最近检查的任务成功执行但返回 0 候选，查询完整名称
`Nancy Grace Roman Space Telescope`；不能据此判断没有公开 MOC。
别名 Roman/WFIRST 的临时外部查询曾 TLS 握手超时，未取得新的结果证据。

[增强设计](docs/moc-discovery-enhancement-design.md) 已完成，尚未实施：受控别名
查询后，由用户显式启动联网 LLM 提取带引用候选；区分观测、计划、模拟与未知，
科学校验和人工审核不变。下一步只有在用户要求实现增强时才进入 Warehouse
接口/供应商配置与实现；当前无需重复改造发布队列。

## 验证基线与操作证据

revision 182 已通过 build、211 项 Node 测试、Core wheel 校验、site TypeScript、
Helm lint 和 diff check。`scripts/public-workflow-browser.py` 验证延迟加载图标、
名称图标同行、语言切换、空/错误目录、显式 CDS 链接、同级来源、无折叠以及
EN/ZH、明暗主题、1440/900/390px 布局。线上实际目录与下载验收通过，
资源包 Range 为 206（32 字节）。本次交接整理只修改文档，未重新部署或重跑全套测试。

- 日志：`/dev/shm/assets-flow-layout-{build,tests,image,push}.log`。
- 截图：`/dev/shm/assets-flow-live-{home,releases}.png`、`/dev/shm/release-flow-*.png`。
- 迁移一致性备份：`/dev/shm/assets-split-migration/`；这些是内存文件系统临时证据，重启会丢失。
  `quiesced-content-spool.tar.gz` SHA256：
  `616b19e5cd2961177ec57b98e826512fc230098cfcfac1c82726aa1f7edc66f4`；
  `quiesced-current.json` SHA256：
  `4efb1b9434d5c9b7abf8121b00e3c20094c8a1405ba9bdfc25c26fd47eb38166`。
- 发生新业务写入后，回滚必须先停止 backend，保留 SQLite/WAL/业务记录和当前
  authority，再使用 `scripts/export-publication-rollback.ts` 导出最新历史；不能恢复旧快照覆盖用户新写入。
- 外部 HTTPS 曾有证书主机名不匹配；内部网站核验使用
  `http://astro-survey-atlas-assets:80`，没有禁用 TLS 验证。

## 工作区与继续工作约束

本次整理前 HEAD 为 `689e2eb`，工作区干净，先前代码及页面修改已被收录；此轮
只新增/更新交接及关联说明，尚未提交。不要沿用历史日志中“代码仍全部未提交”的描述。
临时 4199 浏览器测试服务器已关闭。本轮未提交、推送或修改集群资源。

保留现有修改、历史发布与 PVC。凭据仅使用已有 Secret，不写日志或文档。
运行时仅连接配置的 Warehouse ES；旧 ES 只允许显式的一次性迁移。
input manifest、normalized scan、task snapshot 属于 evidence，不进入浏览器初始
请求；CSST input-manifest 不可加入 Git 公共发布白名单。保留 ICRS/NESTED、真实
原生精度、来源 hash，不从低阶预览伪造高阶覆盖。
