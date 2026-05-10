/** Parse cursor token to in-memory message index. */
export function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return null;
  }
  const value = Number(cursor);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Parse QQ timestamp (seconds/milliseconds/ISO string) to Date.
 *
 * @param fallbackToNow When true, invalid or empty input falls back to `new Date()`.
 */
export function parseQQTimestamp(value: string | undefined, fallbackToNow: true): Date;
export function parseQQTimestamp(value: string | undefined, fallbackToNow: false): Date | null;
export function parseQQTimestamp(value: string | undefined, fallbackToNow: boolean): Date | null {
  if (!value) {
    return fallbackToNow ? new Date() : null;
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber > 10_000_000_000 ? asNumber : asNumber * 1000);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  return fallbackToNow ? new Date() : null;
}
