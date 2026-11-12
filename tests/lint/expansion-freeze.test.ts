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
import { posix, relative, resolve } from 'node:path';
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

// FR-R6-F14 -- the optional metadata exporter is the one network client in `src`, and it is
// not wired to anything.
//
// Before F14 no file in `src` imported a network module. The exporter's transport is the first,
// and package F14-A ships it constructed by nothing: no setting, no command and no activation
// path reaches it. These probes keep both statements true after the fact. A second network
// client, or a first importer outside the exporter's directory, is its own decision (F14-B),
// not a passenger on another change.
//
// The exporter is also held to a closed import list, which is what makes "it reads no
// environment variable, writes no file, opens no listener and never sees the editor API"
// checkable: the only modules it can reach are the ones named here.
const EXPORTER_DIR = 'src/services/telemetry-export/';
const EXPORTER_CONTRACT = 'src/contracts/telemetry-export.ts';
const EXPORTER_TRANSPORT = 'src/services/telemetry-export/otlp-http-transport.ts';
const EXPORTER_INDEX = 'src/services/telemetry-export/index.ts';
const ACCOUNTING_TYPES = 'src/contracts/usage-accounting/accounting-types.ts';
const DIMENSION_RULE = 'src/services/usage-accounting/dimension-sanitizer.ts';

