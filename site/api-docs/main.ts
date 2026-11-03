import SwaggerUI from "swagger-ui-dist/swagger-ui-bundle.js";
import "swagger-ui-dist/swagger-ui.css";
import { mountLocaleControls, t } from "../src/i18n.js";
import { mountSiteChrome } from "../src/site-chrome.js";
import "./styles.css";

mountLocaleControls(); mountSiteChrome();
SwaggerUI({ dom_id: "#swagger-ui", url: "/api/v1/openapi.json", validatorUrl: null, persistAuthorization: false, displayRequestDuration: true, docExpansion: "list", deepLinking: true, queryConfigEnabled: false, supportedSubmitMethods: ["get", "post"], defaultModelsExpandDepth: -1 });
let status: { status: string; publicRelease: { id: string; publishedMocLayers: number }; nativeIndex: { version: string; managed: boolean; verified: boolean }; services: Array<{ id: string; status: string }> } | undefined;
let unavailable = false;
function render(): void {
  const root = document.getElementById("api-status")!;
  root.replaceChildren();
  root.classList.remove("is-unavailable");
  if (!status) {
    const message = document.createElement("p"); message.className = unavailable ? "api-status-error" : "api-status-loading";
    message.textContent = t(unavailable ? "api.unavailable" : "api.loading");
    if (unavailable) root.classList.add("is-unavailable");
    root.append(message);
    return;
  }

  const overview = document.createElement("div"); overview.className = "api-status-overview";
  const heading = document.createElement("div"); heading.className = "api-status-heading";
  const label = document.createElement("p"); label.className = "api-status-label"; label.textContent = t("api.status");
  const state = document.createElement("span"); state.className = "api-status-state"; state.dataset.status = status.status.toLowerCase();
  const indicator = document.createElement("span"); indicator.className = "api-status-indicator"; indicator.setAttribute("aria-hidden", "true");
  const stateName = document.createElement("strong"); stateName.textContent = status.status;
  state.append(indicator, stateName);
  heading.append(label, state);

  const releaseFacts = document.createElement("div"); releaseFacts.className = "api-status-release";
  const layerCount = document.createElement("strong"); layerCount.className = "api-status-layer-count"; layerCount.textContent = String(status.publicRelease.publishedMocLayers);
  const layerLabel = document.createElement("span"); layerLabel.textContent = t("api.mocLayers");
  const releaseLabel = document.createElement("span"); releaseLabel.className = "api-status-release-label"; releaseLabel.textContent = t("api.publicRelease");
  const releaseId = document.createElement("code"); releaseId.className = "api-status-release-id"; releaseId.textContent = status.publicRelease.id;
  releaseFacts.append(layerCount, layerLabel, releaseLabel, releaseId);
  overview.append(heading, releaseFacts);

  const index = document.createElement("div"); index.className = "api-native-index";
  const indexLabel = document.createElement("span"); indexLabel.className = "api-native-index-label"; indexLabel.textContent = t("api.nativeIndex");
  const indexVersion = document.createElement("code"); indexVersion.textContent = status.nativeIndex.version;
  const indexState = document.createElement("span"); indexState.className = "api-native-index-state";
  indexState.textContent = `${t(status.nativeIndex.managed ? "api.indexManaged" : "api.indexUnmanaged")} · ${t(status.nativeIndex.verified ? "api.indexVerified" : "api.indexUnverified")}`;
  index.append(indexLabel, indexVersion, indexState);

  const list = document.createElement("ul");
  list.className = "api-service-list";
  for (const service of status.services) {
    const item = document.createElement("li"); item.className = "api-service";
    const name = document.createElement("code"); name.className = "api-service-name"; name.textContent = service.id;
    const serviceState = document.createElement("span"); serviceState.className = "api-service-state"; serviceState.dataset.status = service.status.toLowerCase();
    const serviceIndicator = document.createElement("span"); serviceIndicator.className = "api-status-indicator"; serviceIndicator.setAttribute("aria-hidden", "true");
    const serviceLabel = document.createElement("span"); serviceLabel.textContent = service.status;
    serviceState.append(serviceIndicator, serviceLabel);
    item.append(name, serviceState);
    list.append(item);
  }
  root.append(overview, index, list);
}
async function loadStatus(): Promise<void> {
  try { const response = await fetch("/api/v1/status", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); status = await response.json(); unavailable = false; render(); }
  catch { unavailable = true; render(); }
}
window.addEventListener("atlas:locale-change", render);
void loadStatus();
