/**
 * Shared worker-thread entry-point resolution and error helpers.
 *
 * Resolves typed worker scripts across all three host execution environments
 * without inline script-string evaluation:
 *   1. Bundled extension host (`dist/extension.js`) -> sibling `dist/<name>.worker.js`.
 *   2. `tsc`-compiled integration host (`out/src/.../*.js`) -> sibling compiled `<entry>.js`.
 *   3. Direct TypeScript source execution under Vitest -> sibling `<entry>.ts`
 *      executed via Node's built-in erasable-TypeScript type stripping.
 *
 * Zero `vscode` imports (keeps module headless-testable).
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export const WORKER_OOM_ERROR_CODE = 'ERR_WORKER_OUT_OF_MEMORY' as const;

export interface WorkerEntryPathOptions {
  /** Bundled worker filename emitted into `dist/` by esbuild (e.g. `run-snapshot.worker.js`). */
  readonly bundledFilename: string;
  /** Sibling source module stem without extension (e.g. `run-snapshot-worker-entry`). */
  readonly sourceEntryStem: string;
  /** Calling module directory (`__dirname`). */
  readonly callerDir: string;
  /** Calling module filename (`__filename`). */
  readonly callerFilename: string;
  /** Injectable existence predicate (defaults to `existsSync`). */
  readonly fileExists?: ((candidatePath: string) => boolean) | undefined;
}

/**
 * Resolve the absolute worker entry module path for the current runtime layout.
 */
export function resolveWorkerEntryPath(options: WorkerEntryPathOptions): string {
  const exists = options.fileExists ?? existsSync;
  const isCompiledJsHost =
    options.callerFilename.endsWith('.js') ||
    options.callerFilename.endsWith('.cjs') ||
    options.callerFilename.endsWith('.mjs');

  if (isCompiledJsHost) {
    const bundled = path.join(options.callerDir, options.bundledFilename);
    if (exists(bundled)) {
      return bundled;
    }
    const compiledSibling = path.join(options.callerDir, `${options.sourceEntryStem}.js`);
    if (exists(compiledSibling)) {
      return compiledSibling;
    }
  }

  const tsSibling = path.join(options.callerDir, `${options.sourceEntryStem}.ts`);
  if (exists(tsSibling)) {
    return tsSibling;
  }

  return isCompiledJsHost ? path.join(options.callerDir, options.bundledFilename) : tsSibling;
}

/**
 * Node emits `MODULE_TYPELESS_PACKAGE_JSON` when executing ESM-syntax `.ts` files
 * directly under a package without `"type": "module"`. Suppress that stderr noise
 * only for `.ts` source execution in tests; bundled CJS `.js` workers need no extra flags.
 */
export function workerExecArgvForEntry(workerEntryPath: string): string[] | undefined {
  if (workerEntryPath.endsWith('.ts')) {
    return ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
  }
  return undefined;
}

/** Extract a string `.code` property from an unknown error value. */
export function extractWorkerErrorCode(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return fallback;
}

/** True when a worker terminated due to reaching its V8 `resourceLimits`. */
export function isWorkerOutOfMemoryError(err: unknown): boolean {
  return extractWorkerErrorCode(err, '') === WORKER_OOM_ERROR_CODE;
}
