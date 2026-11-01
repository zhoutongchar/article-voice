import { createPagedImageSource } from './paged-image.js';

export function createKindleSource({ document: doc = document, url = new URL(location.href), recognize, onChange = () => {} }) {
  if (!recognize) throw new Error('Update Article Voice on this Mac to enable Kindle reading.');
  const root = doc.querySelector('#main-content'), renderer = doc.querySelector('#kr-renderer');
  if (!root || !renderer) throw new Error('Open a book in Kindle, then start Article Voice.');
  let cover, coverUrl, busy = false, originalInert, shownSrc, source;
  const pageImage = () => [...renderer.querySelectorAll('.kg-full-page-img img,.kg-short-page-img img')]
    .find(image => image.getBoundingClientRect().width > 0);
  const observer = new MutationObserver(() => {
    if (!busy && shownSrc && pageImage()?.currentSrc !== shownSrc) { source?.invalidate(); onChange(); }
  });
  observer.observe(renderer, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  const access = {
    async capture(signal) {
      signal?.throwIfAborted();
      const image = pageImage();
      if (!image?.complete || !image.naturalWidth || !image.currentSrc.startsWith(`blob:${doc.location.origin}/`))
        throw new Error('Wait for Kindle to finish displaying this page, then try again.');
      if (image.naturalWidth * image.naturalHeight > 16_000_000)
        throw new Error('This page image is too large to recognize. Reduce the reader window size and try again.');
      // Kindle revokes its blob URL after the image decodes. Read the displayed
      // pixels, not that expired URL, and own the resulting image from here on.
      const canvas = doc.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || blob.size > 8 * 1024 * 1024) throw new Error('This page image is too large to recognize. Try a smaller reader window.');
      signal?.throwIfAborted();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const rect = image.getBoundingClientRect();
      const label = doc.querySelector('#kr-scrubber-bar')?.getAttribute('aria-label') || '';
      // Kindle hides/recreates its location control and updates it separately
      // from the rendered image. It is display metadata, not page identity.
      return { id: `${url.searchParams.get('asin')}:${digest}`, image: btoa(binary), imageMime: blob.type.startsWith('image/') ? blob.type : 'image/png',
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        title: doc.querySelector('.top-chrome__book-title')?.textContent || doc.title,
        url: url.href, language: doc.documentElement.lang?.split('-')[0] || 'en', label };
    },
    async turn(direction, signal) {
      signal?.throwIfAborted();
      const button = doc.querySelector(direction > 0 ? '#kr-chevron-right' : '#kr-chevron-left');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
      const before = pageImage()?.currentSrc;
      button.click();
      const deadline = performance.now() + 8000;
      while (performance.now() < deadline) {
        // Finish locating a page already turned before observing cancellation.
        // The owner needs its identity in order to restore the original page.
        const image = pageImage();
        if (image?.complete && image.naturalWidth && image.currentSrc !== before) return access.capture();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Kindle did not finish turning the page. Reopen the reader at your reading position.');
    },
    cover(unit) {
      if (cover) return;
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
    dispose() { observer.disconnect(); access.uncover(); }
  };
  source = createPagedImageSource({ id: 'kindle', access, recognize });
  source.capabilities.preparationNotice = 'Prepares two pages ahead and returns to your page. Kindle may count prepared pages as visited.';
  const open = source.open;
  source.open = async () => { const unit = await open(); shownSrc = pageImage()?.currentSrc; return unit; };
  return source;
}
