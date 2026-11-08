// Carrier responses are untrusted. These helpers read fields without trusting their types.

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A trimmed string, or "" for anything that is not a non-empty string. */
export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A trimmed string, or null when empty. */
export function strOrNull(value: unknown): string | null {
  return str(value) || null;
}
