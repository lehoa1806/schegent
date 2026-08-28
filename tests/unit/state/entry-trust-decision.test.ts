// FR-R3-136 (FR-001, FR-005, FR-006, FR-007) — the entry-trust decision, as a
// full truth table.
//
// Four rows is the whole domain: two dispositions by two trust states. Written out
// rather than parameterised down to a one-liner, because the two rows that matter
// are the two the old code got wrong in opposite directions — a mutating entry
// running while untrusted (the defect) and a read-only entry refused while
// untrusted (the over-correction that would break the `limited` claim
// `FR-R3-126` shipped).
import { describe, expect, it } from 'vitest';

import {
  decideEntry,
  renderEntryRefusal,
  type EntryTrustDecision
} from '../../../src/state/entry-trust-decision';

describe('decideEntry', () => {
  it('allows a mutating entry in a trusted workspace', () => {
    expect(decideEntry({ disposition: 'mutating', workspaceTrusted: true })).toEqual({
      allowed: true
    });
  });

  it('refuses a mutating entry in an untrusted workspace, with a named reason', () => {
    const decision: EntryTrustDecision = decideEntry({
      disposition: 'mutating',
      workspaceTrusted: false
    });
    expect(decision).toEqual({ allowed: false, reason: 'workspace-untrusted' });
  });

  it('allows a read-only entry in a trusted workspace', () => {
    expect(decideEntry({ disposition: 'read-only', workspaceTrusted: true })).toEqual({
      allowed: true
    });
  });

  it('allows a read-only entry in an untrusted workspace', () => {
    // The half of the boundary that is a promise rather than a restriction. The
    // manifest's `limited` claim says state, history, audit and log views keep
    // working, so this row failing would be a regression an operator feels
    // immediately even though it would look like extra safety.
    expect(decideEntry({ disposition: 'read-only', workspaceTrusted: false })).toEqual({
      allowed: true
    });
  });

  it('is a pure function of its inputs — no captured state between calls', () => {
    // FR-005's property, asserted the only way a pure function can carry it:
    // the same inputs give the same answer after the opposite inputs have been
    // seen. A cached implementation would fail the third call.
    const untrusted = { disposition: 'mutating', workspaceTrusted: false } as const;
    const trusted = { disposition: 'mutating', workspaceTrusted: true } as const;
    expect(decideEntry(untrusted).allowed).toBe(false);
    expect(decideEntry(trusted).allowed).toBe(true);
    expect(decideEntry(untrusted).allowed).toBe(false);
  });
});

describe('renderEntryRefusal', () => {
  it('names the command, the reason, and what still works', () => {
    const message = renderEntryRefusal('schegent.enqueue', 'queue enqueue');
    expect(message).toContain('schegent.enqueue');
    expect(message).toContain('queue enqueue');
    expect(message).toContain('not trusted');
    // The remedy and the reassurance. A refusal that says only "no" sends the
    // operator looking for a broken extension.
    expect(message).toContain('Trust the folder');
    expect(message).toContain('audit');
  });
});
