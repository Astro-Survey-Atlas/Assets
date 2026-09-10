import { Archive, Check, Copy, Download, Package, RefreshCw, Telescope, createIcons } from "lucide";
import { locale, mountLocaleControls, t } from "../src/i18n.js";
import { mountSiteChrome as mountChrome } from "../src/site-chrome.js";
import "../src/public.css";

interface ReleaseHistoryRelease {
  id: string;
  label: string;
  kind?: string;
  releasedYear?: number;
  modalities: string[];
  layerCount: number;
}

interface ReleaseHistorySource {
  releaseId: string;
  label: string;
  url: string;
  authority: string;
}

interface ReleaseHistoryPackage {
  id: string;
  version: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  survey?: { id: string; displayName: string; mission?: string };
  facilities?: string[];
  modalities?: string[];
  releases?: ReleaseHistoryRelease[];
  accessModes?: string[];
  sources?: ReleaseHistorySource[];
}

interface ReleaseHistoryCollection {
  fileName: string;
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
  collection?: ReleaseHistoryCollection;
  packages: ReleaseHistoryPackage[];
}

interface ReleaseHistoryDocument {
  schemaVersion: number;
  latestReleaseId?: string;
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
  createIcons({ icons: { Archive, Check, Copy, Download, Package, RefreshCw, Telescope } });
}

function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function bindCopyButton(button: HTMLButtonElement, icon: HTMLElement, text: string): void {
  button.addEventListener("click", () => {
    void copyToClipboard(text).then((copied) => {
      if (!copied) return;
      icon.dataset.lucide = "check";
      button.classList.add("is-copied");
      renderIcons();
      window.setTimeout(() => {
        icon.dataset.lucide = "copy";
        button.classList.remove("is-copied");
        renderIcons();
      }, 1600);
    });
  });
}

function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function modalityBadges(modalities: string[]): HTMLElement {
  const container = document.createElement("span");
  container.className = "release-modality-badges";
  for (const modality of modalities) {
    const badge = document.createElement("span");
    badge.className = "release-modality-badge";
    badge.textContent = modality;
    container.append(badge);
  }
  return container;
}

function copyButtonFor(url: string): { button: HTMLButtonElement; icon: HTMLElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button release-copy-api";
  button.title = t("page.releases.copyApi");
  button.setAttribute("aria-label", t("page.releases.copyApi"));
  const icon = document.createElement("i");
  icon.dataset.lucide = "copy";
  button.append(icon);
  bindCopyButton(button, icon, absoluteUrl(url));
  return { button, icon };
}

function checksumCode(sha256: string): HTMLElement {
  const checksum = document.createElement("code");
  checksum.className = "release-package-sha";
  checksum.title = `${t("page.releases.checksum")}: ${sha256}`;
  checksum.textContent = `${sha256.slice(0, 12)}…`;
  return checksum;
}

function downloadLinkFor(url: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "release-download";
  link.href = url;
  link.textContent = label;
  const icon = document.createElement("i");
  icon.dataset.lucide = "download";
  link.prepend(icon);
  return link;
}

function collectionRow(collection: ReleaseHistoryCollection): HTMLElement {
  const row = document.createElement("div");
  row.className = "release-collection-row";

  const title = document.createElement("span");
  title.className = "release-collection-title";
  const icon = document.createElement("i");
  icon.dataset.lucide = "archive";
  title.append(icon);
  const text = document.createElement("span");
  text.textContent = t("page.releases.collectionDownload");
  title.append(text);

  const meta = document.createElement("span");
  meta.className = "release-package-meta";
  meta.textContent = formatBytes(collection.sizeBytes);

  const checksum = checksumCode(collection.sha256);

  const actions = document.createElement("span");
  actions.className = "release-package-actions";
  const { button } = copyButtonFor(collection.downloadUrl);
  actions.append(button, downloadLinkFor(collection.downloadUrl, t("page.releases.download")));

  row.append(title, meta, checksum, actions);
  return row;
}

