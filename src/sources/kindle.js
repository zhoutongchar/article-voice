import { createPagedImageSource } from './paged-image.js';

export function createKindleSource({ document: doc = document, url = new URL(location.href), recognize, onChange = () => {} }) {
  if (!recognize) throw new Error('Update Article Voice on this Mac to enable Kindle reading.');
  const root = doc.querySelector('#main-content'), renderer = doc.querySelector('#kr-renderer');
  if (!root || !renderer) throw new Error('Open a book in Kindle, then start Article Voice.');
  let cover, coverUrl, busy = false, originalInert, shownSrc, source, verification, changed = false, disposed = false, lastTurn = -Infinity;
  const pageImage = () => [...renderer.querySelectorAll('.kg-full-page-img img,.kg-short-page-img img')]
    .find(image => image.getBoundingClientRect().width > 0);
  const observer = new MutationObserver(verifyCurrentPage);
  observer.observe(renderer, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  renderer.addEventListener('load', verifyCurrentPage, true);
  // The delivered reader throttles each navigation direction for 100 ms and
  // remains busy after replacing the image. Image presence alone is not a
  // completed turn, especially during the two consecutive backward restores.
  const quietMs = 125;
  async function readyImage({ from, signal } = {}) {
    const deadline = performance.now() + 8000;
    let stableSrc, stableSince = 0;
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      const image = pageImage(), now = performance.now();
      const loading = !!root.querySelector('.loader')?.childElementCount
        || [...renderer.querySelectorAll('.kg-view')].some(view => view.getAnimations()
          .some(animation => animation.playState === 'running' || animation.pending));
      if (!loading && image?.complete && image.naturalWidth && (!from || image.currentSrc !== from)) {
        if (stableSrc !== image.currentSrc) { stableSrc = image.currentSrc; stableSince = now; }
        if (now - stableSince >= quietMs && now - lastTurn >= quietMs) return image;
      } else { stableSrc = undefined; stableSince = 0; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(from ? 'Kindle did not finish turning the page.' : 'Kindle is still changing this page. Wait for it to finish, then reopen the reader.');
  }
  async function captureImage(image, signal) {
    signal?.throwIfAborted();
    if (!image?.complete || !image.naturalWidth || !image.currentSrc.startsWith(`blob:${doc.location.origin}/`))
      throw new Error('Wait for Kindle to finish displaying this page, then try again.');
    if (image.naturalWidth * image.naturalHeight > 16_000_000)
      throw new Error('This page image is too large to recognize. Reduce the reader window size and try again.');
    // Kindle revokes its blob URL after the image decodes. Read the displayed
    // pixels, not that expired URL, and own the resulting image from here on.
    const src = image.currentSrc;
    const canvas = doc.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 8 * 1024 * 1024) throw new Error('This page image is too large to recognize. Try a smaller reader window.');
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (pageImage() !== image || image.currentSrc !== src) throw new Error('Kindle changed the page during capture. Reopen the reader at your reading position.');
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const rect = image.getBoundingClientRect();
    const label = doc.querySelector('#kr-scrubber-bar')?.getAttribute('aria-label') || '';
    // Kindle hides/recreates its location control and updates it separately
    // from the rendered image. It is display metadata, not page identity.
    return { id: `${url.searchParams.get('asin')}:${digest}`, image: btoa(binary), imageMime: blob.type.startsWith('image/') ? blob.type : 'image/png',
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      title: doc.querySelector('.top-chrome__book-title')?.textContent || doc.title,
      url: url.href, language: doc.documentElement.lang?.split('-')[0] || 'en', label };
  }
  function verifyCurrentPage() {
    const unit = source?.current(), image = pageImage();
    if (disposed || changed || busy || !unit || !shownSrc || verification
      || (image?.currentSrc === shownSrc && image.src === shownSrc)) return;
    const controller = verification = new AbortController();
    (async () => {
      try {
        // A blob URL is only a repaint hint. Use the same content identity as
        // navigation; a new URL or a temporary missing image is not a new page.
        const image = await readyImage({ signal: controller.signal });
        const observed = await captureImage(image, controller.signal);
        if (busy || disposed || controller.signal.aborted || source.current() !== unit) return;
        if (observed.id !== unit.id) {
          changed = true; source.invalidate(); onChange({ type: 'page' }); return;
        }
        shownSrc = image.currentSrc; onChange({ type: 'repaint' });
      } catch (error) {
        if (error.name === 'AbortError' || disposed || busy || changed) return;
        changed = true; source.invalidate(); onChange({ type: 'changed', reason: error.message });
      } finally {
        if (verification === controller) { verification = null; verifyCurrentPage(); }
      }
    })();
  }
  const access = {
    async capture(signal) {
      return captureImage(await readyImage({ signal }), signal);
    },
    async turn(direction, signal) {
      signal?.throwIfAborted();
      const before = (await readyImage({ signal })).currentSrc;
      const button = doc.querySelector(direction > 0 ? '#kr-chevron-right' : '#kr-chevron-left');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
      // Kindle's chevron container navigates on a mouse press/release. Its
      // click listener only records metrics; HTMLElement.click() cannot turn
      // a page. Send one complete gesture through the normal DOM listeners.
      const rect = button.parentElement.getBoundingClientRect();
      const gesture = { bubbles: true, cancelable: true, view: doc.defaultView,
        button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      lastTurn = performance.now();
      button.dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { ...gesture, buttons: 1 }));
      button.dispatchEvent(new doc.defaultView.MouseEvent('mouseup', { ...gesture, buttons: 0 }));
      // A started turn must finish locating its page even after cancellation,
      // so the source can record and restore the actual position.
      return captureImage(await readyImage({ from: before }));
    },
    cover(unit) {
      if (cover) return;
      verification?.abort(); verification = null;
      busy = true; originalInert = root.inert; root.inert = true;
      const bytes = Uint8Array.from(atob(unit.image), value => value.charCodeAt(0));
      coverUrl = URL.createObjectURL(new Blob([bytes], { type: unit.imageMime }));
      cover = doc.createElement('img'); cover.src = coverUrl;
      cover.alt = ''; cover.dataset.articleVoicePage = '';
      const rect = pageImage()?.getBoundingClientRect() || unit.rect;
      cover.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:2147483645;background:white;`;
      doc.documentElement.append(cover);
    },
    uncover() {
      if (!busy) return;
      shownSrc = pageImage()?.currentSrc; observer.takeRecords();
      cover?.remove(); cover = null;
      if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = null;
      root.inert = originalInert ?? false; busy = false;
    },
    rectangle() { return (cover || pageImage())?.getBoundingClientRect(); },
    dispose() {
      disposed = true; verification?.abort(); observer.disconnect();
      renderer.removeEventListener('load', verifyCurrentPage, true); access.uncover();
    }
  };
  source = createPagedImageSource({ id: 'kindle', access, recognize });
  source.capabilities.preparationNotice = 'Prepares two pages ahead and returns to your page. Kindle may count prepared pages as visited.';
  const open = source.open;
  source.open = async () => { const unit = await open(); shownSrc = pageImage()?.currentSrc; return unit; };
  return source;
}
