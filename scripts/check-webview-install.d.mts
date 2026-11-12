/** The documented install for the webview package, as CONTRIBUTING.md states it. */
export const WEBVIEW_INSTALL_COMMAND: string;

/** `null` when the webview dependencies are installed under `root`; otherwise what to run. */
export function webviewInstallProblem(root?: string): string | null;
