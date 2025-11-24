export class EQ {
  private filters: BiquadFilterNode[] = [];
  public readonly input: GainNode;
  public readonly output: GainNode;

  private bands = [
    32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
  ] as const;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    for (const freq of this.bands) {
      const filter = ctx.createBiquadFilter();
      filter.type =
        freq <= 64 ? "lowshelf" : freq >= 8000 ? "highshelf" : "peaking";
      filter.frequency.value = freq;
      filter.Q.value = 1;
      filter.gain.value = 0;
      this.filters.push(filter);
    }

    this.input.connect(this.filters[0]!);
    for (let i = 0; i < this.filters.length - 1; i++) {
      this.filters[i]!.connect(this.filters[i + 1]!);
    }
    this.filters[this.filters.length - 1]!.connect(this.output);
  }

  setBand(index: number, gainDb: number) {
    if (this.filters[index]) {
      this.filters[index]!.gain.setValueAtTime(gainDb, this.ctx.currentTime);
    }
  }

  bypass(enabled: boolean) {
    this.input.disconnect();
    if (enabled) this.input.connect(this.output);
    else this.input.connect(this.filters[0]!);
  }
}
