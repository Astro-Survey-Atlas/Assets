/** Reconcile rendered output without replacing unchanged rows or progress nodes. */
export function reconcileMarkup(root: HTMLElement, markup: string): void {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const key = (node: Node): string | null => node instanceof Element ? (node.getAttribute("data-row-key") ?? node.id) || null : null;
  function sync(parent: Node, desired: Node): void {
    const keyed = new Map([...parent.childNodes].flatMap(node => key(node) ? [[key(node)!, node] as const] : []));
    let cursor = parent.firstChild;
    for (const source of [...desired.childNodes]) {
      let target: Node | null = key(source) ? keyed.get(key(source)!) ?? null : cursor;
      if (target instanceof Element && source instanceof Element && target.tagName.toLowerCase() === "svg" && source.tagName === "I" && target.getAttribute("data-lucide") === source.getAttribute("data-lucide")) {
        cursor = target.nextSibling;
        continue;
      }
      if (!target || target.nodeType !== source.nodeType || (target instanceof Element && source instanceof Element && target.tagName !== source.tagName) || key(target) !== key(source)) {
        target = source.cloneNode(true);
        parent.insertBefore(target, cursor);
      } else {
        if (target !== cursor) parent.insertBefore(target, cursor);
        if (target instanceof Element && source instanceof Element) {
          for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
          for (const attr of [...source.attributes]) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
          if (!target.isEqualNode(source)) sync(target, source);
        } else if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
      }
      cursor = target.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
  }
  sync(root, template.content);
}
