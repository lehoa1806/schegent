// Feature 091 T007–T010 — default command runner for the one-time
// Wake-up cleanup.
//
// Ported from `defaultCommandRunner()` in the deleted
// `src/wakeup/daemon-manager.ts`, trimmed to what removal needs: the
// `env` override is dropped (no removal operation customises the
// environment) and a default timeout is applied, because cleanup runs
// unattended after activation and must not hold a child process open
// indefinitely (FR-011, SC-008).
//
// Withdrawn at v0.6.0 with the rest of `src/cleanup/`.

import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunner } from './types';

/**
 * Upper bound on any single scheduler command. `launchctl`,
 * `systemctl`, `crontab`, and `schtasks` all return in well under a
 * second in normal operation; this bound exists so a wedged binary
 * cannot keep the cleanup run alive.
 */
export const COMMAND_TIMEOUT_MS = 10_000;

export function defaultCommandRunner(): CommandRunner {
  return {
    run(cmd, args, opts = {}) {
      return new Promise<CommandResult>((resolve) => {
        const child = spawn(cmd, [...args], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* the child is already gone */
          }
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* the child is already gone */
            }
          }, 5_000).unref();
        }, timeoutMs);
        timer.unref();

        const settle = (exitCode: number): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode });
        };

        child.stdout?.on('data', (d) => {
          stdout += String(d);
        });
        child.stderr?.on('data', (d) => {
          stderr += String(d);
        });
        child.on('exit', (code) => settle(typeof code === 'number' ? code : 1));
        child.on('error', () => settle(-1));

        if (typeof opts.input === 'string' && child.stdin) {
          child.stdin.write(opts.input);
          child.stdin.end();
        } else if (child.stdin) {
          child.stdin.end();
        }
      });
    }
  };
}
