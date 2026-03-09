export interface EQBand {
  frequency: number;
  gain: number;
  Q: number;
  type: BiquadFilterType;
}

const DEFAULT_EQ_BANDS: EQBand[] = [
  { frequency: 32, gain: 0, Q: 1, type: "lowshelf" },
  { frequency: 64, gain: 0, Q: 1, type: "peaking" },
  { frequency: 125, gain: 0, Q: 1, type: "peaking" },
  { frequency: 250, gain: 0, Q: 1, type: "peaking" },
  { frequency: 500, gain: 0, Q: 1, type: "peaking" },
  { frequency: 1000, gain: 0, Q: 1, type: "peaking" },
  { frequency: 2000, gain: 0, Q: 1, type: "peaking" },
  { frequency: 4000, gain: 0, Q: 1, type: "peaking" },
  { frequency: 8000, gain: 0, Q: 1, type: "peaking" },
  { frequency: 16000, gain: 0, Q: 1, type: "highshelf" },
];

export class AudioGraph {
  private _ctx: AudioContext;

  private _inputGain: GainNode;
  private _eqFilters: BiquadFilterNode[] = [];
  private _outputGain: GainNode;
  private _analyser: AnalyserNode;

  private _eqEnabled = true;
  private _bands: EQBand[];

  private _freqDataArray: Uint8Array<ArrayBuffer>;
  private _timeDataArray: Uint8Array<ArrayBuffer>;

  private _fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private _fadeResolve: (() => void) | null = null;

  private static readonly SILENCE_GAIN = 1e-4;

  constructor(ctx: AudioContext, bands?: EQBand[]) {
    this._ctx = ctx;
    this._bands = bands ?? [...DEFAULT_EQ_BANDS];
    this._inputGain = ctx.createGain();
    this._outputGain = ctx.createGain();

    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 2048;

    this._freqDataArray = new Uint8Array(
      this._analyser.frequencyBinCount,
    ) as Uint8Array<ArrayBuffer>;

    this._timeDataArray = new Uint8Array(
      this._analyser.fftSize,
    ) as Uint8Array<ArrayBuffer>;

    this.createEQFilters();
    this.connectChain();
  }

  get input(): AudioNode {
    return this._inputGain;
  }

  get output(): AudioNode {
    return this._outputGain;
  }

  get analyzer(): AnalyserNode {
    return this._analyser;
  }

  get bands(): EQBand[] {
    return this._bands;
  }

  get isFading(): boolean {
    return this._fadeTimer !== null;
  }

  private createEQFilters(): void {
    this._eqFilters = this._bands.map((band) => {
      const filter = this._ctx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.Q;
      return filter;
    });
  }

  private connectChain(): void {
    this._inputGain.disconnect();
    this._eqFilters.forEach((f) => f.disconnect());
    this._analyser.disconnect();

    if (this._eqFilters.length > 0) {
      this._inputGain.connect(this._eqFilters[0]);

      for (let i = 0; i < this._eqFilters.length - 1; i++) {
        this._eqFilters[i].connect(this._eqFilters[i + 1]);
      }

      this._eqFilters[this._eqFilters.length - 1].connect(this._analyser);
    } else {
      this._inputGain.connect(this._analyser);
    }

    this._analyser.connect(this._outputGain);
  }

  setEQBand(index: number, gain: number): void {
    if (index < 0 || index >= this._eqFilters.length) return;

    this._bands[index].gain = gain;

    if (this._eqEnabled) {
      this._eqFilters[index].gain.setValueAtTime(gain, this._ctx.currentTime);
    }
  }

  setEQBands(gains: number[]): void {
    gains.forEach((gain, i) => this.setEQBand(i, gain));
  }

  getEQBand(index: number): number {
    return this._bands[index]?.gain ?? 0;
  }

  resetEQ(): void {
    this._bands.forEach((band, i) => {
      band.gain = 0;
      if (this._eqEnabled) {
        this._eqFilters[i].gain.setValueAtTime(0, this._ctx.currentTime);
      }
    });
  }

  setEQEnabled(enabled: boolean): void {
    if (this._eqEnabled === enabled) return;
    this._eqEnabled = enabled;

    const now = this._ctx.currentTime;

    this._bands.forEach((band, i) => {
      const targetGain = enabled ? band.gain : 0;
      this._eqFilters[i].gain.setTargetAtTime(targetGain, now, 0.015);
    });
  }

  get eqEnabled(): boolean {
    return this._eqEnabled;
  }

  setVolume(volume: number): void {
    this.cancelFade();
    this._outputGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, volume)),
      this._ctx.currentTime,
      0.015,
    );
  }

  fadeTo(
    targetVolume: number,
    durationSec: number,
    fromVolume?: number,
  ): Promise<void> {
    this.cancelFade();

    const now = this._ctx.currentTime;
    const gain = this._outputGain.gain;
    const clamped = Math.max(
      AudioGraph.SILENCE_GAIN,
      Math.min(1, targetVolume),
    );

    gain.cancelScheduledValues(now);

    if (durationSec <= 0) {
      gain.setValueAtTime(
        targetVolume <= AudioGraph.SILENCE_GAIN ? 0 : clamped,
        now,
      );
      return Promise.resolve();
    }

    const startValue =
      fromVolume !== undefined
        ? Math.max(AudioGraph.SILENCE_GAIN, Math.min(1, fromVolume))
        : Math.max(AudioGraph.SILENCE_GAIN, gain.value);

    gain.setValueAtTime(startValue, now);
    gain.exponentialRampToValueAtTime(clamped, now + durationSec);

    return new Promise<void>((resolve) => {
      this._fadeResolve = resolve;
      this._fadeTimer = setTimeout(() => {
        this._fadeTimer = null;
        this._fadeResolve = null;
        if (targetVolume <= AudioGraph.SILENCE_GAIN) {
          gain.setValueAtTime(0, this._ctx.currentTime);
        }
        resolve();
      }, durationSec * 1000);
    });
  }

  cancelFade(): void {
    if (this._fadeTimer !== null) {
      clearTimeout(this._fadeTimer);
      this._fadeTimer = null;
    }

    const resolve = this._fadeResolve;
    this._fadeResolve = null;

    if (resolve) {
      const now = this._ctx.currentTime;
      this._outputGain.gain.cancelScheduledValues(now);
      this._outputGain.gain.setValueAtTime(this._outputGain.gain.value, now);
      resolve();
    }
  }

  getFrequencyData(): Uint8Array {
    this._analyser.getByteFrequencyData(this._freqDataArray);
    return this._freqDataArray;
  }

  getTimeDomainData(): Uint8Array {
    this._analyser.getByteTimeDomainData(this._timeDataArray);
    return this._timeDataArray;
  }

  dispose(): void {
    this.cancelFade();
    this._inputGain.disconnect();
    this._eqFilters.forEach((f) => f.disconnect());
    this._analyser.disconnect();
    this._outputGain.disconnect();
  }
}
