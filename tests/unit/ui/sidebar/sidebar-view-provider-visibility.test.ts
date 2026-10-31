// A hidden sidebar does no snapshot work (FR-R4-F08, contract V: V-T1 to V-T8; FR-011 to FR-014).
//
// WHAT THIS PINS. `SidebarViewProvider` posts a `STATE_SNAPSHOT` only while its view is
// visible, posts the projector's current snapshot once on each not-visible-to-visible
// transition, and holds at most one projector subscription and one visibility listener across
// any number of resolve and dispose cycles. Every other message (acknowledgements above all)
// is posted whatever the visibility.
//
// FIXTURE. The view is this file's own fake `WebviewView`: a mutable `visible`, a counted
// `onDidChangeVisibility` emitter and a counted `onDidDispose` emitter, a recording
// `postMessage` whose promise a case can hold open, and a captured `onDidReceiveMessage`. The
// projector is a fake `ProjectorHandle` that counts live subscriptions, answers
// `getCurrentSnapshot()`, and lets a case emit. As the real projector does, `subscribe` hands
// the listener the current snapshot immediately.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SidebarViewProvider } from '../../../../src/ui/sidebar/sidebar-view-provider';
import type { ProjectorHandle, ProjectorListener } from '../../../../src/ui/sidebar/projector-handle';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { CMD_ACK, CMD_OPEN_DASHBOARD, STATE_SNAPSHOT } from '../../../../src/ui/sidebar/messages';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() },
  Uri: { file: vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' })) }
}));

interface Post {
  readonly type: string;
  readonly payload: unknown;
}

/** A snapshot reduced to the one field a case reads: its serial. */
const snapshotOf = (serial: number): WorkflowSnapshot => ({ serial }) as unknown as WorkflowSnapshot;
const serialOf = (payload: unknown): number => (payload as { serial: number }).serial;

class FakeProjector implements ProjectorHandle {
  public current: WorkflowSnapshot;
  public liveSubscriptions = 0;
  private readonly listeners = new Set<ProjectorListener>();

  constructor(startSerial: number) {
    this.current = snapshotOf(startSerial);
  }

  public subscribe(listener: ProjectorListener) {
    this.listeners.add(listener);
    this.liveSubscriptions += 1;
    listener(this.current);
    return {
      dispose: () => {
        if (this.listeners.delete(listener)) this.liveSubscriptions -= 1;
      }
    };
  }

  public getCurrentSnapshot(): WorkflowSnapshot {
    return this.current;
  }

  /** A projection: the current snapshot becomes `serial`, and every listener hears it. */
  public emit(serial: number): void {
    this.current = snapshotOf(serial);
    for (const listener of [...this.listeners]) listener(this.current);
  }
}

class FakeView {
  public visible = true;
  public readonly posts: Post[] = [];
  public inbound: ((raw: unknown) => void) | null = null;
  /** When set, `postMessage` returns this promise instead of resolving at once. */
  public holdPosts: Promise<boolean> | null = null;
  private readonly visibilityListeners = new Set<(event: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();

  public get liveVisibilityListeners(): number {
    return this.visibilityListeners.size;
  }

  public readonly webview = {
    cspSource: 'vscode-webview://visibility-fixture',
    html: '',
    options: {} as unknown,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }),
    postMessage: (message: { type: string; payload?: unknown }): Promise<boolean> => {
      this.posts.push({ type: message.type, payload: message.payload });
      return this.holdPosts ?? Promise.resolve(true);
    },
    onDidReceiveMessage: (handler: (raw: unknown) => void) => {
      this.inbound = handler;
      return { dispose: () => undefined };
    }
  };

  public readonly onDidChangeVisibility = (listener: (event: unknown) => void) => {
    this.visibilityListeners.add(listener);
    return { dispose: () => void this.visibilityListeners.delete(listener) };
  };

  public readonly onDidDispose = (listener: () => void) => {
    this.disposeListeners.add(listener);
    return { dispose: () => void this.disposeListeners.delete(listener) };
  };

  /** What VS Code does: change `visible`, then tell every listener. */
  public setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.visibilityListeners]) listener({ webviewPanel: this });
  }

  public dispose(): void {
    for (const listener of [...this.disposeListeners]) listener();
  }

  public snapshotSerials(): number[] {
    return this.posts.filter((post) => post.type === STATE_SNAPSHOT).map((post) => serialOf(post.payload));
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await Promise.resolve();
}

