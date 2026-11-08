# 冗余审计与管理台流程报告

日期：2026-11-08。只出报告，不改代码。

---

## 一、管理台流程结构

当前六步：`overview | sources | tasks | review | releases | api`
（`site/admin/navigation.ts:1`）。

tasks 页内四面板：`outputs | discovery | scans | native`
（`site/admin/task-tabs.ts:4`）。

---

## 二、管理台内部冗余

### 2.1 Native-units 同一份数据渲染进 5 个步骤

`site/admin/native-units.ts:169–182` 的 `render()` 函数在一次调用里依次写入：
`native-overview`、`native-sources`、`native-tasks`、`native-review`、`native-releases`。
每次轮询都把相同的 `NativeView` 序列化 5 次、注入 5 个不同容器，
没有按步骤按需读取的路径。

### 2.2 Tasks 面板重复：outputs 面板调用与 scans 面板重叠

`site/admin/main.ts:1466` 的 `renderWorkOutputs` 是 outputs 面板的主渲染函数，
同时被 `renderTasks`（`:1141`）和 `renderMocDiscovery`（`:1148` 附近）内部调用，
因此 scans 和 discovery 数据变化时都会触发 outputs 的完整重渲，
三个面板共用同一个渲染路径。

### 2.3 同一条 MOC build 记录有 4 个独立渲染器

| 函数 | 行号 | 用途 |
|---|---|---|
| `mocBuildStatusText` | `main.ts:1645` | 产品列表行状态文字 |
| `mocBuildReadout` | `main.ts:1409` | 详情弹窗 lifecycle 区块 |
| `workBuildRowMarkup` | `main.ts:1447` | outputs 面板卡片行 |
| `renderMocBuildDetails` | `main.ts:1417` | 详情弹窗完整内容 |

四处各自解析 `MocBuildRequest`，字段取法和阶数格式不完全一致。

### 2.4 产品弹窗里 preflight 出现两遍

`main.ts:2015`：preflight 项目被内联在 `facts.innerHTML` 的大模板字符串中一并注入。
`main.ts:2041–2052`：`preflight.innerHTML` 随即被单独覆写一次（含独立的 native order gate、gap 列表、checkbox）。
第一次注入实际上立即被第二次覆盖，第一次写入无效。

### 2.5 一个产品行并存 4 套状态词汇

| 函数 | 行号 | 词汇集 |
|---|---|---|
| `reviewProductState` | `main.ts:1659` | `retired / unregistered / reviewed / published / pending` |
| `qualificationReadout` | `main.ts:1723` | `ready / confirm-limitations / blocked / stale / unregistered / unmatched / error / loading` |
| `productPublicationRun` | `main.ts:1766` | 按 `failed` + revision 比较 |
| `productSkyStatus` | `main.ts:804` | `已退休 / 已公开 / 未公开 / 已审核待发布 / 待审核` |

四套词汇来自不同数据源，无共同类型；同一产品可在同一屏出现状态不一致的文案。

### 2.6 重复入口

- **发布入口 3 个**：overview 页快捷操作、review 步骤产品弹窗、releases 步骤。
- **建扫描任务入口 3 个**：sources 步骤、tasks/scans 面板、产品弹窗 readiness action。
- **登记 build 入口 3 个**：tasks/outputs 卡片（`main.ts:1406`）、tasks/discovery 面板、build 详情弹窗。

各入口触发相同后端接口，无流程区分，用户不清楚应走哪条路。

### 2.7 `/catalog/status` 每轮拉取但无人读取

`site/admin/workspaces.ts:7` 定义了 `catalogStatus: "/api/v1/admin/catalog/status"` 资源，
`workspaces.ts:16` 将其挂入 `review` 步骤的资源列表，因此每次进入 review 步骤都会发出请求。
全局搜索 `main.ts` 中 `catalogStatus`、`catalog/status` 均无命中——响应结果从未被读取或渲染。

### 2.8 客户端重算服务端结论 6 处，含一条不可达分支

`main.ts:1659–1668` 的 `reviewProductState` 在客户端重新推断 review 状态，
与服务端 `/api/v1/admin/products?view=surveys` 返回的 `review.state` 字段平行存在。
第 1663 行的分支（`state === "published" && draftRevision !== undefined && publishedRevision !== draftRevision`）
隐含了一个"已发布但草稿版本落后"的中间态，而服务端已将此情况归一化为 `reviewed` 或 `pending`，
客户端该分支在正常数据下不可达。其余 5 处重算散布在 `reviewEligibilityState`、
`qualificationReadout`、`renderReviewSurveys` 等函数内。

### 2.9 `/overview` 内部重复调用 `/products?view=surveys` 的处理器

