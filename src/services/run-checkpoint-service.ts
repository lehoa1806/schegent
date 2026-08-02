import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';

const runExecFile = promisify(execFile);
const PER_RUN_LIMIT = 20;

/** Private recovery checkpoints captured immediately before Git-capable phases. */
export class RunCheckpointService {
  constructor(
    private readonly root: string,
    private readonly workspaceRoot: string,
    private readonly logger: SanitizedLogger
  ) {}

  public async checkpoint(run: WorkflowRun, phaseId: string): Promise<void> {
    const safeRun = run.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safePhase = phaseId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const runRoot = path.join(this.root, 'checkpoints', safeRun);
    try {
      await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(runRoot, 0o700);
      const [{ stdout: diff }, { stdout: status }] = await Promise.all([
        runExecFile('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
          cwd: this.workspaceRoot,
          maxBuffer: 20 * 1024 * 1024
        }),
        runExecFile('git', ['status', '--porcelain=v1'], {
          cwd: this.workspaceRoot,
          maxBuffer: 1024 * 1024
        })
      ]);
      const prefix = `${Date.now()}-${safePhase}`;
      await fs.writeFile(path.join(runRoot, `${prefix}.patch`), diff, { mode: 0o600 });
      await fs.writeFile(
        path.join(runRoot, `${prefix}.json`),
        JSON.stringify({ runId: run.id, phaseId, capturedAt: Date.now(), status }, null, 2),
        { mode: 0o600 }
      );
      await this.prune(runRoot);
    } catch (error) {
      this.logger.warn(`checkpoint failed; Git-capable phase blocked: ${(error as Error).message}`);
      throw new Error('checkpoint-unavailable');
    }
  }

  private async prune(runRoot: string): Promise<void> {
    const files = (await fs.readdir(runRoot)).sort();
    const prefixes = [...new Set(files.map((name) => name.replace(/\.(patch|json)$/, '')))];
    for (const prefix of prefixes.slice(0, Math.max(0, prefixes.length - PER_RUN_LIMIT))) {
      await Promise.all([
        fs.rm(path.join(runRoot, `${prefix}.patch`), { force: true }),
        fs.rm(path.join(runRoot, `${prefix}.json`), { force: true })
      ]);
    }
  }
}
