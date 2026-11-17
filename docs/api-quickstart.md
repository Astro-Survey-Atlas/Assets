# API 快速开始：覆盖反查

面向购买或获得 API Key 的调用方。完整契约见 [API 契约](api-reference.md)，
Key 的签发与额度规则见 [API 管理](api-management-design.md)。

## 1. 你拿到的是什么

一个以 `asa_live_` 开头的 Key，只授权 `region:query` 一个权限：

- `POST /api/v1/coverage/reverse-lookup` 的完整来源反查（含分页）；
- `POST /api/v1/access/region-query` 的区域查询；
- 网页图集里的“继续浏览”和下载计划导出（在 `/atlas/` 解锁一次即可）。

Key 不能管理、审核、发布或签发 Key。Assets 只返回已有的匹配和来源链接，
**不代下载科学数据**。

匿名也能用的部分不需要 Key：公开目录、资源包列表与下载，以及
`"preview": true` 的反查预览（最多 6 条入口，不能翻页）。

## 2. 额度怎么算

| 规则 | 说明 |
| --- | --- |
| 总次数 | 次数包的 Key 有总调用额度。**每个通过鉴权的请求计 1 次**：网页解锁、每一页反查、每次区域查询各算 1 次。翻页也计次。 |
| 不计次 | 被拒绝的请求不计：Key 无效或过期（401）、权限不符（403）、触发每分钟限流（429）。 |
| 额度用完 | 返回 `403`，消息“API Key 调用额度已用完”。额度不会自动恢复。 |
| 每分钟限额 | 每个 Key 1–30 次/分钟（购买时确定）。超出返回 `429`，带 `Retry-After`（最多 60 秒），等待后重试即可，**不消耗额度**。 |
| 有效期 | 到期后返回 `401`。 |

目前没有“查询剩余次数”的接口；剩余额度请向发卡方（pay.72602.space 的商品页或联系邮箱）确认。

状态码速查：`200` 成功 · `400` 请求格式错误 · `401` Key 无效/撤销/过期 · `403` 权限不符或额度用完 ·
`409` 覆盖版本在翻页中途变化，请从头再查 · `410` 查询快照已过期（1 小时） · `429` 超过每分钟限额。

## 3. 请求头

```http
X-Assets-API-Key: asa_live_xxxxxxxx
Content-Type: application/json
```

不要把 Key 放进 URL 查询参数，也不要写进前端公开代码。

## 4. 先找到图层 ID

```bash
curl -s https://astro.assets.72602.space/api/v1/coverage/catalog \
  | python3 -c "import sys,json; [print(l['layerId'], l['surveyId'], l['availableOrders']) for l in json.load(sys.stdin)['layers']]"
```

`layerId` 是下面所有请求的 `layerIds`。同一个巡天的不同 DR、波段是独立图层，不会被合并。

## 5. 按矩形反查（最常用）

RA/Dec 是 ICRS 角度。`raStart > raEnd` 表示跨过 0°；`0 → 360` 表示全 RA。

```bash
curl -s https://astro.assets.72602.space/api/v1/coverage/reverse-lookup \
  -H "X-Assets-API-Key: $ASA_KEY" -H "Content-Type: application/json" \
  -d '{
    "layerIds": ["desi-dr1-spectra-footprint"],
    "rectangle": {"raStart": 150, "raEnd": 151, "decMin": 2, "decMax": 3},
    "boundaryOrder": 10,
    "pageSize": 50
  }'
```

