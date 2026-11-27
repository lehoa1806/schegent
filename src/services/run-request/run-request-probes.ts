import { lstat } from 'node:fs/promises';
import { checkLocalFile, checkLocalFolder } from './local-input-validator';
import type { RunRequestValidationContext } from './run-request-validator';

type ValidationProbes = Pick<RunRequestValidationContext, 'localInputs' | 'outputProbe' | 'priorOutputs'>;

/** Shared by editor and headless launchers. A dangling symlink occupies an output target. */
export function runRequestProbes(
  readPriorRunOutputs: ValidationProbes['priorOutputs']['outputsFor'] | undefined
): ValidationProbes {
  return {
    localInputs: { checkFile: checkLocalFile, checkFolder: checkLocalFolder },
    outputProbe: {
      async exists(target) {
        try {
          await lstat(target);
          return true;
        } catch (error) {
          // An inaccessible target cannot safely be treated as available.
          return (error as NodeJS.ErrnoException).code !== 'ENOENT';
        }
      }
    },
    priorOutputs: { outputsFor: (runId) => readPriorRunOutputs?.(runId) ?? null }
  };
}
