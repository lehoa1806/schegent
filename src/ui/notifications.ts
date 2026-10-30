export interface NotificationApi {
  showInformationMessage(message: string): Thenable<string | undefined>;
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
}

export class Notifier {
  private readonly api: NotificationApi;

  constructor(api: NotificationApi) {
    this.api = api;
  }

  public info(message: string): void {
    void this.api.showInformationMessage(message);
  }

  /**
   * A warning, with optional action buttons. The promise resolves to the action the operator chose, or
   * `undefined` if they dismissed it (FR-R4-F04: the deletion result offers "Show retained items").
   */
  public warn(message: string, ...actions: string[]): Thenable<string | undefined> {
    return this.api.showWarningMessage(message, ...actions);
  }

  public error(message: string): void {
    void this.api.showErrorMessage(message);
  }
}
