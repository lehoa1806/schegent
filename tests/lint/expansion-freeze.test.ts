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

const MCP_PATTERN = /\bmodelcontextprotocol\b|@modelcontextprotocol|\bmcpServers\b|\bMcpServer\b/;

// FR-R6-F13 -- one recorded allowance, and the freeze stays in force around it.
//
// ACP v1 makes the server list a required parameter of `session/new` and `session/load`. The
// host's ACP client sends the EMPTY list: a statement that it configures no MCP server, which
// is what the freeze asks for. Leaving the field out would not keep the freeze any better, and
// a conforming agent may reject the request.
//
// The allowance is the exact empty literal, in the ACP client module, and nothing else. A list
// with an entry, a list built from a variable, the same literal in any other file, and every
// other MCP spelling still fail below. The decision is recorded in
// `docs/operations/acp-runtime.md` (Protocol) and in the feature's review audit.
const ACP_CLIENT = 'src/services/acp-runtime/acp-client.ts';
const EMPTY_SERVER_LIST = /\bmcpServers: \[\](?=\s*[,}])/g;
/** `session/new` and `session/load`. A third site is a new decision, not this one. */
const EMPTY_SERVER_LIST_SITES = 2;

/** The source as the freeze reads it: the ACP client's empty server list removed, nothing else. */
function asFrozenScanReads(path: string, source: string): string {
  return path === ACP_CLIENT ? source.replace(EMPTY_SERVER_LIST, '') : source;
}

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
    pattern: MCP_PATTERN
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
      const offenders = SOURCES.filter(([path, source]) =>
        entry.pattern.test(asFrozenScanReads(path, source))
      ).map(([path]) => path);
      expect(
        offenders,
        `${entry.surface} is frozen: ${entry.reason}. If this is genuinely needed, it is its own ` +
          `decision with its own record — not a passenger on a containment change.`
      ).toEqual([]);
    }
  );

  it('FR-R6-F13: the ACP client sends the empty server list, and only that is allowed', () => {
    const [, source] = SOURCES.find(([path]) => path === ACP_CLIENT) ?? [ACP_CLIENT, ''];
    // Non-vacuity: the allowance is in use at exactly the two request sites. At zero it is
    // dead and should be deleted; at three something new is riding on it.
    expect((source.match(EMPTY_SERVER_LIST) ?? []).length).toBe(EMPTY_SERVER_LIST_SITES);

    const allowed = 'const params = { cwd, mcpServers: [] };';
    expect(MCP_PATTERN.test(asFrozenScanReads(ACP_CLIENT, allowed))).toBe(false);

    const stillFrozen: ReadonlyArray<readonly [string, string]> = [
      // A list with an entry is a configured MCP server.
      [ACP_CLIENT, 'const params = { cwd, mcpServers: [server] };'],
      // So is a list the literal does not show.
      [ACP_CLIENT, 'const params = { cwd, mcpServers: servers };'],
      [ACP_CLIENT, 'const params = { cwd, mcpServers: [].concat(servers) };'],
      [ACP_CLIENT, 'const params = { cwd, mcpServers };'],
      // The SDK and the server type stay frozen in the ACP client too.
      [ACP_CLIENT, "import { McpServer } from '@modelcontextprotocol/sdk';"],
      // The same literal anywhere else is not covered.
      ['src/services/acp-runtime/session-state.ts', allowed],
      ['src/runner/claude-cli.ts', allowed]
    ];
    for (const [path, probe] of stillFrozen) {
      expect(MCP_PATTERN.test(asFrozenScanReads(path, probe)), `${path}: ${probe}`).toBe(true);
    }
  });

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
      ['builder', 'history', 'metrics', 'operations', 'settings', 'system'].sort()
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