```python
import os, requests

BASE = "https://astro.assets.72602.space/api/v1"
HEADERS = {"X-Assets-API-Key": os.environ["ASA_KEY"], "Content-Type": "application/json"}

body = {
    "layerIds": ["desi-dr1-spectra-footprint"],
    "rectangle": {"raStart": 150, "raEnd": 151, "decMin": 2, "decMax": 3},
    "boundaryOrder": 10,
    "pageSize": 50,
}

pages = []
while True:
    r = requests.post(f"{BASE}/coverage/reverse-lookup", json=body, headers=HEADERS, timeout=60)
    if r.status_code == 429:                      # 限流：不耗额度，等一等再试
        import time; time.sleep(int(r.headers.get("Retry-After", "5"))); continue
    r.raise_for_status()
    data = r.json()
    pages.append(data)
    cursor = data.get("page", {}).get("nextCursor")
    if not cursor:
        break
    # 续页必须带同一个选择器、签名游标和快照 ID；每一页计 1 次
    body["cursor"] = cursor
    body["querySnapshotId"] = data["querySnapshot"]["id"]

print(len(pages), "pages")
```

```js
const BASE = "https://astro.assets.72602.space/api/v1";
const headers = { "X-Assets-API-Key": process.env.ASA_KEY, "Content-Type": "application/json" };

let body = {
  layerIds: ["desi-dr1-spectra-footprint"],
  rectangle: { raStart: 150, raEnd: 151, decMin: 2, decMax: 3 },
  boundaryOrder: 10,
  pageSize: 50,
};
const pages = [];
for (;;) {
  const r = await fetch(`${BASE}/coverage/reverse-lookup`, { method: "POST", headers, body: JSON.stringify(body) });
  if (r.status === 429) { await new Promise(t => setTimeout(t, 1000 * Number(r.headers.get("Retry-After") ?? 5))); continue; }
  if (!r.ok) throw new Error(`${r.status} ${(await r.json()).error}`);
  const data = await r.json();
  pages.push(data);
  if (!data.page?.nextCursor) break;
  body = { ...body, cursor: data.page.nextCursor, querySnapshotId: data.querySnapshot.id };
}
console.log(pages.length, "pages");
```

## 6. 按 HEALPix 单元反查

已知 NESTED 单元时（`order` 必须是图层真实支持的阶数，不会被升级到更高阶）：

```bash
curl -s https://astro.assets.72602.space/api/v1/coverage/reverse-lookup \
  -H "X-Assets-API-Key: $ASA_KEY" -H "Content-Type: application/json" \
  -d '{"layerIds":["desi-dr1-spectra-footprint"],"order":8,"cells":[48640,48641],"limit":500}'
```

也可以提交混阶区域：
`"region": {"coordinateFrame":"ICRS","ordering":"NESTED","cells":[{"order":4,"ipix":190}]}`
（1–4096 个 O4–O12 单元；`rectangle`、`region`、`order/cells` 三种选择器互斥）。

## 7. 响应怎么读

- `sources[]`：每个图层的覆盖信息与来源摘要。
- 命中的巡天/Tile/文件身份、匹配依据、**来源链接**；文件链接指向来源站点，请自行访问。
- `querySnapshot`：`id`、`expiresAt`（1 小时）、`queryExhausted`。`queryExhausted: true` 才表示所选区域的批次已查完。
- `truncated: true` 表示结果不完整（触达预算上限，或这是只返回前 6 条的匿名预览，预览里恒为 `true`）。请缩小区域或继续翻页。
- 不带 Key 的完整反查返回 `401`（“Unlock downloads or provide a service API key”）；只有 `"preview": true` 可匿名使用。
- `inventoryComplete` 始终为 `false`：Assets 不声称拥有某巡天的完整文件库存。

## 8. 常见问题

- **为什么没有科学数据文件？** Assets 只提供“哪个位置对应哪个文件、链接在哪”，不托管也不代下载。
- **为什么 O8 的请求在某些图层上拿不到结果？** 图层只有 O4 精度时不会被伪造成 O8。先看目录里的 `availableOrders`。
- **翻页到一半报 409/410？** 覆盖版本变化或快照过期，从头再查一次。
- **能同时查多个巡天吗？** 可以，`layerIds` 最多 64 个；超过 100 平方度的区域会自动拆成批，按快照翻页。
