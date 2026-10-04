import { connectorDefaultIcon } from "../../src/connector-icon.js";

interface ConnectorIconView { name: string; type: string; iconUrl?: string }
const escapeText = (text: string): string => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function connectorIconMarkup(connector: ConnectorIconView): string {
  return connector.iconUrl
    ? `<img class="connector-custom-icon" src="${escapeText(connector.iconUrl)}" alt="${escapeText(connector.name)} 图标" data-connector-icon-type="${escapeText(connector.type)}" referrerpolicy="no-referrer" />`
    : `<i data-lucide="${connectorDefaultIcon(connector.type)}"></i>`;
}

export function mountConnectorIconEditor<T extends ConnectorIconView>(options: {
  api: <R>(path: string, init?: RequestInit) => Promise<R>;
  onSaved: (connector: T) => void;
  renderIcons: () => void;
}): { open: (connector: T) => void } {
  const dialog = document.createElement("dialog");
  dialog.className = "admin-dialog";
  dialog.id = "connector-icon-dialog";
  dialog.setAttribute("aria-labelledby", "connector-icon-title");
  dialog.innerHTML = `<form class="admin-form"><h3 id="connector-icon-title">Connector 图标</h3><p data-icon-name></p><div class="connector-icon-preview"><span class="connector-type-icon" data-icon-preview></span><span>管理页和扫描来源使用同一图标</span></div><label><span>图标 URL <small>可选</small></span><input name="iconUrl" placeholder="https://… 或 /assets/…" spellcheck="false" /></label><label><span>上传图标</span><input type="file" accept=".ico,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon" /></label><small>支持 ICO、PNG、JPEG、WebP，最大 64 KiB。未设置时按连接类型显示默认图标。</small><div class="form-row"><button type="button" class="admin-quiet" data-icon-reset>恢复默认</button><button type="button" class="admin-quiet" data-icon-cancel>取消</button><button type="submit" class="admin-primary"><i data-lucide="save"></i><span>保存图标</span></button></div><p class="form-message" role="status" aria-live="polite"></p></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLInputElement>('[name="iconUrl"]')!;
  const fileInput = form.querySelector<HTMLInputElement>('[type="file"]')!;
  const preview = form.querySelector<HTMLElement>("[data-icon-preview]")!;
  const message = form.querySelector<HTMLElement>(".form-message")!;
  let current: T | undefined;
  let upload: string | undefined;
  let busy = false;
  let readSequence = 0;
  let reading = false;
  const render = () => {
    if (current) preview.innerHTML = connectorIconMarkup({ ...current, iconUrl: upload ?? (input.value.trim() || undefined) });
    options.renderIcons();
  };
  document.addEventListener("error", event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains("connector-custom-icon")) return;
    const fallback = document.createElement("i");
    fallback.dataset.lucide = connectorDefaultIcon(image.dataset.connectorIconType);
    image.replaceWith(fallback);
    options.renderIcons();
  }, true);
  input.addEventListener("input", () => { readSequence++; reading = false; upload = undefined; fileInput.value = ""; message.textContent = ""; render(); });
  fileInput.addEventListener("change", () => void (async () => {
    const sequence = ++readSequence;
    upload = undefined;
    const file = fileInput.files?.[0];
    if (!file) { render(); return; }
    reading = true;
    try {
      if (file.size > 64 * 1024) throw new Error("图标不能超过 64 KiB");
      const types: Record<string, string> = { ico: "image/x-icon", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      const type = types[file.name.split(".").pop()?.toLowerCase() ?? ""];
      if (!type) throw new Error("请选择 ICO、PNG、JPEG 或 WebP 图标");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(`data:${type};base64,${String(reader.result).split(",")[1]}`);
        reader.onerror = () => reject(new Error("读取图标失败"));
        reader.readAsDataURL(file);
      });
      if (sequence !== readSequence) return;
      upload = data;
      input.value = "";
      message.textContent = `已选择 ${file.name}，保存后生效`;
    } catch (error) { if (sequence !== readSequence) return; fileInput.value = ""; message.textContent = error instanceof Error ? error.message : "读取图标失败"; }
    if (sequence === readSequence) reading = false;
    render();
  })());
  async function save(iconUrl: string | null): Promise<void> {
    if (!current || busy) return;
    if (reading) { message.textContent = "正在读取图标，请稍候…"; return; }
    busy = true;
    form.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    message.textContent = "正在保存…";
    try {
      const response = await options.api<{ connector: T }>(`/api/v1/admin/connectors/${encodeURIComponent(current.name)}/icon`, { method: "PUT", body: JSON.stringify({ iconUrl }) });
      options.onSaved(response.connector);
      dialog.close();
    } catch (error) { message.textContent = error instanceof Error ? error.message : "保存失败"; }
    finally { busy = false; form.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; }); }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void save(upload ?? (input.value.trim() || null)); });
  form.querySelector("[data-icon-reset]")!.addEventListener("click", () => void save(null));
  form.querySelector("[data-icon-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  return { open(connector) {
    current = connector; upload = undefined; readSequence++; reading = false; form.reset();
    input.value = connector.iconUrl ?? ""; message.textContent = "";
    form.querySelector("[data-icon-name]")!.textContent = connector.name;
    render(); dialog.showModal();
  } };
}