interface Rig {
  readonly provider: SidebarViewProvider;
  readonly projector: FakeProjector;
  readonly view: FakeView;
}

async function resolved(startSerial = 1): Promise<Rig> {
  const projector = new FakeProjector(startSerial);
  const provider = new SidebarViewProvider({
    extensionRoot: '/nonexistent-extension-root',
    projector,
    logger: new SanitizedLogger()
  });
  const view = new FakeView();
  await provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken
  );
  await settle();
  // The immediate snapshot a subscription delivers is the visible sidebar's first paint, not what a case measures.
  view.posts.length = 0;
  return { provider, projector, view };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('V-T1 a hidden sidebar posts no snapshot', () => {
  it('three emitted snapshots while hidden produce zero STATE_SNAPSHOT posts', async () => {
    const { view, projector } = await resolved();
    // The control: while visible, an emit is posted, so a silent hidden period means something.
    projector.emit(2);
    await settle();
    expect(view.snapshotSerials(), 'the control: a visible emit is posted').toEqual([2]);

    view.posts.length = 0;
    view.setVisible(false);
    projector.emit(3);
    projector.emit(4);
    projector.emit(5);
    await settle();
    expect(view.snapshotSerials()).toEqual([]);
  });
});

describe('V-T2 and V-T3 a reveal posts the current snapshot once', () => {
  it('after changes while hidden, exactly one post carrying the current snapshot', async () => {
    const { view, projector } = await resolved();
    view.setVisible(false);
    projector.emit(2);
    projector.emit(3);
    projector.emit(4);
    await settle();
    expect(view.snapshotSerials(), 'nothing posted while hidden').toEqual([]);

    view.setVisible(true);
    await settle();
    expect(view.snapshotSerials()).toEqual([4]);
  });

  it('with no change while hidden, a reveal still posts one snapshot', async () => {
    const { view, projector } = await resolved(7);
    view.setVisible(false);
    await settle();
    view.setVisible(true);
    await settle();
    expect(projector.getCurrentSnapshot()).toEqual(snapshotOf(7));
    expect(view.snapshotSerials()).toEqual([7]);
  });
});

describe('V-T4 a repeated visible event posts nothing', () => {
  it('the reveal posts one, and a second visible=true event adds none', async () => {
    const { view } = await resolved();
    view.setVisible(false);
    await settle();
    view.setVisible(true);
    await settle();
    expect(view.snapshotSerials(), 'the control: the reveal itself posts one').toEqual([1]);

    view.setVisible(true);
    view.setVisible(true);
    await settle();
    expect(view.snapshotSerials(), 'a visibility event that is not a transition posts nothing').toEqual([1]);
  });
});

describe('V-T5 posts are made in event order', () => {
  it('hide, reveal, hide before the reveal post resolves, emit, reveal: never older after newer', async () => {
    const { view, projector } = await resolved(10);
    let release: (value: boolean) => void = () => undefined;
    view.holdPosts = new Promise<boolean>((resolve) => {
      release = resolve;
    });

    view.setVisible(false);
    projector.emit(11);
    projector.emit(12);
    view.setVisible(true);
    // The first reveal's post is still pending when the sidebar is hidden again.
    view.setVisible(false);
    projector.emit(13);
    projector.emit(14);
    view.setVisible(true);
    release(true);
    await settle();

    const serials = view.snapshotSerials();
    expect(serials, 'one post per reveal, carrying what was current then').toEqual([12, 14]);
    expect(serials).toEqual([...serials].sort((a, b) => a - b));
  });
});

