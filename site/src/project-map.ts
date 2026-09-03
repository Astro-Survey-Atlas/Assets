interface Point {
  x: number;
  y: number;
}

interface Route {
  d: string;
  label: Point;
}

const host = document.querySelector<HTMLElement>("[data-project-execution-map]");

function relativeRect(element: HTMLElement, origin: DOMRect): DOMRect {
  const rect = element.getBoundingClientRect();
  return new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
}

function routeToSide(source: DOMRect, target: DOMRect, side: "left" | "right"): Route {
  const inset = Math.min(64, Math.max(24, source.width * 0.12));
  const sourceX = side === "left" ? source.left + inset : source.right - inset;
  const targetX = side === "left" ? target.left : target.right;
  const targetY = target.top + target.height * 0.5;
  const labelX = side === "left"
    ? (sourceX + target.left) / 2
    : (sourceX + target.right) / 2;
  const d = `M ${sourceX.toFixed(1)} ${source.bottom.toFixed(1)} V ${targetY.toFixed(1)} H ${targetX.toFixed(1)}`;
  return { d, label: { x: labelX, y: targetY - 14 } };
}

function routeAroundStack(source: DOMRect, target: DOMRect, trackX: number, side: "left" | "right", label: Point): Route {
  const inset = Math.min(48, Math.max(20, source.width * 0.14));
  const sourceX = side === "left" ? source.left + inset : source.right - inset;
  const targetX = side === "left" ? target.left : target.right;
  const targetY = target.top + target.height * 0.5;
  const d = `M ${sourceX.toFixed(1)} ${source.bottom.toFixed(1)} H ${trackX.toFixed(1)} V ${targetY.toFixed(1)} H ${targetX.toFixed(1)}`;
  return { d, label: { x: label.x, y: label.y } };
}

function renderMap(): void {
  if (!host) return;
  const svg = host.querySelector<SVGSVGElement>("[data-project-execution-graph]");
  const assets = host.querySelector<HTMLElement>("[data-project-node='assets']");
  const warehouse = host.querySelector<HTMLElement>("[data-project-node='warehouse']");
  const workspace = host.querySelector<HTMLElement>("[data-project-node='workspace']");
  if (!svg || !assets || !warehouse || !workspace) return;

  const origin = host.getBoundingClientRect();
  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const assetRect = relativeRect(assets, origin);
  const warehouseRect = relativeRect(warehouse, origin);
  const workspaceRect = relativeRect(workspace, origin);
  const compact = width < 680;
  const routes = compact
    ? (() => {
        const trackPadding = Math.max(10, Math.min(16, width * 0.045));
        const leftTrack = Math.max(6, Math.min(assetRect.left, workspaceRect.left, warehouseRect.left) - trackPadding);
        const rightTrack = Math.min(width - 6, Math.max(assetRect.right, workspaceRect.right, warehouseRect.right) + trackPadding);
        const labelY = (workspaceRect.bottom + warehouseRect.top) / 2;
        return {
          asset: routeAroundStack(assetRect, warehouseRect, leftTrack, "left", { x: width * 0.25, y: labelY }),
          workspace: routeAroundStack(workspaceRect, warehouseRect, rightTrack, "right", { x: width * 0.75, y: labelY }),
        };
      })()
    : {
        asset: routeToSide(assetRect, warehouseRect, "left"),
        workspace: routeToSide(workspaceRect, warehouseRect, "right"),
      };
  const assetRoute = routes.asset;
  const workspaceRoute = routes.workspace;
  const edge = (key: string): SVGPathElement | null => svg.querySelector<SVGPathElement>(`[data-project-edge='${key}']`);
  edge("assets-warehouse")?.setAttribute("d", assetRoute.d);
  edge("workspace-warehouse")?.setAttribute("d", workspaceRoute.d);

  const placeLabel = (key: string, point: Point): void => {
    const label = host.querySelector<HTMLElement>(`[data-project-label='${key}']`);
    if (!label) return;
    label.style.left = `${point.x}px`;
    label.style.top = `${point.y}px`;
  };
  placeLabel("assets-warehouse", assetRoute.label);
  placeLabel("workspace-warehouse", workspaceRoute.label);
}

if (host) {
  renderMap();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(renderMap);
    observer.observe(host);
    host.querySelectorAll<HTMLElement>("[data-project-node]").forEach((node) => observer.observe(node));
  }
  window.addEventListener("resize", renderMap, { passive: true });
}
