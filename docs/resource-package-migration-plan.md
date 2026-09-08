# archive-only v1 分阶段工作计划

状态：计划稿。代码路径已实现一部分，但 MinIO、开发 canary、生产切换和 ZIP 删除均未完成。

## v1 定义

archive-only v1 的发布边界是一个完整 immutable `release.tar.gz`：

```text
public/releases/<bundle-id>/<bundle-sha256>/release.tar.gz
public/current.json
```

v1 不做：

- 运行时逐文件 S3/MinIO 读取；
- 每个 public asset 单独上传为对象；
- 浏览器直接读取 evidence、input manifest 或 normalized scan；
- 生产自动清理未经过审批的旧 archive；
- 通过 ZIP 文件名推断 layer identity。

v1 必须做到：

- 代码-only 镜像；
- init container 下载并校验完整 archive；
- `/data/current` 原子切换；
- manifest、catalog、MOC、provenance 和 Resource Package ZIP 同步；
- 支持 pointer rollback；
- Workspace 可以通过公开 catalog 安装并验证 Resource Package。

## 阶段一：冻结基线和清单

状态：代码侧基本完成，需在迁移会话重新确认。

工作：

- 保存当前 commit、工作树状态、bundle manifest hash；
- 固定 15 个 Resource Package v3 记录的 ID、version、size、SHA-256；
- 区分 runtime 和 evidence，确认 CSST input manifest 不在公开 allowlist；
- 记录当前开发 revision 作为 PVC/static 回退基线；
- 生成迁移清单，不删除任何 ZIP 或旧 release 目录。

门禁：

- `npm run artifacts:validate`
- `npm run moc:validate`
- `npm run build`
- `npm test`
- `helm lint charts/astro-survey-atlas-assets`
- `git diff --check`

产物：

- `migration-inventory.json` 或等价审计记录；
- 当前 manifest、catalog、provenance 的 hash 快照；
- 回滚目标 archive 的身份记录。

## 阶段二：外部 ZIP staging

状态：未完成。

工作：

```bash
export ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages
npm run catalog:build
npm run artifacts:validate
```

将 15 个 ZIP 放在 staging root 的顶层，并逐个记录：

```text
basename
sizeBytes
sha256
catalog package id
source/reference
```

staging root 不等于公开 URL。它可以是受控本地目录、私有 PVC 或受限对象存储前缀。未完成公开 archive 前，不推进 `public/current.json`。

门禁：

- 15/15 ZIP 可读；
- size 和 SHA-256 与 catalog/provenance 一致；
- 无额外未审计 ZIP；
- evidence 文件不进入 staging package 集合；
- 从干净 checkout 仅依赖 staging root 即可重建 package asset records。

## 阶段三：构建确定性 release archive

状态：实现已存在，尚未用最终外部 staging 执行。

工作：

```bash
ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages \
ASSETS_RELEASE_ARCHIVE=/srv/releases/<bundle-sha256>.tar.gz \
npm run release:package
```

检查：

- tar 成员路径均为相对安全路径；
- 没有符号链接、硬链接或特殊文件；
- manifest 与 archive 中每个文件的 size/SHA-256 一致；
- archive 包含完整 Resource Package ZIP；
- 两次使用相同输入得到相同 archive SHA-256；
- sidecar descriptor 与实际 archive 完全一致。

门禁：

- archive hash 可独立复算；
- `loadCatalog` 能从解压目录加载；
- bundle ID 和 manifest SHA-256 与 descriptor 一致；
- evidence 仍只作为 evidence，不被转换成 runtime。

## 阶段四：发布到非生产 MinIO

状态：未完成，禁止使用生产 endpoint。

准备 Helm/环境变量：

```yaml
objectStore:
  enabled: true
  endpoint: https://<non-production-minio>
  bucket: <non-production-bucket>
  prefix: ""
  currentKey: public/current.json
  region: us-east-1
  forcePathStyle: true
  retainReleases: 2
  cleanup: false
  credentialsSecret:
    name: <non-production-secret>
```

发布：

```bash
ASSETS_OBJECT_STORE_ENDPOINT=...
ASSETS_OBJECT_STORE_BUCKET=...
ASSETS_OBJECT_STORE_FORCE_PATH_STYLE=true
ASSETS_RELEASE_ARCHIVE=/srv/releases/<bundle-sha256>.tar.gz
npm run release:upload
```

门禁：

- immutable archive PUT 成功；
- 相同 key 相同字节可重复发布；
- 相同 key 不同字节被拒绝；
- read-after-write size/SHA-256 成功；
- `public/current.json` 最后更新；
- pointer 的 `archiveSha256` 不等于 manifest hash 时仍能正确区分两者；
- MinIO 日志不包含 Secret。

## 阶段五：开发 Helm canary