`server/server.ts:2118–2183` 的 `adminOverview` 函数在构造 overview 响应时调用了
`adminProductSurveys(records, adminSurveyIndex())`，这与独立 `/products?view=surveys`
端点的处理器共享同一数据路径。客户端在 overview 步骤和 review 步骤分别独立请求这两个端点，
服务端因此对同一批产品数据执行了两次相同的聚合逻辑。

---

## 三、跨文件冗余工具函数

### 3.1 `sha256Json` 包装 — 5 份

定义或内联于：
`server/upload-spool.ts`、`server/state-snapshot.ts`、
`server/public-release-publication.ts`、`server/resource-package-publication.ts`、
`server/moc-build.ts`。
均为"读文件 → SHA-256 → 返回 hex"的小包装，签名与行为一致。

### 3.2 `writeJsonAtomic` — 3 份

`server/upload-spool.ts`、`server/state-snapshot.ts`、
`server/resource-package-publication.ts` 各自实现了"写临时文件 → rename"模式。

### 3.3 Pretty-JSON 构造 — server 目录约 33 处

`grep 'JSON\.stringify.*null.*2'` 在 server/ 下命中 33 行，
均为内联 `JSON.stringify(value, null, 2)`，无共用格式化函数。

### 3.4 天空面积常数 `41252.96124941927` — 至少 2 处（server 内）

`server/server.ts:229`、`server/server.ts:587` 均硬编码同一天空面积，
HANDOFF 记录全库共 9 处。

### 3.5 CDS host 白名单 — 4 份

`server/package-access-policy.ts:33` 是完整的 host 匹配块；
其他 3 份散布在 `server/native-unit-model.ts`、`server/moc-build.ts`、
`server/products.ts`（经搜索确认 CDS 相关逻辑在这 4 个文件中出现）。

### 3.6 `if (!response.ok) throw` 内联 — 13 处（site/admin/main.ts 内）

`site/admin/main.ts` 单文件内有 13 处内联 fetch 错误检查，
每处独立拼接错误文本，无共用 `checkOk` 函数。

### 3.7 `escapeHtml` / `escapeText` — 3 个文件

`site/src/dom.ts`、`site/src/main.ts`、`site/admin/main.ts` 各自定义了
功能相同的 HTML 转义函数（HANDOFF 记录全库 5 份）。

### 3.8 模态词表重复且不对称

`site/admin/main.ts:599` 的 `modalityLabel` 保留 `photometry` 为独立词条（→「测光」）。
`server/admin.ts:1247` 在审核资格归一化时将 `photometry` 并入 `image`。
两侧对同一 modality 的归一化决策相反；`photometry` 的产品在天球目录里显示为成像，
在管理台文案里仍显示为测光。

---

## 四、死代码

| 符号 | 位置 | 说明 |
|---|---|---|
| `verifyUploadedReleaseArchive` | `server/public-release-publication.ts:541` | exported 但全库无调用方，约 50 行 |
| `readinessAggregateMarkup` | `site/admin/main.ts:784` | 定义后从未调用 |
| `runtimeLayerChip` | `site/admin/main.ts:794` | 定义后从未调用 |
| `locale()` | `site/src/i18n.ts:950` | 对 `getLocale()` 的单行别名；调用方均可直接调 `getLocale()` |

---

## 五、测试缺口

- `site/admin/main.ts`（约 2,860 行，含完整管理台渲染、事件绑定、状态机）**零单测**。
  状态推断（`reviewProductState`、`qualificationReadout` 等）全靠浏览器集成测试覆盖。
- `scripts/admin-browser-smoke.py` 只断言「页面能渲染且无 JS 错误」，
  不验证数据正确性（如 preflight 条目计数、状态词汇一致性、catalogStatus 是否被消费）。

---

## 六、优先级评估（供后续立项参考，本报告不改代码）

高影响、改动集中：

1. **删除 `catalogStatus` 请求**（`workspaces.ts:16`）——零渲染风险，立刻减少每轮一次无效网络请求。
2. **`preflight` 双写（2.4）**——第一次写入无效，去掉 `facts.innerHTML` 中的内联部分即可。
3. **合并 `sha256Json` / `writeJsonAtomic`**——提取到 `server/util.ts`，替换 5/3 处引用。
4. **`modality` 两侧对齐（3.8）**——确定 `photometry` 归入 `image` 还是保持独立，双侧同步。

中等规模：

5. **`if (!response.ok)` 提取为 `checkOk`**——13 处替换，消灭重复错误文案。
6. **native-units 按需渲染**——`render()` 拆分为各步骤独立函数，减少不在当前步骤的无效 DOM 操作。
7. **`escapeHtml` / `escapeText` 统一出处**——移入 `site/src/dom.ts`，其余 import。

较大重构（需单独立项）：

8. **管理台三段收敛**（HANDOFF 待办第 4 项）——涉及 `main.ts` 全文与后端任务状态机，见 HANDOFF.md。
9. **客户端状态推断去重**——统一 `reviewProductState` 与服务端 `review.state`，消除不可达分支。
