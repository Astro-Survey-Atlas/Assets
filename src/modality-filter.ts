export interface ModalityRecord {
  modality?: string;
}

export function canonicalModality(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "image" || normalized === "imaging") return "imaging";
  if (normalized === "spectrum" || normalized === "spectra" || normalized === "spectroscopy") return "spectroscopy";
  return normalized;
}

export function filterByModalities<T extends ModalityRecord>(records: readonly T[], modalities: Iterable<string>): T[] {
  const selected = new Set([...modalities].map(canonicalModality).filter(Boolean));
  if (!selected.size) return [...records];
  return records.filter((record) => selected.has(canonicalModality(record.modality)));
}
