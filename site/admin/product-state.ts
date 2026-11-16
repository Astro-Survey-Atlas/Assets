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
