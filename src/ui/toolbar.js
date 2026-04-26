/**
 * toolbar.js — Top toolbar component
 *
 * Builds the toolbar UI programmatically, inserting tool buttons and a colour
 * picker into the pre-existing #toolbar element in index.html. Owns the
 * activeTool state and the colour selection state.
 *
 * Tool toggle logic: clicking an active tool deactivates it (returns to cursor).
 * Clicking a different tool deactivates the previous one and activates the new one.
 *
 * The colour picker is only visible when highlight or draw is active, since those
 * are the only tools that use colour selection.
 *
 * Imports:
 *   highlight.js — activate, deactivate, setColour
 *   draw.js      — activate, deactivate, setColour
 *
 * Exports: init(), setActiveTool(), getActiveTool(), updateStatus()
 */

'use strict';

import {
  activate       as activateHighlight,
  deactivate     as deactivateHighlight,
  setColour      as setHighlightColour,
  setStrokeWidth as setHighlightStrokeWidth,
  setShapeSnap   as setHighlightShapeSnap,
} from '../annotations/highlight.js';

import {
  activate           as activateDraw,
  deactivate         as deactivateDraw,
  setColour          as setDrawColour,
  setStrokeWidth     as setDrawStrokeWidth,
  setPressureSensitive,
  setShapeSnap       as setDrawShapeSnap,
} from '../annotations/draw.js';

import {
  activate        as activateEraser,
  deactivate      as deactivateEraser,
  setEraseRadius,
  setEraseMode,
} from '../annotations/eraser.js';

import {
  activate   as activateSelect,
  deactivate as deactivateSelect,
} from '../annotations/select.js';

import {
  activate       as activateNote,
  deactivate     as deactivateNote,
  setNoteDefaults,
  applyFocusedStyle,
  FONT_SIZES     as NOTE_FONT_SIZES,
} from '../annotations/note.js';


import { state as viewportState }        from '../canvas/viewport.js';
import { setTwoPageMode, getTwoPageMode } from '../pages/pageManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key for the saved custom colour palette */
const LS_CUSTOM_PALETTE = 'qn-custom-palette';

/** localStorage keys for per-tool custom size presets */
const LS_CUSTOM_SIZES_DRAW      = 'qn-custom-sizes-draw';
const LS_CUSTOM_SIZES_HIGHLIGHT = 'qn-custom-sizes-highlight';
const LS_CUSTOM_SIZES_ERASER    = 'qn-custom-sizes-eraser';

/**
 * localStorage key for per-tool colour + size memory.
 * Stored as: { draw: { colour, sizeId }, highlight: { colour, sizeId }, eraser: { sizeId } }
 */
const LS_TOOL_SETTINGS = 'qn-tool-settings';

/** Maximum number of user-saved custom colours */
const MAX_CUSTOM_COLOURS = 10;

/** Tools that support colour selection */
const COLOUR_TOOLS = new Set(['highlight', 'draw']);

/** Tools that support stroke/size selection */
const STROKE_TOOLS = new Set(['draw', 'highlight', 'eraser']);

/**
 * Per-tool size preset definitions and their localStorage-persisted overrides.
 * Each tool has its own independent 4-slot array so customising pen size
 * does not affect eraser or highlighter sizes.
 *
 * width:       canvas-unit stroke width (draw / highlight)
 * eraseRadius: canvas-unit erase radius (eraser only)
 * dot:         visual dot diameter in px on the button
 */
function _loadSizes(defaults, lsKey) {
  try {
    const stored = localStorage.getItem(lsKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 4) {
        return defaults.map((def, i) => ({ ...def, ...parsed[i], id: def.id, label: def.label }));
      }
    }
  } catch { /* ignore corrupt data */ }
  return defaults.map(d => ({ ...d }));
}

const _DEFAULT_DRAW_SIZES = [
  { id: 'fine',   label: 'Fine',   width: 0.5, dot: 2  },
  { id: 'normal', label: 'Normal', width: 2,   dot: 5  },
  { id: 'thick',  label: 'Thick',  width: 4,   dot: 8  },
  { id: 'brush',  label: 'Brush',  width: 8,   dot: 12 },
];
const _DEFAULT_HIGHLIGHT_SIZES = [
  { id: 'fine',   label: 'Fine',   width: 3,  dot: 4  },
  { id: 'normal', label: 'Normal', width: 6,  dot: 7  },
  { id: 'thick',  label: 'Thick',  width: 12, dot: 10 },
  { id: 'brush',  label: 'Broad',  width: 20, dot: 14 },
];
const _DEFAULT_ERASER_SIZES = [
  { id: 'fine',   label: 'Precise', eraseRadius: 2,  dot: 2  },
  { id: 'normal', label: 'Normal',  eraseRadius: 12, dot: 5  },
  { id: 'thick',  label: 'Wide',    eraseRadius: 24, dot: 8  },
  { id: 'brush',  label: 'Max',     eraseRadius: 48, dot: 12 },
];

const DRAW_SIZES      = _loadSizes(_DEFAULT_DRAW_SIZES,      LS_CUSTOM_SIZES_DRAW);
const HIGHLIGHT_SIZES = _loadSizes(_DEFAULT_HIGHLIGHT_SIZES, LS_CUSTOM_SIZES_HIGHLIGHT);
const ERASER_SIZES    = _loadSizes(_DEFAULT_ERASER_SIZES,    LS_CUSTOM_SIZES_ERASER);

/** Returns the size array for the currently active tool. */
function _getCurrentSizes() {
  if (activeTool === 'eraser')    return ERASER_SIZES;
  if (activeTool === 'highlight') return HIGHLIGHT_SIZES;
  return DRAW_SIZES; // draw and fallback
}

/**
 * Colour definitions.
 * name:       logical name used by highlight.js
 * solid:      CSS hex used by draw.js (opaque strokes)
 * background: CSS colour used for the swatch circle
 */
const COLOURS = [
  { name: 'blue',   solid: '#5b8af5', background: '#5b8af5' },
  { name: 'black',  solid: '#1a1a1a', background: '#1a1a1a' },
  { name: 'yellow', solid: '#f5c518', background: '#f5c518' },
  { name: 'red',    solid: '#e53e3e', background: '#e53e3e' },
  { name: 'green',  solid: '#3ecf8e', background: '#3ecf8e' },
];

/**
 * Tool definitions.
 * id:    logical name used throughout the app
 * title: tooltip text
 * svg:   inner SVG markup (18×18 viewBox, rendered at 18×18px for clarity)
 */
