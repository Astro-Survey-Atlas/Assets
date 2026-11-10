# 前端中文字体分片

站点和管理页的 `Atlas Sans CJK`（Noto Sans SC，Regular 400 / Bold 700）不再整体下载，
而是按 `unicode-range` 分片，浏览器只请求页面实际用到字符所在的分片。

- 完整字体（各约 11–12 MB）仅作为生成输入，存放在 `fonts-src/`，**不在** `site/public`，
  不会被服务或打入镜像。原文件在 git 历史中仍可找到。
- 每个字重的分片互不相交，并集等于原字体 cmap：`latin`（U+0000–024F，保持拉丁字形与原来一致）、
  `core`（站点源码实际用到的字符，清单 `fonts-src/site-used-chars.txt`）、`rare-NN`（其余字符）。
- 产物：`site/public/fonts/cjk/*.woff2`（文件名含 SHA-256 前 8 位）、`fonts-src/cjk-slices.json`、
  `site/src/cjk-font-faces.css`（由前台和管理页样式 `@import`）。均为生成文件，不要手改。
- 服务端对 `/fonts/cjk/NotoSansSC-*.<slice>.<hash>.woff2` 返回 `public, max-age=31536000, immutable`；
  其他路径缓存策略不变。CSP 不变（同源）。

## 重新生成

需要带 `fonttools` 与 `brotli` 的 Python（例如 `/tmp/fv` 下的 venv）：

```
/tmp/fv/bin/python -I scripts/slice_cjk_font.py            # 复用 site-used-chars.txt
/tmp/fv/bin/python -I scripts/slice_cjk_font.py --rescan   # 重新扫描 site/ 源码中的字符
/tmp/fv/bin/python -I scripts/validate_cjk_font_slices.py  # 证明并集=原 cmap、unicode-range=真实 cmap
```

新增文案出现 `core` 之外的汉字时仍可显示（落入 `rare-NN` 分片，按需下载）；
需要减少首屏请求时再 `--rescan`。canvas 文字不会触发 @font-face 加载，也不会在分片到达后重绘。
