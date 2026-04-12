/**
 * handwritingSearch.js — Handwriting recognition search panel
 *
 * Opens a floating panel with a keyword input and a scope toggle:
 *   "This document" — recognises draw strokes in the current file only.
 *   "All documents" — scans every .vellum in pinned folders + backup dir.
 *
 * Recognition is lazy and cached:
 *   - Each page's draw strokes are grouped and sent together to the Windows
 *     Ink recogniser (PowerShell bridge) so multi-stroke letters are resolved.
 *   - The result is stored in manager.js (pageInkText) and persisted via
 *     autosave so subsequent searches on the same document are instant.
 *   - Pages are re-recognised only if a draw stroke was added/removed since
 *     the last recognition run (tracked by manager.js dirty flags).
 *
 * Results:
 *   "This document" — shows matching pages; clicking scrolls the canvas to
 *     that page.
 *   "All documents" — shows filename + page; clicking opens the .vellum file
 *     and scrolls to the matching page.
 *
 * Exports: initHandwritingSearch(), showHandwritingSearch(), hideHandwritingSearch()
 */

'use strict';

import { getAll }                                          from '../annotations/manager.js';
import { getPageInkText, setPageInkText, isPageInkDirty } from '../annotations/manager.js';
import { getPageList }                                     from '../pages/pageManager.js';
import { goToPage }                                        from '../pages/pageManager.js';
import { scheduleSave }                                    from '../storage/autosave.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _panelEl    = null;
let _inputEl    = null;
let _scopeBtns  = {}; // { current, all }
let _resultsEl  = null;
let _statusEl   = null;
let _visible    = false;
let _scope      = 'current'; // 'current' | 'all'

/** Called by app.js to open a .vellum file when the user clicks a cross-file result */
let _openVellumCallback = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Sets up the search panel. Must be called once after the DOM is ready.
 *
 * @param {{ onOpenVellum: function(string): void }} opts
 *   onOpenVellum — called with a .vellum path when the user clicks a cross-file result
 */
function init({ onOpenVellum } = {}) {
  _openVellumCallback = onOpenVellum ?? null;

  _panelEl   = document.getElementById('ink-search-panel');
  _inputEl   = document.getElementById('ink-search-input');
  _resultsEl = document.getElementById('ink-search-results');
  _statusEl  = document.getElementById('ink-search-status');

  _scopeBtns.current = document.getElementById('ink-scope-current');
  _scopeBtns.all     = document.getElementById('ink-scope-all');

  _scopeBtns.current?.addEventListener('click', () => _setScope('current'));
  _scopeBtns.all?.addEventListener('click',     () => _setScope('all'));

  _inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); _runSearch(); }
    if (e.key === 'Escape') { hide(); }
    e.stopPropagation(); // don't trigger canvas shortcuts while typing
  });

  document.getElementById('ink-search-btn')
    ?.addEventListener('click', _runSearch);

  document.getElementById('ink-search-close')
    ?.addEventListener('click', hide);
}

// ---------------------------------------------------------------------------
// Show / hide
// ---------------------------------------------------------------------------

function show() {
  if (!_panelEl) return;
  _panelEl.classList.remove('hidden');
  _visible = true;
  _inputEl?.focus();
  _inputEl?.select();
}

function hide() {
  if (!_panelEl) return;
  _panelEl.classList.add('hidden');
  _visible = false;
}

function toggle() {
  _visible ? hide() : show();
}

// ---------------------------------------------------------------------------
// Scope toggle
// ---------------------------------------------------------------------------