const TOOLS = [
  {
    id: 'cursor',
    title: 'Cursor (V)',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 2.5v14.5l4-4.5 2.2 5.5 2.8-1.1-2.2-5.5H16L5 2.5z" fill="currentColor"/>
    </svg>`,
  },
  {
    id: 'draw',
    title: 'Draw (D)',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 3l3 3-9.5 9.5-3.5.5.5-3.5L14 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>
      <path d="M11.5 5.5L14.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'highlight',
    title: 'Highlight (H)',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2.5" y="6" width="15" height="7" rx="1.5" fill="currentColor" opacity="0.5"/>
      <line x1="2.5" y1="16" x2="17.5" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'eraser',
    title: 'Eraser (E)',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M13.5 3.5l3 3-8 8H5l-1.5-1.5 8-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>
      <path d="M7 11.5L13 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="3" y1="17.5" x2="17" y2="17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'select',
    title: 'Select & Move (S)',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="14" height="14" rx="1.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.5"/>
      <path d="M8 8h4M8 10h4M8 12h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'note',
    title: 'Text Box (N) — tap/click to place',
    svg: `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
      <line x1="6.5" y1="8" x2="13.5" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="6.5" y1="11" x2="11" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Which tool is currently active, or null for the default cursor */
let activeTool = null;

/** Tool that was active before switching to 'select', used to revert after empty lasso */
let _prevTool = null;

/**
 * Currently selected colour — either a preset name ('blue') or a CSS hex
 * string ('#ff5733') when a custom colour has been picked.
 */
let activeColour = 'blue';

/**
 * User-saved custom colours (hex strings). Max MAX_CUSTOM_COLOURS entries.
 * Persisted in localStorage.
 */
let customPalette = (() => {
  try {
    const stored = localStorage.getItem(LS_CUSTOM_PALETTE);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_CUSTOM_COLOURS) : [];
  } catch { return []; }
})();

/** Map of tool id → button element, populated during init() */
const toolButtons = new Map();

/** Map of colour name → swatch element, populated during init() */
const swatchButtons = new Map();

/**
 * The custom palette swatch container — rebuilt whenever customPalette changes.
 * Sits between the preset swatches and the custom-colour controls.
 */
let customPaletteContainerEl = null;

/** The #colour-picker container element */
let colourPickerEl = null;

/** The #colour-sep separator element */
let colourSepEl = null;

/** The #stroke-picker container element */
let strokePickerEl = null;

/** Currently active stroke size id */
let activeStrokeSize = 'normal';

/**
 * Per-tool persisted settings: colour and/or stroke size remembered for each
 * tool so switching back restores the last-used configuration.
 */
let toolSettings = (() => {
  try {
    const raw = localStorage.getItem(LS_TOOL_SETTINGS);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
})();

/**
 * Text box tool default settings — persisted in toolSettings.textBox.
 * Applied to newly placed text boxes and reflected in the toolbar controls.
 */
let _textBoxSettings = (() => {
  try {
    const raw = localStorage.getItem(LS_TOOL_SETTINGS);
    return JSON.parse(raw)?.textBox ?? {};
  } catch { return {}; }
})();

/** Colour options for the text box tool */
const TEXTBOX_COLOURS = [
  { value: '#000000', label: 'Black'     },
  { value: '#444444', label: 'Dark grey' },
  { value: '#ffffff', label: 'White'     },
  { value: '#e53e3e', label: 'Red'       },
  { value: '#f0b429', label: 'Amber'     },
  { value: '#3b82f6', label: 'Blue'      },
  { value: '#10b981', label: 'Green'     },
];

/** Map of size id → button element, populated during init() */
const strokeSizeButtons = new Map();

/** The #textbox-options container element */
let textboxOptionsEl = null;

/** The #eraser-mode-picker container element */
let eraserModePickerEl = null;

/** Map of eraser mode id → button element */
const eraserModeBtns = new Map();

/** Currently selected eraser mode */
let activeEraseMode = 'partial';

/** The #pressure-toggle container element */
let pressureToggleEl = null;

/** Whether pressure sensitivity is currently on */
let pressureOn = true;

/** The #shape-snap-toggle container element */
let shapeSnapToggleEl = null;


/** Whether hold-to-snap shape recognition is currently on */
let shapeSnapOn = true;

/** The #lbl-page label element */
let lblPageEl = null;

/** The #lbl-zoom label element */
let lblZoomEl = null;

/** Currently visible size-edit slider popover, or null */
let activeSizePopover = null;

/** Cached viewport scale — updated on viewport-changed to drive cursor sizing */
let cachedViewportScale = 1.0;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Builds the toolbar UI and wires up all button click handlers.
 * Must be called once after the DOM is ready.
 */
function init() {
  const toolGroup    = document.getElementById('tool-group');
  colourPickerEl     = document.getElementById('colour-picker');
  colourSepEl        = document.getElementById('colour-sep');
  strokePickerEl     = document.getElementById('stroke-picker');
  eraserModePickerEl = document.getElementById('eraser-mode-picker');
  pressureToggleEl   = document.getElementById('pressure-toggle');
  shapeSnapToggleEl  = document.getElementById('shape-snap-toggle');
  textboxOptionsEl   = document.getElementById('textbox-options');
  lblPageEl          = document.getElementById('lbl-page');
  lblZoomEl          = document.getElementById('lbl-zoom');

  // Build tool buttons
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.className  = 'tool-btn';
    btn.title      = tool.title;
    btn.innerHTML  = tool.svg;
    btn.dataset.tool = tool.id;

    btn.addEventListener('click', () => handleToolClick(tool.id));

    toolGroup.appendChild(btn);
    toolButtons.set(tool.id, btn);
  }

  // Build preset colour swatches
  for (const colour of COLOURS) {
    const swatch = document.createElement('button');
    swatch.className         = 'colour-swatch';
    swatch.title             = colour.name.charAt(0).toUpperCase() + colour.name.slice(1);
    swatch.style.background  = colour.background;
    swatch.dataset.colour    = colour.name;

    swatch.addEventListener('click', () => handleColourClick(colour.name));

    colourPickerEl.appendChild(swatch);
    swatchButtons.set(colour.name, swatch);
  }

  // Custom palette container — sits between presets and custom controls
  customPaletteContainerEl = document.createElement('div');
  customPaletteContainerEl.className = 'colour-custom-palette';
  colourPickerEl.appendChild(customPaletteContainerEl);
  renderCustomPalette();

  // Apply initial swatch active state
  activeColour = COLOURS[0].name;
  updateSwatchState();

  // ── Custom colour circle (opens native colour picker) ──────────────────
  const customSep = document.createElement('div');
  customSep.className = 'colour-custom-sep';
  colourPickerEl.appendChild(customSep);

  // The hidden <input type="color"> drives the native OS colour picker
  const colourInput = document.createElement('input');
  colourInput.type  = 'color';
  colourInput.id    = 'colour-input-hidden';
  colourInput.value = '#ffffff';
  colourInput.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
  colourInput.addEventListener('input', (e) => handleCustomColour(e.target.value));
  colourPickerEl.appendChild(colourInput);

  // Visible circle button — shows a rainbow gradient until a colour is chosen
  const customBtn = document.createElement('button');
  customBtn.id        = 'btn-custom-colour';
  customBtn.className = 'colour-swatch colour-swatch-custom';
  customBtn.title     = 'Pick custom colour (right-click to save to palette)';
  customBtn.style.background = 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
  customBtn.addEventListener('click', () => colourInput.click());
  customBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); saveCustomColourToPalette(activeColour); });
  colourPickerEl.appendChild(customBtn);

  // Save-to-palette button — adds the current colour to the saved palette
  const saveBtn = document.createElement('button');
  saveBtn.className = 'colour-save-btn';
  saveBtn.title     = `Save current colour to palette (max ${MAX_CUSTOM_COLOURS})`;
  saveBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
    <path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
  saveBtn.addEventListener('click', () => saveCustomColourToPalette(activeColour));
  colourPickerEl.appendChild(saveBtn);

  // ── Eyedropper (Chromium/Electron supports the EyeDropper API) ─────────
  if ('EyeDropper' in window) {
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'colour-eyedropper';
    eyeBtn.title     = 'Pick colour from screen';
    eyeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 1.5L10.5 3L5.5 8H4V6.5L9 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M7.5 3L9 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M4 8L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="2" cy="10" r="1" fill="currentColor"/>
    </svg>`;
    eyeBtn.addEventListener('click', handleEyedropper);
    colourPickerEl.appendChild(eyeBtn);
  }

  // Build stroke size buttons inside the stroke picker.
  // Buttons are built once using the draw-size slot ids; dot visuals refresh
  // via _refreshSizeDots() whenever the active tool changes.
  for (const size of DRAW_SIZES) {
    const sizeId = size.id;
    const btn = document.createElement('button');
    btn.className    = 'stroke-size-btn';
    btn.title        = `${size.label} — long-press to customise`;
    btn.dataset.size = sizeId;

    // Visual dot — a filled circle whose diameter indicates the stroke weight
    const dot = document.createElement('span');
    dot.className = 'stroke-size-dot';
    dot.style.width  = `${size.dot}px`;
    dot.style.height = `${size.dot}px`;
    btn.appendChild(dot);

    btn.addEventListener('click', () => handleStrokeSizeClick(sizeId));

    // Right-click (mouse) or long-press (touch/pen, 600 ms with 8px cancel threshold)
    // opens a slider to customise that slot's width value for the current tool.
    const LONG_PRESS_CANCEL_PX = 8;
    let longPressTimer  = null;
    let longPressStartX = 0;
    let longPressStartY = 0;

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearTimeout(longPressTimer);
      showSizePopover(sizeId, btn);
    });
    btn.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      longPressStartX = e.clientX;
      longPressStartY = e.clientY;
      longPressTimer  = setTimeout(() => showSizePopover(sizeId, btn), 600);
    });
    btn.addEventListener('pointermove', (e) => {
      const d = Math.hypot(e.clientX - longPressStartX, e.clientY - longPressStartY);
      if (d > LONG_PRESS_CANCEL_PX) clearTimeout(longPressTimer);
    });
    btn.addEventListener('pointerup',     () => clearTimeout(longPressTimer));
    btn.addEventListener('pointercancel', () => clearTimeout(longPressTimer));

    strokePickerEl.appendChild(btn);
    strokeSizeButtons.set(sizeId, btn);
  }

  // Apply initial stroke size active state
  updateStrokeSizeState();

  // ── Eraser mode toggle (partial / full) ────────────────────────────────
  const ERASE_MODES = [
    { id: 'partial', label: 'Partial' },
    { id: 'full',    label: 'Full'    },
  ];
  for (const mode of ERASE_MODES) {
    const btn = document.createElement('button');
    btn.className    = 'eraser-mode-btn';
    btn.dataset.mode = mode.id;
    btn.textContent  = mode.label;
    btn.title        = mode.id === 'partial'
      ? 'Partial erase — splits strokes at the eraser circle'
      : 'Full erase — removes whole annotations';
    btn.addEventListener('click', () => {
      activeEraseMode = mode.id;
      updateEraserModeState();
      setEraseMode(mode.id);
      saveToolSettings();
    });
    eraserModePickerEl.appendChild(btn);
    eraserModeBtns.set(mode.id, btn);
  }
  updateEraserModeState();

  // ── Pressure sensitivity toggle (draw tool only) ────────────────────────
  const pressureBtn = document.createElement('button');
  pressureBtn.id        = 'btn-pressure-toggle';
  pressureBtn.className = 'tool-btn pressure-toggle-btn';
  pressureBtn.title     = 'Pressure sensitivity — vary stroke width with stylus pressure';
  pressureBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 16c2-4 4-8 6-8s3 2 3 4-1 4-1 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M12 7c1-2 2-3.5 3-3.5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    <path d="M8 13c0.5-1 1-2 1.5-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
  pressureBtn.classList.toggle('active', pressureOn);
  pressureBtn.addEventListener('click', () => {
    pressureOn = !pressureOn;
    pressureBtn.classList.toggle('active', pressureOn);
    setPressureSensitive(pressureOn);
    saveToolSettings();
  });
  pressureToggleEl.appendChild(pressureBtn);

  // ── Shape snap toggle (draw tool only) ─────────────────────────────────────
  const shapeSnapBtn = document.createElement('button');
  shapeSnapBtn.id        = 'btn-shape-snap-toggle';
  shapeSnapBtn.className = 'tool-btn shape-snap-toggle-btn';
  shapeSnapBtn.title     = 'Shape snap — hold pen for 1 s to snap to line, rect, or circle';
  shapeSnapBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="14.5" cy="14.5" r="3" stroke="currentColor" stroke-width="1.5"/>
  </svg>`;
  shapeSnapBtn.classList.toggle('active', shapeSnapOn);
  shapeSnapBtn.addEventListener('click', () => {
    shapeSnapOn = !shapeSnapOn;
    shapeSnapBtn.classList.toggle('active', shapeSnapOn);
    setDrawShapeSnap(shapeSnapOn);
    setHighlightShapeSnap(shapeSnapOn);
    saveToolSettings();
  });
  shapeSnapToggleEl.appendChild(shapeSnapBtn);

  // ── Two-page layout toggle ─────────────────────────────────────────────────
  const twoPageBtn = document.getElementById('btn-two-page');
  if (twoPageBtn) {
    twoPageBtn.classList.toggle('active', getTwoPageMode());
    twoPageBtn.addEventListener('click', () => {
      const next = !getTwoPageMode();
      setTwoPageMode(next);
      twoPageBtn.classList.toggle('active', next);
    });
  }

  // ── Text box toolbar options ───────────────────────────────────────────────
  _buildTextBoxOptions();

  // When a text box is placed, the note tool self-deactivates — switch to cursor
  document.addEventListener('note-placed', () => {
    setActiveTool(null);
  });

  // When a text box is focused for editing, switch any active tool to cursor
  document.addEventListener('request-cursor-tool', () => {
    if (activeTool !== null) setActiveTool(null);
  });

  // Sync toolbar controls when a text box gains/loses focus
  document.addEventListener('textbox-focus-changed', (e) => {
    if (e.detail) {
      _syncTextBoxToolbar(e.detail.style);
    }
  });

  // ── Viewport scale tracking — drives the dynamic pen cursor size ──────────
  const canvasContainer = document.getElementById('canvas-container');
  if (canvasContainer) {
    canvasContainer.addEventListener('viewport-changed', () => {
      const newScale = viewportState.scale;
      // Only rebuild the cursor if scale changed by more than 10% — avoids
      // redundant SVG generation on every micro-zoom step.
      if (Math.abs(newScale - cachedViewportScale) / cachedViewportScale > 0.1) {
        cachedViewportScale = newScale;
        updateToolCursor();
      }
    });

    // input.js resets container.style.cursor to '' on pointerup and space-keyup.
    // Re-apply the tool cursor after those events so the size indicator stays
    // visible during continuous drawing without requiring a zoom event.
    canvasContainer.addEventListener('pointerup', updateToolCursor);
    document.addEventListener('keyup', (e) => { if (e.key === ' ') updateToolCursor(); });
  }

  // Check for updates in the background — delayed so it doesn't compete with
  // startup rendering. Shows a badge in the toolbar if a newer release exists.
  setTimeout(_checkForUpdates, 4000);

  // Restore the previous tool when the lasso selection catches nothing
  document.addEventListener('select-deselected', () => {
    if (activeTool !== 'select') return;
    const revertTo = _prevTool ?? null;
    _prevTool = null;
    setActiveTool(revertTo);
  });
}

