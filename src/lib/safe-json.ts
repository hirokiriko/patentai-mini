export function parseJsonOrNull<T>(
  value: string | null | undefined,
  label: string
): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(`[safe-json] Failed to parse ${label}:`, error);
    return null;
  }
}