function drRow(entry: ReleaseHistoryRelease): HTMLElement {
  const row = document.createElement("li");
  row.className = "release-dr";

  const title = document.createElement("span");
  title.className = "release-dr-title";
  title.textContent = entry.label;

  const detail = document.createElement("span");
  detail.className = "release-dr-meta";
  const parts: string[] = [];
  if (entry.releasedYear) parts.push(String(entry.releasedYear));
  parts.push(`${String(entry.layerCount)} ${t("page.releases.layersUnit")}`);
  detail.textContent = parts.join(" · ");

  row.append(title, modalityBadges(entry.modalities), detail);
  return row;
}

function sourceRow(source: ReleaseHistorySource): HTMLElement {
  const row = document.createElement("li");
  row.className = "release-source";

  const label = document.createElement("a");
  label.className = "release-source-link";
  label.href = source.url;
  label.target = "_blank";
  label.rel = "noopener noreferrer";
  label.textContent = source.label;

  const authority = document.createElement("span");
  authority.className = "release-modality-badge";
  authority.textContent = source.authority;

  const releaseId = document.createElement("code");
  releaseId.className = "release-package-version";
  releaseId.textContent = source.releaseId;

  row.append(label, authority, releaseId);
  return row;
}

function surveyEntry(pkg: ReleaseHistoryPackage): HTMLElement {
  const details = document.createElement("details");
  details.className = "release-survey";

  const summary = document.createElement("summary");
  summary.className = "release-survey-summary";

  const title = document.createElement("span");
  title.className = "release-survey-title";
  const icon = document.createElement("i");
  icon.dataset.lucide = "telescope";
  title.append(icon);
  const name = document.createElement("span");
  name.textContent = pkg.survey?.displayName ?? pkg.name;
  title.append(name);
  if (pkg.survey?.mission) {
    const mission = document.createElement("small");
    mission.className = "release-survey-mission";
    mission.textContent = pkg.survey.mission;
    title.append(mission);
  }

  const meta = document.createElement("span");
  meta.className = "release-survey-meta";
  const version = document.createElement("code");
  version.className = "release-package-version";
  version.textContent = pkg.version;
  const size = document.createElement("span");
  size.textContent = formatBytes(pkg.sizeBytes);
  meta.append(version, size);

  const checksum = checksumCode(pkg.sha256);

  const actions = document.createElement("span");
  actions.className = "release-package-actions";
  const { button } = copyButtonFor(pkg.downloadUrl);
  actions.append(button, downloadLinkFor(pkg.downloadUrl, t("page.releases.download")));

  summary.append(title, modalityBadges(pkg.modalities ?? []), meta, checksum, actions);

  const body = document.createElement("div");
  body.className = "release-survey-body";
  if ((pkg.accessModes ?? []).length > 0) {
    const accessHeading = document.createElement("p");
    accessHeading.className = "release-dr-heading";
    accessHeading.textContent = t("page.releases.accessLabel");
    body.append(accessHeading, modalityBadges(pkg.accessModes ?? []));
  }
  const heading = document.createElement("p");
  heading.className = "release-dr-heading";
  heading.textContent = t("page.releases.drLabel");
  body.append(heading);
  const list = document.createElement("ul");
  list.className = "release-dr-list";
  for (const release of pkg.releases ?? []) {
    list.append(drRow(release));
  }
  body.append(list);
  if ((pkg.sources ?? []).length > 0) {
    const sourcesHeading = document.createElement("p");
    sourcesHeading.className = "release-dr-heading";
    sourcesHeading.textContent = t("page.releases.sourcesLabel");
    body.append(sourcesHeading);
    const sources = document.createElement("ul");
    sources.className = "release-source-list";
    for (const source of pkg.sources ?? []) {
      sources.append(sourceRow(source));
    }
    body.append(sources);
  }

  details.append(summary, body);
  return details;
}

