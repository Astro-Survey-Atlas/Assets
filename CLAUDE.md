# Astro Survey Atlas Assets - Claude 工作指南

## 72602生产环境部署

**关键连接方式：**
```bash
ssh aaron@72602-minipc-proxy
```

通过此SSH连接可直接访问72602生产Kubernetes集群和Helm。

### 部署流程

1. **检查当前状态**（通过SSH）：
```bash
ssh aaron@72602-minipc-proxy '/home/aaron/bin/helm -n astro-survey-atlas-assets-72602 list -o json'
```

2. **打包并传输Helm chart**：
```bash
# 本地打包
cd ~/Repo/Astro-Survey-Atlas-Assets
helm package charts/astro-survey-atlas-assets -d /tmp/

# 传输到72602
scp /tmp/astro-survey-atlas-assets-*.tgz aaron@72602-minipc-proxy:/tmp/
```

3. **执行部署**（在72602机器上）：
```bash
ssh aaron@72602-minipc-proxy
cd /tmp
helm upgrade astro-survey-atlas-assets-72602 ./astro-survey-atlas-assets-*.tgz \
  -n astro-survey-atlas-assets-72602 \
  -f values.yaml \
  --wait --timeout=10m
```

### 生产环境信息

- **命名空间**: `astro-survey-atlas-assets-72602`
- **Helm release**: `astro-survey-atlas-assets-72602`
- **域名**: https://astro.assets.72602.space/
- **镜像仓库**: `crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/astro-survery-atlas/astro-survey-atlas-assets`
- **节点选择器**: `kubernetes.io/hostname: 72602-minipc`

### Values配置要点

关键配置项保存在 `~/.local/share/astro-assets-deployments/72602/*/values-before.yaml`：

- **对象存储凭据**: `objectStore.credentialsSecret.name` (必需)
- **API管理密钥**: `apiManagement.secretName`
- **区域访问密钥**: `regionAccess.secretName`
- **管理员令牌**: `admin.adminTokenSecret.name`
- **镜像拉取密钥**: `imagePullSecrets[0].name: aliyun-registry`
- **TLS证书**: `ingress.tls[0].secretName` (使用占位符 `{{SECRET_*}}`)

**重要**: Values中的 `{{SECRET_*}}` 和 `{{NAME_*}}` 占位符会被运行时自动替换为真实值，工具调用时原样使用。

### 验证检查

部署后验证项：
```bash
# Health检查
curl -sf https://astro.assets.72602.space/api/v1/healthz | jq '.version'

# Catalog API
curl -sf https://astro.assets.72602.space/api/v1/catalog | jq '.surveys | length'

# Pod状态
kubectl -n astro-survey-atlas-assets-72602 get pods
```

### 回滚

如需回滚到上一版本：
```bash
ssh aaron@72602-minipc-proxy
helm rollback astro-survey-atlas-assets-72602 -n astro-survey-atlas-assets-72602 --wait
```

## 字体优化（0.0.13+）

- 使用unicode-range分片：90个切片/字重（latin + core + rare-00..42）
- 英文页面：~326KB CJK字体（原23.5MB，减少98.6%）
- 中文页面：~556KB CJK字体（原23.5MB，减少97.6%）
- 切片文件：`site/public/fonts/cjk/NotoSansSC-{Regular|Bold}.{slice}.{hash}.woff2`
- 生成脚本：`scripts/slice_cjk_font.py`
- 验证脚本：`scripts/validate_cjk_font_slices.py`

## Git LFS注意事项

本地环境缺少git-lfs，以下文件会显示为modified但**不应提交**：
- `vendor/moc-core/*.tar.gz`
- `artifacts/.../moc-core/*.tar.gz`

提交时使用显式staging，避免 `git add .`。必要时使用 `git push --no-verify` 跳过LFS钩子。

## sky-globe依赖管理

sky-globe是独立仓库（`~/Repo/sky-globe`），Assets通过codeload引用：
```json
"@astro-survey-atlas/sky-globe": "https://codeload.github.com/Astro-Survey-Atlas/sky-globe/tar.gz/refs/tags/v0.1.4"
```

更新流程：
1. 在sky-globe仓库修改并测试
2. 提交并打tag（如 `v0.1.4`）
3. 推送tag到GitHub
4. 在Assets中更新package.json版本引用
5. 运行 `npm install` 更新lockfile
