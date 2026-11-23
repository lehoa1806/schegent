// The Settings page's refusals: how a setting the host refused comes into sight.
//
// The page's one Save writes every section at once, so the host can refuse a setting the user
// cannot see: in a section the page is not showing, in a row a search hides, or in a group the
// user closed. Each part draws its refusal beside the setting, and the part's search action
// (`settings-search.svelte.ts`) adds it here, with the way to reveal it.
//
// A refusal the user can see already keeps the page where it is, so a refusal in sight never
// moves away: a later answer to the same Save cannot take the page from it. Otherwise the first
// refusal drawn since the last time, in page order, is revealed. Either way the page then
// scrolls only as far as it must to bring that refusal into view. Focus stays where it is, so
// the user is not taken from what they are doing; each refusal is drawn in its own alert live
// region.
import { tick } from 'svelte';

interface Refusal {
  readonly node: HTMLElement;
  /** Shows what hides the refusal: its section, the row a search hides, its closed group. */
  readonly reveal: () => void;
}

export class Refusals {
  /** Every refusal on the page. */
  readonly #drawn = new Set<Refusal>();
  /** The refusals drawn since the page last brought one into sight. */
  readonly #fresh = new Set<Refusal>();
  #settling = false;

  /**
   * Adds a refusal drawn on `node` and returns the function that removes it. Every refusal drawn
   * by one answer is weighed together, once the page has drawn them all.
   */
  add(node: HTMLElement, reveal: () => void): () => void {
    const refusal: Refusal = { node, reveal };
    this.#drawn.add(refusal);
    this.#fresh.add(refusal);
    this.#settleSoon();
    return () => {
      this.#drawn.delete(refusal);
      this.#fresh.delete(refusal);
    };
  }

  #settleSoon(): void {
    if (this.#settling) return;
    this.#settling = true;
    void tick().then(() => {
      this.#settling = false;
      this.#settle();
    });
  }

  #settle(): void {
    const fresh = [...this.#fresh].filter(isOnPage).sort(inPageOrder);
    this.#fresh.clear();
    const target = [...this.#drawn].some((refusal) => isOnPage(refusal) && isShown(refusal.node))
      ? fresh.find((refusal) => isShown(refusal.node))
      : fresh.at(0);
    if (target === undefined) return;
    if (!isShown(target.node)) target.reveal();
    // The reveal changes state; the scroll waits until the page has drawn it.
    void tick().then(() => {
      scrollIntoView(target.node);
    });
  }
}

function isOnPage(refusal: Refusal): boolean {
  return refusal.node.isConnected;
}

/**
 * True when nothing around the node hides it: no hidden section or row, and no closed group. A
 * refusal is never drawn in a group's summary, the one part of a closed group that shows.
 */
function isShown(node: HTMLElement): boolean {
  return node.closest('[hidden], details:not([open])') === null;
}

function inPageOrder(a: Refusal, b: Refusal): number {
  if (a.node === b.node) return 0;
  return (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1;
}

/** Scrolls the least that brings the node into view. jsdom, where the unit tests run, has none. */
function scrollIntoView(node: HTMLElement): void {
  if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
}