function releaseEntry(release: ReleaseHistoryEntry, index: number, isLatest: boolean): HTMLElement {
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

  if (isLatest) {
    const badge = document.createElement("span");
    badge.className = "release-current-badge";
    badge.textContent = t("page.releases.currentBadge");
    heading.append(badge);
  }

  const meta = document.createElement("span");
  meta.className = "release-entry-meta";
  meta.textContent = `${t("page.releases.sequence")} ${String(release.sequence)} · ${formatDate(release.releasedAt)} · ${t("page.releases.surveysLabel")} ${String(release.packages.length)}`;

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

  if (release.collection) {
    body.append(collectionRow(release.collection));
  }

  const list = document.createElement("div");
  list.className = "release-survey-list";
  const sorted = [...release.packages].sort((a, b) => {
    const left = a.survey?.displayName ?? a.name;
    const right = b.survey?.displayName ?? b.name;
    return left.localeCompare(right) || a.id.localeCompare(b.id);
  });
  for (const pkg of sorted) {
    list.append(surveyEntry(pkg));
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
  const latestReleaseId = history.latestReleaseId ?? releases[0]?.releaseId;
  releaseList.replaceChildren();
  releases.forEach((release, index) => {
    releaseList.append(releaseEntry(release, index, release.releaseId === latestReleaseId));
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
    if ((history.schemaVersion !== 2 && history.schemaVersion !== 1) || !Array.isArray(history.releases)) {
      throw new Error("Unexpected release history schema");
    }
    render(history);
  } catch {
    renderError();
  }
}

function renderCodeLines(code: HTMLElement, source: string): void {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const container = document.createElement("span");
  container.className = "release-code-lines";
  lines.forEach((line, index) => {
    const row = document.createElement("span");
    row.className = "release-code-line";
    const number = document.createElement("span");
    number.className = "release-code-line-no";
    number.textContent = String(index + 1);
    const text = document.createElement("span");
    text.className = "release-code-line-text";
    text.textContent = line;
    row.append(number, text);
    container.append(row);
  });
  code.replaceChildren(container);
}

const exampleSources = new Map<string, string>();

function activeExampleTab(): string {
  return document.querySelector<HTMLButtonElement>(".release-code-tab.is-active")?.dataset.codeTab ?? "curl";
}

function exampleCodeElement(tab: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#release-pane-${tab} .release-code`);
}

async function loadExampleSource(tab: string): Promise<void> {
  const code = exampleCodeElement(tab);
  const src = code?.dataset.src;
  if (!code || !src || code.dataset.loaded === "1") return;
  code.dataset.loaded = "loading";
  code.textContent = `${t("page.releases.loadingExample")}\n`;
  try {
    const response = await window.fetch(src, { headers: { accept: "text/plain" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    exampleSources.set(tab, source);
    renderCodeLines(code, source);
    code.dataset.loaded = "1";
  } catch {
    delete code.dataset.loaded;
    code.textContent = `${t("page.releases.loadExampleError")}\n`;
  }
}

function mountExampleTabs(): void {
  const panel = document.querySelector<HTMLElement>("#release-example-panel");
  if (!panel) return;
  const curlCode = exampleCodeElement("curl");
  if (curlCode && !curlCode.dataset.src) exampleSources.set("curl", curlCode.textContent ?? "");

  for (const button of panel.querySelectorAll<HTMLButtonElement>(".release-code-tab")) {
    button.addEventListener("click", () => {
      const tab = button.dataset.codeTab;
      if (!tab) return;
      for (const other of panel.querySelectorAll<HTMLButtonElement>(".release-code-tab")) {
        const active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-selected", active ? "true" : "false");
      }
      for (const pane of panel.querySelectorAll<HTMLElement>(".release-code-pane")) {
        const active = pane.id === `release-pane-${tab}`;
        pane.classList.toggle("is-active", active);
        pane.toggleAttribute("hidden", !active);
      }
      void loadExampleSource(tab);
    });
  }

  const copyButton = panel.querySelector<HTMLButtonElement>("#release-code-copy");
  if (copyButton) {
    const icon = copyButton.querySelector("i");
    copyButton.addEventListener("click", () => {
      const source = exampleSources.get(activeExampleTab()) ?? exampleCodeElement(activeExampleTab())?.textContent ?? "";
      void copyToClipboard(source).then((copied) => {
        if (!copied || !icon) return;
        icon.dataset.lucide = "check";
        copyButton.classList.add("is-copied");
        renderIcons();
        window.setTimeout(() => {
          icon.dataset.lucide = "copy";
          copyButton.classList.remove("is-copied");
          renderIcons();
        }, 1600);
      });
    });
  }
}

mountLocaleControls();
mountChrome();
mountExampleTabs();
window.addEventListener("atlas:locale-change", () => {
  void load();
});
void load();
