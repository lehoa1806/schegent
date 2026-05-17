export interface NotificationApi {
  showInformationMessage(message: string): Thenable<string | undefined>;
  showWarningMessage(message: string): Thenable<string | undefined>;
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

  public warn(message: string): Thenable<string | undefined> {
    return this.api.showWarningMessage(message);
  }

  public error(message: string): void {
    void this.api.showErrorMessage(message);
  }
}
