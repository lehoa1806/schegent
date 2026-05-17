// Feature 048 — small LRU memo helper for the per-domain projectors. Each
// projector that wraps `memoize()` keys on a deterministic signature
// (typically a `JSON.stringify` of the inputs that affect its output) and
// caches the last `capacity` projections. Memoization is opt-in; the
// orchestrator only wraps projectors whose inputs change rarely relative to
// the snapshot publish cadence (e.g. queue + history). Bookkeeping-driven
// projections (live activity, phase elapsed) read monotonic time and are
// NOT memoizable.
export interface MemoEntry<V> {
  readonly key: string;
  readonly value: V;
}

export class LruMemo<V> {
  private readonly entries: MemoEntry<V>[] = [];
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('LruMemo capacity must be >= 1');
  }

  public get(key: string): V | undefined {
    const idx = this.entries.findIndex((entry) => entry.key === key);
    if (idx === -1) return undefined;
    const [hit] = this.entries.splice(idx, 1);
    this.entries.push(hit);
    return hit.value;
  }

  public set(key: string, value: V): void {
    const idx = this.entries.findIndex((entry) => entry.key === key);
    if (idx !== -1) this.entries.splice(idx, 1);
    this.entries.push({ key, value });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  public clear(): void {
    this.entries.length = 0;
  }

  public get size(): number {
    return this.entries.length;
  }
}

/**
 * Wrap a pure projector with an LRU memo. The signer function MUST be
 * deterministic on the projector's input — any field the projector reads
 * but the signer omits will result in stale projections.
 */
export function memoize<I, O>(
  project: (input: I) => O,
  sign: (input: I) => string,
  capacity = 4
): (input: I) => O {
  const memo = new LruMemo<O>(capacity);
  return (input: I): O => {
    const key = sign(input);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const fresh = project(input);
    memo.set(key, fresh);
    return fresh;
  };
}
