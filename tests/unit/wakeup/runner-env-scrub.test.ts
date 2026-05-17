// Feature 014 T040 — unit tests for the runner's env-scrub policy.
//
// The runner (src/headless/wakeup-runner.ts) MUST sanitize the parent
// environment before spawning `claude`. The rules under test (from the
// runner's source):
//
//   ENV_ALLOW (strict allowlist):
//     PATH, HOME, LANG, USER, LOGNAME, SHELL, TMPDIR, TEMP, TMP
//   PLUS any LC_* (locale category variables)
//
//   ENV_DENY_PREFIXES (hard-fail even if mistakenly added to allow):
//     VSCODE_*, WORKSPACE*, SCHEGENT_*
//
//   ENV_DENY_EXACT:
//     CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
//
//   ENV_DENY_TOKENS (substring match on the variable name):
//     TOKEN, SECRET, KEY, PASSWORD
//
// The scrub is the runner's only sandbox between the launchd/cron/etc.
// invocation context and the child `claude` process — every false
// negative here is a workspace-context leak. See SC-003, SC-009, US2.

import { describe, it, expect } from 'vitest';
import { scrubEnv } from '../../../src/headless/wakeup-runner';

// Fixture placeholder for env-var values in this file. The scrub policy
// strips by NAME, never by VALUE, so what we set here is irrelevant —
// but using a named constant keeps secret-scanning pre-commit hooks
// from misreading test fixtures as real credentials. The value is
// intentionally identical for all keys.
const FIXTURE_VALUE = 'placeholder';