/** The specifier an import resolves to for a file: its path without the extension. */
const moduleOf = (file: string): string => file.replace(/\.ts$/, '');

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\brequire\(\s*)['"]([^'"\n]+)['"]/g;
const NETWORK_MODULE = /^(?:node:)?(?:http|https|http2|dns|net|tls|dgram)(?:\/.*)?$/;
/** Network clients that need no import. */
const AMBIENT_NETWORK_CLIENT = /\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b/;
const OTEL_ENVIRONMENT_NAME = /\bOTEL_[A-Z]/;
const SERVER_OR_LISTENER = /\bcreateServer\b|\.listen\(/;
const ENVIRONMENT_FILE_OR_LOG = /\bprocess\.env\b|\bconsole\.[a-z]+\(/;

/** Every module the exporter may import that is not one of its own files. */
const EXPORTER_MAY_IMPORT: readonly string[] = [
  'node:crypto',
  'node:dns',
  'node:http',
  'node:https',
  'node:net',
  moduleOf(EXPORTER_CONTRACT),
  moduleOf(ACCOUNTING_TYPES),
  moduleOf(DIMENSION_RULE)
];

/** The import specifiers of one source, relative ones resolved to a path from the repo root. */
function importsOf(path: string, source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => {
    const specifier = match.at(1) ?? '';
    return specifier.startsWith('.') ? posix.join(posix.dirname(path), specifier) : specifier;
  });
}

const isExporterFile = (path: string): boolean => path.startsWith(EXPORTER_DIR);
const EXPORTER_SOURCES = SOURCES.filter(([path]) => isExporterFile(path) || path === EXPORTER_CONTRACT);

describe('FR-R6-F14 — the exporter is the only network client, and nothing reaches it', () => {
  it('scanned the exporter and its contract', () => {
    expect(EXPORTER_SOURCES.length).toBeGreaterThanOrEqual(16);
    expect(EXPORTER_SOURCES.map(([path]) => path)).toContain(EXPORTER_TRANSPORT);
    expect(EXPORTER_SOURCES.map(([path]) => path)).toContain(EXPORTER_CONTRACT);
  });

  it('only the exporter transport imports a network module', () => {
    const importers = SOURCES.filter(([path, source]) =>
      importsOf(path, source).some((specifier) => NETWORK_MODULE.test(specifier))
    ).map(([path]) => path);
    expect(importers, 'a second network client in src is its own decision').toEqual([EXPORTER_TRANSPORT]);
  });

  it('no source uses a network client that needs no import', () => {
    const users = SOURCES.filter(([, source]) => AMBIENT_NETWORK_CLIENT.test(source)).map(([path]) => path);
    expect(users).toEqual([]);
  });

  it('only the F14-B telemetry host service imports the exporter outside its directory', () => {
    const importers = SOURCES.filter(
      ([path, source]) =>
        !isExporterFile(path) && importsOf(path, source).some((specifier) => `${specifier}/`.startsWith(EXPORTER_DIR))
    ).map(([path]) => path);
    expect(importers, 'F14-B pins the single host coordinator allowed to construct the exporter').toEqual([
      'src/services/telemetry-host/telemetry-host-service.ts'
    ]);
  });

  it('the exporter imports nothing outside its closed list', () => {
    const outside = new Set<string>();
    for (const [path, source] of EXPORTER_SOURCES) {
      for (const specifier of importsOf(path, source)) {
        if (!`${specifier}/`.startsWith(EXPORTER_DIR)) outside.add(specifier);
      }
    }
    // Equality, not containment: an entry nothing imports any more leaves the list too. The list
    // holds no `vscode`, no `node:fs`, no `node:child_process` and, from the usage ledger's
    // services, only the dimension rule.
    expect([...outside].sort()).toEqual([...EXPORTER_MAY_IMPORT].sort());
  });

  it('the exporter contract imports only the accounting types', () => {
    const [, source] = SOURCES.find(([path]) => path === EXPORTER_CONTRACT) ?? [EXPORTER_CONTRACT, ''];
    expect(importsOf(EXPORTER_CONTRACT, source)).toEqual([moduleOf(ACCOUNTING_TYPES)]);
  });

  it('no source names an OpenTelemetry environment variable', () => {
    // The exporter is configured by a profile the host evaluates, never by the ambient
    // environment; an agent or a shell profile cannot switch it on or point it elsewhere.
    const namers = SOURCES.filter(([, source]) => OTEL_ENVIRONMENT_NAME.test(source)).map(([path]) => path);
    expect(namers).toEqual([]);
  });

  it('the exporter creates no server, reads no environment and logs nothing', () => {
    for (const [path, source] of EXPORTER_SOURCES) {
      expect(SERVER_OR_LISTENER.test(source), `${path} must not listen`).toBe(false);
      expect(ENVIRONMENT_FILE_OR_LOG.test(source), `${path} must not read the environment or log`).toBe(false);
    }
  });

  it('NON-VACUITY: each probe matches the thing it forbids', () => {
    // A real file one directory beside the exporter, so `..` resolves as it would for a caller.
    const caller = DIMENSION_RULE;
    expect(importsOf(caller, "import { request } from 'node:https';")).toEqual(['node:https']);
    expect(importsOf(caller, "const http = require('http');")).toEqual(['http']);
    expect(importsOf(caller, "const dns = await import('node:dns/promises');")).toEqual(['node:dns/promises']);
    expect(importsOf(caller, "import 'vscode';")).toEqual(['vscode']);
    expect(importsOf(caller, "} from '../telemetry-export';")).toEqual(['src/services/telemetry-export']);
    expect(importsOf('src/extension.ts', "import { x } from './services/telemetry-export/index';")).toEqual([
      moduleOf(EXPORTER_INDEX)
    ]);
    expect(moduleOf(EXPORTER_INDEX).endsWith('/index')).toBe(true);
    // The contract is not the exporter: importing it wires nothing.
    expect(`${importsOf(caller, "} from '../../contracts/telemetry-export';").join('')}/`.startsWith(EXPORTER_DIR)).toBe(false);
    for (const specifier of ['node:http', 'https', 'node:dns/promises', 'net', 'node:tls', 'node:http2', 'dgram']) {
      expect(NETWORK_MODULE.test(specifier), specifier).toBe(true);
    }
    for (const specifier of ['node:crypto', 'node:path', './network', 'http-errors', 'node:network']) {
      expect(NETWORK_MODULE.test(specifier), specifier).toBe(false);
    }
    expect(AMBIENT_NETWORK_CLIENT.test('const response = await fetch(endpoint);')).toBe(true);
    expect(AMBIENT_NETWORK_CLIENT.test('const socket = new WebSocket(url);')).toBe(true);
    expect(OTEL_ENVIRONMENT_NAME.test("const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];")).toBe(true);
    expect(SERVER_OR_LISTENER.test('const server = createServer(handler);')).toBe(true);
    expect(SERVER_OR_LISTENER.test('server.listen(0);')).toBe(true);
    expect(ENVIRONMENT_FILE_OR_LOG.test('const proxy = process.env.HTTPS_PROXY;')).toBe(true);
    expect(ENVIRONMENT_FILE_OR_LOG.test("console.warn('export failed');")).toBe(true);
    // And the scan can see such things in this tree: the environment is read elsewhere in `src`.
    const readers = SOURCES.filter(([, source]) => ENVIRONMENT_FILE_OR_LOG.test(source)).map(([path]) => path);
    expect(readers).toContain('src/runner/spawn-env.ts');
    expect(readers.some(isExporterFile)).toBe(false);
  });
});
