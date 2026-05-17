import * as fs from 'fs/promises';
import type { InitialTailReader } from './state-projector';

/**
 * Reads the last `maxLines` non-empty lines from an audit-log file.
 *
 * Returns raw bytes intentionally. Sanitization happens downstream in
 * `StateProjector` before any audit tail entry crosses the webview IPC
 * boundary; `SECRET_PATTERNS` in `src/lib/logger.ts` is the single
 * source of truth. Do not add a parallel sanitizer here — double
 * sanitization is forbidden per the threat-model invariants.
 */
export class FileInitialTailReader implements InitialTailReader {
  public async readTail(filePath: string, maxLines: number): Promise<readonly string[]> {
    let contents: string;
    try {
      contents = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
    const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(Math.max(0, lines.length - maxLines));
  }
}
