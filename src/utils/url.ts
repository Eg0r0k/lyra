/**
 * True when `url` resolves to a different origin than the current document.
 * Relative or unparseable URLs are treated as same-origin (returns `false`).
 *
 * Shared by the HTML5 strategy (deciding the `crossOrigin` attribute) and the
 * Player (deciding CORS-fallback eligibility) so both agree.
 */
export function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}
