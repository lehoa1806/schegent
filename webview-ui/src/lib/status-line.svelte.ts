// The dashboard's status line: the one place a view says what just happened.
//
// The dashboard shell renders `statusLine.message` in a polite live region at the bottom of the
// window, so a screen reader reads each new message once and a sighted operator can glance at it.
// A view calls `statusLine.announce` after a change it made itself and that is not otherwise
// obvious: which page is showing, which row's details opened, what the Workflow Builder's canvas
// selected, added or deleted. It is not a log and keeps no history; the next message replaces the
// last.
//
// Only dashboard code imports this module. The sidebar has no status line.

/** What the line reads before anything has been announced. */
export const STATUS_LINE_READY = 'Ready.';

class StatusLine {
  #message = $state(STATUS_LINE_READY);

  get message(): string {
    return this.#message;
  }

  /** Replaces the line's text. */
  announce(next: string): void {
    this.#message = next;
  }
}

export const statusLine = new StatusLine();
