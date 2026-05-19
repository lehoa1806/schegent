import { CMD_SAVE_PIPELINES } from './messages';
import { saveCatalogCommand, type SaveCatalogResult } from './save-catalog-command';

export interface SavePipelineRow {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
}

export type SavePipelinesResult = SaveCatalogResult;

export function savePipelines(
  pipelines: readonly SavePipelineRow[],
  postMessage?: (msg: unknown) => void
): Promise<SavePipelinesResult> {
  return saveCatalogCommand(CMD_SAVE_PIPELINES, { pipelines }, postMessage);
}
