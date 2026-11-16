/**
 * The single product lifecycle shown in the review browser.
 *
 * The server already normalises revisions: `review.state` is "published" only when the published
 * revision equals the draft revision, "reviewed" when the current draft was reviewed, otherwise
 * "draft" (or "unmatched*" for records outside the public catalog). The client therefore only
 * maps that vocabulary onto five labels and must not recompute revisions.
 */
export type ProductLifecycleState = "pending" | "reviewed" | "published" | "retired" | "unregistered";

export interface LifecycleInput {
  retiredAt?: string;
  lifecycle?: { publication?: { state?: string } };
  review?: { state: string };
}

export function productLifecycleState(product: LifecycleInput): ProductLifecycleState {
  if (product.retiredAt || product.lifecycle?.publication?.state === "RETIRED") return "retired";
  switch (product.review?.state) {
    case "unmatched": return "unregistered";
    case "reviewed": return "reviewed";
    case "published":
    case "unmatched-published": return "published";
    default: return "pending";
  }
}

export const productLifecycleLabels: Record<ProductLifecycleState, string> = {
  pending: "待审核", reviewed: "已审核", published: "已发布", retired: "已退休", unregistered: "未登记",
};

export interface PublicCoverageInput { published: boolean; orders: number[]; retired: boolean }
export interface ProductBadgeInput extends LifecycleInput {
  publicCoverage?: PublicCoverageInput;
  review?: { state: string; draftRevision?: number; reviewedRevision?: number };
}
export interface PublicationRunInput { status: string }

/** Publication tasks that are still in flight; the product row shows progress instead of its resting state. */
export const ACTIVE_PUBLICATION_STATUSES = ["queued", "building", "uploading", "verifying"] as const;

export type ProductBadgeKind = "publishing" | "failed" | ProductLifecycleState;
export interface ProductBadge { kind: ProductBadgeKind; label: string; active: boolean }

/**
 * The one badge shown on a product row: an in-flight or failed publication run takes priority,
 * otherwise the resting lifecycle label. Withdrawal wording is supplied by the caller because it
 * needs the product's lifecycle record.
 */
export function productBadge(
  product: ProductBadgeInput,
  run: PublicationRunInput | undefined,
  options: { activeLabel: (run: PublicationRunInput) => string; withdrawal: () => string },
): ProductBadge {
  const state = productLifecycleState(product);
  if (run && (ACTIVE_PUBLICATION_STATUSES as readonly string[]).includes(run.status)) {
    return { kind: "publishing", label: options.activeLabel(run), active: true };
  }
  if (run?.status === "failed") return { kind: "failed", label: "发布失败 · 查看详情", active: false };
  if (state === "retired") return { kind: "retired", label: `已退休 · ${options.withdrawal()}`, active: false };
  return { kind: state, label: productLifecycleLabels[state], active: false };
}

/**
 * Whether the product is visible on the public sky, and how finely. This is a fact about the live
 * release, not a second lifecycle: it is shown next to the lifecycle badge, never instead of it.
 */
export function skyVisibility(coverage: PublicCoverageInput | undefined, orderText: (orders: number[]) => string): string {
  if (coverage?.retired) return coverage.published ? "天球：待撤下" : "天球：已撤下";
  if (!coverage?.published) return "天球：未公开";
  return coverage.orders.length ? `天球：可显示 · ${orderText(coverage.orders)}` : "天球：已公开 · 暂无覆盖几何";
}