/**
 * Fetches the latest GitHub release and shows the update badge if a newer
 * version is available. Fails silently — offline users see nothing.
 */
async function _checkForUpdates() {
  try {
    const result = await window.api.checkForUpdates();
    if (!result?.hasUpdate) return;

    const btn = document.getElementById('btn-update');
    if (!btn) return;

    btn.textContent = `⬆ v${result.latestVersion}`;
    btn.title       = `Update available: v${result.latestVersion} — click to download`;
    btn.classList.remove('hidden');

    btn.addEventListener('click', () => {
      if (result.releaseUrl) window.api.openExternal(result.releaseUrl);
    });
  } catch {
    // Network unavailable or repo not configured — silently do nothing
  }
}

// ---------------------------------------------------------------------------
// Tool switching
// ---------------------------------------------------------------------------

/**
 * Handles a tool button click.
 * Toggles off if clicking the active tool, otherwise switches to the new tool.
 *
 * @param {string} toolId — One of the TOOLS ids
 */
function handleToolClick(toolId) {
  if (toolId === 'cursor') {
    // Cursor always deactivates whatever is active and returns to neutral
    setActiveTool(null);
    return;
  }

  // Toggle: clicking the active tool deactivates it (returns to cursor)
  const next = (activeTool === toolId) ? null : toolId;
  setActiveTool(next);
}

