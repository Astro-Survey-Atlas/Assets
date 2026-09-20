/** Public coverage must carry real native precision; preview upsampling cannot qualify it. */
export const MIN_PUBLIC_COVERAGE_ORDER = 4;

export class CoveragePrecisionError extends Error {
  readonly statusCode = 422;
}

export function assertPublicCoverageOrder(maxOrder: number): void {
  if (!Number.isInteger(maxOrder) || maxOrder < MIN_PUBLIC_COVERAGE_ORDER) {
    throw new CoveragePrecisionError(`原生覆盖精度 order ${maxOrder} 低于公开发布最低要求 order ${MIN_PUBLIC_COVERAGE_ORDER}；请获取真实更高精度 MOC，不能放大预览替代。`);
  }
}