function _setScope(scope) {
  _scope = scope;
  _scopeBtns.current?.classList.toggle('active', scope === 'current');
  _scopeBtns.all?.classList.toggle('active',     scope === 'all');
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------

async function _runSearch() {
  const keyword = _inputEl?.value?.trim();
  if (!keyword) return;

  _setStatus('Searching…');
  _clearResults();

  try {
    if (_scope === 'current') {
      await _searchCurrentDoc(keyword);
    } else {
      await _searchAllDocs(keyword);
    }
  } catch (err) {
    _setStatus(`Error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Current-document search
// ---------------------------------------------------------------------------

/**
 * Recognises draw strokes in the currently open document and searches for
 * the keyword. Only pages that are dirty (new/removed strokes since last
 * recognition) or have no cached text are re-recognised.
 */
async function _searchCurrentDoc(keyword) {
  const pageList = getPageList();
  const allAnnotations = getAll();

  // Group draw strokes by pageId
  const strokesByPage = {};
  for (const anno of allAnnotations) {
    if (anno.type !== 'draw' || !Array.isArray(anno.points) || anno.points.length < 2) continue;
    if (!strokesByPage[anno.pageId]) strokesByPage[anno.pageId] = [];
    strokesByPage[anno.pageId].push(anno.points.map(p => ({ x: p.x, y: p.y })));
  }

  const pageIds = Object.keys(strokesByPage);
  if (pageIds.length === 0) {
    _setStatus('No handwriting in this document.');
    return;
  }

  // Recognise pages that need it
  const inkText = getPageInkText();
  let recognised = 0;
  const total = pageIds.filter(id => inkText[id] === undefined || isPageInkDirty(id)).length;

  if (total > 0) _setStatus(`Recognising ${total} page${total !== 1 ? 's' : ''}…`);

  for (const pageId of pageIds) {
    if (inkText[pageId] !== undefined && !isPageInkDirty(pageId)) continue;

    const text = await window.api.recognizeHandwriting(strokesByPage[pageId]);
    setPageInkText(pageId, text);
    inkText[pageId] = text;
    recognised++;
    if (total > 1) _setStatus(`Recognising… (${recognised}/${total})`);
  }

  if (recognised > 0) scheduleSave(); // persist the newly cached ink text

  // Search
  const needle  = keyword.toLowerCase();
  const matches = [];
  for (const [pageId, text] of Object.entries(inkText)) {
    if (typeof text === 'string' && text.toLowerCase().includes(needle)) {
      matches.push({ pageId, excerpt: text.slice(0, 120) });
    }
  }

  if (matches.length === 0) {
    _setStatus('No matches found.');
    return;
  }

  _setStatus(`${matches.length} match${matches.length !== 1 ? 'es' : ''} in this document`);

  // Render results — map pageId → human-readable label
  const pageIndexMap = {};
  pageList.forEach((p, i) => { pageIndexMap[p.id] = i + 1; });

  for (const { pageId, excerpt } of matches) {
    const label = pageIndexMap[pageId] ? `Page ${pageIndexMap[pageId]}` : pageId;
    _addResult({
      title:   label,
      excerpt,
      onClick: () => { goToPage(pageId); hide(); },
    });
  }
}

// ---------------------------------------------------------------------------
// All-documents search
// ---------------------------------------------------------------------------

async function _searchAllDocs(keyword) {
  _setStatus('Collecting documents…');
  let vellumPaths;
  try {
    vellumPaths = await window.api.listVellumFilesForSearch();
  } catch {
    _setStatus('Could not read library folders.');
    return;
  }

  if (!vellumPaths || vellumPaths.length === 0) {
    _setStatus('No .vellum files found. Pin a folder in the library or set a backup folder.');
    return;
  }

  _setStatus(`Searching ${vellumPaths.length} file${vellumPaths.length !== 1 ? 's' : ''}…`);

  let totalMatches = 0;
  let processed    = 0;

  for (const vellumPath of vellumPaths) {
    processed++;
    _setStatus(`Searching ${processed} / ${vellumPaths.length}…`);

    let matches;
    try {
      matches = await window.api.searchInkInVellum(vellumPath, keyword);
    } catch {
      continue; // unreadable archive — skip
    }

    if (!matches || matches.length === 0) continue;

    const fileName = vellumPath.replace(/\\/g, '/').split('/').pop().replace(/\.vellum$/i, '');

    for (const { pageId, excerpt } of matches) {
      totalMatches++;
      const pageNum = pageId.match(/\d+/)?.[0];
      const label   = pageNum ? `${fileName} — p.${parseInt(pageNum, 10) + 1}` : `${fileName} — ${pageId}`;
      _addResult({
        title:   label,
        excerpt,
        onClick: () => {
          if (_openVellumCallback) _openVellumCallback(vellumPath);
          hide();
        },
      });
    }
  }

  _setStatus(
    totalMatches > 0
      ? `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} across ${vellumPaths.length} file${vellumPaths.length !== 1 ? 's' : ''}`
      : 'No matches found.'
  );
}

// ---------------------------------------------------------------------------
// Result rendering helpers
// ---------------------------------------------------------------------------

function _clearResults() {
  if (_resultsEl) _resultsEl.innerHTML = '';
}

function _setStatus(text) {
  if (_statusEl) _statusEl.textContent = text;
}

/**
 * Appends a single result row to the results list.
 *
 * @param {{ title: string, excerpt: string, onClick: function }} opts
 */
function _addResult({ title, excerpt, onClick }) {
  const item = document.createElement('button');
  item.className = 'ink-search-result';
  item.addEventListener('click', onClick);

  const titleEl = document.createElement('div');
  titleEl.className   = 'ink-search-result-title';
  titleEl.textContent = title;

  const excerptEl = document.createElement('div');
  excerptEl.className   = 'ink-search-result-excerpt';
  excerptEl.textContent = excerpt || '(no text)';

  item.appendChild(titleEl);
  item.appendChild(excerptEl);
  _resultsEl.appendChild(item);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initHandwritingSearch, show as showHandwritingSearch, hide as hideHandwritingSearch, toggle as toggleHandwritingSearch };
