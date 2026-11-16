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

export type FlagSeverity = "ok" | "warn" | "block" | "info";
export interface EligibilityInput {
  /** Review eligibility: ready, confirm-limitations, blocked, stale, error, loading, unregistered, unmatched, published, retired. */
  state: string;
  label: string;
  reason: string;
  /** Publication eligibility straight from the server: ready, needs-review, confirm-limitations, blocked, stale, ... */
  publicationState?: string;
  publicationLabel: string;
}
export interface ProductFlag { severity: FlagSeverity; text: string; detail: string }

const REVIEW_SEVERITY: Record<string, FlagSeverity> = {
  ready: "ok", "confirm-limitations": "warn", blocked: "block", stale: "block", error: "block",
  loading: "info", unregistered: "info", unmatched: "info",
};
const PUBLICATION_SEVERITY: Record<string, FlagSeverity> = {
  ready: "ok", "confirm-limitations": "warn", blocked: "block", stale: "block", "needs-review": "info",
};

/**
 * A warning attached to a product, not a second status. It names the next gate only:
 * pending products show their review eligibility, reviewed products show their publication gate,
 * published and retired products show nothing (the lifecycle badge already says everything).
 * A version that changed under a published product is the one exception, because it needs action.
 */
export function eligibilityFlag(lifecycle: ProductLifecycleState, eligibility: EligibilityInput): ProductFlag | null {
  if (eligibility.state === "stale") return { severity: "block", text: eligibility.label, detail: eligibility.reason };
  if (lifecycle === "published" || lifecycle === "retired") return null;
  if (lifecycle === "reviewed") {
    const severity = PUBLICATION_SEVERITY[eligibility.publicationState ?? ""] ?? "info";
    return { severity, text: eligibility.publicationLabel, detail: "" };
  }
  return { severity: REVIEW_SEVERITY[eligibility.state] ?? "info", text: eligibility.label, detail: eligibility.reason };
}