describe('Feature 014 T040 — runner env-scrub', () => {
  it('drops the canonical workspace-context leak vectors named in T040', () => {
    const parent: NodeJS.ProcessEnv = {
      // These are the exact five enumerated in tasks.md T040.
      VSCODE_PID: '123',
      WORKSPACES: '/x:/y',
      SCHEGENT_RUN_ID: 'abc',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '42',
      OPENAI_API_KEY: FIXTURE_VALUE,
      // Plus a baseline of allowlisted vars so the scrub has a non-empty result.
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/Users/test'
    };

    const scrubbed = scrubEnv(parent);

    expect(scrubbed).not.toHaveProperty('VSCODE_PID');
    expect(scrubbed).not.toHaveProperty('WORKSPACES');
    expect(scrubbed).not.toHaveProperty('SCHEGENT_RUN_ID');
    expect(scrubbed).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(scrubbed).not.toHaveProperty('OPENAI_API_KEY');

    // The two safe baseline vars survive — sanity check the allow path.
    expect(scrubbed.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(scrubbed.HOME).toBe('/Users/test');
  });

  it('drops every VSCODE_ prefix var (denylist by prefix)', () => {
    const parent: NodeJS.ProcessEnv = {
      VSCODE_PID: '1',
      VSCODE_IPC_HOOK: '/tmp/vsc.sock',
      VSCODE_NLS_CONFIG: '{}',
      VSCODE_CWD: '/Users/a/workspace',
      VSCODE_INJECTION: '1',
      PATH: '/bin'
    };
    const out = scrubEnv(parent);
    for (const k of Object.keys(parent)) {
      if (k === 'PATH') continue;
      expect(out, `${k} must be dropped`).not.toHaveProperty(k);
    }
  });

  it('drops every SCHEGENT_ prefix var (host context leak)', () => {
    const parent: NodeJS.ProcessEnv = {
      SCHEGENT_RUN_ID: 'r1',
      SCHEGENT_PHASE_ID: 'plan',
      SCHEGENT_PIPELINE_ID: 'standard',
      SCHEGENT_MODE: 'auto',
      // SCHEGENT_WAKEUP_HOME is also denied. The runner itself reads
      // it from `process.env` BEFORE scrubbing — once the child claude
      // process is spawned, it has no business knowing where the
      // wake-up bundle lives.
      SCHEGENT_WAKEUP_HOME: '/var/folders/xyz',
      PATH: '/bin'
    };
    const out = scrubEnv(parent);
    for (const k of Object.keys(parent)) {
      if (k === 'PATH') continue;
      expect(out, `${k} must be dropped`).not.toHaveProperty(k);
    }
  });

  it('drops every WORKSPACE-prefixed var (single + multi)', () => {
    const parent: NodeJS.ProcessEnv = {
      WORKSPACES: '/a:/b',
      WORKSPACE_FOLDER: '/a',
      WORKSPACE_PATH: '/a',
      WORKSPACEURI: 'file:///a',
      PATH: '/bin'
    };
    const out = scrubEnv(parent);
    expect(out).not.toHaveProperty('WORKSPACES');
    expect(out).not.toHaveProperty('WORKSPACE_FOLDER');
    expect(out).not.toHaveProperty('WORKSPACE_PATH');
    expect(out).not.toHaveProperty('WORKSPACEURI');
  });

  it('drops the exact CLAUDE_AUTOCOMPACT_PCT_OVERRIDE deny match', () => {
    // The runner intentionally does NOT inherit the autocompact override
    // — the priming session is a one-token noop and should never pick
    // up the host's tuning knob (feature 012 wired this for normal
    // workflow runs only).
    const out = scrubEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '42', PATH: '/bin' });
    expect(out).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(out.PATH).toBe('/bin');
  });

  it('drops any var whose name contains TOKEN/SECRET/KEY/PASSWORD (substring match)', () => {
    const parent: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: FIXTURE_VALUE,
      AWS_ACCESS_KEY_ID: FIXTURE_VALUE,
      GITHUB_TOKEN: FIXTURE_VALUE,
      NPM_TOKEN: FIXTURE_VALUE,
      SLACK_BOT_TOKEN: FIXTURE_VALUE,
      DATABASE_PASSWORD: FIXTURE_VALUE,
      JWT_SECRET: FIXTURE_VALUE,
      MY_CUSTOM_SECRET: FIXTURE_VALUE,
      // Substring positives — defense-in-depth catches even creative names.
      WEIRD_API_KEY_NAME: FIXTURE_VALUE,
      PATH: '/bin'
    };
    const out = scrubEnv(parent);
    for (const k of Object.keys(parent)) {
      if (k === 'PATH') continue;
      expect(out, `${k} must be dropped`).not.toHaveProperty(k);
    }
  });

  it('preserves the allowlist exactly', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      HOME: '/Users/x',
      LANG: 'en_US.UTF-8',
      USER: 'x',
      LOGNAME: 'x',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/folders/x',
      TEMP: '/tmp',
      TMP: '/tmp'
    };
    const out = scrubEnv(parent);
    for (const k of Object.keys(parent)) {
      expect(out[k]).toBe(parent[k]);
    }
  });

  it('preserves LC_* locale variables (allowlist wildcard)', () => {
    const parent: NodeJS.ProcessEnv = {
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      LC_MESSAGES: 'en_US.UTF-8'
    };
    const out = scrubEnv(parent);
    expect(out.LC_ALL).toBe('en_US.UTF-8');
    expect(out.LC_CTYPE).toBe('UTF-8');
    expect(out.LC_MESSAGES).toBe('en_US.UTF-8');
  });

  it('drops anything not on the allowlist (default-deny posture)', () => {
    const parent: NodeJS.ProcessEnv = {
      // Random vars that look harmless but aren't on the allow list.
      EDITOR: 'vim',
      PWD: '/Users/x',
      OLDPWD: '/Users',
      _: '/usr/bin/node',
      RANDOM_VAR: 'value',
      MAYBE_USEFUL: '1',
      PATH: '/bin'
    };
    const out = scrubEnv(parent);
    expect(out.PATH).toBe('/bin');
    // None of the non-allowlisted survive even though they're not
    // explicitly denylisted — default-deny is the canonical posture.
    expect(out).not.toHaveProperty('EDITOR');
    expect(out).not.toHaveProperty('PWD');
    expect(out).not.toHaveProperty('OLDPWD');
    expect(out).not.toHaveProperty('_');
    expect(out).not.toHaveProperty('RANDOM_VAR');
    expect(out).not.toHaveProperty('MAYBE_USEFUL');
  });

  it('drops `undefined` values without crashing (NodeJS.ProcessEnv tolerance)', () => {
    // process.env values are `string | undefined`; the scrub must be
    // resilient to entries whose value is `undefined`.
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      HOME: undefined,
      VSCODE_PID: undefined
    };
    const out = scrubEnv(parent);
    expect(out.PATH).toBe('/bin');
    expect(out).not.toHaveProperty('HOME');
    expect(out).not.toHaveProperty('VSCODE_PID');
  });

  it('returns a fresh object — does not mutate the input', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      OPENAI_API_KEY: FIXTURE_VALUE
    };
    const out = scrubEnv(parent);
    expect(out).not.toBe(parent);
    // Input retains the placeholder (scrub copies, does not splice).
    expect(parent.OPENAI_API_KEY).toBe(FIXTURE_VALUE);
    // Output is clean.
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
  });
});
