/**
 * FR-R6-F12 (FR-004, FR-005, FR-014; research R5) — the editor binding for change reviews.
 *
 * The only module of the feature that imports the editor API. The content provider reads a review
 * document by handle and nothing else: the display segment of the path is never used to find
 * content. Nothing in activation imports this yet; a host wires it when a review surface ships.
 */

import * as vscode from 'vscode';
import { PLACEHOLDER_SENTENCES } from '../../contracts/change-review';
import type { ChangeReviewService } from '../../services/change-review/change-review-service';
import { CHANGES_COMMAND, type ChangeTriple, type EditorPort } from './review-opener';
import { REVIEW_SCHEME, parseDocumentPath } from './review-uri';

const DIFF_COMMAND = 'vscode.diff';

function reviewUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REVIEW_SCHEME, path });
}

function optionalUri(path: string | undefined): vscode.Uri | undefined {
  return path === undefined ? undefined : reviewUri(path);
}

/** The content provider for review documents; dispose it to stop serving them. */
export function registerChangeReviewProvider(service: ChangeReviewService): vscode.Disposable {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri) => {
      const handle = parseDocumentPath(uri.path);
      if (handle === null) return PLACEHOLDER_SENTENCES.unavailable;
      return (await service.readContent(handle)).text;
    }
  };
  return vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, provider);
}

/** The opener's editor port over the editor API. */
export function createVscodeEditorPort(): EditorPort {
  return {
    hasCommand: async (id) => (await vscode.commands.getCommands(true)).includes(id),
    openChanges: async (title, triples: readonly ChangeTriple[]) => {
      const resources = triples.map((triple) => [reviewUri(triple.label), optionalUri(triple.left), optionalUri(triple.right)]);
      await vscode.commands.executeCommand(CHANGES_COMMAND, title, resources);
    },
    showNotice: (text) => {
      void vscode.window.showInformationMessage(text);
    },
    pick: async (labels) => {
      const items = labels.map((label, index) => ({ label, index }));
      const picked = await vscode.window.showQuickPick(items, { canPickMany: false });
      return picked?.index;
    },
    openDiff: async (left, right, title) => {
      await vscode.commands.executeCommand(DIFF_COMMAND, reviewUri(left), reviewUri(right), title);
    }
  };
}
