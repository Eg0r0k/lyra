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
   * Current input position in seconds — how far playback has advanced through
   * the source buffer. The source-of-truth for `currentTime` in stretcher mode
   * (the strategy's `ctx.currentTime` math is bypassed).
   */
  getInputPosition(): number;

  /** Drop internally buffered audio; called on seek to avoid stale bleed. */
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
