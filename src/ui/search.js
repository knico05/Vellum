/**
 * search.js — Search bar UI and match highlight rendering
 *
 * Creates a floating search bar overlay (#search-bar in index.html).
 * Opened with Ctrl+F (wired in shortcuts.js), closed with Escape.
 *
 * Match highlights are drawn on the foreground canvas overlay (registerOverlay)
 * so they appear in front of PDF content. They are transient — never saved as
 * annotations and cleared when the bar closes or the PDF changes.
 *
 * Highlight colours:
 *   All matches      — semi-transparent yellow (#ffd54f at 40% opacity)
 *   Active match     — semi-transparent accent blue (--accent at 50% opacity)
 *
 * The draw callback receives a context already in canvas space (the viewport
 * transform has been applied by renderer.js). We can therefore draw match rects
 * directly using canvas coordinates — no manual toScreen() conversion needed.
 *
 * Exports: initSearch, showSearch, hideSearch, toggleSearch
 */

'use strict';

import { registerOverlay, requestRender } from '../canvas/renderer.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** All matches for the current query: [{ pageId, canvasRect }] */
let _matches = [];

/** 0-based index of the active (highlighted blue) match, or -1 if none */
let _activeIdx = -1;

/** Whether the search bar is currently visible */
let _visible = false;

/** Debounce timer for the search input */
let _debounceTimer = null;

/**
 * Async callback: (query: string) => Promise<Array<{pageId, canvasRect}>>
 * Performs the actual text search; provided by app.js via initSearch().
 */
let _onSearchCb = null;

/**
 * Callback: (match: {pageId, canvasRect}) => void
 * Called when navigating to a match so the viewport can scroll to it.
 */
let _onNavigateCb = null;

// DOM element references (set in initSearch)
let _bar   = null;
let _input = null;
let _count = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Connects the search module to the DOM and registers the canvas draw callback.
 * Must be called once after the DOM is ready.
 *
 * @param {{ onSearch: Function, onNavigate: Function }} callbacks
 *   onSearch(query)  → Promise<Array<{pageId: string, canvasRect: {x,y,w,h}}>>
 *   onNavigate(match) → void — scroll viewport to the given match
 */
function initSearch({ onSearch, onNavigate }) {
  _onSearchCb   = onSearch;
  _onNavigateCb = onNavigate;

  _bar   = document.getElementById('search-bar');
  _input = document.getElementById('search-input');
  _count = document.getElementById('search-count');

  if (!_bar || !_input) return;

  // Debounced search: fires 150 ms after the user stops typing
  _input.addEventListener('input', () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_runSearch, 150);
  });

  // Keyboard navigation inside the input
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) _prevMatch(); else _nextMatch();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // prevent global handler from also calling setTool(null)
      hideSearch();
    }
  });

  document.getElementById('btn-search-next')?.addEventListener('click', _nextMatch);
  document.getElementById('btn-search-prev')?.addEventListener('click', _prevMatch);
  document.getElementById('btn-search-close')?.addEventListener('click', hideSearch);

  // Register the draw callback on the foreground (overlay) canvas
  registerOverlay(_drawHighlights);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Shows the search bar and focuses the input.
 * Re-runs the current query if the input already has text.
 */
function showSearch() {
  if (!_bar) return;
  _bar.classList.remove('hidden');
  _visible = true;
  _input.focus();
  _input.select();
  if (_input.value.trim()) _runSearch();
}

/**
 * Opens the search bar and pre-fills it with the given query, then runs the search.
 * Useful for tablet mode where Ctrl+F is inaccessible — the panel search bar
 * calls this so the user can type in the panel and launch PDF text search from there.
 *
 * @param {string} query
 */
function showSearchWithQuery(query) {
  if (!_bar) return;
  _input.value = query;
  showSearch();
}

/**
 * Hides the search bar and clears all match highlights.
 */
function hideSearch() {
  if (!_bar) return;
  _bar.classList.add('hidden');
  _visible = false;
  _clearMatches();
  requestRender();
}

/**
 * Toggles the search bar visibility.
 */
function toggleSearch() {
  if (_visible) hideSearch(); else showSearch();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Runs the search using the current input value and updates match state.
 */
async function _runSearch() {
  const query = _input.value.trim();

  if (!query || !_onSearchCb) {
    _clearMatches();
    requestRender();
    return;
  }

  const results  = await _onSearchCb(query);
  _matches       = results;
  _activeIdx     = results.length > 0 ? 0 : -1;

  _updateCounter();
  requestRender();

  // Navigate to first match immediately
  if (_activeIdx >= 0 && _onNavigateCb) {
    _onNavigateCb(_matches[_activeIdx]);
  }
}

/**
 * Advances to the next match (wraps around).
 */
function _nextMatch() {
  if (_matches.length === 0) return;
  _activeIdx = (_activeIdx + 1) % _matches.length;
  _updateCounter();
  requestRender();
  if (_onNavigateCb) _onNavigateCb(_matches[_activeIdx]);
}

/**
 * Goes back to the previous match (wraps around).
 */
function _prevMatch() {
  if (_matches.length === 0) return;
  _activeIdx = (_activeIdx - 1 + _matches.length) % _matches.length;
  _updateCounter();
  requestRender();
  if (_onNavigateCb) _onNavigateCb(_matches[_activeIdx]);
}

/**
 * Resets match state.
 */
function _clearMatches() {
  _matches   = [];
  _activeIdx = -1;
  _updateCounter();
}

/**
 * Updates the "N / M" counter in the search bar.
 */
function _updateCounter() {
  if (!_count) return;
  if (_matches.length === 0) {
    _count.textContent = (_input?.value.trim()) ? '0 / 0' : '';
  } else {
    _count.textContent = `${_activeIdx + 1} / ${_matches.length}`;
  }
}

// ---------------------------------------------------------------------------
// Canvas draw callback
// ---------------------------------------------------------------------------

/**
 * Draws match highlight rectangles on the foreground canvas.
 *
 * Called every frame by renderer.js via registerOverlay().
 * The context is already in canvas space (viewport transform applied),
 * so canvasRect coordinates are used directly.
 *
 * @param {CanvasRenderingContext2D} ctx — foreground canvas context (canvas space)
 */
function _drawHighlights(ctx) {
  if (!_visible || _matches.length === 0) return;

  // All-match colour: semi-transparent yellow
  ctx.fillStyle = 'rgba(255, 213, 79, 0.40)';
  for (let i = 0; i < _matches.length; i++) {
    if (i === _activeIdx) continue; // drawn separately below
    const r = _matches[i].canvasRect;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // Active match: accent blue with a 1-canvas-unit border
  if (_activeIdx >= 0) {
    const r = _matches[_activeIdx].canvasRect;
    ctx.fillStyle = 'rgba(91, 138, 245, 0.45)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.9)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { initSearch, showSearch, hideSearch, toggleSearch, showSearchWithQuery };
