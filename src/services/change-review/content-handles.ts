/**
 * FR-R6-F12 (research R3 and R8) — live reviews and their opaque content handles.
 *
 * A handle is 16 random bytes in base64url. It names one side of one change in one live review and
 * carries nothing a reader could turn into a path or an object identity. The registry keeps at most
 * `max` reviews in host memory (NFR-003); adding one past the limit evicts the oldest together with
 * every handle it issued, so a stale editor tab reads the `unavailable` sentence and never another
 * review's content.
 */

const HANDLE_BYTES = 16;

/** One side of one change, as the host reads it back. Never sent to a surface. */
export interface ContentResource {
  readonly handle: string;
  readonly reviewId: string;
  readonly blob: string;
  readonly mode: string;
  readonly binary: boolean;
}

export type RandomBytes = (size: number) => Uint8Array;

/** A fresh opaque identifier: 22 base64url characters. */
export function opaqueId(random: RandomBytes): string {
  return Buffer.from(random(HANDLE_BYTES)).toString('base64url');
}

export interface ReviewRegistry<R> {
  /** Keeps `value` and its resources; returns the ids evicted to stay within the limit. */
  add(reviewId: string, value: R, resources: readonly ContentResource[]): string[];
  get(reviewId: string): R | null;
  resource(handle: string): ContentResource | null;
  /** Drops the review and its handles; `false` when it was not live. */
  close(reviewId: string): boolean;
  /** Replaces a live review's value; `false` when it was not live. */
  replace(reviewId: string, value: R): boolean;
  size(): number;
}

interface LiveReview<R> {
  readonly value: R;
  readonly handles: readonly string[];
}

/** A registry keeping at most `max` live reviews, oldest evicted first. */
export function createReviewRegistry<R>(max: number): ReviewRegistry<R> {
  const reviews = new Map<string, LiveReview<R>>();
  const resources = new Map<string, ContentResource>();

  const drop = (reviewId: string): boolean => {
    const live = reviews.get(reviewId);
    if (live === undefined) return false;
    for (const handle of live.handles) resources.delete(handle);
    reviews.delete(reviewId);
    return true;
  };

  const evictOldest = (): string[] => {
    const evicted: string[] = [];
    for (const reviewId of reviews.keys()) {
      if (reviews.size <= max) break;
      drop(reviewId);
      evicted.push(reviewId);
    }
    return evicted;
  };

  return {
    add: (reviewId, value, added) => {
      drop(reviewId);
      for (const resource of added) resources.set(resource.handle, resource);
      reviews.set(reviewId, { value, handles: added.map((resource) => resource.handle) });
      return evictOldest();
    },
    get: (reviewId) => reviews.get(reviewId)?.value ?? null,
    resource: (handle) => resources.get(handle) ?? null,
    close: drop,
    replace: (reviewId, value) => {
      const live = reviews.get(reviewId);
      if (live === undefined) return false;
      reviews.set(reviewId, { value, handles: live.handles });
      return true;
    },
    size: () => reviews.size
  };
}
