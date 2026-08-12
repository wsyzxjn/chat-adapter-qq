/**
 * Bounded TTL set used to remember recently seen inbound message keys.
 *
 * Entries expire after `ttlMs`. When `maxEntries` is reached, the oldest key is
 * evicted so the set cannot grow without bound.
 */
export class TtlSeenSet {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  /**
   * Record `key` as seen.
   *
   * @returns `true` when the key is already present and unexpired (duplicate).
   */
  seen(key: string): boolean {
    if (!this.enabled) {
      return false;
    }

    this.prune();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > Date.now()) {
      return true;
    }

    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    this.entries.delete(key);
    this.entries.set(key, Date.now() + this.ttlMs);
    return false;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      } else {
        break;
      }
    }
  }
}
