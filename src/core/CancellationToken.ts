export class CancellationError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

export class CancellationToken {
  private _controller: AbortController;

  constructor() {
    this._controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get isCancelled(): boolean {
    return this._controller.signal.aborted;
  }

  cancel(): void {
    this._controller.abort();
  }

  throwIfCancelled(): void {
    if (this.isCancelled) {
      throw new CancellationError();
    }
  }

  wrap<T>(promise: Promise<T>): Promise<T> {
    if (this.isCancelled) return Promise.reject(new CancellationError());

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const onAbort = () => done(() => reject(new CancellationError()));
      this.signal.addEventListener("abort", onAbort, { once: true });

      promise
        .then((value) =>
          done(() => {
            this.signal.removeEventListener("abort", onAbort);
            resolve(value);
          }),
        )
        .catch((err) =>
          done(() => {
            this.signal.removeEventListener("abort", onAbort);
            reject(err);
          }),
        );
    });
  }

  static replace(old: CancellationToken): CancellationToken {
    old.cancel();
    return new CancellationToken();
  }
}
