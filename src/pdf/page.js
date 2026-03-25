/**
 * page.js — Individual PDF page rendering and viewport culling
 *
 * Each PDFPage owns a <canvas> element that it renders its page content into.
 * These canvases are absolutely positioned inside #canvas-container and their
 * CSS transform is updated every frame to match the current viewport.
 *
 * Lazy rendering: we only render a page when it is (or is near) the visible
 * viewport. Rendering every page up front would consume gigabytes of memory
 * for a 200-page document.
 *
 * Render scale: PDF.js renders at a pixel density we choose. We render at
 * BASE_RENDER_SCALE × devicePixelRatio so the output is crisp on HiDPI
 * screens. The CSS size of the canvas is kept at BASE_RENDER_SCALE canvas
 * units; the physical canvas pixels are larger by devicePixelRatio.
 *
 * Exports: PDFPage class
 */

'use strict';

import { toScreen, state as viewportState } from '../canvas/viewport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The scale at which we render PDF pages into their offscreen canvases.
 * 1.0 = 72 DPI (PDF native). 2.0 = 144 DPI. We use 2.0 for crisp text
 * at typical zoom levels, multiplied by devicePixelRatio for HiDPI displays.
 */
const BASE_RENDER_SCALE = 2.0;

/** Gap between pages in canvas units */
const PAGE_GAP = 24;

// ---------------------------------------------------------------------------
// PDFPage class
// ---------------------------------------------------------------------------

/**
 * Represents one page of a PDF on the infinite canvas.
 *
 * Lifecycle:
 *   1. Constructed with page index and canvas position
 *   2. mount(container) — creates and inserts the DOM canvas element
 *   3. render(pdfDoc)  — renders via PDF.js (once; result is cached)
 *   4. updatePosition(viewport) — called every frame to reposition via CSS
 *   5. destroy()        — removes DOM element, frees memory
 */
class PDFPage {
  /**
   * @param {number} pageIndex  — 0-based index within the PDF
   * @param {number} canvasX    — Left edge position in canvas space
   * @param {number} canvasY    — Top edge position in canvas space
   * @param {number} width      — Page width in canvas units (PDF points)
   * @param {number} height     — Page height in canvas units (PDF points)
   */
  constructor(pageIndex, canvasX, canvasY, width, height) {
    this.pageIndex = pageIndex;
    this.canvasX   = canvasX;
    this.canvasY   = canvasY;
    this.width     = width;
    this.height    = height;

    /** True once PDF.js has rendered pixels into the canvas element */
    this.rendered = false;

    /** True while a render is in progress (prevent double-renders) */
    this.rendering = false;

    /** The <canvas> DOM element owned by this page */
    this.element = null;
  }

  // -------------------------------------------------------------------------
  // DOM lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates the <canvas> element and appends it to the container.
   * Must be called before render() or updatePosition().
   *
   * @param {HTMLElement} container — #canvas-container
   */
  mount(container) {
    this.element = document.createElement('canvas');
    this.element.style.cssText = [
      'position: absolute',
      'top: 0',
      'left: 0',
      'transform-origin: top left',
      'box-shadow: 0 2px 16px rgba(0,0,0,0.4)',  // shadow to lift page off background
      'background: #fff',                          // white page background
    ].join(';');

    container.appendChild(this.element);
  }

  /**
   * Removes the DOM element and marks the page as unrendered.
   * Call this when the page scrolls far out of view to free GPU memory.
   */
  destroy() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element  = null;
    this.rendered = false;
    this.rendering = false;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Renders the page into its canvas element using PDF.js.
   * No-ops if already rendered or a render is in progress.
   *
   * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
   * @returns {Promise<void>}
   */
  async render(pdfDoc) {
    if (this.rendered || this.rendering || !this.element) return;
    this.rendering = true;

    try {
      // PDF.js pages are 1-indexed
      const pdfPage = await pdfDoc.getPage(this.pageIndex + 1);

      // Render scale: BASE_RENDER_SCALE for quality, × dPR for HiDPI
      const dpr   = window.devicePixelRatio || 1;
      const scale = BASE_RENDER_SCALE * dpr;

      const viewport = pdfPage.getViewport({ scale });

      // Physical canvas size (actual pixels, HiDPI-corrected)
      this.element.width  = viewport.width;
      this.element.height = viewport.height;

      // CSS size stays at 1:1 with canvas units so the viewport transform works
      this.element.style.width  = `${this.width}px`;
      this.element.style.height = `${this.height}px`;

      const ctx = this.element.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      this.rendered  = true;
    } catch (err) {
      console.error(`PDFPage ${this.pageIndex}: render failed`, err);
    } finally {
      this.rendering = false;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Updates the CSS transform so the page canvas sits at the correct screen
   * position given the current viewport pan/zoom.
   *
   * Called every frame by the renderer draw callback.
   */
  updatePosition() {
    if (!this.element) return;
    const { x, y } = toScreen(this.canvasX, this.canvasY);
    // We scale the canvas element via CSS rather than re-rendering at every
    // zoom level — PDF.js rendering is expensive. The rendered pixels are
    // always at BASE_RENDER_SCALE; CSS zoom handles the rest.
    // The actual scale factor for CSS: viewport.scale (handled by parent transform)
    // Since we're inside #canvas-container which is NOT transformed, we apply
    // the full screen transform here directly.
    this.element.style.transform = `translate(${x}px, ${y}px) scale(${viewportState.scale})`;
  }

  // -------------------------------------------------------------------------
  // Viewport culling
  // -------------------------------------------------------------------------

  /**
   * Returns true if any part of this page is within or near the screen.
   * "Near" means within one screen-height of the visible area — we render
   * pages just before they scroll into view for a seamless experience.
   *
   * @param {number} screenW — Container width in pixels
   * @param {number} screenH — Container height in pixels
   * @returns {boolean}
   */
  isNearViewport(screenW, screenH) {
    const { x, y } = toScreen(this.canvasX, this.canvasY);
    const { x: x2, y: y2 } = toScreen(this.canvasX + this.width, this.canvasY + this.height);

    const margin = screenH; // Preload one screen-height ahead
    return (
      x2 > -margin &&
      y2 > -margin &&
      x  < screenW + margin &&
      y  < screenH + margin
    );
  }
}

// ---------------------------------------------------------------------------
// Page layout helper
// ---------------------------------------------------------------------------

/**
 * Computes the canvas-space Y position for each page, stacking them
 * vertically with PAGE_GAP between them. All pages are centred on X=0.
 *
 * @param {Array<{width: number, height: number}>} dimensions
 * @returns {Array<{x: number, y: number, width: number, height: number}>}
 */
function layoutPages(dimensions) {
  let y = 0;
  return dimensions.map(({ width, height }) => {
    const layout = { x: -width / 2, y, width, height };
    y += height + PAGE_GAP;
    return layout;
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { PDFPage, layoutPages, PAGE_GAP };
