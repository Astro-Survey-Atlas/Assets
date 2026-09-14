export const capabilityNames: Record<number, string> = {
  [-1]: "来源待补充", 0: "来源已登记", 1: "覆盖可查询", 2: "单元可反查", 3: "文件可定位",
};

export const gapGuidance: Record<string, { title: string; description: string; blocking?: boolean }> = {
  "source-not-traceable": { title: "缺少可追溯来源", description: "选择官方来源或探查候选，再获取覆盖；系统将保存来源地址。", blocking: true },
  "input-snapshot-hash-missing": { title: "来源快照尚未锁定", description: "探索产品的输入是查询条件、来源响应及下载的 MOC。选择候选并构建后，系统保存来源文件和哈希，无需填写输入清单。" },
  "validated-coverage-missing": { title: "覆盖尚未构建或校验", description: "从本产品的探查候选构建覆盖；已有构建时检查执行结果并重新校验。", blocking: true },
  "coverage-query-unavailable": { title: "覆盖尚不可查询", description: "先获取本产品的覆盖 MOC，构建成功后由系统记录实际支持的精度。", blocking: true },
  "source-unit-index-missing": { title: "尚不能定位 Tile / 曝光", description: "总 MOC 只描述覆盖。可先按覆盖查询能力发布；需要更强反查时，补充官方单元边界或空间查询服务。" },
  "file-level-reverse-index-missing": { title: "尚不能定位具体文件", description: "可先发布覆盖；文件反查需要官方文件索引，或通过已授权存储扫描生成映射。无需下载整个 DR。" },
  "execution-record-missing": { title: "缺少实际执行记录", description: "已有 MOC 构建时重新校验产物；否则从候选触发构建。系统根据真实执行结果记录证据。" },
  "output-validation-missing": { title: "输出尚未通过校验", description: "点击“校验已有构建”，检查来源和输出文件的实际字节、哈希及 MOC 有效性；失败会指出需要重建的产物。", blocking: true },
  "isolated-restore-not-verified": { title: "发布时验证权威恢复", description: "此项在发布阶段自动完成：候选上传权威后，在干净目录按哈希恢复并校验，通过后才切换公开版本。当前审核不要求手工填写恢复证明。" },
  "completeness-unknown": { title: "完整性尚未确认", description: "尚无可核验的总量或统计范围，不能显示百分比。公开 MOC 不等于整个 DR 的文件清单，可披露此限制后发布。" },
  "completeness-partial": { title: "当前仅覆盖部分数据", description: "查看来源范围及失败记录；可披露当前范围后发布，或补齐缺失输入后重新处理。" },
};

export interface DiscoveryObservation {
  state: "waiting" | "delayed" | "blocked" | "running" | "finished";
  checkedAt: string;
  waitedSeconds?: number;
  lastProgressAt?: string;
  executor: { health: "unknown" | "unavailable" | "error"; checkedAt: string; reason?: string; message: string; source?: string };
}

export function discoveryObservationLabel(observation?: DiscoveryObservation): string {
  return observation ? ({ waiting: "等待接单", delayed: "等待异常", blocked: "等待受阻 · 探索服务异常", running: "执行中", finished: "已结束" })[observation.state] : "等待接单";
}

export function discoveryProgress(request: { createdAt?: string; observation?: DiscoveryObservation; status: { phase?: string; jobName?: string; message?: string; reason?: string; lastTransitionTime?: string } }): string {
  const status = request.status;
  if (["SUCCEEDED", "COMPLETED"].includes((status.phase ?? "").toUpperCase())) return status.message || "探索已完成。关闭并重新打开详情可查看最新候选。";
  if (["FAILED", "ERROR", "INVALID", "CANCELLED"].includes((status.phase ?? "").toUpperCase())) return status.message || status.reason || "探索已结束，未能生成可用结果；请查看执行记录。";
  if (!status.jobName) {
    const observation = request.observation;
    const wait = observation?.waitedSeconds === undefined ? "" : `已等待 ${Math.floor(observation.waitedSeconds / 60)} 分 ${observation.waitedSeconds % 60} 秒。`;
    const reason = observation?.state === "blocked" ? observation.executor.message : observation?.state === "delayed" ? "超过接单时限，原因尚未确认。" : "等待执行器接单。";
    return `请求已保存，尚未创建执行任务。${wait}${reason}${observation?.executor.health === "unavailable" ? "执行器诊断暂不可获取。" : ""}无需重复提交；系统将继续检查原请求。`;
  }
  return status.message || (status.jobName ? `执行任务 ${status.jobName}；等待结果更新` : "已提交，尚未收到明确的执行进度");
}
