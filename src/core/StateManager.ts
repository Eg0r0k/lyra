import { PlayerState } from "../types/index";

const VALID_TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  idle: ["loading", "disposed"],
  loading: ["ready", "error", "idle", "disposed"],
  ready: ["playing", "loading", "idle", "disposed"],
  playing: ["paused", "buffering", "ready", "error", "idle", "disposed"],
  paused: ["playing", "ready", "loading", "idle", "disposed"],
  buffering: ["playing", "paused", "error", "idle", "disposed"],
  error: ["loading", "idle", "disposed"],
  disposed: [],
};

export interface StateChangeEvent {
  from: PlayerState;
  to: PlayerState;
}

export type StateChangeCallback = (event: StateChangeEvent) => void;

export class StateManager {
  private _state: PlayerState = "idle";

  private _callbacks = new Set<StateChangeCallback>();

  get state(): PlayerState {
    return this._state;
  }

  transition(to: PlayerState): boolean {
    if (this._state === to) return true;

    const validNext = VALID_TRANSITIONS[this._state];

    if (!validNext.includes(to)) {
      console.warn(
        `Invalid state transition: ${this._state} -> ${to}. ` +
          `Valid transitions: ${validNext.join(", ")}`
      );
      return false;
    }

    const from = this._state;

    this._state = to;

    for (const cb of this._callbacks) {
      try {
        cb({ from, to });
      } catch (err) {
        console.error("Error in state change callback:", err);
      }
    }
    return true;
  }

  onChange(callback: StateChangeCallback) {
    this._callbacks.add(callback);
    return () => this._callbacks.delete(callback);
  }

  is(state: PlayerState) {
    return this._state === state;
  }

  isOneOf(...states: PlayerState[]): boolean {
    return states.includes(this._state);
  }

  get isPlayable(): boolean {
    return this.isOneOf("ready", "paused", "playing", "buffering");
  }

  get isActive(): boolean {
    return this.isOneOf("playing", "buffering");
  }

  get isIdle(): boolean {
    return this._state === "idle";
  }

  get isDisposed(): boolean {
    return this._state === "disposed";
  }

  reset(): void {
    if (this._state !== "disposed") {
      this.transition("idle");
    }
  }

  dispose(): void {
    this.transition("disposed");
    this._callbacks.clear();
  }
}