状态：未完成。

重要阻塞：

当前 archive-only `sync-release.ts` 拒绝非 S3 store，而开发 values 仍可能是 `enabled: false`、空 endpoint/bucket。未配置 MinIO 前不得 rollout；否则 `publish-assets` init container 会失败。

工作：

- 构建新的 immutable code-only image；
- 使用非生产 MinIO values 和 Secret；
- 从空的 `/data` PVC 启动；
- 检查 init container exit code 0；
- 检查 `/data/current` 指向 pointer bundle；
- 验证 `/healthz`、`/api/v1/assets`、coverage catalog 和 package catalog；
- 下载完整 ZIP，测试 `Range: bytes=...`、ETag 和 `X-Content-SHA256`；
- 重启 Pod，确认已安装 bundle 不会重复下载；
- 比较 archive 模式和历史 static/PVC 基线的文件数、catalog hash 和 API 响应。

门禁：

- 首次安装成功；
- 重启成功；
- 不访问 Git checkout；
- S3/MinIO 断开时已安装 release 仍可服务；
- 新 pointer 指向损坏 archive 时旧 `/data/current` 不被破坏。

## 阶段六：Workspace 消费者验证

状态：代码路径已有测试，真实迁移 archive 尚未验证。

工作：

1. 获取 `/api/v1/resource-packages/catalog.json`；
2. 按 `sizeBytes` 和 `sha256` 下载完整 archive/ZIP；
3. 运行 MOC Core package validate；
4. 安装到 Workspace 私有 package root；
5. 调用 `mocLayers(packageId)`；
6. 确认返回 manifest 的真实 `layerId`、`surveyId`、`releaseId`、路径、大小和 hash；
7. 确认 Workspace 不读取 Assets Git checkout、release PVC 或 MinIO bucket。

门禁：

- 全部目标 package 安装成功；
- 至少一个含多个 layer 的 package 通过查询；
- hash 不匹配时安装被拒绝；
- 失败 staging 和临时 ZIP 被清理；
- 已安装目录和状态文件保留 hash 与 active release IDs。

## 阶段七：生产切换审批和 rollout

状态：未开始。生产 overlay 仍是占位模板。

切换前必须完成：

- 非生产 canary 和 rollback；
- 生产 MinIO bucket、TLS、region、path-style 决策；
- 生产 Secret 通过外部 Secret 管理创建；
- 生产 release、content、evidence PVC 已预创建；
- 生产镜像 tag immutable；
- `objectStore.cleanup` 初始建议为 `false`，待观察期后再启用；
- 记录旧 static/PVC bundle 的 manifest hash 和回滚 pointer；
- 评审 `retainReleases >= 2`。

生产 rollout 门禁：

- `helm template` 和 `helm lint`；
- init container exit code 0；
- health、catalog、package download、Range 和 hash smoke；
- 至少一次生产 Pod 重启；
- 监控无 archive checksum、catalog load 或权限错误；
- 生产回滚 pointer 已在值班手册中验证。

## 阶段八：保留策略、清理和删除 ZIP

状态：未开始。

保留规则：

- `ASSETS_RELEASE_RETENTION` 至少为 2；
- `ASSETS_RELEASE_CLEANUP=true` 只允许在当前 release 和上一版本均已验证后启用；
- init cleanup 只删除 release PVC 中未保留的旧目录；
- 不通过 init cleanup 删除对象存储 immutable archive；
- 对象存储 archive 删除必须有独立 retention 审批和 rollback 证明。

Git ZIP 删除门禁：

- 阶段二至六全部通过；
- 外部 staging、MinIO archive 和 Workspace 安装均有可复现记录；
- CI/build 不依赖 ZIP 的 Git 路径；
- `ASSETS_PACKAGE_STAGING_ROOT` 缺失时不会被误认为内容已验证；
- 已生成并保存完整 package hash 台账；
- 至少完成一次 pointer rollback；
- 负责人确认可从外部 staging 或 archive 恢复；
- 删除只针对已明确列出的 ZIP，不删除 raw evidence、MOC、provenance 或 input manifest；
- 删除后重新运行 build/test，并重新检查 release archive 成员；
- 迁移负责人、Assets owner 和 Workspace owner 书面批准。

## 当前下一步

下一会话优先完成阶段一和阶段二：

1. 记录当前 dirty worktree 和 manifest/catalog/provenance hash；
2. 确认开发 values 与 S3-only init 的一致性；
3. 准备非生产 MinIO 和 Secret；
4. 建立 15 个 ZIP 的外部 staging 及逐文件校验；
5. 生成第一个 archive descriptor；
6. 在非生产环境完成上传前的离线验收。

在上述步骤完成前，不推进生产 rollout，也不删除 Git 中的 ZIP。
