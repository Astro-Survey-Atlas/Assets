import { Menu, Moon, Sun, X, createIcons } from "lucide";
import "./public.css";

export type SiteTheme = "light" | "dark";

const THEME_STORAGE_KEY = "asa-theme";
const LIGHT_LOGO_SRC = "/icon_without_name_lon_web.svg";
const DARK_LOGO_SRC = "/icon_without_name_lon_web_dark.svg";

function systemTheme(): SiteTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedTheme(): SiteTheme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function themeLabels(theme: SiteTheme): { label: string; title: string } {
  const chinese = document.documentElement.lang.toLowerCase().startsWith("zh");
  return theme === "dark"
    ? { label: chinese ? "切换到亮色模式" : "Use light theme", title: chinese ? "亮色模式" : "Light theme" }
    : { label: chinese ? "切换到暗色模式" : "Use dark theme", title: chinese ? "暗色模式" : "Dark theme" };
}

function renderChromeIcons(): void {
  document.querySelectorAll<HTMLElement>(".site-header").forEach((header) => {
    createIcons({ icons: { Menu, Moon, Sun, X }, attrs: { "aria-hidden": "true" }, root: header });
  });
}

function iconElement(name: string): HTMLElement {
  const element = document.createElement("i");
  element.dataset.lucide = name;
  return element;
}

function applyThemeLogos(theme: SiteTheme): void {
  const source = theme === "dark" ? DARK_LOGO_SRC : LIGHT_LOGO_SRC;
  document.querySelectorAll<HTMLImageElement>(".brand-logo").forEach((logo) => {
    if (logo.getAttribute("src") !== source) logo.setAttribute("src", source);
    logo.dataset.themeLogo = theme;
  });
}

export function applySiteTheme(theme: SiteTheme, persist = false): void {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* private browsing */ }
  }
  const labels = themeLabels(theme);
  applyThemeLogos(theme);
  document.querySelectorAll<HTMLElement>("[data-theme-toggle], #theme-toggle").forEach((toggle) => {
    toggle.setAttribute("aria-label", labels.label);
    toggle.setAttribute("title", labels.title);
    toggle.replaceChildren(iconElement(theme === "dark" ? "sun" : "moon"));
  });
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#25282d" : "#eef0f2";
  renderChromeIcons();
  window.dispatchEvent(new CustomEvent("atlas:theme-change", { detail: { theme } }));
}

export function mountSiteChrome(): void {
  const initial = storedTheme() ?? systemTheme();
  applySiteTheme(initial);

  document.querySelectorAll<HTMLElement>("[data-theme-toggle], #theme-toggle").forEach((toggle) => {
    if (toggle.dataset.themeBound === "true") return;
    toggle.dataset.themeBound = "true";
    toggle.addEventListener("click", () => {
      const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      applySiteTheme(current === "dark" ? "light" : "dark", true);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-mobile-menu-toggle]").forEach((toggle) => {
    if (toggle.dataset.menuBound === "true") return;
    toggle.dataset.menuBound = "true";
    const nav = toggle.closest("header")?.querySelector<HTMLElement>("[data-site-nav]");
    if (!nav) return;
    toggle.addEventListener("click", () => {
      const open = nav.dataset.open === "true";
      nav.dataset.open = String(!open);
      toggle.setAttribute("aria-expanded", String(!open));
      toggle.replaceChildren(iconElement(open ? "menu" : "x"));
      renderChromeIcons();
    });
    nav.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("a")) {
        nav.dataset.open = "false";
        toggle.setAttribute("aria-expanded", "false");
        toggle.replaceChildren(iconElement("menu"));
        renderChromeIcons();
      }
    });
  });

  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  media?.addEventListener?.("change", () => {
    if (!storedTheme()) applySiteTheme(systemTheme());
  });
}
