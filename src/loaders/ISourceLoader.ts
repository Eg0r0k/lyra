import { QualityLevel, AudioSource } from "../types/index";

export interface LoadResult {
  audioBuffer?: AudioBuffer;

  sourceUrl?: string;

  objectUrl?: string;

  duration: number;

  metadata?: Record<string, unknown>;
}

export interface ISourceLoader {
  readonly id: string;

  canLoad(source: AudioSource): boolean;

  load(
    source: AudioSource,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<LoadResult>;

  attachMedia?(element: HTMLAudioElement): void;

  detachMedia?(): void;
  getQualityLevels?(): QualityLevel[];

  setQuality?(level: number): void;

  getCurrentQuality?(): number;

  dispose(): void;
}
