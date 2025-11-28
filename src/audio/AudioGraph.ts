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

  constructor(ctx: AudioContext, bands?: EQBand[]) {
    this._ctx = ctx;
    this._bands = bands ?? [...DEFAULT_EQ_BANDS];
    this._inputGain = ctx.createGain();
    this._outputGain = ctx.createGain();
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 2048;
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

    if (this._eqEnabled && this._eqFilters.length > 0) {
      // input -> filters -> analyser -> output
      this._inputGain.connect(this._eqFilters[0]);

      for (let i = 0; i < this._eqFilters.length - 1; i++) {
        this._eqFilters[i].connect(this._eqFilters[i + 1]);
      }

      this._eqFilters[this._eqFilters.length - 1].connect(this._analyser);
    } else {
      // input -> analyser -> output (bypass EQ)
      this._inputGain.connect(this._analyser);
    }

    this._analyser.connect(this._outputGain);
  }

  setEQBand(index: number, gain: number): void {
    if (index < 0 || index >= this._eqFilters.length) return;

    this._bands[index].gain = gain;
    this._eqFilters[index].gain.setValueAtTime(gain, this._ctx.currentTime);
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
      this._eqFilters[i].gain.setValueAtTime(0, this._ctx.currentTime);
    });
  }

  setEQEnabled(enabled: boolean): void {
    if (this._eqEnabled === enabled) return;

    this._eqEnabled = enabled;
    this.connectChain();
  }

  get eqEnabled(): boolean {
    return this._eqEnabled;
  }

  setVolume(volume: number): void {
    this._outputGain.gain.setValueAtTime(
      Math.max(0, Math.min(1, volume)),
      this._ctx.currentTime
    );
  }

  getFrequencyData(): Uint8Array {
    const data = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(data);
    return data;
  }

  getTimeDomainData(): Uint8Array {
    const data = new Uint8Array(this._analyser.fftSize);
    this._analyser.getByteTimeDomainData(data);
    return data;
  }

  dispose(): void {
    this._inputGain.disconnect();
    this._eqFilters.forEach((f) => f.disconnect());
    this._analyser.disconnect();
    this._outputGain.disconnect();
  }
}
