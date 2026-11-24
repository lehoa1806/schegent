/**
 * FR-R8-02 (02-02) — end-to-end admission, consent binding, single-resolution handoff, and audit
 * posture proof for standalone native-review scanner executables (`codex-security`).
 *
 * Uses disposable recording executables on disk (`codex` and `codex-security`, plus an alternate
 * PATH decoy) through the real `wireContainmentAdmission` -> `SpawnGatedRunner` -> `AcpBackedRunner`
 * -> bundled `dist/acp-stdio-bridge.js` -> `invokeNativeReviewer` pipeline.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { ReviewScannerId } from '../../src/contracts/containment-qualification';
import { invokeNativeReviewer } from '../../src/controller/native-review';
import { UncontainedConsentGate } from '../../src/controller/uncontained-consent-gate';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { SpawnGatedRunner } from '../../src/runner/spawn-gated-runner';
import { ContainmentAdmissionRefusedError } from '../../src/services/containment-qualification/admission-refusal';
import type { AcceptanceMementoPort } from '../../src/services/containment-qualification/acceptance-bindings';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { unwrapStreamJson } from '../../src/parser/stream-json-unwrapper';

const BRIDGE_BUNDLE = resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

class InMemoryMemento implements AcceptanceMementoPort {
  private readonly store = new Map<string, unknown>();
  public get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

function makeStubInner(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: async () => {
      throw new Error('legacy inner runner must not execute for ACP native review');
    },
    cancelActive: () => false,
    settleTeardowns: async () => [],
    close: () => undefined
  };
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function makeFakeCodexScript(markerPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.163.0\\n');
  process.exit(0);
}
appendFileSync(${JSON.stringify(markerPath)}, 'codex:' + JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
const report = JSON.stringify({ verdict: 'clean', summary: 'Code review clean', findings: [] });
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 12 } }) + '\\n');
process.exit(0);
`;
}

function makeFakeCodexSecurityScript(
  markerPath: string,
  versionLogPath: string,
  versionFilePath: string,
  tag: string,
  mergeBase: string
): string {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  const ver = readFileSync(${JSON.stringify(versionFilePath)}, 'utf8').trim();
  appendFileSync(${JSON.stringify(versionLogPath)}, '${tag}:--version:' + ver + '\\n', 'utf8');
  process.stdout.write('codex-security ' + ver + '\\n');
  process.exit(0);
}
appendFileSync(${JSON.stringify(markerPath)}, '${tag}:' + JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    manifest: {
      scan: {
        status: 'completed',
        target: { kind: 'git_diff', baseRevision: ${JSON.stringify(mergeBase)} }
      }
    },
    coverage: { deferred: [] },
    findings: { findings: [] }
  }
}) + '\\n');
process.exit(0);
`;
}

function initDisposableGitRepo(dir: string): string {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'app.ts'), 'export const x = 1;\n', 'utf8');
  execFileSync('git', ['add', 'app.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'app.ts'), 'export const x = 2;\n', 'utf8');
  return head;
}

describe('FR-R8-02 (02-02) — standalone codex-security scanner admission and truthful audit posture', () => {
  it('refuses codex-security without explicit scanner consent, in Restricted Mode, on binary/version change, and after revocation, while admitting consented tuple with exact path handoff and honest audit posture', async () => {
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'schegent-scanner-adm-'));
    try {
      const workspaceDir = join(root, 'workspace');
      const binDir = join(root, 'bin');
      const movedDir = join(root, 'moved-bin');
      const decoyDir = join(root, 'decoy-bin');
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(movedDir, { recursive: true });
      mkdirSync(decoyDir, { recursive: true });
      const mergeBase = initDisposableGitRepo(workspaceDir);

      const codexMarker = join(root, 'codex-spawn.log');
      const scannerMarker = join(root, 'scanner-spawn.log');
      const scannerVersionLog = join(root, 'scanner-version.log');
      const scannerVersionFile = join(root, 'scanner-version.txt');
      const decoyMarker = join(root, 'decoy-spawn.log');
      const decoyVersionFile = join(root, 'decoy-version.txt');
      writeFileSync(codexMarker, '', 'utf8');
      writeFileSync(scannerMarker, '', 'utf8');
      writeFileSync(scannerVersionLog, '', 'utf8');
      writeFileSync(scannerVersionFile, '1.2.0\n', 'utf8');
      writeFileSync(decoyMarker, '', 'utf8');
      writeFileSync(decoyVersionFile, '9.9.9\n', 'utf8');

      const codexPath = join(binDir, 'codex');
      const scannerPath = join(binDir, 'codex-security');
      const movedScannerPath = join(movedDir, 'codex-security');
      const decoyPath = join(decoyDir, 'codex-security');
      writeExecutable(codexPath, makeFakeCodexScript(codexMarker));
      writeExecutable(
        scannerPath,
        makeFakeCodexSecurityScript(scannerMarker, scannerVersionLog, scannerVersionFile, 'primary', mergeBase)
      );
      writeExecutable(
        decoyPath,
        makeFakeCodexSecurityScript(decoyMarker, scannerVersionLog, decoyVersionFile, 'decoy', mergeBase)
      );

      const memento = new InMemoryMemento();
      let trusted = true;
      let grantedScanners = new Set<ReviewScannerId>();
      const grantedBackends = new Set<BackendRunnerKind>(['codex']);

      // Use real default `createCliVersionProbe.observeScanner` (no fake scanner version map!)
      // so we prove strictly ZERO subprocess spawns (--version or scan) on every refusal path.
      const wiring = wireContainmentAdmission({
        memento,
        logger: { warn: () => undefined },
        isTrusted: () => trusted,
        hasPrimacy: async () => true,
        environmentPolicy: { mode: 'inherit', inheritProcessEnv: true },
        granted: () => grantedBackends,
        grantedScanners: () => grantedScanners,
        observeVersion: async (cliPath) => (cliPath === codexPath ? '0.163.0' : null)
      });

      const acpRunner = new AcpBackedRunner({
        kind: 'codex',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: workspaceDir,
        platform: QUALIFIED_PLATFORM
      });
      const gatedRunner = new SpawnGatedRunner('codex', acpRunner, wiring.spawnGate);

      const envWithScanner = {
        PATH: `${binDir}:${decoyDir}:${process.env.PATH ?? '/usr/bin:/bin'}`
      };

      const runSecurityReview = async (
        audited: Record<string, unknown>[],
        envOverride: Readonly<Record<string, string>> = envWithScanner
      ) =>
        invokeNativeReviewer(
          (req, sink) => gatedRunner.invoke(req, sink),
          {
            runId: 'run-scanner-01',
            cliPath: codexPath,
            cwd: workspaceDir,
            prompt: 'security review',
            phase: 'review',
            iteration: 1,
            timeoutMs: 15_000,
            env: envOverride,
            review: { kind: 'security', mergeBase, excludedPaths: [] }
          },
          'codex',
          null,
          undefined,
          async (payload) => {
            audited.push(payload);
          }
        );

      // 1. Qualified `codex` alone MUST NOT admit `codex-security` — fails closed with ZERO spawns
      //    (neither `--version` nor `scan`), and UncontainedConsentGate MUST NOT offer core `codex` consent!
      const auditRefused: Record<string, unknown>[] = [];
      let refusedErr: unknown;
      try {
        await runSecurityReview(auditRefused);
      } catch (err) {
        refusedErr = err;
      }
      expect(refusedErr).toBeInstanceOf(ContainmentAdmissionRefusedError);
      const refusal1 = refusedErr as ContainmentAdmissionRefusedError;
      expect(refusal1.reason).toBe('containment-unqualified-for-tuple');
      expect(refusal1.kind).toBe('codex');
      expect(refusal1.scannerTarget).toBe('codex-security');
      expect(refusal1.consentable).toBe(false);
      expect(readFileSync(scannerMarker, 'utf8')).toBe('');
      expect(readFileSync(scannerVersionLog, 'utf8')).toBe('');
      expect(readFileSync(decoyMarker, 'utf8')).toBe('');
      expect(auditRefused).toEqual([]);

      let consentPrompted = false;
      let coreAccepted = false;
      const consentGate = new UncontainedConsentGate(
        async () => {
          consentPrompted = true;
          return { decision: 'granted' };
        },
        (m) => m,
        async () => {
          coreAccepted = true;
        }
      );
      expect(await consentGate.decide(refusal1)).toEqual({ action: 'report', err: refusal1 });
      expect(consentPrompted).toBe(false);
      expect(coreAccepted).toBe(false);

      // 2. Explicit operator inspection probes `--version` once and binds the exact scanner fingerprint;
      //    Restricted Mode STILL fails closed with ZERO spawns!
      const inspected1 = await wiring.inspectScannerForConsent('codex-security', envWithScanner);
      expect(inspected1.ok).toBe(true);
      if (!inspected1.ok) throw new Error('expected scanner inspection to succeed');
      expect(readFileSync(scannerVersionLog, 'utf8')).toContain('primary:--version:1.2.0');
      grantedScanners = new Set<ReviewScannerId>(['codex-security']);
      await wiring.recordScannerAcceptance('codex-security', inspected1.fingerprint);

      const versionLogAfterBind = readFileSync(scannerVersionLog, 'utf8');
      trusted = false;
      await expect(runSecurityReview([])).rejects.toThrow(ContainmentAdmissionRefusedError);
      expect(readFileSync(scannerMarker, 'utf8')).toBe('');
      expect(readFileSync(scannerVersionLog, 'utf8')).toBe(versionLogAfterBind);
      trusted = true;

      // 3. Trusted + explicitly consented + bound tuple: scanner runs via exact resolved path
      //    (decoy never invoked) and audit records `codex-security` + `accepted-uncontained` + `unrestricted`.
      const auditConsented: Record<string, unknown>[] = [];
      const consentedRaw = await runSecurityReview(auditConsented);
      expect(consentedRaw.exitCode).toBe(0);
      expect(unwrapStreamJson(consentedRaw.stdoutBuffer).text).toContain('"status":"completed"');
      expect(readFileSync(scannerMarker, 'utf8')).toContain('primary:');
      expect(readFileSync(decoyMarker, 'utf8')).toBe('');
      expect(auditConsented).toHaveLength(1);
      expect(auditConsented[0]).toMatchObject({
        runner: 'codex',
        operation: 'native-review',
        permissionMode: 'unrestricted',
        executableTarget: 'codex-security',
        containmentPosture: 'accepted-uncontained'
      });

      // 4. Path-move invalidation: identical binary bytes placed in a different PATH dir changes
      //    `resolvedPathDigest` and MUST refuse BEFORE any `--version` or `scan` spawn!
      const spawnsBeforeMove = readFileSync(scannerMarker, 'utf8');
      const versionLogBeforeMove = readFileSync(scannerVersionLog, 'utf8');
      copyFileSync(scannerPath, movedScannerPath);
      chmodSync(movedScannerPath, 0o755);
      const envMoved = { PATH: `${movedDir}:${process.env.PATH ?? '/usr/bin:/bin'}` };
      let moveErr: unknown;
      try {
        await runSecurityReview([], envMoved);
      } catch (err) {
        moveErr = err;
      }
      expect(moveErr).toBeInstanceOf(ContainmentAdmissionRefusedError);
      expect((moveErr as ContainmentAdmissionRefusedError).reason).toBe('acceptance-fingerprint-changed');
      expect(readFileSync(scannerMarker, 'utf8')).toBe(spawnsBeforeMove);
      expect(readFileSync(scannerVersionLog, 'utf8')).toBe(versionLogBeforeMove);

      // 5. Replace binary in-place on disk (digest changes even with same path & version) ->
      //    MUST refuse BEFORE any `--version` or `scan` spawn!
      writeExecutable(
        scannerPath,
        makeFakeCodexSecurityScript(scannerMarker, scannerVersionLog, scannerVersionFile, 'swapped', mergeBase)
      );
      let swapErr: unknown;
      try {
        await runSecurityReview([]);
      } catch (err) {
        swapErr = err;
      }
      expect(swapErr).toBeInstanceOf(ContainmentAdmissionRefusedError);
      expect((swapErr as ContainmentAdmissionRefusedError).reason).toBe('acceptance-fingerprint-changed');
      expect(readFileSync(scannerMarker, 'utf8')).toBe(spawnsBeforeMove);
      expect(readFileSync(scannerVersionLog, 'utf8')).toBe(versionLogBeforeMove);

      // 6. Re-inspect and bind the swapped binary, then bump its reported `--version` ->
      //    with a fresh wiring (uncached probe), version drift MUST refuse with zero scan spawns!
      const inspected2 = await wiring.inspectScannerForConsent('codex-security', envWithScanner);
      expect(inspected2.ok).toBe(true);
      if (!inspected2.ok) throw new Error('expected re-inspection to succeed');
      await wiring.recordScannerAcceptance('codex-security', inspected2.fingerprint);

      writeFileSync(scannerVersionFile, '1.3.0\n', 'utf8');
      const freshWiring = wireContainmentAdmission({
        memento,
        logger: { warn: () => undefined },
        isTrusted: () => true,
        hasPrimacy: async () => true,
        environmentPolicy: { mode: 'inherit', inheritProcessEnv: true },
        granted: () => grantedBackends,
        grantedScanners: () => grantedScanners,
        observeVersion: async (cliPath) => (cliPath === codexPath ? '0.163.0' : null)
      });
      const freshGatedRunner = new SpawnGatedRunner('codex', acpRunner, freshWiring.spawnGate);
      let verErr: unknown;
      try {
        await invokeNativeReviewer(
          (req, sink) => freshGatedRunner.invoke(req, sink),
          {
            runId: 'run-scanner-ver-bump',
            cliPath: codexPath,
            cwd: workspaceDir,
            prompt: 'security review',
            phase: 'review',
            iteration: 1,
            timeoutMs: 15_000,
            env: envWithScanner,
            review: { kind: 'security', mergeBase, excludedPaths: [] }
          },
          'codex',
          null,
          undefined,
          async () => undefined
        );
      } catch (err) {
        verErr = err;
      }
      expect(verErr).toBeInstanceOf(ContainmentAdmissionRefusedError);
      expect((verErr as ContainmentAdmissionRefusedError).reason).toBe('acceptance-fingerprint-changed');
      expect(readFileSync(scannerMarker, 'utf8')).toBe(spawnsBeforeMove);

      // 7. Revoke scanner grant -> MUST refuse with zero spawns even on matching binary!
      const versionLogBeforeRevoke = readFileSync(scannerVersionLog, 'utf8');
      writeFileSync(scannerVersionFile, '1.2.0\n', 'utf8');
      grantedScanners = new Set<ReviewScannerId>();
      await expect(runSecurityReview([])).rejects.toThrow(ContainmentAdmissionRefusedError);
      expect(readFileSync(scannerMarker, 'utf8')).toBe(spawnsBeforeMove);
      expect(readFileSync(scannerVersionLog, 'utf8')).toBe(versionLogBeforeRevoke);

      // 7. Standard `codex` code review runs `codex` under `read-only` / `contained` posture (never `codex-security`).
      const auditCodeReview: Record<string, unknown>[] = [];
      const codeRaw = await invokeNativeReviewer(
        (req, sink) => gatedRunner.invoke(req, sink),
        {
          runId: 'run-scanner-02',
          cliPath: codexPath,
          cwd: workspaceDir,
          prompt: 'code review',
          phase: 'review',
          iteration: 1,
          timeoutMs: 15_000,
          env: envWithScanner,
          review: { kind: 'code', mergeBase }
        },
        'codex',
        null,
        undefined,
        async (payload) => {
          auditCodeReview.push(payload);
        }
      );
      expect(codeRaw.exitCode).toBe(0);
      expect(readFileSync(codexMarker, 'utf8')).toContain('codex:');
      expect(auditCodeReview).toHaveLength(1);
      expect(auditCodeReview[0]).toMatchObject({
        runner: 'codex',
        operation: 'native-review',
        permissionMode: 'read-only',
        executableTarget: 'codex',
        containmentPosture: 'contained'
      });

      // 8. Defense-in-depth: direct AcpBackedRunner call for codex security review WITHOUT
      // resolvedScannerPath refuses before spawn (`acp-open-refused:scanner-unresolved`).
      const directRefused = await acpRunner.invoke({
        cliPath: codexPath,
        cwd: workspaceDir,
        prompt: 'security review',
        phase: 'review',
        iteration: 1,
        timeoutMs: 10_000,
        review: { kind: 'security', mergeBase, excludedPaths: [] }
      });
      expect(directRefused.exitCode).toBe(1);
      expect(directRefused.diagnosticWarnings).toContain('acp-open-refused:scanner-unresolved');
      expect(directRefused.stdoutBuffer).toBeInstanceOf(ZippedStreamBuffer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
