/**
 * A pluggable time-stretch node for the {@link WebAudioStrategy} (T-24).
 *
 * Dependency-injected exactly like the `hls.js` constructor — the library never
 * imports a stretcher, so no WASM/worklet code enters the base bundle. Provide a
 * {@link TimeStretchFactory} via `PlayerOptions.timeStretch` to change tempo
 * without shifting pitch when `playbackRate !== 1`.
 *
 * @remarks
 * The node is inserted upstream of the {@link AudioGraph} input
 * (`source → gain → node → graph`), so EQ and the analyser observe the
 * pitch-corrected, time-stretched signal.
 *
 * Recommended plugins (MIT, not bundled): SoundTouchJS worklet (light) and
 * Signalsmith Stretch WASM (best quality/weight). Rubber Band WASM is
 * GPL/commercial — avoid unless your license permits it.
 */
export interface ITimeStretchNode {
  /**
   * The Web Audio node to splice into the graph. The strategy feeds the decoded
   * source (played at rate 1.0) into it and routes its output to the graph.
   */
  readonly node: AudioNode;

  /** Set the tempo multiplier (pitch preserved); mirrors `playbackRate`. */
  setRate(rate: number): void;

  /**
   * Seconds of source-side input consumed since the node was constructed or
   * since the last {@link ITimeStretchNode.flush} — a RELATIVE meter, aligned
   * as closely as the plugin can to the audio most recently rendered (i.e.
   * minus internal latency). The strategy owns the absolute position: it adds
   * its own base offset (`currentTime = base + getInputPosition()`) and calls
   * `flush()` to reset this counter on every seek and every resume-from-pause.
   * So a plugin MUST NOT try to track absolute/seek position itself.
   *
   * Report in seconds (divide an internal sample counter by the context sample
   * rate). The value MAY lag reality by up to one worklet report interval; the
   * strategy applies a monotonicity guard, but MUST NOT be relied on to hide a
   * counter that jumps around. Rate-independent as a position measure: it
   * counts input consumed, not output produced.
   */
  getInputPosition(): number;

  /**
   * Drop ALL internally buffered input/output audio AND reset the
   * {@link ITimeStretchNode.getInputPosition} counter to 0. The strategy calls
   * this on every seek and every resume-from-pause, then restarts feeding the
   * source from the new position — so a plugin MUST clear its output FIFO here
   * or stale, already-stretched audio bleeds past the new position. Idempotent
   * (a flush with nothing buffered is a no-op).
   */
  flush(): void;

  /** Release the node / worklet / WASM resources. */
  dispose(): void;
}

/**
 * Async factory that builds an {@link ITimeStretchNode} for a given context.
 * Injected via `PlayerOptions.timeStretch`; never imported by the library.
 */
export type TimeStretchFactory = (
  ctx: AudioContext,
) => Promise<ITimeStretchNode>;
