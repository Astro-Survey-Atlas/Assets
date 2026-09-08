# 资源包外置迁移 HANDOFF

更新日期：2026-09-07  
状态：代码已进入 archive-only v1 草案阶段，MinIO 及生产切换尚未执行。

## 事实边界

本交接基于 `HANDOFF.md` 的 2026-09-05 快照和当前未提交工作树：

- 开发环境最近记录为 Helm revision 122，旧镜像
  `0.1.0-20260905-021417`，NodePort 为
  `http://10.15.51.75:32083/`。
- 该部署记录使用的是静态/PVC 发布路径。不能据此证明 archive-only
  代码或 MinIO 发布已经部署。
- 生产集群、72602 生产环境、生产 S3/MinIO endpoint 和生产 Secret 均未被修改。
- 工作树包含大量生成的 MOC、catalog、provenance、UI 和部署变更。下一会话必须保留并先检查 `git status --short`。
- 当前 Resource Package v3 catalog 包含 15 个 `3.0.0` ZIP 包。ZIP 的大小和 SHA-256 以 `packages/catalog.json`、`provenance.json` 和 `release-manifest.json` 的交叉校验结果为准，不以文件名为准。

## 迁移目标

archive-only v1 只定义一个发布对象：

```text
public/releases/<bundle-id>/<bundle-sha256>/release.tar.gz
public/current.json
```

运行时镜像只包含代码和依赖，不包含 public release tree 或 Resource Package ZIP。`publish-assets` init container 从 S3 兼容对象存储下载一个完整的 `tar.gz`，验证大小、SHA-256、归档路径和 manifest 后，原子切换：

```text
/data/releases/<bundle-sha256>
/data/current -> releases/<bundle-sha256>
```

服务进程只读取 `/data/current`。请求处理期间不访问 S3，也不按文件向对象存储发起请求。

输入 manifest、normalized scan、task snapshot、scanner error、CSST `input-manifest.json` 等仍属于 evidence，不得进入公开 release allowlist、浏览器首个请求或 Resource Package ZIP。

## 已完成代码

| 区域 | 当前实现 |
| --- | --- |
| 构建 | `scripts/release-archive.ts` 根据 `release-manifest.json` 生成确定性的 gzip tar；固定排序、mtime、owner 和 group，并生成 sidecar descriptor。 |
| 外置 ZIP | `ASSETS_PACKAGE_STAGING_ROOT` 可指向仓库外的 ZIP staging 目录；manifest 记录保留公开逻辑路径、大小和 SHA-256。 |
| 上传 | `server/artifact-store.ts` 提供 S3/MinIO `putFileImmutable`；同 key 不同字节会失败，上传后执行 size/SHA-256 校验。 |
| 指针 | `public/current.json` 使用 schema version 2，记录 bundle、archive key、archive size、archive SHA-256 和发布时间；指针最后更新。 |
| 启动同步 | `server/sync-release.ts` 下载完整归档，拒绝路径穿越、绝对路径、符号链接、硬链接和特殊文件，校验 manifest 后原子激活。 |
| 缓存 | 已安装且通过 `loadCatalog` 校验的 bundle hash 不重复下载；失败不会替换当前活动 release。 |
| Helm | chart 已有 `publish-assets` init container、对象存储环境变量、Secret 注入和 endpoint/bucket/Secret guards。 |
| 镜像 | Dockerfile 已改为 code-only runtime；public release tree 不再复制进运行时镜像。 |
| 测试 | `test/artifact-store.test.ts` 等覆盖确定性归档、immutable upload、下载校验、原子激活和 hash cache。 |

注意：当前工作树中 `sync-release.ts` 已拒绝非 S3 store，而 `deploy/k3s-values.yaml` 仍可能是 `objectStore.enabled: false` 且 endpoint/bucket 为空。因此在未配置 MinIO 前，按当前 archive-only chart 直接 rollout 会使 `publish-assets` init container 失败。这是明确的预部署阻塞项，不是已完成部署。

## 尚未完成

- 尚未创建或确认可用的 MinIO bucket、endpoint、TLS 路由和最小权限 Secret。
- 本地外置 ZIP staging 已建立：`/home/aaron/Repo/asa-resource-packages`（15/15 SHA 与 catalog 一致）。
- 在 `ASSETS_PACKAGE_STAGING_ROOT` 下已验证：`artifacts:validate`、`catalog:build`、`release:package`；archive 含 15 个 ZIP，bundle `6ab043e7…`。
- Git 已 `gitignore` + `git rm --cached` 15 个 package ZIP（工作区磁盘副本仍保留作本地缓存）；**未**物理删除，**未** push 删除。
- 尚未把 archive 上传到非生产 MinIO，也尚未推进 `public/current.json`。
- 尚未以真实 endpoint/bucket/Secret 部署 archive-only 镜像。
- 尚未完成开发 canary、重启/hash cache、API、Range 和 Workspace 安装验证。
- 尚未完成生产 overlay 的实际替换、审批和 rollout。
- 物理删除本地/Git 历史中的 ZIP 仍受下节门禁约束；当前仅完成「停止跟踪 + 外部 staging」。

## MinIO、对象存储和 Helm 变量

逻辑对象布局：

```text
<optional-prefix>/public/releases/<bundle-id>/<bundle-sha256>/release.tar.gz
<optional-prefix>/public/current.json
```

Helm values：

```yaml
objectStore:
  enabled: true
  endpoint: https://<minio-or-s3-endpoint>
  bucket: <bucket>
  prefix: ""
  currentKey: public/current.json
  region: us-east-1
  forcePathStyle: true       # MinIO 通常为 true，AWS S3 通常为 false
  retainReleases: 2
  cleanup: false
  credentialsSecret:
    name: <secret-name>
    accessKeyIdKey: access-key-id
    secretAccessKeyKey: secret-access-key
    sessionTokenKey: session-token
```

