# 2026-11-14 审计证据

证据配套上层两份审计文档；代码HEAD和初始工作区见repository-baseline.json。测试日志是本地执行证据，public生产目录和SPHEREx元数据有独立HTTP receipt，不混为生产写入验收。没有科学影像、光谱或Cube下载；spherex/hips_moc.body是官方8640B覆盖MOC元数据，其他body为文档、目录、VOTable或TAP元数据（HEAD body为空），无损保存为*.body.gz。解压后字节应匹配各请求receipt的response SHA和大小；不清理上游HTML空格以免改变原始证据。evidence-manifest校验的是归档文件本身。

文件清单与SHA见evidence-manifest.json；摘要中的native Order gate拒绝为预期发现，不是本次发布操作。public-moc/node-tests.log.gz保留3项缺历史Euclid fixture的真实失败。其余日志中PASS也不能外推到线上。没有保存Maven代理配置、凭据、安装依赖二进制或大规模生成的投影。

## 重现

先按repository-baseline.json的SHA建立四个checkout，再分别遵循仓库依赖锁。Assets本地使用其固定1.2.0 wheel，Workspace消费实验使用其固定1.0.0 wheel，避免cwd/PYTHONPATH遮蔽；仅CLI --version不足以确认wheel。Node本次为24.22.1，Python3.12.14；Warehouse用JDK17/Maven3.9.11。具体suite命令和差异在审计文档各节。

SDK的verify_sdk_paths.py以本目录为相对证据根，读取兄弟spherex/hips_moc.body；缺production/spherex-resource-package.zip时仅跳过可选的已捕获线上包验证。公开包可按production/resource-package-catalog.json的**固定版本**URI只读重新下载，先确认大小/SHA；远端若变化必须另记receipt，不覆写本次证据。没有将科学URI传给该脚本。

Workspace extent-probe.test.ts须从Workspace根用其已安装tsx运行，设置AUDIT_WORKSPACE_ROOT、AUDIT_EVIDENCE_ROOT及安装固定1.0.0的ASTRO_PYTHON；ASTRO_TEST_MOC_CORE_CLI也应指向此Python。脚本会校验vendor wheel SHA和真实distribution，ES/S3均本地fixture。脚本输出到用户指定work目录，不向Assets保存私有扫描。

public-moc/verify-live-package.mts为原执行脚本，保留本次scratch绝对路径以便溯源；移机需把import改指被审计Assets源码并指定已验证的包路径。默认不重放production写入或authority激活。warehouse/ContractProbe.java是纯parse/validate合成探测，不会枚举源、连接ES或调度Job。

HTTP receipts的URL、状态、时间、response SHA以及body字节用于重查官方来源；不是科学文件内容checksum。S3 ETag也未当作MD5。生产/官方元数据为2026-11-14冻结观察；不代表永久有效或全库完整。

原始测试stdout/stderr日志均无损保存为*.log.gz，避免改动空格/终端输出；解压可直接阅读，结果JSON与审计正文供快速核对。
