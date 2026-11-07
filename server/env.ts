/**
 * Environment switches accept 1/true/yes/on as true; anything else, including
 * an empty string, falls back. One rule for every ASSETS_* boolean flag.
 */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
