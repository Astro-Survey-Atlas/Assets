# 文档入口

当前状态与唯一待办入口：[HANDOFF](../HANDOFF.md)。操作边界以
[AGENTS](../AGENTS.md) 和下面的现行契约为准；有日期的研究、发布说明和历史测量
只证明其记录范围，不代表当前部署、完整巡天库存或新的操作授权。

## 现行指南

| 主题 | 文档 |
| --- | --- |
| 覆盖、MOC、阶数、证据与反查 | [coverage-workflow](coverage-workflow.md) |
| HTTP/API Key/分页 | [API 契约](api-reference.md)、[API 管理](api-management-design.md) |
| 原生来源、快照、候选、审核、激活 | [native-unit-management](native-unit-management.md) |
| 产品就绪度与发布门禁 | [admin-product-inventory](admin-product-inventory.md) |
| 对象存储、恢复与单写者运行架构 | [存储](public-artifact-storage.md)、[发布运行架构](publication-runtime-split.md) |
| 跨项目职责与 Warehouse 任务 | [架构边界](architecture-boundary.md)、[Warehouse 要求](data-warehouse-requirements.md)、[批扫描](scan-batches.md) |
| 公开包消费者 | [集成指南](resource-package-integration.md)、[前端指南](frontend-resource-package-guide.md)、[Core 契约](moc-core-contract.md)、[示例](examples/) |
| 前端字体 | [中文字体分片](frontend-fonts.md) |
| 当前数据范围与缺口 | [data-scope](data-scope.md) |
| 探索工作流与可选增强 | [探索契约](deferred-moc-discovery-plan.md)、[增强设计与实现边界](moc-discovery-enhancement-design.md) |

## 研究、审计与历史资料

- [research/](research/)：来源身份、输入哈希、范围、精度、否定证据和来源调查。
  **不是可按日期一刀切的旧计划**；不因完成某次导入就删除其科学依据。
- [数据范围](data-scope.md) 链接重点来源报告；其他报告按巡天名称和日期检索。
- [近期管理台审计](audit-redundancy-and-admin-flow-20261108.md)：下一轮重构线索，
  其中静态结论开工前须与代码核对，不等于所有建议尚未实现。
- [releases/](releases/)：历史发布与实际验收边界，不能推导现网版本。
- [MOC 方法记录](public-footprint-moc-method.md)：历史计算依据，不是旧命令恢复手册。
- [Dev 存储快照](storage-plan-dev-20261007.md)：冻结的历史容量与待治理范围，
  不是继续维护 Dev 或清理 prod 的授权。
- `*-receipt-*.json`、`public-geometry-audit.json` 与 `history/` 下的旧 schema：
  供审计追溯，不作为当前操作指令或现行 schema。

## 文档与图片留存规则

- 只保留一个当前交接，不再叠加整份历史 HANDOFF；已提交的旧计划、事故和部署流水账
  使用 Git history 查阅（例如 `git show ecf6828:HANDOFF.md`）。
- 已完成且由稳定指南取代的施工计划删除，不另建一份大归档；未完成项先迁到 HANDOFF，
  独有门禁迁到对应契约。四巡天 MVP 已于 2026-10-04 结束，其行为契约并入覆盖/API/原生指南。
  历史四巡天 O4 七-cell 场景的 22,772 条验收不代表全巡天库存完整；需要复验时从 Git
  取原始产品选择与分页范围，不能只复用数字。
- `images/home.png` 是中英文 README 使用的用户截图，保留。页面运行素材、logo 与
  许可证不是旧回归截图，不能按“无 Markdown 引用”删除。
- `.tmp-screens/cur/` 是可丢弃的本地旧浏览器截图；v3 mockup 仍是设计基线，不随之删除。
- 修改被 release-manifest 收录的指南后，按 [存储说明](public-artifact-storage.md) 重建
  本地 manifest；文档清理不发布新数据、不改 authority、不下载科学内容。
