import { getLocale } from "./i18n.js";
import "./promos.css";

interface PublicPromo { id: string; title: { zh: string; en: string }; body: { zh: string; en: string }; link?: string }
interface PublicPromos { promos: PublicPromo[]; newSurveys: Array<{ surveyId: string; newUntil: string }> }
const DISMISS_PREFIX = "astro-survey-atlas.promo-dismissed.";
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

/** Render dismissible banner strips directly below the site header. */
export async function mountPromoBanners(): Promise<void> {
  const header = document.querySelector("header.site-header");
  if (!header) return;
  const host = document.createElement("div");
  host.className = "promo-banners";
  host.setAttribute("role", "region");
  header.after(host);
  const promos = await fetchPromos();
  const render = (): void => {
    const locale = getLocale();
    host.replaceChildren(...promos.promos.filter((promo) => !dismissed(promo.id)).map((promo) => {
      const strip = document.createElement("div");
      strip.className = "promo-banner";
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = promo.title[locale] || promo.title.zh || promo.title.en;
      text.append(title);
      const body = promo.body[locale] || promo.body.zh || promo.body.en;
      if (body) text.append(` ${body}`);
      strip.append(text);
      if (promo.link) { const link = document.createElement("a"); link.href = promo.link; link.textContent = locale === "zh" ? "了解更多" : "Learn more"; strip.append(link); }
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", locale === "zh" ? "关闭" : "Dismiss");
      close.addEventListener("click", () => { try { window.localStorage.setItem(DISMISS_PREFIX + promo.id, "1"); } catch { /* private browsing */ } render(); });
      strip.append(close);
      return strip;
    }));
  };
  render();
  window.addEventListener("atlas:locale-change", render);
}
