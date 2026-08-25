// FR-R3-086 §5 — the expansion freeze holds, and a containment feature is the
// most likely place to breach it.
//
// "MCP, a fourth backend, remote or multi-user mode and a UI rewrite are frozen.
// A broker is containment work inside that freeze, not an exception to it — and
// MCP in particular is attractive here and is explicitly blocked; the reviewer
// brief names it as the most plausible route to the thing `SEC-1` lacks, and
// blocked is still blocked."
//
// The temptation is specific and worth naming: a mediated broker wants a channel
// between the host and the agent's tool calls, and MCP is that channel. Route A
// was chosen partly because it needs no such channel. This gate is what keeps
// that true after the fact.
//
// ITS OWN GATE, not an assertion bolted onto the text-parity one. A gate that
// answers for two things is the shape that makes gates hard to control, which is
// the subject of FR-R3-088 next door.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const rel = (absolute: string): string => relative(REPO_ROOT, absolute).replaceAll('\\', '/');

const SOURCES = filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] })
  .filter((file) => !rel(file).includes('/generated/'))
  .map((file) => [rel(file), readFileSync(file, 'utf8')] as const);

/** Each frozen surface, with the reason it is frozen, inline. */
const FROZEN: ReadonlyArray<{
  readonly surface: string;
  readonly reason: string;
  readonly pattern: RegExp;
}> = [
  {
    surface: 'MCP / a plug-in protocol',
    reason:
      'the most plausible route to a mediated broker, and the one the reviewer brief names ' +
      'as attractive here — blocked is still blocked',
    pattern: /\bmodelcontextprotocol\b|@modelcontextprotocol|\bmcpServers\b|\bMcpServer\b/
  },
  {
    surface: 'remote or multi-user mode',
    reason: 'the product is local-only; a remote control surface changes the whole threat model',
    pattern: /\bremoteWorkspace\b|\bmultiUser\b|\btenantId\b/
  }
];

describe('FR-R3-086 §5 — the expansion freeze holds', () => {
  it('scanned a non-empty source tree', () => {
    // A freeze asserted over an empty scan is a freeze asserting nothing.
    expect(SOURCES.length).toBeGreaterThan(300);
  });

  it.each(FROZEN.map((entry) => [entry.surface, entry] as const))(
    'introduces no %s',
    (_surface, entry) => {
      const offenders = SOURCES.filter(([, source]) => entry.pattern.test(source)).map(
        ([path]) => path
      );
      expect(
        offenders,
        `${entry.surface} is frozen: ${entry.reason}. If this is genuinely needed, it is its own ` +
          `decision with its own record — not a passenger on a containment change.`
      ).toEqual([]);
    }
  );

  it('introduces no fourth backend', () => {
    // The union is closed and its membership is the freeze. A fourth member
    // would arrive with adapters, settings, disclosure surfaces and a
    // containment classification — none of which is this feature's scope.
    expect([...SUPPORTED_BACKENDS].sort()).toEqual(['agy', 'claude', 'codex']);
  });

  it('introduces no new webview route — a UI rewrite is frozen too', () => {
    const routes = readFileSync(
      resolve(REPO_ROOT, 'webview-ui/src/dashboard/routes.ts'),
      'utf8'
    );
    const declared = [...routes.matchAll(/^\s*\|\s*'([a-z-]+)'/gm)].map((match) => match[1] as string);
    expect(declared.sort()).toEqual(
      ['builder', 'history', 'metrics', 'operations', 'runs', 'settings', 'system'].sort()
    );
  });

  it('the capability mechanism itself introduces no channel between host and agent', () => {
    // Route A's defining property: the host declares and the backend enforces.
    // A socket, a pipe or an HTTP client inside the capability modules would mean
    // the mediator was built after all, without the decision being made.
    const capabilityModules = SOURCES.filter(([path]) =>
      /src\/(contracts\/phase-capabilities|services\/capability-)/.test(path)
    );
    expect(capabilityModules.length).toBeGreaterThanOrEqual(3);
    for (const [path, source] of capabilityModules) {
      expect(source, `${path} must not open a channel`).not.toMatch(
        /node:net|node:http|WebSocket|child_process|createServer/
      );
    }
  });

  it('NON-VACUITY: each frozen pattern matches the thing it forbids', () => {
    // Without this, a typo in a pattern would make the freeze vacuous and every
    // assertion above would pass over a detector that matches nothing.
    const probes: ReadonlyArray<readonly [string, string]> = [
      ['MCP / a plug-in protocol', "import { McpServer } from '@modelcontextprotocol/sdk';"],
      ['remote or multi-user mode', 'const tenantId = resolveTenant();']
    ];
    for (const [surface, probe] of probes) {
      const entry = FROZEN.find((candidate) => candidate.surface === surface);
      expect(entry, `${surface} must be in the frozen list`).toBeDefined();
      expect(entry?.pattern.test(probe), `${surface} pattern must match its probe`).toBe(true);
    }
  });
});
