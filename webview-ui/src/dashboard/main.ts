import { mount } from 'svelte';
import App from './App.svelte';
import '../lib/theme.css';
import './style.css';
import { snapshotStore } from '../lib/snapshot-store.svelte';
import { disposeIntentLedger } from '../lib/intent-ledger';
import { onHostMessage } from '../lib/vscode-api';
import type { HostMessage } from '../lib/messages';
import type { WorkflowSnapshot } from '../lib/snapshot-types';

const target = document.getElementById('dashboard-app') ?? document.getElementById('app');
if (!target) {
  throw new Error('Schegent dashboard: missing #dashboard-app root');
}

mount(App, { target });

onHostMessage((msg) => {
  snapshotStore.apply(msg as HostMessage<WorkflowSnapshot>);
});

// FR-R4-F05 (I9, FR-026) — when this webview realm goes, every ledger timer and listener goes
// with it and no outcome is shown afterwards. `pagehide` fires on a reload and on a panel's
// disposal; a hidden dashboard tab is reloaded by VS Code, which starts a new action.
window.addEventListener('pagehide', () => disposeIntentLedger());
