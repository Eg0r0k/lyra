import { AudioSource } from "../../types";

/**
 * True when a source looks like an HLS playlist: a `.m3u8` URL, an explicit
 * `format === "m3u8"`, or `type === "hls"`.
 *
 * Shared by {@link HLSHandler} (MSE path), {@link NativeHlsHandler} (native
 * element path), and {@link SourceManager} (actionable no-handler error) so the
 * three stay in lockstep.
 */
export function isHlsSource(source: AudioSource): boolean {
  const url = source.url?.toLowerCase() ?? "";
  return (
    url.includes(".m3u8") || source.format === "m3u8" || source.type === "hls"
  );
}
