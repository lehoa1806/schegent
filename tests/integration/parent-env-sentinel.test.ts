import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSpawnEnv, policyRequestFields } from '../../src/runner/spawn-env';

/**
 * FR-R4-F06 (FR-031; T30; contract Q, Q5) -- what the environment allowlist is, and what it is not.
 *
 * THE CLAIM UNDER TEST. The allowlist decides which variables a backend CHILD receives. It is not an
 * operating-system boundary: a same-user child can often read its PARENT's environment from the OS
 * (`ps -E -p <ppid>` on darwin, `/proc/<ppid>/environ` on Linux). So a secret kept out of the child's
 * own environment can still be reachable by a child that goes looking, and the operator
 * documentation must not say otherwise. This probe observes both facts on the host, as two booleans.
 *
 * THE SHAPE. A real intermediate parent is started WITH the sentinel in its own start-up
 * environment, because that is what the OS records; a variable set later with `process.env[...] = `
 * is not in the kernel's copy and would make `readableFromParent` false for the wrong reason. The
 * parent starts the probe child with the environment `buildSpawnEnv` builds under the allowlist
 * policy. The child reports `inOwnEnv` (the name is in its own environment) and
 * `readableFromParent`.
 *
 * (PROOF) Control: the same spawn with the sentinel's NAME in the allowlist gives `inOwnEnv ===
 * true`, so a `false` in the first case is the allowlist working and not a probe that cannot see.
 *
 * SYNTHETIC ONLY (standing rule 12): the sentinel's name and value are random per run. The test
 * prints the two booleans and nothing else, never an environment name or value. The variable set on
 * this process is deleted in `finally`. Bounded wait, skipped on win32 with the reason.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const CASE_TIMEOUT_MS = 15_000;

/** The probe child: two booleans, and nothing else, on stdout. */
const CHILD_SCRIPT = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [name, value] = process.argv.slice(1);
const inOwnEnv = Object.prototype.hasOwnProperty.call(process.env, name);
let readableFromParent = null;
try {
  if (process.platform === 'darwin') {
    const out = execFileSync('ps', ['-E', '-p', String(process.ppid), '-o', 'command='], { encoding: 'utf8' });
    readableFromParent = out.includes(value);
  } else if (process.platform === 'linux') {
    readableFromParent = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8').includes(value);
  }
} catch {
  readableFromParent = false;
}
process.stdout.write(JSON.stringify({ inOwnEnv, readableFromParent }));
`;

/** The intermediate parent: starts the child with the environment it is handed on stdin. */
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const [name, value] = process.argv.slice(1);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const env = JSON.parse(raw);
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD_SCRIPT)}, name, value], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.pipe(process.stdout);
  child.on('close', (code) => process.exit(code ?? 1));
});
`;

interface Probe {
  readonly inOwnEnv: boolean;
  readonly readableFromParent: boolean | null;
}

let setName: string | undefined;

afterEach(() => {
  if (setName !== undefined) delete process.env[setName];
  setName = undefined;
});

async function probe(allowlist: readonly string[], name: string, value: string): Promise<Probe> {
  process.env[name] = value;
  setName = name;
  // The environment the child is given, built by the same function a Run spawn uses.
  const childEnv = buildSpawnEnv(
    policyRequestFields({ inheritProcessEnv: false, processEnvAllowlist: allowlist })
  );
  return await new Promise<Probe>((resolve, reject) => {
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT, name, value], {
      // The sentinel is in the PARENT's start-up environment; the child's is `childEnv`.
      env: { PATH: process.env.PATH ?? '', [name]: value },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let out = '';
    const timer = setTimeout(() => {
      parent.kill('SIGKILL');
      reject(new Error('the sentinel probe did not finish in time'));
    }, CASE_TIMEOUT_MS - 2_000);
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    parent.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as Probe);
      } catch {
        reject(new Error('the sentinel probe printed something other than its two booleans'));
      }
    });
    parent.stdin.end(JSON.stringify(childEnv));
  });
}

function sentinel(): { name: string; value: string } {
  return {
    name: `SCHEGENT_SENTINEL_${randomBytes(6).toString('hex').toUpperCase()}`,
    value: randomBytes(12).toString('hex')
  };
}

posixOnly('a parent environment is not hidden by the allowlist (T30)', () => {
  it(
    'keeps the sentinel out of the child\'s own environment under the allowlist, and records what a child can read of its parent',
    async () => {
      const { name, value } = sentinel();
      const result = await probe([], name, value);

      // Printed for the qualification record (section 8): the two booleans, and nothing else.
      console.log(
        `T30 sentinel probe (${process.platform}): inOwnEnv=${String(result.inOwnEnv)} ` +
          `readableFromParent=${String(result.readableFromParent)}`
      );
      expect(result.inOwnEnv).toBe(false);
      expect(result.readableFromParent === null || typeof result.readableFromParent === 'boolean').toBe(true);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'control: with the sentinel\'s name in the allowlist the child does hold it',
    async () => {
      const { name, value } = sentinel();
      const result = await probe([name], name, value);
      expect(result.inOwnEnv, 'the probe must be able to see a variable the child holds').toBe(true);
    },
    CASE_TIMEOUT_MS
  );
});
