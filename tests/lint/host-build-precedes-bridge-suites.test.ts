// Principal review Finding 9 — every composite npm script chain that reaches a suite
// consuming `dist/acp-stdio-bridge.js` (`test:host`, `test:coverage`, `test:perf`, `test:e2e`)
// must run `build:host` strictly earlier so clean checkouts never fail for want of the bridge
// and warm checkouts never qualify stale bytes from an earlier commit.
//
// Independent proof: reads `package.json` directly and never imports `verification-steps.json`
// or `generate-verification-scripts.mjs`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

const HOST_BUILD_SCRIPT = 'build:host';

type Marker = 'build:host' | 'bridge-consumer';

function loadScripts(): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts;
  if (scripts === undefined) throw new Error('package.json has no "scripts" object');
  return scripts;
}

function commandsOf(body: string): string[] {
  return body
    .split(/&&|;/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function localRunTarget(command: string): string | undefined {
  return /^npm\s+run\s+(\S+)/.exec(command)?.[1];
}

function isBridgeConsumingCommand(command: string): boolean {
  if (/^node\s+scripts\/package-vsix-smoke\.mjs\b/.test(command)) return true;
  const tokens = command.split(/\s+/);
  const vitest = tokens.indexOf('vitest');
  if (vitest === -1 || tokens[vitest + 1] !== 'run') return false;
  const rest = tokens.slice(vitest + 2);
  const configIdx = rest.indexOf('--config');
  if (configIdx !== -1) {
    const configFile = rest[configIdx + 1] ?? '';
    return configFile === 'vitest.perf.config.ts' || configFile === 'vitest.e2e.config.ts';
  }
  return !rest.some((token) => !token.startsWith('-'));
}

function isPrimitiveRunner(body: string): boolean {
  const commands = commandsOf(body);
  return commands.length === 1 && commands.every((command) => isBridgeConsumingCommand(command));
}

function markersOf(
  name: string,
  scripts: Readonly<Record<string, string>>,
  seen: readonly string[] = []
): Marker[] {
  if (name === HOST_BUILD_SCRIPT) return ['build:host'];
  if (!Object.prototype.hasOwnProperty.call(scripts, name) || seen.includes(name)) return [];
  const body = scripts[name];
  const out: Marker[] = [];
  for (const command of commandsOf(body)) {
    const target = localRunTarget(command);
    if (target !== undefined) {
      out.push(...markersOf(target, scripts, [...seen, name]));
      continue;
    }
    if (isBridgeConsumingCommand(command)) out.push('bridge-consumer');
  }
  return out;
}

function offenders(scripts: Readonly<Record<string, string>>): string[] {
  const bad: string[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (isPrimitiveRunner(body)) continue;
    const markers = markersOf(name, scripts);
    const consumerIdx = markers.indexOf('bridge-consumer');
    if (consumerIdx === -1) continue;
    const buildIdx = markers.indexOf('build:host');
    if (buildIdx !== -1 && buildIdx < consumerIdx) continue;
    bad.push(
      `${name}: ${buildIdx === -1 ? 'never runs build:host' : 'runs build:host only after a bridge-consuming suite'}`
    );
  }
  return bad;
}

describe('every npm chain reaching bridge-consuming suites builds the host first (Finding 9)', () => {
  const scripts = loadScripts();

  it('has no composite script that reaches host, coverage, perf, or e2e suites before build:host', () => {
    expect(offenders(scripts)).toEqual([]);
  });

  it('resolves the release and contributor chains it claims to check', () => {
    for (const chain of ['ci', 'gate', 'ci:fast', 'verify:all', 'verify:edit', 'verify:release', 'test']) {
      const markers = markersOf(chain, scripts);
      const buildIdx = markers.indexOf('build:host');
      const consumerIdx = markers.indexOf('bridge-consumer');
      expect(buildIdx, `${chain} must include build:host`).toBeGreaterThanOrEqual(0);
      expect(consumerIdx, `${chain} must include a bridge-consuming suite`).toBeGreaterThan(buildIdx);
    }
  });

  it('non-vacuity: moving build:host after test:e2e fails the gate', () => {
    const broken: Readonly<Record<string, string>> = {
      ...scripts,
      'broken-chain': 'npm run test:e2e && npm run build:host'
    };
    expect(offenders(broken)).toEqual([
      'broken-chain: runs build:host only after a bridge-consuming suite'
    ]);
  });
});