运行时环境变量：

```text
ASSET_TARGET_ROOT=/data
ASSETS_OBJECT_STORE_CURRENT_KEY=public/current.json
ASSETS_RELEASE_RETENTION=2
ASSETS_RELEASE_CLEANUP=false
ASSETS_OBJECT_STORE_ENDPOINT
ASSETS_OBJECT_STORE_BUCKET
ASSETS_OBJECT_STORE_PREFIX
ASSETS_OBJECT_STORE_REGION=us-east-1
ASSETS_OBJECT_STORE_FORCE_PATH_STYLE=true
ASSETS_OBJECT_STORE_ACCESS_KEY_ID
ASSETS_OBJECT_STORE_SECRET_ACCESS_KEY
ASSETS_OBJECT_STORE_SESSION_TOKEN       # 可选
```

发布机变量：

```text
ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages
ASSETS_RELEASE_ARCHIVE=/srv/releases/<bundle-sha256>.tar.gz
ASSETS_RELEASE_ARCHIVE_METADATA=/srv/releases/<bundle-sha256>.tar.gz.json
```

凭据只能通过 Kubernetes Secret、受保护的环境变量或受保护的文件注入，不得提交到 values、日志、provenance 或交接文档。

## ZIP 删除前置条件

在满足以下全部条件前，不得删除 `artifacts/public-survey-footprints/packages/*.zip`：

- 15 个 ZIP 均已复制到受控的外部 staging，逐个通过 `stat` 和 SHA-256 校验；
- `packages/catalog.json`、`provenance.json`、`release-manifest.json` 中的包 ID、版本、大小和 hash 完全一致；
- 设置 `ASSETS_PACKAGE_STAGING_ROOT` 后，以下命令成功：`npm run catalog:build`、`npm run artifacts:validate`、`npm run release:package`；
- 生成的 tar.gz 中实际包含 15 个 ZIP，且每个 ZIP 的字节和 manifest 完全一致；
- `release:package` 生成的 descriptor 已保存，并通过独立命令再次校验 archive size/SHA-256；
- archive 已上传到非生产 MinIO，read-after-write 下载校验成功；
- `public/current.json` 已指向该 archive，且 init container 可从空 `/data` 成功安装；
- `/healthz`、`/api/v1/assets`、survey/catalog、package 下载、`206 Partial Content`、`ETag` 和 `X-Content-SHA256` 均通过；
- 至少一次 Pod 重启验证已安装 hash cache，且至少一次从旧 pointer 回滚成功；
- Workspace 完成 catalog 下载、完整 ZIP hash 校验、MOC Core package validate、安装和 `mocLayers(packageId)` 验证；
- CI、Docker build、release packaging 和测试不再依赖 Git ZIP 路径；
- 外部 staging 的备份、保留期限、负责人和恢复步骤已记录；
- 迁移负责人、Assets owner 和 Workspace consumer 均明确批准删除；
- 删除后保留 Git diff、对象存储 archive hash、package hash 台账和恢复说明。

`build-release-manifest.ts` 的 `allowMissing` 只允许在没有 staging root 时保留已知 size/hash 元数据，不代表 ZIP 内容存在，也不能作为删除后的发布证明。真正生成归档时仍必须提供可读的外部 ZIP staging。

## 风险与回滚

- MinIO endpoint 可达但 bucket、region、path-style 或 TLS 配置错误，会导致 init container 在启动前失败。
- `public/current.json` 是 mutable pointer；archive key 本身必须 immutable，不能覆盖同一 bundle hash 的不同字节。
- tar.gz 若未固定排序和时间戳，会造成相同输入产生不同 archive hash。
- release archive 中误放 evidence 会扩大公开边界；必须在 manifest 和归档成员级别检查。
- `cleanup: true` 只清理 release PVC 中的旧目录，不删除对象存储中的 immutable archive。
- 回滚只需把 `public/current.json` 改回已验证的旧 archive，并重启 deployment；不得先删除旧 archive 或旧 release 目录。

## 验收门禁

- 本地门禁：`npm run artifacts:validate`、`npm run moc:validate`、`npm run build`、`npm test`、`helm lint`、生产 overlay template render、`git diff --check`。
- 归档门禁：manifest、归档成员、size、SHA-256、无链接、无特殊文件、无路径穿越。
- 对象存储门禁：immutable PUT、read-after-write、current pointer 最后更新。
- 运行时门禁：空 `/data` 安装成功，init exit code 0，catalog bundle hash 与 pointer 一致。
- 在线门禁：health、catalog、package complete download、Range、ETag、`X-Content-SHA256` 和错误回退行为。
- 消费者门禁：Workspace 安装并通过 `mocLayers()` 返回真实 layer identity。
- 回滚门禁：旧 archive 可重新激活，且不需要 Git checkout 或逐文件 S3 读取。

## 下一会话首要动作

1. 读取 `AGENTS.md`、`HANDOFF.md`、`docs/coverage-workflow.md` 和 coverage workflow skill。
2. 保存当前 `git status --short`、当前 release manifest hash 和 package catalog hash；不要清理工作树。
3. 先修正或确认 `deploy/k3s-values.yaml`：在没有 MinIO 前不得按 archive-only 配置 rollout。
4. 准备非生产 MinIO bucket、TLS、最小权限 Secret 和连通性检查；不填写生产凭据。
5. 用外部 `ASSETS_PACKAGE_STAGING_ROOT` 重建并验证 15 个 ZIP，再生成 release archive。
6. 执行非生产上传和 pointer 校验，随后才做开发 Helm canary。
7. 完成 API、Range、重启、Workspace 安装和 rollback 验证后，再拟定生产切换审批单。
