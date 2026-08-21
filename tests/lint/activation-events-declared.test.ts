// Feature 111 (T698 — FR-016, FR-017, FR-021, FR-022, FR-023, SC-011, SC-012,
// SC-016, SC-018, SC-022) — the extension's activation surface, asserted against
// the manifest itself.
//
// This file is the documentation of the activation events as much as it is the
// test of them, because it is where a reader who wonders "why only two?" will
// land. Three things belong here.
//
// **Why `workspaceContains:.schegent/` was added.** A schedule armed for an
// unattended start needs the extension running at the appointed time. Nothing
// woke it: `.specify/` marks a Spec-Kit workspace, and a workspace can hold an
// armed schedule without ever having held a Spec-Kit tree. `.schegent/` is where
// the audit log lives, and the arm path creates it —
// `arm()` → `appendAudit()` → `auditWriter.append()` → `fs.mkdir(dir, { recursive: true })`
// — so its presence is the closest observable thing to "this workspace has been
// used". `tests/integration/scheduled-start-activation-proxy.test.ts` pins that
// the arm path really does leave the directory behind; without that pin this
// event would watch for something that might never appear.
//
// **Why there is no `onCommand:` or `onView:` entry.** At `engines.vscode
// ^1.85.0` both are implicit: since 1.74 VS Code activates an extension when one
// of its contributed commands is invoked or one of its contributed views is
// revealed, whether or not the manifest says so. This extension contributes 19
// commands and one view; spelling any of them out here would add 20 lines that
// change no behaviour, and the list would then have to be kept in step with
// `contributes` by hand. So the rule is: activation events are for triggers VS
// Code cannot infer. Adding an inferable one is the mistake this asserts against.
//
// **What the trigger does not cover.** `workspaceContains:` watches the file
// system, and an armed schedule is not on the file system — it lives in
// `context.workspaceState`, a `Memento`, which no activation event can observe.
// So `.schegent/` is a proxy, not a detector, and two residuals follow from that:
//
//   - A schedule armed in a workspace where nothing was ever written to
//     `.schegent/` still needs one manual activation before it can fire. In
//     practice arming writes an audit entry, so this is the pre-existing-state
//     case rather than the ordinary one.
//   - An operator who deletes `.schegent/` removes the trigger while leaving the
//     schedule armed. The schedule is still there and still correct; nothing will
//     wake the host to run it.
//
// Closing those would need a trigger keyed on extension state, which the
// activation-event vocabulary does not have. They are recorded here rather than
// implied closed.
//
// No `vscode` import: this reads the manifest as data, so it runs in the default
// `npm run test` suite rather than the excluded host set. That is the whole point
// of splitting it out of `tests/integration/activation-eager.host.test.ts`, whose
// runtime half needs a real extension host and therefore cannot gate.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const MANIFEST = resolve(__dirname, '..', '..', 'package.json');

/**
 * Exactly these, in this order. A set comparison would let a duplicate through
 * and would not notice the ordering drift that makes a manifest diff unreadable.
 */
const REQUIRED_EVENTS: readonly string[] = [
  'workspaceContains:.specify/',
  'workspaceContains:.schegent/'
];

interface Manifest {
  readonly activationEvents?: unknown;
  readonly engines?: { readonly vscode?: string };
  readonly contributes?: {
    readonly commands?: readonly unknown[];
    readonly views?: Readonly<Record<string, readonly unknown[]>>;
  };
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

describe('the activation surface is declared and bounded (111, FR-016, FR-017)', () => {
  it('declares exactly the two workspaceContains triggers', () => {
    expect(Array.isArray(manifest.activationEvents), 'activationEvents must be an array').toBe(
      true
    );
    expect(manifest.activationEvents).toEqual(REQUIRED_EVENTS);
  });

  it('declares no event VS Code already infers', () => {
    const events = manifest.activationEvents as readonly string[];
    const inferable = events.filter(
      (event) => event.startsWith('onCommand:') || event.startsWith('onView:')
    );
    expect(
      inferable,
      `At engines.vscode ${manifest.engines?.vscode}, command and view activation is implicit. An entry here changes no behaviour and has to be kept in step with \`contributes\` by hand:\n${inferable.join('\n')}`
    ).toEqual([]);
  });

  it('is asserting against a manifest that still has commands and views to infer', () => {
    // Vacuity guard: the rule above says "these are redundant because VS Code
    // infers them". If the extension stopped contributing commands or views, the
    // rule would pass for the wrong reason and the header's argument would be
    // stale rather than wrong.
    expect(manifest.engines?.vscode).toBe('^1.85.0');
    expect((manifest.contributes?.commands ?? []).length).toBeGreaterThan(0);
    expect(Object.keys(manifest.contributes?.views ?? {}).length).toBeGreaterThan(0);
  });
});
