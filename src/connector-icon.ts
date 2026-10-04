export interface ScanConnectorIdentity {
  name: string;
  type: string;
  iconUrl?: string;
  /** A retained run or locked batch scope establishes the source identity. */
  identityBasis: "scan-run" | "scan-scope";
}

/** The default is shared by Connector management and scanned-source views. */
export function connectorDefaultIcon(type?: string): string {
  const normalized = String(type ?? "").toLowerCase();
  if (normalized === "s3" || normalized === "oss") return "cloud";
  if (["local", "pvc", "filesystem", "file-system"].includes(normalized)) return "hard-drive";
  if (["jdbc", "database", "postgres", "mysql"].includes(normalized)) return "database";
  return "plug";
}
