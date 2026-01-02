import { IPlaybackStrategy } from "../strategy/IPlaybackStrategy";
import { QualityLevel, AudioSource } from "../types/index";

export interface PreparedSource {
  sourceUrl?: string;

  audioBuffer?: AudioBuffer;

  duration: number;

  objectUrlToRevoke?: string;

  metadata?: Record<string, unknown>;
}

export interface SourceCapabilities {
  qualityLevels?: QualityLevel[];
  setQuality?: (level: number) => void;
  getCurrentQuality?: () => number;
  supportsSeek?: boolean;
  isLive?: boolean;
}

export interface ISourceHandler {
  readonly id: string;

  canHandle(source: AudioSource): boolean;
  preferredStrategy(): "html5" | "webaudio" | "any";

  prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<PreparedSource>;

  getCapabilities(): SourceCapabilities | null;
  dispose(): void;
}
