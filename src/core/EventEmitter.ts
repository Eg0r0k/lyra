type Callback<T> = T extends void ? () => void : (payload: T) => void;
type Unsubscribe = () => void;

export class EventEmitter<
  TEventMap extends { [K in keyof TEventMap]: TEventMap[K] }
> {
  private listeners = new Map<keyof TEventMap, Set<Callback<unknown>>>();
  private onceFlags = new WeakSet<Callback<unknown>>();

  on<K extends keyof TEventMap>(
    event: K,
    callback: Callback<TEventMap[K]>
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }

    set.add(callback as Callback<unknown>);

    return () => this.off(event, callback);
  }

  once<K extends keyof TEventMap>(
    event: K,
    callback: Callback<TEventMap[K]>
  ): Unsubscribe {
    const wrapper = ((payload: TEventMap[K]) => {
      this.off(event, wrapper as Callback<TEventMap[K]>);
      (callback as (p: TEventMap[K]) => void)(payload);
    }) as Callback<TEventMap[K]>;

    this.onceFlags.add(wrapper as Callback<unknown>);
    return this.on(event, wrapper);
  }

  waitFor<K extends keyof TEventMap>(
    event: K,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<TEventMap[K]> {
    return new Promise((resolve, reject) => {
      const { timeout, signal } = options ?? {};

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: Unsubscribe;

      const cleanup = () => {
        unsubscribe?.();
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };

      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      signal?.addEventListener("abort", onAbort);

      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for event "${String(event)}"`));
        }, timeout);
      }

      unsubscribe = this.once(event, ((payload: TEventMap[K]) => {
        cleanup();
        resolve(payload);
      }) as Callback<TEventMap[K]>);
    });
  }

  off<K extends keyof TEventMap>(
    event: K,
    callback?: Callback<TEventMap[K]>
  ): void {
    if (!callback) {
      this.listeners.delete(event);
      return;
    }

    const set = this.listeners.get(event);
    set?.delete(callback as Callback<unknown>);
  }

  protected emit<K extends keyof TEventMap>(
    event: K,
    ...args: TEventMap[K] extends void ? [] : [TEventMap[K]]
  ): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    const payload = args[0] as TEventMap[K];

    for (const callback of [...set]) {
      try {
        (callback as (p: TEventMap[K]) => void)(payload);
      } catch (err) {
        console.error(`Error in "${String(event)}" handler:`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
