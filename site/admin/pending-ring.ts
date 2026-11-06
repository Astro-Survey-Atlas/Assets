/**
 * Marks admin placeholders that describe a request still in flight
 * ("尚未读取…", "正在…", "加载中…", "Loading…") so CSS can put the HUD loading
 * ring in front of them. Purely presentational: text and data are untouched,
 * and "empty" messages (暂无…) never match.
 */
const PENDING = /^\s*(尚未读取|正在|加载中|Loading\b|Checking\b)/i;
const TARGETS = ".resource-empty, [data-form-message], #refresh-state, #api-settings-content, #admin-status, .section-note, .native-empty, .review-preflight-summary > span";

function mark(element: Element): void {
  // Only leaf-like messages: a container with child elements is real content.
  const pending = element.childElementCount === 0 && PENDING.test(element.textContent ?? "");
  element.classList.toggle("is-pending", pending);
}

export function mountPendingRings(root: ParentNode = document): void {
  const scan = () => root.querySelectorAll(TARGETS).forEach(mark);
  scan();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}
