# SDSS DR9 零候选对照（2026-09-21）

任务 `sdss-moc-discovery-20260921031030`，产品 `ea03d5d1f33933e0106c`。
Warehouse 返回 SUCCEEDED、candidateCount=0；没有记录传输失败。
输入为 surveyName=`sdss`、releaseHint=`sdss-dr09`、productHint=`DR9 color imaging`。

DiscoveryPlanBuilder 要求 obs_collection 包含 surveyName，再将两个 hint 原样匹配
obs_collection/obs_title/obs_id/ID。内部 `sdss-dr09` 与 CDS 的 `SDSS-DR9`、`SDSSDR9`
不是同一子串；完整产品名称也未必出现在目录字段。两项 hint 之间为 OR，不是 AND。

只读请求 `https://alasky.cds.unistra.fr/MocServer/query`，原条件重放返回空数组。
对照使用 SDSS 与 DR9（各自匹配 obs_collection/obs_title/ID），MAXREC=20，得到相关条目：

- `CDS/V/139/sdss9`：The SDSS Photometric Catalog, Release 9；提供 MOC 与 HiPS Catalog URL。
- `sdss.jhu/services/siapdr9-images`：Sloan Digital Sky Survey DR9 - Images；当前选取字段无 MOC URL。
- `noirlab.edu/datalab/siav1/sdss_dr9`：SDSS DR9 sky-subtracted images；当前选取字段无 MOC URL。
- 其他条目包括类星体等子目录，不能作为整个 DR9 彩色影像覆盖。

对照检索是来源线索，未选择候选、下载校验 MOC、构建、审核或发布；不能证明已找到
DR9 color imaging 对应的原生 MOC。MAXREC=20 结果不是穷尽列表。
原始只读响应暂存 `/dev/shm/sdss-discovery-{original,dr9}.json`，不作为公共资源包。

下一步需要受控别名匹配和显式联网增强。增强流程见
[moc-discovery-enhancement-design.md](moc-discovery-enhancement-design.md)。
当前未配置或启用模型/联网搜索供应商；不得把普通文本模型回答当成已检索到的事实。
