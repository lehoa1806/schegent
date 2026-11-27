// Command-reference drift guard. The historical filename is retained because
// planning-envelope evidence links to this gate by path.
//
// The root README is the project overview, not a second command index. Detailed
// command coverage belongs to `docs/reference/commands.md`, where this guard
// checks both directions and compares manifest titles as well as identifiers.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

interface ContribCmd {
  command: string;
  title?: string;
  category?: string;
}

const INTERNAL_COMMAND_ALLOWLIST = new Set<string>([
  // Internal redetection helper — surfaced only from the dashboard,
  // never the command palette directly.
  'schegent.redetectClaudeTransport'
]);

/**
 * The documents that must index every command, and what each claims to be.
 * Derived from the manifest, never from a list here — a second copy of the
 * command set is a second thing to go stale, which is the defect this guards.
 */
const INDEXES = [
  { path: 'docs/reference/commands.md', claim: 'the complete command contract' }
] as const;

function contributedCommands(): ContribCmd[] {
  const pkgJson = JSON.parse(read('package.json')) as {
    contributes?: { commands?: ContribCmd[] };
  };
  const cmds = pkgJson.contributes?.commands ?? [];
  expect(
    cmds.length,
    'package.json contributes no commands. This guard derives its expectations from the manifest; ' +
      'an empty set would make every assertion below trivially true.'
  ).toBeGreaterThan(0);
  return cmds.filter((c) => typeof c.command === 'string' && c.command.startsWith('schegent.'));
}

/**
 * Contributed settings, by key. Shares the `schegent.` prefix with commands, so
 * the reverse check needs it to tell one from the other.
 */
function configuredSettings(): Record<string, unknown> {
  const pkgJson = JSON.parse(read('package.json')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  return pkgJson.contributes?.configuration?.properties ?? {};
}

describe('command indexes cover every contributed command', () => {
  for (const index of INDEXES) {
    it(`${index.path} names every schegent.* command`, () => {
      const text = read(index.path);
      const missing = contributedCommands()
        .map((c) => c.command)
        .filter((cmd) => !INTERNAL_COMMAND_ALLOWLIST.has(cmd) && !text.includes(cmd));
      expect(
        missing,
        `${index.path} is ${index.claim} and does not name: ${missing.join(', ')}. A command absent ` +
          `from an index reads as a command that does not exist.`
      ).toEqual([]);
    });

    it(`${index.path} names no command that no longer exists`, () => {
      // The reverse direction. A reader following a documented command into
      // nothing is worse served than one who cannot find it at all.
      //
      // Settings share the `schegent.` prefix, and the reference may legitimately
      // name them — including `schegent.phases` and `schegent.pipelines`, which
      // are named precisely to record that feature 098 deleted them. A reverse
      // check that could not tell a setting from a command reported six false
      // positives on the day it was written. The settings set is derived from
      // the manifest for the same reason the command set is: a list written here
      // would be a third copy to keep in step.
      // Scoped to where an index actually indexes: a table row whose first cell
      // is the identifier, or a `### `-level heading naming it. Prose elsewhere
      // in these documents legitimately mentions `schegent.phases`,
      // `schegent.pipelines` and `schegent.workflows` in order to record that
      // feature 098 deleted them — a scan of the whole file reported those as
      // stale commands, which is the opposite of what they are.
      const declared = new Set(contributedCommands().map((c) => c.command));
      const indexed: string[] = [];
      for (const line of read(index.path).split('\n')) {
        const trimmed = line.trim();
        const row = /^\|\s*`(schegent\.[a-zA-Z]+)`\s*\|/.exec(trimmed);
        if (row) indexed.push(row[1]);
        const heading = /^#{2,4}\s+`(schegent\.[a-zA-Z]+)`\s*$/.exec(trimmed);
        if (heading) indexed.push(heading[1]);
      }
      expect(
        indexed.length,
        `${index.path} indexes no command at all. This check reads table rows and headings; if the ` +
          `document changed shape it must be taught the new one rather than passing over nothing.`
      ).toBeGreaterThan(0);
      // Settings share the prefix and can live in tables whose rows look exactly
      // like command rows. Both filters
      // are needed: structure alone lets the settings table through, and the
      // settings set alone lets retired names in prose through.
      const settings = new Set(Object.keys(configuredSettings()));
      const stale = [...new Set(indexed)].filter(
        (cmd) => !declared.has(cmd) && !settings.has(cmd)
      );
      expect(
        stale,
        `${index.path} documents ${stale.join(', ')}, which package.json does not contribute. ` +
          `Either the command was removed and its entry should go, or it was renamed and the ` +
          `entry should follow.`
      ).toEqual([]);
    });
  }

  it('the contract file lists each command under the title the palette shows', () => {
    // Identifiers matching is not enough. A contract naming a command something
    // else is documentation that fails exactly when it is consulted.
    const contract = read('docs/reference/commands.md');
    const wrong: string[] = [];
    for (const cmd of contributedCommands()) {
      if (INTERNAL_COMMAND_ALLOWLIST.has(cmd.command)) continue;
      if (cmd.title === undefined) continue;
      if (!contract.includes(cmd.title)) wrong.push(`${cmd.command} → "${cmd.title}"`);
    }
    expect(
      wrong,
      `docs/reference/commands.md does not carry the manifest title for: ${wrong.join(', ')}. ` +
        `The title is what an operator sees in the palette; a contract listing another name sends ` +
        `them looking for something that is not there.`
    ).toEqual([]);
  });
});
