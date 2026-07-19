export interface LoudnessMetadata {
  integratedLufs: number;
  truePeakDbtp?: number;
}

export interface LoudnessNormalizationOptions {
  enabled?: boolean;
  targetLufs?: number;
  preventClipping?: boolean;
  headroomDb?: number;
  maxGainDb?: number;
  maxAttenuationDb?: number;
  smoothTimeSec?: number;
  /**
   * When false (default), loudness metadata is cleared on every `load()`, so a
   * new track starts at 0 dB until its own metadata is set. When true, metadata
   * (and thus normalization gain) is recomputed and re-applied across loads.
   */
  retainMetadataAcrossLoads?: boolean;
}

export interface ComputeNormalizationGainOptions {
  measuredLufs: number;
  targetLufs: number;
  truePeakDbtp?: number;
  preventClipping?: boolean;
  headroomDb?: number;
  maxGainDb?: number;
  maxAttenuationDb?: number;
}

export const DEFAULT_LOUDNESS_NORMALIZATION_OPTIONS: Required<LoudnessNormalizationOptions> =
  {
    enabled: false,
    targetLufs: -16,
    preventClipping: true,
    headroomDb: 1,
    maxGainDb: 12,
    maxAttenuationDb: 24,
    smoothTimeSec: 0.05,
    retainMetadataAcrossLoads: false,
  };

export const dbToGain = (db: number): number => {
  return Math.pow(10, db / 20);
};

export const gainToDb = (gain: number): number => {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
};

export const computeNormalizationGainDb = (
  options: ComputeNormalizationGainOptions,
): number => {
  const {
    measuredLufs,
    targetLufs,
    truePeakDbtp,
    preventClipping = true,
    headroomDb = 1,
    maxGainDb = 12,
    maxAttenuationDb = 24,
  } = options;

  let gainDb = targetLufs - measuredLufs;

  gainDb = Math.min(gainDb, maxGainDb);
  gainDb = Math.max(gainDb, -maxAttenuationDb);

  if (preventClipping && typeof truePeakDbtp === "number" && gainDb > 0) {
    const maxSafeGainDb = -headroomDb - truePeakDbtp;
    gainDb = Math.min(gainDb, maxSafeGainDb);
  }

  return gainDb;
};
