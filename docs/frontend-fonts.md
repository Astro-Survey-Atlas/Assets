# 前端中文字体分片

站点和管理页的 `Atlas Sans CJK`（Noto Sans SC，Regular 400 / Bold 700）不再整体下载，
而是按 `unicode-range` 分片，浏览器只请求页面实际用到字符所在的分片。

- 完整字体（各约 11–12 MB）已从当前工作树移除，不进入站点产物或运行镜像。
  **没有改写 Git 历史**：普通完整克隆仍会传输/保留历史字体 blob，不能声称此次删除减少普通克隆传输量。
  浅克隆通常不含该旧提交，必须先取得含原始 blob 的历史后才能按下文恢复；仅有当前快照无法重建原字体。
- `fonts-src/` 现在只保存小型元数据 `cjk-slices.json` 和 `site-used-chars.txt`，不保存完整字体。
- 每个字重的 45 个分片互不相交，并集等于原字体 cmap：`latin`（U+0000–024F，保持拉丁字形与原来一致）、
  `core`（站点源码实际用到的字符）、`rare-NN`（其余字符）。共 90 片；本次校验修复不重新生成它们。
- 产物：`site/public/fonts/cjk/*.woff2`（文件名含 SHA-256 前 8 位）、
  `site/src/cjk-font-faces.css`（由前台和管理页样式 `@import`）。均为生成文件，不要手改。
- 服务端对 `/fonts/cjk/NotoSansSC-*.<slice>.<hash>.woff2` 返回 `public, max-age=31536000, immutable`；
  其他路径缓存策略不变。CSP 不变（同源）。

## 独立原始基准

原始字节来自历史提交 `21230c1` 的 `fonts-src/NotoSansSC-{Regular,Bold}.woff2`，不是此前的
`site/public/fonts/` 路径，也不是从第三方下载 URL 推测的等价字体。

| 字重 | 原始字节数 | 原始 SHA-256 | cmap 码点数 |
| --- | ---: | --- | ---: |
| Regular | 11,424,252 | `99a017fe6ec47dd7bcf6cbb695084189b5180451c38340a01d94ad347bc9185d` | 44,810 |
| Bold | 12,116,992 | `d1225aeb609ebdd34ec016dac28e92e988854efeb2a0ecb467b59f70f914603f` | 44,810 |

两个原始 cmap 的完整集合 SHA-256 均为
`78956b472c10f6e58e31c58886bebd1806fc21f43e56353b20cbb30070bca3d6`。
算法 `sorted-6hex-lf-v1`：将唯一 Unicode 码点升序排列，每个编码为六位大写十六进制与一个 LF，
拼接为 ASCII 字节再计算 SHA-256。该指纹直接从原字体计算，不从分片或 CSS 推导。
元数据还保存源提交完整 ID、每片完整 SHA-256、字节数、码点数及范围。

## 安装校验工具

在仓库根目录操作；虚拟环境和原始字体放在仓库之外。依赖固定在 `requirements/fonts.lock`，不增加运行镜像依赖。

```sh
python3 -I -m venv /tmp/assets-font-tools
/tmp/assets-font-tools/bin/python -I -m pip install -r requirements/fonts.lock
export CJK_FONT_PYTHON=/tmp/assets-font-tools/bin/python
"$CJK_FONT_PYTHON" -I scripts/validate_cjk_font_slices.py
npm run test:fonts
```

Node 测试默认使用 `python3`，可用 `CJK_FONT_PYTHON` 选择已安装依赖的 Python；不依赖固定的 `/tmp/fv`，
也不因依赖缺失跳过。Checks 和 Code Release 工作流安装固定依赖并强制运行字体测试。
验证逐片检查完整 hash/大小/cmap/每条 CSS 声明，并将两字重各自的互斥并集与原始集合指纹比较。
无需完整字体即可完成发布校验；可用 `--source-dir` 额外核对历史原始字节及 cmap。

## 恢复输入并重新生成

以下命令要求本地已经具有历史源提交。在一个全新的临时目录恢复原始字节，`&&` 保证 Git 读取失败不继续生成。
不把完整字体恢复到工作树，也不移动/改写任何历史 tag。

```sh
source_dir=$(mktemp -d /tmp/assets-cjk-originals.XXXXXX) &&
git show 21230c1:fonts-src/NotoSansSC-Regular.woff2 > "$source_dir/NotoSansSC-Regular.woff2" &&
git show 21230c1:fonts-src/NotoSansSC-Bold.woff2 > "$source_dir/NotoSansSC-Bold.woff2" &&
"$CJK_FONT_PYTHON" -I scripts/validate_cjk_font_slices.py --source-dir "$source_dir"

# 确有需要时才生成；不带 --rescan 时复用已审阅的小字符表。
"$CJK_FONT_PYTHON" -I scripts/slice_cjk_font.py --source-dir "$source_dir"
# 重新扫描 site/ 源码，并实际更新 core 分片和 site-used-chars.txt。
"$CJK_FONT_PYTHON" -I scripts/slice_cjk_font.py --source-dir "$source_dir" --rescan
```

生成器必须显式接收 `--source-dir`，先验证两个原始文件的字节 hash，再解码 cmap；不从当前目录隐式读取字体。
缺失或错误输入不会删除/改写已安装的良好分片。新产物先写入全新的同文件系统 staging 目录，全部验证通过后才替换，
替换失败会恢复备份。生成会改变文件 hash；必须审阅元数据、CSS 与字体差异，不为例行部署无意义重生成。

新增文案出现 `core` 之外的汉字时仍可显示（落入 `rare-NN` 分片，按需下载）；
需要减少首屏请求时再 `--rescan`。canvas 文字不会触发 @font-face 加载，也不会在分片到达后重绘。