/**
 * Sets the active tool, deactivating the previous one and activating the new one.
 * This is also the external API used by shortcuts.js.
 *
 * @param {string|null} toolName — Tool id or null for cursor/none
 */
function setActiveTool(toolName) {
  // Track the tool we're leaving so we can restore it after an empty lasso
  if (toolName === 'select' && activeTool !== 'select') {
    _prevTool = activeTool;
  } else if (toolName !== 'select') {
    _prevTool = null;
  }

  // Deactivate whatever is currently running
  deactivateCurrentTool();

  activeTool = toolName;

  // Activate the new tool
  if (activeTool === 'highlight') activateHighlight();
  if (activeTool === 'draw')      activateDraw();
  if (activeTool === 'eraser')    activateEraser();
  if (activeTool === 'select')    activateSelect();
  if (activeTool === 'note')      activateNote();

  // Stamp the active tool onto #canvas-container so CSS can gate
  // pointer-events on image annotations (images are inert outside select mode)
  const container = document.getElementById('canvas-container');
  if (container) container.dataset.tool = activeTool ?? 'cursor';

  updateButtonStates();
  updateColourPickerVisibility();
  document.dispatchEvent(new CustomEvent('tool-changed', { detail: activeTool }));
}

/**
 * Deactivates the currently active tool, if any.
 * Safe to call when no tool is active.
 */
function deactivateCurrentTool() {
  if (activeTool === 'highlight') deactivateHighlight();
  if (activeTool === 'draw')      deactivateDraw();
  if (activeTool === 'eraser')    deactivateEraser();
  if (activeTool === 'select')    deactivateSelect();
  if (activeTool === 'note')      deactivateNote();
}

/**
 * Returns the current active tool name, or null for cursor.
 *
 * @returns {string|null}
 */
function getActiveTool() {
  return activeTool;
}

// ---------------------------------------------------------------------------
// Colour selection
// ---------------------------------------------------------------------------

/**
 * Handles a colour swatch click.
 * Applies the colour to whichever tool is currently active.
 *
 * @param {string} colourName — e.g. 'yellow', 'green'
 */
function handleColourClick(colourName) {
  activeColour = colourName;
  updateSwatchState();
  applyColourToActiveTool();
  saveToolSettings();
}

/**
 * Sends the currently selected colour to the active annotation tool.
 * Handles both preset names and custom hex strings.
 */
function applyColourToActiveTool() {
  const presetDef = COLOURS.find(c => c.name === activeColour);

  if (activeTool === 'highlight') {
    // highlight.js accepts preset names and hex strings
    setHighlightColour(activeColour);
  } else if (activeTool === 'draw') {
    // draw.js expects an opaque CSS colour — use preset solid or custom hex
    setDrawColour(presetDef ? presetDef.solid : activeColour);
  }
}

// ---------------------------------------------------------------------------
// Custom palette persistence
// ---------------------------------------------------------------------------

