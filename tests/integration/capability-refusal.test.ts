// FR-R3-086 — the refusal, exercised end to end through a real adapter.
//
// HOW A REFUSAL IS OBSERVED WITHOUT A LIVE MODEL. Every runner takes an
// injectable `spawnFn`. The fake below behaves like a permission-enforcing CLI:
// handed argv that withholds a capability, it emits the refusal a real CLI would
// emit and exits non-zero; handed the unbounded argv, it succeeds. So the host
// half is driven for real — the argv it produced, the classification, the
// outcome — against a stand-in for the backend's own permission engine.
//
// THE LIMIT, and it is stated at the code rather than left to be inferred: this
// proves what the HOST does. It does not prove the CLI enforces the flag. That is
// the backend's guarantee, recorded as a trust anchor in the threat model, and it
// is exactly why the mechanism refuses a phase whose declared set a backend
// cannot express rather than trusting it to do something sensible.
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AgyCliRunner } from '../../src/runner/agy-cli';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { declaredCapabilitySet, DEFAULT_CAPABILITY_SET, ALL_PHASE_CAPABILITIES } from '../../src/contracts/phase-capabilities';
import { isCapabilityRefusal } from '../../src/services/capability-refusal';
import type { InvocationRequest } from '../../src/runner/invocation-result';

/** What the fake CLI was asked to do, captured for assertion. */
interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
}

const spawned: Spawned[] = [];

/**
 * A CLI that enforces its own permission flags.
 *
 * `--disallowedTools Bash` means a shell attempt is refused at the attempt, the
 * way the real CLI's permission engine refuses it — so the fake emits the denial
 * on stdout and exits non-zero rather than pretending to run the command.
 */
function fakePermissionEnforcingCli(command: string, args: readonly string[]): EventEmitter {
  spawned.push({ command, args: [...args] });
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: () => boolean;
    pid?: number;
  };
  const denied = args.includes('--disallowedTools') && args.join(' ').includes('Bash');
  const line = denied
    ? JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'permission denied: Bash' })
    : JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  child.stdout = Readable.from([`${line}\n`]);
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _enc, done) { done(); } });
  child.kill = () => true;
  child.pid = 4242;
  setImmediate(() => child.emit('close', denied ? 1 : 0, null));
  return child;
}

function request(over: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    cliPath: 'fake-cli',
    prompt: 'do the thing',
    workspaceRoot: '/tmp/does-not-matter',
    ...over
  } as InvocationRequest;
}

describe('FR-R3-086 — a declared capability set is enforced or the phase is refused', () => {
  it('the DEFAULT set spawns with today\'s argv — nothing about an existing run changes', async () => {
    spawned.length = 0;
    const runner = new ClaudeCliRunner(fakePermissionEnforcingCli as never);
    await runner.invoke(request());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain('--dangerously-skip-permissions');
    expect(spawned[0]?.args.join(' ')).not.toContain('--disallowedTools');
  });

  it('a set WITHHOLDING process-spawn produces argv that denies the shell tool', async () => {
    spawned.length = 0;
    const runner = new ClaudeCliRunner(fakePermissionEnforcingCli as never);
    const narrowed = declaredCapabilitySet(
      ALL_PHASE_CAPABILITIES.filter((capability) => capability !== 'process-spawn')
    );
    const output = await runner.invoke(request({ capabilities: narrowed }));

    // The host produced the narrowing argv...
    expect(spawned[0]?.args).toContain('--disallowedTools');
    expect(spawned[0]?.args.join(' ')).toContain('Bash');
    expect(spawned[0]?.args).not.toContain('--dangerously-skip-permissions');
    // ...and the refusal the backend emitted is IN EVIDENCE — the invocation's
    // own recorded output, not something reconstructed from a transcript later.
    expect(output.exitCode).not.toBe(0);
    expect([...output.stdoutBuffer.decompressStream()].join('')).toContain('permission denied');
  });

  it('NON-VACUITY: widening the set lets the SAME operation succeed', async () => {
    // Without this, the refusal above could be an artefact of the fixture rather
    // than of the narrowing — "the gate stayed red" is the same observation
    // whether the mechanism works or the probe is wrong.
    spawned.length = 0;
    const runner = new ClaudeCliRunner(fakePermissionEnforcingCli as never);
    const widened = declaredCapabilitySet([...ALL_PHASE_CAPABILITIES]);
    const output = await runner.invoke(request({ capabilities: widened }));
    expect(spawned[0]?.args.join(' ')).not.toContain('Bash');
    expect(output.exitCode).toBe(0);
    expect([...output.stdoutBuffer.decompressStream()].join('')).not.toContain('permission denied');
  });

  it('a capability the backend CANNOT express refuses the phase BEFORE it starts', async () => {
    // Agy has one enforcement surface and no per-tool flag, so withholding
    // `network` has no expression there. The phase must not start: running with
    // the declared set ignored is the fence problem again.
    spawned.length = 0;
    const runner = new AgyCliRunner(fakePermissionEnforcingCli as never);
    const narrowed = declaredCapabilitySet(
      ALL_PHASE_CAPABILITIES.filter((capability) => capability !== 'network')
    );
    await expect(runner.invoke(request({ capabilities: narrowed }))).rejects.toSatisfy(
      isCapabilityRefusal
    );
    // Nothing was spawned. "Before it starts" is the claim, so it is asserted.
    expect(spawned).toHaveLength(0);
  });

  it('the refusal names every capability that backend cannot enforce', async () => {
    const runner = new AgyCliRunner(fakePermissionEnforcingCli as never);
    const narrowed = declaredCapabilitySet(['process-spawn']);
    let caught: unknown;
    try {
      await runner.invoke(request({ capabilities: narrowed }));
    } catch (error) {
      caught = error;
    }
    expect(isCapabilityRefusal(caught)).toBe(true);
    if (!isCapabilityRefusal(caught)) throw new Error('unreachable');
    expect(caught.kind).toBe('agy');
    expect(caught.unenforceable.length).toBeGreaterThan(1);
    // Distinguishable from a phase failure by TYPE, not by message-matching.
    expect(caught.name).toBe('CapabilityNotEnforceableError');
    expect(caught.message).toContain('refused rather than run with the declared set ignored');
  });

  it('an explicit default-marked set behaves exactly like an absent one', async () => {
    spawned.length = 0;
    const runner = new ClaudeCliRunner(fakePermissionEnforcingCli as never);
    await runner.invoke(request({ capabilities: DEFAULT_CAPABILITY_SET }));
    const withDefault = spawned[0]?.args;
    spawned.length = 0;
    await runner.invoke(request());
    expect(withDefault).toEqual(spawned[0]?.args);
  });
});
