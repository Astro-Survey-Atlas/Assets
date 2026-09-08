import { Check, Copy, Download, Package, RefreshCw, createIcons } from "lucide";
import { locale, mountLocaleControls, t } from "../src/i18n.js";
import { mountSiteChrome as mountChrome } from "../src/site-chrome.js";
import "../src/public.css";

interface ReleaseHistoryPackage {
  id: string;
  version: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
}

interface ReleaseHistoryEntry {
  releaseId: string;
  sequence: number;
  bundleId: string;
  releasedAt: string;
  notes?: string;
  packages: ReleaseHistoryPackage[];
}

interface ReleaseHistoryDocument {
  schemaVersion: 1;
  releases: ReleaseHistoryEntry[];
}

const releaseList = document.querySelector<HTMLDivElement>("#release-list");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function renderIcons(): void {
  createIcons({ icons: { Check, Copy, Download, Package, RefreshCw } });
}

function packageRow(pkg: ReleaseHistoryPackage): HTMLElement {
  const row = document.createElement("li");
  row.className = "release-package";

  const title = document.createElement("span");
  title.className = "release-package-name";
  title.textContent = pkg.name || pkg.id;

  const version = document.createElement("code");
  version.className = "release-package-version";
  version.textContent = pkg.version;

  const meta = document.createElement("span");
  meta.className = "release-package-meta";
  meta.textContent = formatBytes(pkg.sizeBytes);

  const checksum = document.createElement("code");
  checksum.className = "release-package-sha";
  checksum.title = `${t("page.releases.checksum")}: ${pkg.sha256}`;
  checksum.textContent = `${pkg.sha256.slice(0, 12)}…`;

  const actions = document.createElement("span");
  actions.className = "release-package-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "icon-button release-copy-api";
  copyButton.dataset.i18nTitleFallback = t("page.releases.copyApi");
  copyButton.title = t("page.releases.copyApi");
  copyButton.setAttribute("aria-label", t("page.releases.copyApi"));
  const copyIcon = document.createElement("i");
  copyIcon.dataset.lucide = "copy";
  copyButton.append(copyIcon);
  copyButton.addEventListener("click", () => {
    void navigator.clipboard.writeText(new URL(pkg.downloadUrl, window.location.origin).toString()).then(() => {
      copyIcon.dataset.lucide = "check";
      copyButton.classList.add("is-copied");
      renderIcons();
      window.setTimeout(() => {
        copyIcon.dataset.lucide = "copy";
        copyButton.classList.remove("is-copied");
        renderIcons();
      }, 1600);
    });
  });

  const downloadLink = document.createElement("a");
  downloadLink.className = "release-download";
  downloadLink.href = pkg.downloadUrl;
  downloadLink.textContent = t("page.releases.download");
  const downloadIcon = document.createElement("i");
  downloadIcon.dataset.lucide = "download";
  downloadLink.prepend(downloadIcon);

  actions.append(copyButton, downloadLink);
  row.append(title, version, meta, checksum, actions);
  return row;
}

function releaseEntry(release: ReleaseHistoryEntry, index: number, isCurrent: boolean): HTMLElement {
  const details = document.createElement("details");
  details.className = "release-entry";
  if (index === 0) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "release-entry-summary";

  const heading = document.createElement("span");
  heading.className = "release-entry-title";
  const packageIcon = document.createElement("i");
  packageIcon.dataset.lucide = "package";
  heading.append(packageIcon);
  const label = document.createElement("code");
  label.textContent = release.releaseId;
  heading.append(label);

  if (isCurrent) {
    const badge = document.createElement("span");
    badge.className = "release-current-badge";
    badge.textContent = t("page.releases.currentBadge");
    heading.append(badge);
  }

  const meta = document.createElement("span");
  meta.className = "release-entry-meta";
  meta.textContent = `${t("page.releases.sequence")} ${String(release.sequence)} · ${formatDate(release.releasedAt)} · ${t("page.releases.packagesLabel")} ${String(release.packages.length)}`;

  summary.append(heading, meta);

  const body = document.createElement("div");
  body.className = "release-entry-body";

  const facts = document.createElement("p");
  facts.className = "release-entry-facts";
  facts.textContent = `${t("page.releases.bundleId")}: ${release.bundleId}`;
  body.append(facts);

  if (release.notes) {
    const notes = document.createElement("p");
    notes.className = "release-entry-notes";
    notes.textContent = `${t("page.releases.notes")}: ${release.notes}`;
    body.append(notes);
  }

  const list = document.createElement("ul");
  list.className = "release-package-list";
  for (const pkg of [...release.packages].sort((a, b) => a.id.localeCompare(b.id))) {
    list.append(packageRow(pkg));
  }
  body.append(list);

  details.append(summary, body);
  return details;
}

function renderEmpty(): void {
  if (!releaseList) return;
  releaseList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "release-placeholder";
  empty.textContent = t("page.releases.empty");
  releaseList.append(empty);
}

function renderError(): void {
  if (!releaseList) return;
  releaseList.replaceChildren();
  const error = document.createElement("p");
  error.className = "release-placeholder release-error";
  error.textContent = t("page.releases.loadError");

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "release-retry";
  retry.textContent = t("page.releases.retry");
  const retryIcon = document.createElement("i");
  retryIcon.dataset.lucide = "refresh-cw";
  retry.prepend(retryIcon);
  retry.addEventListener("click", () => {
    void load();
  });

  releaseList.append(error, retry);
  renderIcons();
}

function render(history: ReleaseHistoryDocument): void {
  if (!releaseList) return;
  const releases = [...history.releases].sort((a, b) => b.sequence - a.sequence);
  if (releases.length === 0) {
    renderEmpty();
    return;
  }
  releaseList.replaceChildren();
  releases.forEach((release, index) => {
    releaseList.append(releaseEntry(release, index, index === 0));
  });
  renderIcons();
}

async function load(): Promise<void> {
  if (!releaseList) return;
  const placeholder = document.createElement("p");
  placeholder.className = "release-placeholder";
  placeholder.textContent = "…";
  releaseList.replaceChildren(placeholder);
  try {
    const response = await window.fetch("/api/v1/releases", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = (await response.json()) as ReleaseHistoryDocument;
    if (history.schemaVersion !== 1 || !Array.isArray(history.releases)) throw new Error("Unexpected release history schema");
    render(history);
  } catch {
    renderError();
  }
}

mountLocaleControls();
mountChrome();
window.addEventListener("atlas:locale-change", () => {
  void load();
});
void load();