/**
 * Saves the currently active colour to the persistent custom palette.
 * Ignored if colour is already in the palette or palette is full.
 *
 * @param {string} hex — CSS hex colour string
 */
function saveCustomColourToPalette(hex) {
  // Only save valid hex colours
  if (!hex || !hex.startsWith('#')) return;
  if (customPalette.includes(hex)) return;
  if (customPalette.length >= MAX_CUSTOM_COLOURS) {
    // Silently drop the oldest entry to stay within the limit
    customPalette.shift();
  }
  customPalette.push(hex);
  localStorage.setItem(LS_CUSTOM_PALETTE, JSON.stringify(customPalette));
  renderCustomPalette();
  updateSwatchState();
}

/**
 * Removes a colour from the custom palette.
 *
 * @param {string} hex
 */
function removeCustomColourFromPalette(hex) {
  customPalette = customPalette.filter(c => c !== hex);
  localStorage.setItem(LS_CUSTOM_PALETTE, JSON.stringify(customPalette));
  // If the removed colour was active, reset to the first preset colour
  if (activeColour === hex) handleColourClick(COLOURS[0].name);
  renderCustomPalette();
  updateSwatchState();
}

/**
 * Rebuilds the custom palette swatch DOM from the current customPalette array.
 * Right-click (mouse) or long-press (touch) opens a context menu with options
 * to delete the colour or re-edit it in the colour picker.
 */
function renderCustomPalette() {
  if (!customPaletteContainerEl) return;
  customPaletteContainerEl.innerHTML = '';

  if (customPalette.length === 0) return;

  // Thin separator before custom palette entries
  const sep = document.createElement('div');
  sep.className = 'colour-custom-sep';
  customPaletteContainerEl.appendChild(sep);

  for (const hex of customPalette) {
    const wrapper = document.createElement('div');
    wrapper.className = 'colour-saved-wrapper';

    const swatch = document.createElement('button');
    swatch.className        = 'colour-swatch colour-swatch-saved';
    swatch.title            = hex;
    swatch.style.background = hex;
    swatch.dataset.colour   = hex;
    swatch.addEventListener('click', () => handleColourClick(hex));

    // Right-click → context menu
    swatch.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _showSwatchMenu(hex, e.clientX, e.clientY);
    });

    // Long-press (touch) → context menu after 500 ms
    let longPressTimer = null;
    swatch.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; // handled by contextmenu
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        _showSwatchMenu(hex, e.clientX, e.clientY);
      }, 500);
    });
    swatch.addEventListener('pointerup',    () => clearTimeout(longPressTimer));
    swatch.addEventListener('pointermove',  () => clearTimeout(longPressTimer));
    swatch.addEventListener('pointercancel',() => clearTimeout(longPressTimer));

    wrapper.appendChild(swatch);
    customPaletteContainerEl.appendChild(wrapper);
  }
}

/**
 * Shows a context menu for a custom palette swatch at the given screen position.
 * Provides "Delete colour" and "Edit colour" options.
 *
 * @param {string} hex     — The colour hex string this swatch represents
 * @param {number} screenX — Cursor X in viewport coordinates
 * @param {number} screenY — Cursor Y in viewport coordinates
 */
