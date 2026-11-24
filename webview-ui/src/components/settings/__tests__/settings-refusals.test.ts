// The Settings page's refusals: how a setting the host refused comes into sight.
//
// The page's one Save writes every section at once, so the host can refuse a setting the user
// cannot see. A refusal is drawn beside its setting; this list brings it into sight. A refusal the
// user can see already keeps the page where it is. Otherwise the first new refusal in page order is
// revealed, its section shown and its group opened, and every time the page scrolls only as far as
// it must to bring the refusal into view.
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';

import { Refusals } from '../settings-refusals';

interface Scroll {
  readonly node: HTMLElement;
  readonly options: unknown;
}

/** Gives every element a `scrollIntoView` (jsdom has none) that records each call, in order. */
function recordScrolls(): Scroll[] {
  const scrolls: Scroll[] = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement, options: unknown) {
      scrolls.push({ node: this, options });
    }
  });
  return scrolls;
}

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

/** Waits until the list has done all it does after a refusal is drawn (Refusals chains two Svelte ticks). */
async function settled(): Promise<void> {
  await tick();
  await tick();
}

function element(tag: string, parent: HTMLElement = document.body): HTMLElement {
  const created = document.createElement(tag);
  parent.append(created);
  return created;
}

/** A section the page does not show, with a refusal inside. */
function hiddenSection(): { readonly section: HTMLElement; readonly refusal: HTMLElement } {
  const section = element('section');
  section.hidden = true;
  return { section, refusal: element('p', section) };
}

const NEAREST = { block: 'nearest' };

describe('Refusals', () => {
  it('reveals a refusal the page hides, then scrolls it into view', async () => {
    const scrolls = recordScrolls();
    const { section, refusal } = hiddenSection();

    new Refusals().add(refusal, () => {
      section.hidden = false;
    });
    await settled();

    expect(section.hidden).toBe(false);
    expect(scrolls).toEqual([{ node: refusal, options: NEAREST }]);
  });

  it('counts a refusal inside a closed group as out of sight', async () => {
    recordScrolls();
    const group = element('details') as HTMLDetailsElement;
    element('summary', group);
    const refusal = element('p', group);
    let reveals = 0;

    new Refusals().add(refusal, () => {
      reveals += 1;
    });
    await settled();

    expect(reveals).toBe(1);
  });

  it('keeps the page where it is when a refusal is in sight, and scrolls to that one', async () => {
    const scrolls = recordScrolls();
    const hidden = hiddenSection();
    const shown = element('p');
    const reveals: string[] = [];
    const refusals = new Refusals();

    refusals.add(hidden.refusal, () => reveals.push('hidden'));
    refusals.add(shown, () => reveals.push('shown'));
    await settled();

    expect(reveals).toEqual([]);
    expect(scrolls).toEqual([{ node: shown, options: NEAREST }]);
  });

  it('reveals the first refusal in page order when none is in sight', async () => {
    const scrolls = recordScrolls();
    const first = hiddenSection();
    const second = hiddenSection();
    const reveals: string[] = [];
    const refusals = new Refusals();

    refusals.add(second.refusal, () => reveals.push('second'));
    refusals.add(first.refusal, () => reveals.push('first'));
    await settled();

    expect(reveals).toEqual(['first']);
    expect(scrolls).toEqual([{ node: first.refusal, options: NEAREST }]);
  });

  it('keeps the page on a refusal in sight when a later answer draws another', async () => {
    const scrolls = recordScrolls();
    const shown = element('p');
    const later = hiddenSection();
    const reveals: string[] = [];
    const refusals = new Refusals();

    refusals.add(shown, () => reveals.push('shown'));
    await settled();
    refusals.add(later.refusal, () => reveals.push('later'));
    await settled();

    expect(reveals).toEqual([]);
    expect(scrolls).toEqual([{ node: shown, options: NEAREST }]);
  });

  it('brings in only the refusals drawn since it last did', async () => {
    recordScrolls();
    const earlier = hiddenSection();
    const later = hiddenSection();
    const reveals: string[] = [];
    const refusals = new Refusals();

    refusals.add(earlier.refusal, () => reveals.push('earlier'));
    await settled();
    refusals.add(later.refusal, () => reveals.push('later'));
    await settled();

    expect(reveals).toEqual(['earlier', 'later']);
  });

  it('forgets a refusal once it is removed', async () => {
    const scrolls = recordScrolls();
    const removed = element('p');
    const hidden = hiddenSection();
    const reveals: string[] = [];
    const refusals = new Refusals();

    const remove = refusals.add(removed, () => reveals.push('removed'));
    await settled();
    remove();
    refusals.add(hidden.refusal, () => reveals.push('hidden'));
    await settled();

    expect(reveals).toEqual(['hidden']);
    expect(scrolls.map((scroll) => scroll.node)).toEqual([removed, hidden.refusal]);
  });

  it('leaves out a refusal no longer on the page', async () => {
    const scrolls = recordScrolls();
    const gone = element('p');
    gone.remove();
    let reveals = 0;

    new Refusals().add(gone, () => {
      reveals += 1;
    });
    await settled();

    expect(reveals).toBe(0);
    expect(scrolls).toEqual([]);
  });

  it('still reveals a refusal where the page cannot scroll', async () => {
    const { section, refusal } = hiddenSection();

    new Refusals().add(refusal, () => {
      section.hidden = false;
    });
    await settled();

    expect(section.hidden).toBe(false);
  });
});
