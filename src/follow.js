export const SCROLL_PAUSE_MS = 10_000;

// The content script owns following: playback and word highlighting continue
// independently while the reader explores another part of the page.
export class ScrollFollow {
  constructor(now = () => performance.now()) { this.now = now; this.enabled = true; this.until = 0; }
  setEnabled(value) { this.enabled = !!value; this.until = 0; }
  pause() { if (this.enabled) this.until = this.now() + SCROLL_PAUSE_MS; }
  get canScroll() { return this.enabled && this.now() >= this.until; }
}
