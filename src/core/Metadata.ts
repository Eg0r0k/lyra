import {
  Input,
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  AttachedImage,
} from "mediabunny";
import { CoverMimeType, TrackMetadata } from "./types";

export class Metadata {
  static async extract(source: File | Blob | string): Promise<TrackMetadata> {
    const inputSource =
      source instanceof File || source instanceof Blob
        ? new BlobSource(source)
        : new UrlSource(source);

    const input = new Input({
      source: inputSource,
      formats: ALL_FORMATS,
    });

    try {
      const [tags, duration] = await Promise.all([
        input.getMetadataTags(),
        input.computeDuration().catch(() => undefined),
      ]);

      let cover: TrackMetadata["cover"] = undefined;

      if (tags.images?.length) {
        const image: AttachedImage = tags.images[0];

        const data: Uint8Array = image.data;

        const mimeType = Metadata.validateMimeType(image.mimeType);
        //@ts-ignore
        const blob = new Blob([data], {
          type: mimeType,
        });
        const blobUrl = URL.createObjectURL(blob);

        cover = {
          blobUrl,
          mimeType: image.mimeType as CoverMimeType,
        };
      }

      return {
        title: tags.title ?? undefined,
        artist: tags.artist ?? undefined,
        album: tags.album ?? undefined,
        albumArtist: tags.albumArtist ?? undefined,
        genre: tags.genre ?? undefined,
        date: tags.date
          ? new Date(tags.date).toISOString().slice(0, 10)
          : undefined,
        track: tags.trackNumber ?? undefined,
        disc: tags.discNumber ?? undefined,
        duration: duration ?? undefined,
        cover,
        raw: tags.raw ?? undefined,
      };
    } finally {
      await input.dispose();
    }
  }

  private static validateMimeType(mime?: string): CoverMimeType {
    if (!mime) return "image/jpeg";

    const lower = mime.toLowerCase();
    const valid: CoverMimeType[] = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/bmp",
    ];

    return valid.includes(lower as CoverMimeType)
      ? (lower as CoverMimeType)
      : "image/jpeg";
  }

  static revokeCover(metadata: TrackMetadata): void {
    if (metadata.cover?.blobUrl) {
      URL.revokeObjectURL(metadata.cover.blobUrl);
    }
  }
}
