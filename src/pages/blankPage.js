/**
 * blankPage.js — Blank page DOM canvas element
 *
 * Mirrors PDFPage exactly: creates a <canvas> element absolutely positioned
 * inside #canvas-container, styled identically (white background, box-shadow,
 * transform-origin top left). Position is updated each frame via CSS transform.
 *
 * Unlike PDFPage, render() is synchronous — the canvas is just a white fill.
 * No PDF.js involvement.
 *
 * canvasX and canvasY are set externally by pageManager.recomputeLayout()
 * after construction, before mount() is called.
 *
 * Exports: BlankPage class
 */

'use strict';

import { toScreen, state as viewportState } from '../canvas/viewport.js';

class BlankPage {
  /**
   * @param {number} width    — Page width in canvas units
   * @param {number} height   — Page height in canvas units
   * @param {string} template — 'plain' | 'lined' | 'dotted' | 'graph' | 'cornell'
   * @param {number} gridSize — Spacing between lines/dots in canvas units (default 24)
   */
  constructor(width, height, template = 'plain', gridSize = 24) {
    this.width    = width;
    this.height   = height;
    this.template = template;
    this.gridSize = gridSize;
    this.canvasX  = 0;   // set by pageManager.recomputeLayout() before mount
    this.canvasY  = 0;
    this.element  = null;
  }

  // -------------------------------------------------------------------------
  // DOM lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates the <canvas> element, fills it white, and appends to container.
   * Must be called after canvasX/canvasY are set by recomputeLayout().
   *
   * @param {HTMLElement} container — #canvas-container
   */
  mount(container) {
    this.element = document.createElement('canvas');
    // Identical CSS to PDFPage so blank pages look exactly like PDF pages
    this.element.style.cssText = [
      'position: absolute',
      'top: 0',
      'left: 0',
      'transform-origin: top left',
      'box-shadow: 0 2px 16px rgba(0,0,0,0.4)',
      'background: #fff',
    ].join(';');

    // Allocate at devicePixelRatio for crisp display on HiDPI screens
    const dpr = window.devicePixelRatio || 1;
    this.element.width  = Math.round(this.width  * dpr);
    this.element.height = Math.round(this.height * dpr);
    this.element.style.width  = `${this.width}px`;
    this.element.style.height = `${this.height}px`;

    // Fill white, then draw the chosen template pattern
    const ctx = this.element.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.element.width, this.element.height);
    this._drawTemplate(ctx, this.element.width, this.element.height, dpr);

    container.appendChild(this.element);
    this.updatePosition();
  }

  /**
   * Removes the DOM element.
   */
  destroy() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Updates the CSS transform to keep the page canvas at the correct screen
   * position given the current viewport pan/zoom.
   * Called every frame by pageManager's registered draw callback.
   */
  updatePosition() {
    if (!this.element) return;
    const { x, y } = toScreen(this.canvasX, this.canvasY);
    this.element.style.transform = `translate(${x}px, ${y}px) scale(${viewportState.scale})`;
  }

  // -------------------------------------------------------------------------
  // Viewport culling
  // -------------------------------------------------------------------------

  /**
   * Returns true if any part of this page is within or near the screen.
   * Mirrors PDFPage.isNearViewport() — one screen-height margin for pre-loading.
   *
   * @param {number} screenW
   * @param {number} screenH
   * @returns {boolean}
   */
  isNearViewport(screenW, screenH) {
    const { x,  y  } = toScreen(this.canvasX, this.canvasY);
    const { x: x2, y: y2 } = toScreen(this.canvasX + this.width, this.canvasY + this.height);
    const margin = screenH;
    return x2 > -margin && y2 > -margin && x < screenW + margin && y < screenH + margin;
  }

  // -------------------------------------------------------------------------
  // Template drawing
  // -------------------------------------------------------------------------

  /**
   * Draws ruled lines, dots, graph grid, or Cornell structure on the blank page.
   * Called once in mount() after the white fill.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w   — Canvas pixel width  (already DPR-scaled)
   * @param {number} h   — Canvas pixel height (already DPR-scaled)
   * @param {number} dpr — Device pixel ratio used to scale line widths / dot radii
   */
  _drawTemplate(ctx, w, h, dpr) {
    const STEP = (this.gridSize ?? 24) * dpr;

    switch (this.template) {

      case 'lined': {
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth   = 1;
        for (let y = STEP; y < h; y += STEP) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        break;
      }

      case 'dotted': {
        ctx.fillStyle = '#c8c8c8';
        for (let y = STEP; y < h; y += STEP) {
          for (let x = STEP; x < w; x += STEP) {
            ctx.beginPath();
            ctx.arc(x, y, 1.5 * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }

      case 'graph': {
        // Minor lines every STEP, major lines every 5×STEP (slightly darker)
        const MAJOR = STEP * 5;
        ctx.lineWidth = 1;

        for (let y = STEP; y < h; y += STEP) {
          ctx.strokeStyle = (Math.round(y) % Math.round(MAJOR) < 0.5) ? '#c8c8c8' : '#e8e8e8';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        for (let x = STEP; x < w; x += STEP) {
          ctx.strokeStyle = (Math.round(x) % Math.round(MAJOR) < 0.5) ? '#c8c8c8' : '#e8e8e8';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        break;
      }

      case 'cornell': {
        // Vertical cue-column line at 28% width, horizontal summary line at 75% height
        const cueX = Math.round(w * 0.28);
        const sumY = Math.round(h * 0.75);

        ctx.strokeStyle = '#c4c4c4';
        ctx.lineWidth   = 1.5 * dpr;

        // Cue column (stops at the summary line)
        ctx.beginPath();
        ctx.moveTo(cueX, 0);
        ctx.lineTo(cueX, sumY);
        ctx.stroke();

        // Summary divider (full width)
        ctx.beginPath();
        ctx.moveTo(0, sumY);
        ctx.lineTo(w, sumY);
        ctx.stroke();

        // Region labels in very light grey
        ctx.fillStyle = '#d0d0d0';
        ctx.font = `${10 * dpr}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillText('Cues',    6 * dpr,          14 * dpr);
        ctx.fillText('Notes',   cueX + 6 * dpr,   14 * dpr);
        ctx.fillText('Summary', 6 * dpr,          sumY + 14 * dpr);
        break;
      }

      // 'plain' — white fill only, nothing more to draw
    }
  }
}

export { BlankPage };
