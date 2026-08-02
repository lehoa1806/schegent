import { CMD_SAVE_MODELS } from './messages';
import { saveCatalogCommand, type SaveCatalogResult } from './save-catalog-command';

export type SaveModelsResult = SaveCatalogResult;

export function saveModels(
  models: Record<string, readonly string[]>,
  postMessage?: (msg: unknown) => void
): Promise<SaveModelsResult> {
  return saveCatalogCommand(CMD_SAVE_MODELS, { models }, postMessage);
}