function _showSwatchMenu(hex, screenX, screenY) {
  // Remove any existing menu
  _dismissSwatchMenu();

  const menu = document.createElement('div');
  menu.className = 'colour-swatch-menu';
  menu.id        = 'colour-swatch-context-menu';

  const editBtn = document.createElement('button');
  editBtn.className   = 'colour-swatch-menu-item';
  editBtn.textContent = 'Edit colour';
  editBtn.addEventListener('click', () => {
    _dismissSwatchMenu();
    // Pre-fill the colour input with the current value and open it
    const colourInput = document.getElementById('colour-input-hidden');
    if (colourInput) {
      colourInput.value = hex;
      colourInput.click();
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'colour-swatch-menu-item colour-swatch-menu-item-delete';
  deleteBtn.textContent = 'Delete colour';
  deleteBtn.addEventListener('click', () => {
    _dismissSwatchMenu();
    removeCustomColourFromPalette(hex);
  });

  menu.appendChild(editBtn);
  menu.appendChild(deleteBtn);
  document.body.appendChild(menu);

  // Position: keep inside viewport
  const { innerWidth, innerHeight } = window;
  const menuW = 140, menuH = 72;
  const x = Math.min(screenX, innerWidth  - menuW - 8);
  const y = Math.min(screenY, innerHeight - menuH - 8);
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  // Dismiss when clicking outside the menu
  setTimeout(() => {
    document.addEventListener('pointerdown', function onDown(e) {
      if (!menu.contains(e.target)) {
        _dismissSwatchMenu();
        document.removeEventListener('pointerdown', onDown);
      }
    });
  }, 0);
}

/** Removes the swatch context menu if present. */
function _dismissSwatchMenu() {
  document.getElementById('colour-swatch-context-menu')?.remove();
}

// ---------------------------------------------------------------------------
// Custom colour & eyedropper
// ---------------------------------------------------------------------------

/**
 * Applies a custom hex colour picked via the colour input or eyedropper.
 * Updates the custom circle button to show the chosen colour.
 *
 * @param {string} hex — CSS hex string e.g. '#ff5733'
 */
function handleCustomColour(hex) {
  activeColour = hex;
  const customBtn = document.getElementById('btn-custom-colour');
  if (customBtn) customBtn.style.background = hex;
  updateSwatchState();
  applyColourToActiveTool();
  saveToolSettings();
}

/**
 * Opens the EyeDropper API and applies the sampled colour.
 * Falls back silently if the user cancels.
 */
async function handleEyedropper() {
  try {
    const result = await new EyeDropper().open();
    const hex    = result.sRGBHex;
    handleCustomColour(hex);
    // Sync the hidden colour input so it shows the picked value on next open
    const input = colourPickerEl.querySelector('input[type="color"]');
    if (input) input.value = hex;
  } catch {
    // User cancelled the dropper — do nothing
  }
}

// ---------------------------------------------------------------------------
// Stroke size selection
// ---------------------------------------------------------------------------

/**
 * Handles a stroke size button click.
 *
 * @param {string} sizeId — One of the STROKE_SIZES ids
 */
function handleStrokeSizeClick(sizeId) {
  activeStrokeSize = sizeId;
  updateStrokeSizeState();
  applyStrokeSizeToActiveTool();
  saveToolSettings();
}

/**
 * Sends the currently selected stroke width/radius to the active tool.
 */
function applyStrokeSizeToActiveTool() {
  const sizeDef = _getCurrentSizes().find(s => s.id === activeStrokeSize);
  if (!sizeDef) return;
  if (activeTool === 'draw')      setDrawStrokeWidth(sizeDef.width);
  if (activeTool === 'highlight') setHighlightStrokeWidth(sizeDef.width);
  if (activeTool === 'eraser')    setEraseRadius(sizeDef.eraseRadius);
  updateToolCursor();
}

// ---------------------------------------------------------------------------
// Per-tool settings persistence
// ---------------------------------------------------------------------------

/**
 * Saves the current colour and/or size to toolSettings for the active tool,
 * then writes the whole object to localStorage.
 * Called after any colour or size change so each tool "remembers" its last state.
 */
function saveToolSettings() {
  if (!activeTool) return;
  const entry = {};
  if (COLOUR_TOOLS.has(activeTool)) entry.colour    = activeColour;
  if (STROKE_TOOLS.has(activeTool)) entry.sizeId    = activeStrokeSize;
  if (activeTool === 'eraser')      entry.eraseMode  = activeEraseMode;
  if (activeTool === 'draw')        entry.pressure   = pressureOn;
  if (activeTool === 'draw')        entry.shapeSnap  = shapeSnapOn;
  if (Object.keys(entry).length === 0) return;
  toolSettings[activeTool] = entry;
  localStorage.setItem(LS_TOOL_SETTINGS, JSON.stringify(toolSettings));
}

/**
 * Restores colour and size from the saved settings for the given tool.
 * Falls back to the starred default colour and 'normal' stroke size when no
 * memory exists for that tool.
 *
 * @param {string} toolName
 */
function restoreToolSettings(toolName) {
  const saved = toolSettings[toolName];
  if (COLOUR_TOOLS.has(toolName)) {
    activeColour = saved?.colour ?? COLOURS[0].name;
  }
  if (STROKE_TOOLS.has(toolName)) {
    activeStrokeSize = saved?.sizeId ?? 'normal';
  }
  if (toolName === 'eraser') {
    activeEraseMode = saved?.eraseMode ?? 'partial';
  }
  if (toolName === 'draw') {
    pressureOn  = saved?.pressure  ?? true;
    shapeSnapOn = saved?.shapeSnap ?? true;
  }
}

// ---------------------------------------------------------------------------
// DOM state updates
// ---------------------------------------------------------------------------

/**
 * Syncs tool button active classes with the current activeTool state.
 */
function updateButtonStates() {
  for (const [id, btn] of toolButtons) {
    // cursor button is "active" when no tool is selected
    const isActive = id === 'cursor' ? activeTool === null : id === activeTool;
    btn.classList.toggle('active', isActive);
  }
}

/**
 * Shows the colour picker only when a colour-capable tool is active.
 * Shows the stroke picker only when the draw tool is active.
 * Restores the tool's last-used colour and size from toolSettings.
 */
function updateColourPickerVisibility() {
  const colourVisible      = activeTool !== null && COLOUR_TOOLS.has(activeTool);
  const strokeVisible      = activeTool !== null && STROKE_TOOLS.has(activeTool);
  const eraserModeVisible  = activeTool === 'eraser';
  const pressureVisible    = activeTool === 'draw';
  const shapeSnapVisible   = activeTool === 'draw' || activeTool === 'highlight';
  const textboxVisible     = activeTool === 'note';

  const show = (el, visible, displayVal = 'flex') => {
    if (!el) return;
    el.style.display       = visible ? displayVal : 'none';
    el.style.pointerEvents = visible ? '' : 'none';
  };

  show(colourPickerEl,     colourVisible);
  show(colourSepEl,        colourVisible, 'block');
  show(strokePickerEl,     strokeVisible);
  show(eraserModePickerEl, eraserModeVisible);
  show(pressureToggleEl,   pressureVisible);
  show(shapeSnapToggleEl,  shapeSnapVisible);
  show(textboxOptionsEl,   textboxVisible);
  pressureToggleEl.classList.remove('toolbar-btn-invisible');

  if (colourVisible || strokeVisible || eraserModeVisible || pressureVisible) {
    restoreToolSettings(activeTool);
    if (colourVisible) {
      updateSwatchState();
      applyColourToActiveTool();
    }
    if (strokeVisible) {
      _refreshSizeDots();
      updateStrokeSizeState();
      applyStrokeSizeToActiveTool();
    }
    if (eraserModeVisible) {
      updateEraserModeState();
      setEraseMode(activeEraseMode);
    }
    if (pressureVisible) {
      document.getElementById('btn-pressure-toggle')?.classList.toggle('active', pressureOn);
      setPressureSensitive(pressureOn);
    }
    if (shapeSnapVisible) {
      document.getElementById('btn-shape-snap-toggle')?.classList.toggle('active', shapeSnapOn);
      setDrawShapeSnap(shapeSnapOn);
      setHighlightShapeSnap(shapeSnapOn);
    }
  }
  // Update the tool cursor whenever the tool changes
  updateToolCursor();
}

/**
 * Syncs swatch active and default (star) classes with current state.
 * If activeColour is a hex string (custom), marks the custom button active.
 */
function updateSwatchState() {
  const isPreset      = COLOURS.some(c => c.name === activeColour);
  const isCustomSaved = customPalette.includes(activeColour);

  for (const [name, swatch] of swatchButtons) {
    swatch.classList.toggle('active', name === activeColour);
  }

  if (customPaletteContainerEl) {
    for (const sw of customPaletteContainerEl.querySelectorAll('.colour-swatch')) {
      sw.classList.toggle('active', sw.dataset.colour === activeColour);
    }
  }

  const customBtn = document.getElementById('btn-custom-colour');
  customBtn?.classList.toggle('active', !isPreset && !isCustomSaved);
}

/**
 * Syncs stroke size button active classes with the current activeStrokeSize state.
 */
function updateStrokeSizeState() {
  for (const [id, btn] of strokeSizeButtons) {
    btn.classList.toggle('active', id === activeStrokeSize);
  }
}

/**
 * Syncs eraser mode button active classes with the current activeEraseMode state.
 */
function updateEraserModeState() {
  for (const [id, btn] of eraserModeBtns) {
    btn.classList.toggle('active', id === activeEraseMode);
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

/**
 * Updates the page indicator and zoom level labels in the toolbar.
 *
 * @param {{ pageCount: number, currentPage: number|null, scale: number }} status
 */
function updateStatus({ pageCount, currentPage, scale }) {
  if (lblZoomEl) {
    lblZoomEl.textContent = `${Math.round(scale * 100)}%`;
  }
  if (lblPageEl) {
    if (pageCount > 0 && currentPage !== null && currentPage !== undefined) {
      lblPageEl.textContent = `${currentPage + 1} / ${pageCount}`;
    } else if (pageCount > 0) {
      lblPageEl.textContent = `— / ${pageCount}`;
    } else {
      lblPageEl.textContent = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic pen cursor
// ---------------------------------------------------------------------------

/**
 * Builds a CSS cursor data-URL string from a circle SVG sized to match the
 * expected stroke diameter on screen.
 *
 * @param {number} diameterPx — on-screen diameter in CSS pixels
 * @returns {string} CSS cursor value
 */
function buildCursor(diameterPx) {
  const r    = Math.max(2, Math.min(44, diameterPx / 2));
  const size = Math.ceil(r * 2 + 4); // +4px padding for the stroke border
  const c    = size / 2;
  const svg  = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>` +
    `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='white' stroke-width='1.5'/>` +
    `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='black' stroke-width='0.6' stroke-dasharray='3 2'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

/**
 * Applies a size-matched SVG cursor to the canvas container for draw,
 * highlight, and eraser tools. Clears to default for other tools.
 */
function updateToolCursor() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  const sizeDef = _getCurrentSizes().find(s => s.id === activeStrokeSize);
  const scale   = cachedViewportScale;

  if (activeTool === 'draw' || activeTool === 'highlight') {
    const diameterPx = (sizeDef?.width ?? 2) * scale;
    container.style.cursor = buildCursor(diameterPx);
  } else if (activeTool === 'eraser') {
    // Cursor is managed by eraser.js (ring overlay replaces cursor — leave as none)
  } else {
    // Let CSS handle cursor for other tools (cursor, select, note)
    container.style.cursor = '';
  }
}

// ---------------------------------------------------------------------------
// Editable size presets — long-press slider popover
// ---------------------------------------------------------------------------

/**
 * Saves the custom sizes for the given tool to localStorage.
 *
 * @param {'draw'|'highlight'|'eraser'} tool
 */
function _saveCustomSizes(tool) {
  if (tool === 'draw') {
    localStorage.setItem(LS_CUSTOM_SIZES_DRAW, JSON.stringify(
      DRAW_SIZES.map(s => ({ width: s.width, dot: s.dot }))
    ));
  } else if (tool === 'highlight') {
    localStorage.setItem(LS_CUSTOM_SIZES_HIGHLIGHT, JSON.stringify(
      HIGHLIGHT_SIZES.map(s => ({ width: s.width, dot: s.dot }))
    ));
  } else if (tool === 'eraser') {
    localStorage.setItem(LS_CUSTOM_SIZES_ERASER, JSON.stringify(
      ERASER_SIZES.map(s => ({ eraseRadius: s.eraseRadius, dot: s.dot }))
    ));
  }
}

/**
 * Exponential mapping between slider integer positions (1–20) and actual stroke
 * widths (0.3–20) or erase radii (0.5–60).
 *
 * pos=1→min, pos=20→max
 */
function _sliderToValue(pos, min, max) {
  const ratio = Math.pow(max / min, (pos - 1) / 19);
  return Math.round(ratio * min * 10) / 10;
}
function _valueToSlider(val, min, max) {
  const clamped = Math.max(min, Math.min(max, val));
  return Math.round(1 + 19 * Math.log(clamped / min) / Math.log(max / min));
}

// Kept for backwards compatibility (cursor sizing still calls this)
const _SLIDER_MIN_WIDTH = 0.3;
const _SLIDER_MAX_WIDTH = 20;
function _sliderToWidth(pos)   { return _sliderToValue(pos, _SLIDER_MIN_WIDTH, _SLIDER_MAX_WIDTH); }
function _widthToSlider(width) { return _valueToSlider(width, _SLIDER_MIN_WIDTH, _SLIDER_MAX_WIDTH); }

/**
 * Updates the dot visuals on all size buttons to match the current tool's array.
 * Called each time the active tool changes.
 */
function _refreshSizeDots() {
  const sizes = _getCurrentSizes();
  for (const sizeDef of sizes) {
    const btn = strokeSizeButtons.get(sizeDef.id);
    if (!btn) continue;
    const dot = btn.querySelector('.stroke-size-dot');
    if (dot) { dot.style.width = `${sizeDef.dot}px`; dot.style.height = `${sizeDef.dot}px`; }
    btn.title = `${sizeDef.label} — long-press to customise`;
  }
}

/**
 * Shows a slider popover above the given size button for the current tool's
 * size entry at sizeId. Customises draw width or erase radius independently.
 *
 * @param {string}      sizeId — slot id ('fine', 'normal', 'thick', 'brush')
 * @param {HTMLElement} btn
 */
function showSizePopover(sizeId, btn) {
  closeSizePopover();

  const isEraser = activeTool === 'eraser';
  const sizeDef  = _getCurrentSizes().find(s => s.id === sizeId);
  if (!sizeDef) return;

  const sliderMin = isEraser ? 0.5 : _SLIDER_MIN_WIDTH;
  const sliderMax = isEraser ? 60  : _SLIDER_MAX_WIDTH;
  const curVal    = isEraser ? sizeDef.eraseRadius : sizeDef.width;

  const popover = document.createElement('div');
  popover.className = 'size-popover';

  const label = document.createElement('span');
  label.className   = 'size-popover-label';
  label.textContent = sizeDef.label;
  popover.appendChild(label);

  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.min   = '1';
  slider.max   = '20';
  slider.step  = '1';
  slider.value = String(_valueToSlider(curVal, sliderMin, sliderMax));
  slider.className = 'size-popover-slider';
  popover.appendChild(slider);

  const valueDisplay = document.createElement('span');
  valueDisplay.className   = 'size-popover-value';
  valueDisplay.textContent = curVal;
  popover.appendChild(valueDisplay);

  slider.addEventListener('input', () => {
    const newVal = _sliderToValue(parseInt(slider.value, 10), sliderMin, sliderMax);
    valueDisplay.textContent = newVal;

    if (isEraser) {
      sizeDef.eraseRadius = newVal;
      sizeDef.dot = Math.round(2 + newVal * 0.25);
    } else {
      sizeDef.width = newVal;
      sizeDef.dot   = Math.round(2 + newVal * 1.2);
    }

    const dot = btn.querySelector('.stroke-size-dot');
    if (dot) { dot.style.width = `${sizeDef.dot}px`; dot.style.height = `${sizeDef.dot}px`; }

    if (activeStrokeSize === sizeId) applyStrokeSizeToActiveTool();
    _saveCustomSizes(activeTool);
  });

  // Use fixed positioning so the popover is never clipped by overflow:hidden
  // on the toolbar or any ancestor.
  popover.style.position = 'fixed';
  document.body.appendChild(popover);
  const btnRect = btn.getBoundingClientRect();
  popover.style.left   = `${Math.max(4, Math.min(btnRect.left, window.innerWidth - 220))}px`;
  popover.style.top    = `${btnRect.bottom + 4}px`;

  activeSizePopover = popover;

  // Close when the user clicks/taps outside the popover.
  // Uses a persistent listener (not once:true) so interacting with the slider
  // doesn't close it — only a click that lands outside does.
  setTimeout(() => {
    document.addEventListener('pointerdown', _onOutsidePointerDown);
  }, 0);
}

function _onOutsidePointerDown(e) {
  if (activeSizePopover && !activeSizePopover.contains(e.target)) {
    closeSizePopover();
  }
}

function closeSizePopover() {
  activeSizePopover?.remove();
  activeSizePopover = null;
  document.removeEventListener('pointerdown', _onOutsidePointerDown);
}

// ---------------------------------------------------------------------------
// Text box toolbar options
// ---------------------------------------------------------------------------

/** References to textbox toolbar controls for sync */
const _tbSwatches   = new Map(); // hex → button
let   _tbSizeSelect = null;
const _tbAlignBtns  = new Map(); // align → button
const _tbFormatBtns = new Map(); // cmd → button

/**
 * Builds colour swatches, font-size select, bold/italic/underline toggles,
 * and alignment buttons inside #textbox-options.
 */
function _buildTextBoxOptions() {
  if (!textboxOptionsEl) return;

  const curColour   = _textBoxSettings.colour   ?? '#000000';
  const curFontSize = _textBoxSettings.fontSize  ?? 14;
  const curAlign    = _textBoxSettings.align     ?? 'left';

  // Colour swatches
  for (const c of TEXTBOX_COLOURS) {
    const btn = document.createElement('button');
    btn.className        = 'tbo-swatch';
    btn.title            = c.label;
    btn.style.background = c.value;
    if (c.value === '#ffffff') { btn.style.outline = '1px solid #888'; btn.style.outlineOffset = '-1px'; }
    btn.classList.toggle('active', c.value === curColour);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _applyTextBoxSetting('colour', c.value);
    });
    textboxOptionsEl.appendChild(btn);
    _tbSwatches.set(c.value, btn);
  }

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'tbo-sep';
  textboxOptionsEl.appendChild(sep1);

  // Font size select
  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'tbo-size-select';
  sizeSelect.title     = 'Font size';
  for (const sz of NOTE_FONT_SIZES) {
    const opt = document.createElement('option');
    opt.value       = sz;
    opt.textContent = sz;
    if (sz === curFontSize) opt.selected = true;
    sizeSelect.appendChild(opt);
  }
  sizeSelect.addEventListener('change', () => {
    _applyTextBoxSetting('fontSize', Number(sizeSelect.value));
  });
  textboxOptionsEl.appendChild(sizeSelect);
  _tbSizeSelect = sizeSelect;

  // Separator
  const sep2 = document.createElement('div');
  sep2.className = 'tbo-sep';
  textboxOptionsEl.appendChild(sep2);

  // Format buttons (bold, italic, underline) via execCommand
  const fmtBtns = [
    { cmd: 'bold',      label: 'B', title: 'Bold (Ctrl+B)',       style: 'font-weight:700' },
    { cmd: 'italic',    label: 'I', title: 'Italic (Ctrl+I)',     style: 'font-style:italic' },
    { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)',  style: 'text-decoration:underline' },
    { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list', style: '' },
  ];
  for (const f of fmtBtns) {
    const btn = document.createElement('button');
    btn.className        = 'tbo-fmt-btn';
    btn.title            = f.title;
    btn.innerHTML        = `<span style="${f.style}">${f.label}</span>`;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.execCommand(f.cmd);
    });
    textboxOptionsEl.appendChild(btn);
    _tbFormatBtns.set(f.cmd, btn);
  }

  // Separator
  const sep3 = document.createElement('div');
  sep3.className = 'tbo-sep';
  textboxOptionsEl.appendChild(sep3);

  // Alignment buttons
  const alignOpts = [
    { align: 'left',   title: 'Align left',   svg: `<svg width="14" height="14" viewBox="0 0 14 14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.4"/><line x1="1" y1="7" x2="9" y2="7" stroke="currentColor" stroke-width="1.4"/><line x1="1" y1="11" x2="11" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>` },
    { align: 'center', title: 'Centre',        svg: `<svg width="14" height="14" viewBox="0 0 14 14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.4"/><line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1.4"/><line x1="2" y1="11" x2="12" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>` },
    { align: 'right',  title: 'Align right',   svg: `<svg width="14" height="14" viewBox="0 0 14 14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.4"/><line x1="5" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.4"/><line x1="3" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1.4"/></svg>` },
  ];
  for (const a of alignOpts) {
    const btn = document.createElement('button');
    btn.className  = 'tbo-fmt-btn';
    btn.title      = a.title;
    btn.innerHTML  = a.svg;
    btn.classList.toggle('active', a.align === curAlign);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _applyTextBoxSetting('align', a.align);
    });
    textboxOptionsEl.appendChild(btn);
    _tbAlignBtns.set(a.align, btn);
  }

  // Push defaults to note.js
  setNoteDefaults({ colour: curColour, fontSize: curFontSize, align: curAlign });
}

/**
 * Applies one text box setting — updates toolbar state, note defaults,
 * the focused annotation (if any), and persists.
 */
function _applyTextBoxSetting(key, value) {
  _textBoxSettings[key] = value;
  setNoteDefaults({ [key]: value });
  applyFocusedStyle({ [key]: value });
  _syncTextBoxToolbar({ ..._textBoxSettings });
  _saveTextBoxSettings();
}

/**
 * Syncs toolbar control states to the given style (from focused annotation
 * or current defaults).
 */
function _syncTextBoxToolbar(style) {
  for (const [hex, btn] of _tbSwatches) {
    btn.classList.toggle('active', hex === (style.colour ?? '#000000'));
  }
  if (_tbSizeSelect && style.fontSize != null) {
    _tbSizeSelect.value = String(style.fontSize);
  }
  for (const [align, btn] of _tbAlignBtns) {
    btn.classList.toggle('active', align === (style.align ?? 'left'));
  }
}

/** Persists textbox settings to the existing tool settings localStorage key. */
function _saveTextBoxSettings() {
  try {
    const raw = localStorage.getItem(LS_TOOL_SETTINGS);
    const all = raw ? JSON.parse(raw) : {};
    all.textBox = _textBoxSettings;
    localStorage.setItem(LS_TOOL_SETTINGS, JSON.stringify(all));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init, setActiveTool, getActiveTool, updateStatus };
