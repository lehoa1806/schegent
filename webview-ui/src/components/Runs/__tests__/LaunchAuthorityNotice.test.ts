// FR-R4-F06 (FR-007 to FR-009, FR-014; T7; contract D, D4 to D6, and K6) -- what the
// launch surface says about the authority a Run will have.
//
// `LaunchAuthorityNotice` renders text the HOST composed and chose: a posture's `notice`
// for each backend the selected definition would actually run on, and that definition's
// capability notices. It composes no sentence of its own (hard rule 2), so the cases here
// are about WHICH host text appears, in WHAT form, and what the optional link does.
//
// CONTROL M18 (tasks.md TA8): a component that rendered every posture's `notice` and
// ignored `backends` would pass the Claude case and fail the Codex-only case. That case is
// the one that shows `backends` is being read, and it is why it is here.
//
// "Review in Settings" is a webview-local navigation (D5): the component calls a function
// it was handed by context. The case that asserts `postCommand` is never called is the
// guard against the shortcut of posting a command instead.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendPosture, CapabilityNotice } from '../../../lib/snapshot-types';
import {
  DASHBOARD_NAVIGATION,
  type DashboardNavigation
} from '../../../dashboard/navigation-context';

const postCommand = vi.fn();
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: readonly unknown[]) => postCommand(...args)
}));

// Late import so the component binds to the stub above.
import LaunchAuthorityNotice from '../LaunchAuthorityNotice.svelte';

afterEach(() => {
  cleanup();
  postCommand.mockReset();
});

const CLAUDE_NOTICE =
  'Claude runs with no OS-enforced bound, so model-generated actions execute with your local ' +
  'user authority; you accepted that for this backend only.';

const POSTURES: readonly BackendPosture[] = [
  { kind: 'claude', containment: 'none', mechanism: 'none', grant: 'granted', notice: CLAUDE_NOTICE },
  {
    kind: 'codex',
    containment: 'os-enforced',
    mechanism: 'codex-sandbox-workspace-write',
    grant: 'not-required'
  },
  { kind: 'agy', containment: 'none', mechanism: 'none', grant: 'not-granted', refusal: 'refused' }
];

function navigationContext() {
  const openBackendSettings = vi.fn();
  const navigation: DashboardNavigation = { openBackendSettings };
  return { openBackendSettings, context: new Map([[DASHBOARD_NAVIGATION, navigation]]) };
}

describe('the host notice for a granted uncontained backend (D4)', () => {
  it('renders the notice as text for a launch that runs on that backend', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude'], postures: POSTURES, capabilityNotices: [] }
    });

    expect(view.getByTestId('launch-authority-notice-text-claude').textContent).toBe(CLAUDE_NOTICE);
  });

  it('renders nothing for a launch whose backends are all contained (M18 control)', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['codex'], postures: POSTURES, capabilityNotices: [] }
    });

    expect(view.queryByTestId('launch-authority-notice')).toBeNull();
    expect(view.queryByTestId('launch-authority-notice-text-claude')).toBeNull();
    expect(view.container.textContent.trim()).toBe('');
  });

  it('renders nothing for a backend whose posture carries no notice', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['agy'], postures: POSTURES, capabilityNotices: [] }
    });

    expect(view.queryByTestId('launch-authority-notice')).toBeNull();
  });

  it('shows the notice once for a launch that spans two backends of which one is granted', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude', 'codex'], postures: POSTURES, capabilityNotices: [] }
    });

    expect(view.getAllByTestId(/^launch-authority-notice-text-/)).toHaveLength(1);
    expect(view.getByTestId('launch-authority-notice-text-claude').textContent).toBe(CLAUDE_NOTICE);
  });

  it('renders markup in a notice literally, as text', () => {
    const hostile: readonly BackendPosture[] = [
      {
        kind: 'claude',
        containment: 'none',
        mechanism: 'none',
        grant: 'granted',
        notice: '<img src=x onerror=alert(1)><b>bold</b>'
      }
    ];
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude'], postures: hostile, capabilityNotices: [] }
    });

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('b')).toBeNull();
    expect(view.getByTestId('launch-authority-notice-text-claude').textContent).toBe(
      '<img src=x onerror=alert(1)><b>bold</b>'
    );
  });
});

describe('capability notices (K6)', () => {
  const NOTICES: readonly CapabilityNotice[] = [
    {
      phaseName: 'implement',
      backend: 'claude',
      outcome: 'residual',
      text: 'implement: a tool-access restriction, not OS isolation.'
    },
    {
      phaseName: 'review',
      backend: 'agy',
      outcome: 'refused',
      text: '<script>alert(1)</script>'
    }
  ];

  it('renders each capability notice as text, with no markup interpreted', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['codex'], postures: POSTURES, capabilityNotices: NOTICES }
    });

    expect(view.getByTestId('launch-authority-capability-0').textContent).toBe(NOTICES[0]?.text);
    expect(view.getByTestId('launch-authority-capability-1').textContent).toBe(
      '<script>alert(1)</script>'
    );
    expect(view.container.querySelector('script')).toBeNull();
  });

  it('renders capability notices even when no posture notice applies', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['codex'], postures: POSTURES, capabilityNotices: NOTICES }
    });

    expect(view.queryByTestId('launch-authority-notice-text-claude')).toBeNull();
    expect(view.getAllByTestId(/^launch-authority-capability-/)).toHaveLength(2);
  });
});

describe('Review in Settings (D5)', () => {
  it('follows the posture notice with one button that calls openBackendSettings once', async () => {
    const { openBackendSettings, context } = navigationContext();
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude'], postures: POSTURES, capabilityNotices: [] },
      context
    });

    const buttons = view.getAllByRole('button', { name: 'Review in Settings' });
    expect(buttons).toHaveLength(1);
    await fireEvent.click(buttons[0] as HTMLElement);

    expect(openBackendSettings).toHaveBeenCalledTimes(1);
  });

  it('renders no button without the navigation context', () => {
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude'], postures: POSTURES, capabilityNotices: [] }
    });

    expect(view.queryByRole('button')).toBeNull();
    expect(view.getByTestId('launch-authority-notice-text-claude')).toBeDefined();
  });

  it('renders no button for a capability notice, which has nothing to review there', () => {
    const { context } = navigationContext();
    const view = render(LaunchAuthorityNotice, {
      props: {
        backends: ['codex'],
        postures: POSTURES,
        capabilityNotices: [
          { phaseName: 'p', backend: 'claude', outcome: 'residual', text: 'residual text' }
        ]
      },
      context
    });

    expect(view.queryByRole('button')).toBeNull();
  });

  it('posts no command, on render or on a click', async () => {
    const { context } = navigationContext();
    const view = render(LaunchAuthorityNotice, {
      props: { backends: ['claude'], postures: POSTURES, capabilityNotices: [] },
      context
    });

    await fireEvent.click(view.getByRole('button', { name: 'Review in Settings' }));

    expect(postCommand).not.toHaveBeenCalled();
  });
});
