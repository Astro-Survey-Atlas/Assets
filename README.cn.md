# Astro Survey Atlas

Astro Survey Atlas 是面向公开天文巡天的数据基础设施，用来回答“天空哪里有
覆盖、对应的官方数据从哪里获取”。`Assets` 仓库是面向公众的入口：发布经过
审阅的巡天元数据、ICRS/NESTED HEALPix 覆盖、重合结果、provenance 和版本化
Resource Package v3。

本仓库属于 [Astro Survey Atlas 组织](https://github.com/Astro-Survey-Atlas)：

| 项目 | 职责 | 入口 |
| --- | --- | --- |
| [Assets](https://github.com/Astro-Survey-Atlas/Assets) | 公共巡天目录、覆盖天球、MOC、重合查询和发布制品 | [在线目录](https://astro.assets.dev.72602.space:32443/surveys/) |
| [Warehouse](https://github.com/Astro-Survey-Atlas/Warehouse) | Scanner、ScanPlan/ScanRequest 执行、当前文件/覆盖索引和 evidence | [Warehouse README](https://github.com/Astro-Survey-Atlas/Warehouse) |
| [Workspace](https://github.com/Astro-Survey-Atlas/Workspace) | 用户资产、Connector、本地工作流、用户 MOC 和私有探索 | [Workspace README](https://github.com/Astro-Survey-Atlas/Workspace) |

## 三个项目如何协作

```mermaid
flowchart TB
  U[研究者和数据用户] --> A[Assets\n公共目录与天球 UI]
  A -->|公共 coverage task\nScanPlan v2| W[Warehouse\n扫描与当前状态]
  W -->|ACTIVE ast_*\n文件/覆盖 evidence| A
  A -->|Resource Package v3\nMOC 与 provenance| X[Workspace\n用户数据工作区]
  X -->|可选用户 ScanRequest\nnamespace-local| W
  X -->|本地资产、MOC、\n工作流和历史| X
```

边界是刻意设计的。Assets 决定哪些结果进入公共发布并负责面向用户的展示；
Warehouse 枚举本地/S3/OSS 数据源，提取文件级空间信息并报告 `ast_*` 当前
索引状态；Workspace 在自己的数据面保存用户数据和任务历史，可以消费经过校验
的公共包，也可以选择 Warehouse 执行用户扫描，但不会把用户记录写回 Assets。

```mermaid
flowchart LR
  S[源 inventory 快照] --> F[筛选与元数据读取]
  F --> I[ICRS 校验]
  I --> H[NESTED HEALPix 像元]
  H --> M[MOC、preview、query blocks]
  M --> P[Manifest + SHA-256]
  P --> R[公共 Resource Package v3]
  P -. 仅审计 .-> E[对象存储 evidence]
```

Assets 不会把 preview 当成更高精度的测量。每个响应都会返回实际 order，并标记
`exact`、`estimated`、`entrypoint-only` 或 `truncated`。在线反查有明确上限，
只读取配置的 Warehouse endpoint（`ASSETS_WAREHOUSE_ES_URL`）。

## Assets 发布什么

- `GET /api/v1/surveys` 和 `GET /api/v1/products`：已审阅的元数据和产品 dossier。
- `GET /api/v1/coverage/catalog` 及不可变 coverage blocks：天球 UI 数据。
- `POST /api/v1/coverage/overlap` 和 `/overlap/details`：公共 order 重合与连通区域。
- `POST /api/v1/coverage/reverse-lookup`：有界的文件、tile 和下载入口反查。
- Resource Package v3：MOC、公共 footprint 投影、provenance 和包说明。

[覆盖工作流](docs/coverage-workflow.md)、[API 参考](docs/api-reference.md) 和
[Resource Package 集成指南](docs/resource-package-integration.md) 定义稳定契约。
[MOC Core 契约](docs/moc-core-contract.md) 记录现有的离线
`astro-survey-moc-core` 实现；当前组织没有承诺一个通用在线 SDK。

## 公共发布与 evidence 存储

Git 保存小型、可审阅的发布元数据：survey/layer registry、recipe lock、schema、
catalog 投影、provenance 摘要和 hash。版本化 MOC、资源包和大型 evidence 计划放入
对象存储发布桶。当前仓库仍保留迁移设计阶段的工作制品，本轮不会删除任何 artifact。

详见[公共制品存储与迁移](docs/public-artifact-storage.md)，其中定义 bucket 目录、
不可变 URL/hash 契约、evidence 边界和切换流程。输入 manifest、normalized scan 等
始终属于 evidence，不会进入浏览器初始请求或公共 release allowlist。

发布同步任务现在包含 filesystem fallback，也提供可选的 S3-compatible 发布适配器。
只有在配置 endpoint、bucket 和 credential Secret 后才启用；在明确批准对象存储切换
之前，线上服务仍从经过校验的 PVC bundle 读取。配置说明见[存储契约](docs/public-artifact-storage.md)。

## 本地开发

```bash
npm ci
npm run validate
npm start
```

服务监听 `http://127.0.0.1:4180`。测试 Warehouse 反查时设置
`ASSETS_WAREHOUSE_ES_URL`；没有该变量时，静态公共几何目录仍可使用。

网站提供独立入口：[项目总览](/github/)、[巡天目录](/surveys/) 和
[集成/SDK 状态](/sdk/)。

English version: [README.md](README.md)。

## 许可证

本仓库采用 Apache License, Version 2.0。详见 [LICENSE](LICENSE) 和
[NOTICE](NOTICE)。本项目属于 Astro Survey Atlas GitHub 组织，不是 Apache
Software Foundation 项目。
