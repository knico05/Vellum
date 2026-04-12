/**
 * inkHighlight.js — Temporary canvas-space highlight rectangles for ink search results.
 *
 * When a search result is clicked, showInkHighlights() draws translucent accent
 * rectangles over the matched recognition segments on the infinite canvas.
 * The highlight tracks pan/zoom via the 'viewport-changed' event and fades out
 * after a short duration.
 *
 * Exports: showInkHighlights(segments, keyword)
 */

'use strict';

import { toScreen } from '../canvas/viewport.js';

/**
 * Shows temporary highlight rectangles over the segments that contain the
 * matched keyword. Each rectangle is positioned in canvas space and
 * automatically repositioned when the user pans or zooms.
 *
 * @param {Array<{text:string, bounds:{minX,maxX,minY,maxY}}>} segments
 * @param {string} keyword  — the search term (case-insensitive)
 * @param {number} [duration=2500]  — ms before starting fade-out
 */
function showInkHighlights(segments, keyword, duration = 2500) {
  const container = document.getElementById('canvas-container');
  if (!container || !segments?.length) return;

  const needle = keyword.toLowerCase();
  const matched = segments.filter(s => s.text?.toLowerCase().includes(needle) && s.bounds);
  if (!matched.length) return;

  const elements = matched.map(seg => {
    const el = document.createElement('div');
    el.className = 'ink-canvas-highlight';
    container.appendChild(el);

    function updatePos() {
      const { minX, minY, maxX, maxY } = seg.bounds;
      const tl = toScreen(minX - 6, minY - 6);
      const br = toScreen(maxX + 6, maxY + 6);
      el.style.left   = `${tl.x}px`;
      el.style.top    = `${tl.y}px`;
      el.style.width  = `${Math.max(0, br.x - tl.x)}px`;
      el.style.height = `${Math.max(0, br.y - tl.y)}px`;
    }

    updatePos();
    container.addEventListener('viewport-changed', updatePos);

    // Fade out and clean up
    const fadeTimer = setTimeout(() => {
      el.classList.add('ink-canvas-highlight--fade');
      setTimeout(() => {
        el.remove();
        container.removeEventListener('viewport-changed', updatePos);
      }, 600);
    }, duration);

    el._cleanup = () => {
      clearTimeout(fadeTimer);
      el.remove();
      container.removeEventListener('viewport-changed', updatePos);
    };

    return el;
  });

  return elements;
}

export { showInkHighlights };
