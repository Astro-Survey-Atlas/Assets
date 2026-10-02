import SwaggerUI from "swagger-ui-dist/swagger-ui-bundle.js";
import "swagger-ui-dist/swagger-ui.css";
import { mountLocaleControls, t } from "../src/i18n.js";
import { mountSiteChrome } from "../src/site-chrome.js";
import "./styles.css";

mountLocaleControls(); mountSiteChrome();
SwaggerUI({ dom_id: "#swagger-ui", url: "/api/v1/openapi.json", validatorUrl: null, persistAuthorization: false, displayRequestDuration: true, docExpansion: "list", deepLinking: true, queryConfigEnabled: false, supportedSubmitMethods: ["get", "post"], defaultModelsExpandDepth: -1 });
let status: { status: string; publicRelease: { id: string; publishedMocLayers: number }; nativeIndex: { version: string; managed: boolean }; services: Array<{ id: string; status: string }> } | undefined;
function render(): void {
  const root = document.getElementById("api-status")!;
  root.replaceChildren();
  if (!status) return;
  const label = document.createElement("p"); label.textContent = `${t("api.status")}: ${status.status} · ${status.publicRelease.publishedMocLayers} MOC layers · ${status.publicRelease.id}`; root.append(label);
  const list = document.createElement("ul");
  for (const service of status.services) { const item = document.createElement("li"); item.textContent = `${service.id}: ${service.status}`; list.append(item); }
  root.append(list);
}
async function refresh(): Promise<void> {
  const button = document.getElementById("api-status-refresh") as HTMLButtonElement; button.disabled = true;
  try { const response = await fetch("/api/v1/status", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); status = await response.json(); render(); }
  catch { document.getElementById("api-status")!.textContent = t("api.unavailable"); }
  finally { button.disabled = false; }
}
document.getElementById("api-status-refresh")!.addEventListener("click", () => { void refresh(); });
window.addEventListener("atlas:locale-change", render);
void refresh();
