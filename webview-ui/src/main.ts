import { mount } from 'svelte';
import App from './App.svelte';
import './lib/theme.css';
import { snapshotStore } from './lib/snapshot-store.svelte';
import { onHostMessage } from './lib/vscode-api';
import type { HostMessage } from './lib/messages';
import type { WorkflowSnapshot } from './lib/snapshot-types';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Schegent webview: missing #app root');
}

mount(App, { target });

onHostMessage((msg) => {
  snapshotStore.apply(msg as HostMessage<WorkflowSnapshot>);
});
