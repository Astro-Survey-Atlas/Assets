import { getLocale } from "./i18n.js";
import "./promos.css";

type PromoKind = "notice" | "new-survey" | "maintenance";
interface PublicPromo { id: string; kind?: PromoKind; surveyIds?: string[]; title: { zh: string; en: string }; body: { zh: string; en: string }; link?: string }
interface PublicPromos { promos: PublicPromo[]; newSurveys: Array<{ surveyId: string; newUntil: string }> }
const DISMISS_PREFIX = "astro-survey-atlas.promo-dismissed.";
const KIND_LABEL: Record<PromoKind, { zh: string; en: string; icon: string }> = {
  notice: { zh: "公告", en: "Notice", icon: "📣" },
  "new-survey": { zh: "新收录", en: "New", icon: "✦" },
  maintenance: { zh: "维护", en: "Maintenance", icon: "🛠" },
};
const ROTATE_MS = 6000;
let cached: Promise<PublicPromos> | undefined;

export function fetchPromos(): Promise<PublicPromos> {
  cached ??= fetch("/api/public/promos", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : { promos: [], newSurveys: [] }) as Promise<PublicPromos>)
    .catch(() => ({ promos: [], newSurveys: [] }));
  return cached;
}

function dismissed(id: string): boolean {
  try { return window.localStorage.getItem(DISMISS_PREFIX + id) === "1"; } catch { return false; }
}

/** Ids of surveys currently flagged NEW (newUntil still in the future). */
export function activeNewSurveyIds(promos: PublicPromos, now = Date.now()): Set<string> {
  return new Set(promos.newSurveys.filter((flag) => Date.parse(flag.newUntil) > now).map((flag) => flag.surveyId));
}

/** One card at a time, rotating when there are several; the whole carousel can be dismissed per promo id. */
export async function mountPromoBanners(): Promise<void> {
  const header = document.querySelector("header.site-header");
  if (!header) return;
  const host = document.createElement("section");
  host.className = "promo-carousel";
  host.setAttribute("aria-roledescription", "carousel");
  host.hidden = true;
  header.after(host);
  const promos = await fetchPromos();
  let index = 0;
  let timer: number | undefined;
  const visible = () => promos.promos.filter((promo) => !dismissed(promo.id));
  const render = (): void => {
    window.clearTimeout(timer);
    const items = visible();
    host.hidden = items.length === 0;
    if (!items.length) { host.replaceChildren(); return; }
    index = ((index % items.length) + items.length) % items.length;
    const promo = items[index]!;
    const locale = getLocale();
    const kind = KIND_LABEL[promo.kind ?? "notice"];
    const card = document.createElement("article");
    card.className = "promo-card";
    card.dataset.kind = promo.kind ?? "notice";
    card.setAttribute("aria-label", `${index + 1} / ${items.length}`);
    const surveyId = promo.surveyIds?.[0];
    if (promo.kind === "new-survey" && surveyId) {
      const image = document.createElement("img");
      image.className = "promo-thumb";
      image.src = `/surveys/${encodeURIComponent(surveyId)}.png`;
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      card.append(image);
    }
    const tag = document.createElement("span");
    tag.className = "promo-tag";
    tag.textContent = `${kind.icon} ${kind[locale]}`;
    const copy = document.createElement("div");
    copy.className = "promo-copy";
    const title = document.createElement("strong");
    title.textContent = promo.title[locale] || promo.title.zh || promo.title.en;
    copy.append(title);
    const body = promo.body[locale] || promo.body.zh || promo.body.en;
    if (body) copy.append(Object.assign(document.createElement("span"), { textContent: body }));
    card.append(tag, copy);
    if (promo.link) {
      const link = document.createElement("a");
      link.className = "promo-cta";
      link.href = promo.link;
      link.textContent = locale === "zh" ? "了解详情" : "Learn more";
      if (/^https?:/.test(promo.link)) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      card.append(link);
    }
    if (items.length > 1) {
      const dots = document.createElement("div");
      dots.className = "promo-dots";
      items.forEach((_, position) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "promo-dot";
        dot.setAttribute("aria-label", `${position + 1} / ${items.length}`);
        dot.setAttribute("aria-current", String(position === index));
        dot.addEventListener("click", () => { index = position; render(); });
        dots.append(dot);
      });
      card.append(dots);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "promo-close";
    close.textContent = "×";
    close.setAttribute("aria-label", locale === "zh" ? "关闭此公告" : "Dismiss");
    close.addEventListener("click", () => { try { window.localStorage.setItem(DISMISS_PREFIX + promo.id, "1"); } catch { /* private browsing */ } render(); });
    card.append(close);
    host.replaceChildren(card);
    if (items.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !host.matches(":hover")) {
      timer = window.setTimeout(() => { index += 1; render(); }, ROTATE_MS);
    }
  };
  host.addEventListener("mouseleave", render);
  host.addEventListener("mouseenter", () => window.clearTimeout(timer));
  host.addEventListener("focusin", () => window.clearTimeout(timer));
  render();
  window.addEventListener("atlas:locale-change", render);
}
