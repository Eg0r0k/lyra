/**
 * Mocking strategy:
 * - Browser/media mocks are not needed here; `CancellationToken` is tested as a
 *   pure async primitive with deferred promises.
 * - `vi` timers are unnecessary because cancellation is driven explicitly via
 *   `cancel()` and promise settlement.
 */
import { describe, expect, it } from "vitest";

import { CancellationError, CancellationToken } from "../core/CancellationToken";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CancellationToken", () => {
  it("cancel marks the token as cancelled", () => {
    const token = new CancellationToken();

    token.cancel();

    expect(token.isCancelled).toBe(true);
    expect(token.signal.aborted).toBe(true);
  });

  it("wrap rejects with CancellationError if cancelled before settlement", async () => {
    const token = new CancellationToken();
    const deferred = createDeferred<string>();
    const wrapped = token.wrap(deferred.promise);

    token.cancel();

    await expect(wrapped).rejects.toBeInstanceOf(CancellationError);
  });

  it("wrap rejects immediately if the token is already cancelled", async () => {
    const token = new CancellationToken();
    token.cancel();

    await expect(token.wrap(Promise.resolve("ok"))).rejects.toBeInstanceOf(
      CancellationError,
    );
  });

  it("wrap resolves the original promise when not cancelled", async () => {
    const token = new CancellationToken();

    await expect(token.wrap(Promise.resolve("done"))).resolves.toBe("done");
  });

  it("throwIfCancelled throws CancellationError", () => {
    const token = new CancellationToken();
    token.cancel();

    expect(() => token.throwIfCancelled()).toThrow(CancellationError);
  });

  it("replace cancels the old token and returns a fresh one", () => {
    const oldToken = new CancellationToken();
    const newToken = CancellationToken.replace(oldToken);

    expect(oldToken.isCancelled).toBe(true);
    expect(newToken).toBeInstanceOf(CancellationToken);
    expect(newToken).not.toBe(oldToken);
    expect(newToken.isCancelled).toBe(false);
  });

  it("CancellationError can be caught without being rethrown", async () => {
    const token = new CancellationToken();
    const deferred = createDeferred<void>();
    const wrapped = token.wrap(deferred.promise);

    token.cancel();

    let handled = false;

    await wrapped.catch((error: unknown) => {
      if (error instanceof CancellationError) {
        handled = true;
        return;
      }

      throw error;
    });

    expect(handled).toBe(true);
  });
});
