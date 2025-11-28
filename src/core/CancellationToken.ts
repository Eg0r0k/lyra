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
    if (this.isCancelled) {
      return Promise.reject(new CancellationError());
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new CancellationError());

      this.signal.addEventListener("abort", onAbort, { once: true });

      promise
        .then((value) => {
          this.signal.removeEventListener("abort", onAbort);
          if (this.isCancelled) {
            reject(new CancellationError());
          } else {
            resolve(value);
          }
        })
        .catch((err) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  }

  reset(): CancellationToken {
    this.cancel();
    return new CancellationToken();
  }
}
