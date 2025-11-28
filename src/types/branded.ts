declare const VolumeBrand: unique symbol;
declare const TimeBrand: unique symbol;
declare const PlaybackRateBrand: unique symbol;

export type Volume = number & { readonly [VolumeBrand]: unique symbol };
export type TimeSeconds = number & { readonly [TimeBrand]: unique symbol };
export type PlaybackRate = number & {
  readonly [PlaybackRateBrand]: unique symbol;
};

export function Volume(value: number): Volume {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped as Volume;
}

export function TimeSeconds(value: number): TimeSeconds {
  if (value < 0 || !Number.isFinite(value)) {
    return 0 as TimeSeconds;
  }
  return value as TimeSeconds;
}

export function PlaybackRate(value: number): PlaybackRate {
  return value as PlaybackRate;
}
