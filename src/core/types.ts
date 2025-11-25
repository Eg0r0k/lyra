export interface PlayerOptions {
latencyHint?: "interactive" | "playback" | number;
crossfadeDuration?: number;
}


export type PlayerState =
| "idle"
| "loading"
| "ready"
| "playing"
| "paused"
| "error"
| "disposed";


declare const VolumeBrand: unique symbol;
export type Volume = number & { [VolumeBrand]: never };
export const Volume = (v: number): Volume => {
if (v < 0 || v > 1) {
throw new RangeError(`Volume must be between 0 and 1, got ${v}`);
}
return v as Volume;
};


export type AudioSource =
| File
| Blob
| string
| ArrayBuffer
| Uint8Array
| ReadableStream<Uint8Array>;


export type CoverMimeType =
| "image/jpeg"
| "image/png"
| "image/webp"
| "image/gif"
| "image/bmp";


export interface TrackMetadata {
title?: string;
artist?: string;
album?: string;
albumArtist?: string;
genre?: string;
date?: string;
track?: number;
disc?: number;
duration?: number;
cover?: {
blobUrl: string;
mimeType: CoverMimeType;
};
raw?: Record<string, any>;
}

export interface PlayerEvents {
  play: [];
  pause: [];
  stop: [];
  ended: [];
  loaded: [];
  timeupdate: [number];
  durationchange: [];
  progress: [{ loaded: number; total: number }];
  bufferunderrun: [];
  error: [Error];
  ratechange: [number];
  volumechange: [Volume];
  devicechange: [];
}



export type PlayerEvent = keyof PlayerEvents;