describe('V-T6 no accumulation across resolve and dispose cycles', () => {
  it('ten cycles hold at most one projector subscription and one visibility listener at every point', async () => {
    const projector = new FakeProjector(1);
    const provider = new SidebarViewProvider({
      extensionRoot: '/nonexistent-extension-root',
      projector,
      logger: new SanitizedLogger()
    });
    let lastView: FakeView | null = null;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const view = new FakeView();
      lastView = view;
      await provider.resolveWebviewView(
        view as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      await settle();
      expect(projector.liveSubscriptions, `cycle ${cycle}: projector subscriptions after resolve`).toBeLessThanOrEqual(1);
      expect(view.liveVisibilityListeners, `cycle ${cycle}: visibility listeners after resolve`).toBe(1);
      expect(projector.liveSubscriptions, `the control: cycle ${cycle}'s resolve subscribes to the projector`).toBe(1);
      view.dispose();
      expect(projector.liveSubscriptions, `cycle ${cycle}: projector subscriptions after dispose`).toBe(0);
      expect(view.liveVisibilityListeners, `cycle ${cycle}: visibility listeners after dispose`).toBe(0);
    }
    // After the last dispose an emit posts nothing.
    if (lastView === null) throw new Error('no cycle ran');
    lastView.posts.length = 0;
    projector.emit(99);
    await settle();
    expect(lastView.posts).toEqual([]);
  });

  it('a re-resolve without a dispose still leaves one listener of each kind', async () => {
    const projector = new FakeProjector(1);
    const provider = new SidebarViewProvider({
      extensionRoot: '/nonexistent-extension-root',
      projector,
      logger: new SanitizedLogger()
    });
    const first = new FakeView();
    const second = new FakeView();
    for (const view of [first, second]) {
      await provider.resolveWebviewView(
        view as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
    }
    await settle();
    expect(projector.liveSubscriptions).toBe(1);
    expect(first.liveVisibilityListeners + second.liveVisibilityListeners).toBe(1);
    // The previous view's listeners are gone, and the new view received the current snapshot on subscription.
    expect(first.liveVisibilityListeners, 'the first view\'s visibility listener was released').toBe(0);
    expect(second.snapshotSerials(), 'the re-resolved view is sent the current snapshot').toEqual([1]);
  });
});

describe('V-T7 setProjector while hidden', () => {
  it('posts nothing at once, and the next reveal posts the new projector\'s snapshot', async () => {
    const { provider, view, projector } = await resolved(1);
    view.setVisible(false);
    await settle();
    const replacement = new FakeProjector(500);
    provider.setProjector(replacement);
    await settle();
    expect(view.snapshotSerials(), 'the new subscription\'s immediate snapshot is not posted while hidden').toEqual([]);
    expect(projector.liveSubscriptions, 'the old projector is released').toBe(0);
    expect(replacement.liveSubscriptions).toBe(1);

    view.setVisible(true);
    await settle();
    expect(view.snapshotSerials()).toEqual([500]);
  });
});

describe('V-T8 acknowledgements are not gated', () => {
  it('an acknowledgement is posted while the sidebar is hidden', async () => {
    const { provider, view } = await resolved();
    provider.setDispatch((command, ack) => {
      void ack({ type: CMD_ACK, correlationId: command.correlationId, status: 'accepted' });
    });
    view.setVisible(false);
    await settle();
    expect(view.inbound, 'the control: the provider listens for inbound messages').not.toBeNull();

    view.inbound?.({ type: CMD_OPEN_DASHBOARD, correlationId: 'corr-hidden' });
    await settle();

    expect(view.posts.map((post) => post.type)).toEqual([CMD_ACK]);
  });
});
