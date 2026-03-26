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
  activate   as activateHighlight,
  deactivate as deactivateHighlight,
  setColour  as setHighlightColour,
} from '../annotations/highlight.js';

import {
  activate        as activateDraw,
  deactivate      as deactivateDraw,
  setColour       as setDrawColour,
  setStrokeWidth  as setDrawStrokeWidth,
} from '../annotations/draw.js';

import {
  setStrokeWidth as setHighlightStrokeWidth,
} from '../annotations/highlight.js';

import {
  activate   as activateEraser,
  deactivate as deactivateEraser,
} from '../annotations/eraser.js';

import {
  activate   as activateSelect,
  deactivate as deactivateSelect,
} from '../annotations/select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that support colour selection */
const COLOUR_TOOLS = new Set(['highlight', 'draw']);

/** Tools that support stroke size selection */
const STROKE_TOOLS = new Set(['draw', 'highlight']);

/**
 * Stroke size presets for the draw tool.
 * width: canvas-unit base stroke width passed to setStrokeWidth()
 * dot:   visual dot diameter in px shown on the button
 */
const STROKE_SIZES = [
  { id: 'fine',   label: 'Fine',   width: 1,  dot: 3  },
  { id: 'normal', label: 'Normal', width: 2,  dot: 5  },
  { id: 'thick',  label: 'Thick',  width: 4,  dot: 8  },
  { id: 'brush',  label: 'Brush',  width: 8,  dot: 12 },
];

/**
 * Colour definitions.
 * name:       logical name used by highlight.js
 * solid:      CSS hex used by draw.js (opaque strokes)
 * background: CSS colour used for the swatch circle
 */
const COLOURS = [
  { name: 'yellow', solid: '#f5c518', background: '#f5c518' },
  { name: 'green',  solid: '#3ecf8e', background: '#3ecf8e' },
  { name: 'pink',   solid: '#f472b6', background: '#f472b6' },
  { name: 'blue',   solid: '#5b8af5', background: '#5b8af5' },
];

/**
 * Tool definitions.
 * id:    logical name used throughout the app
 * title: tooltip text
 * svg:   inner SVG markup (14×14 viewBox)
 */
const TOOLS = [
  {
    id: 'cursor',
    title: 'Cursor (V)',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.5 1.5L2.5 11L5 8.5L6.5 12.5L8.5 11.5L7 7.5L10.5 7.5Z" fill="currentColor"/>
    </svg>`,
  },
  {
    id: 'select',
    title: 'Select & Move (S)',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.5 2"/>
      <path d="M5 5L5 9M9 5L9 9M5 5L9 5M5 9L9 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'highlight',
    title: 'Highlight (H)',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="4" width="11" height="5" rx="1" fill="currentColor" opacity="0.55"/>
      <line x1="1.5" y1="11" x2="12.5" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'draw',
    title: 'Draw (D)',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 2L12 4.5L5.5 11L2.5 11.5L3 8.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <line x1="7.5" y1="4" x2="10" y2="6.5" stroke="currentColor" stroke-width="1.4"/>
    </svg>`,
  },
  {
    id: 'note',
    title: 'Text Box (N) — double-click canvas to place',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.5 2.5H8.5L11.5 5.5V11.5H2.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M8.5 2.5V5.5H11.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`,
  },
  {
    id: 'eraser',
    title: 'Eraser (E)',
    svg: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.5 2L12 5.5L6 11.5H2.5L1.5 10.5L7 5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M5 8L8.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <line x1="1.5" y1="11.5" x2="12.5" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Which tool is currently active, or null for the default cursor */
let activeTool = null;

/**
 * Currently selected colour — either a preset name ('yellow') or a CSS hex
 * string ('#ff5733') when a custom colour has been picked.
 */
let activeColour = 'yellow';

/** Map of tool id → button element, populated during init() */
const toolButtons = new Map();

/** Map of colour name → swatch element, populated during init() */
const swatchButtons = new Map();

/** The #colour-picker container element */
let colourPickerEl = null;

/** The #colour-sep separator element */
let colourSepEl = null;

/** The #stroke-picker container element */
let strokePickerEl = null;

/** Currently active stroke size id */
let activeStrokeSize = 'normal';

/** Map of size id → button element, populated during init() */
const strokeSizeButtons = new Map();

/** The #lbl-page label element */
let lblPageEl = null;

/** The #lbl-zoom label element */
let lblZoomEl = null;

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

  // Build colour swatches inside the colour picker
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

  // Apply initial swatch active state
  updateSwatchState();

  // ── Custom colour circle (opens native colour picker) ──────────────────
  const customSep = document.createElement('div');
  customSep.className = 'colour-custom-sep';
  colourPickerEl.appendChild(customSep);

  // The hidden <input type="color"> drives the native OS colour picker
  const colourInput = document.createElement('input');
  colourInput.type  = 'color';
  colourInput.value = '#ffffff';
  colourInput.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
  colourInput.addEventListener('input', (e) => handleCustomColour(e.target.value));
  colourPickerEl.appendChild(colourInput);

  // Visible circle button — shows a rainbow gradient until a colour is chosen
  const customBtn = document.createElement('button');
  customBtn.id        = 'btn-custom-colour';
  customBtn.className = 'colour-swatch colour-swatch-custom';
  customBtn.title     = 'Custom colour';
  customBtn.style.background = 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
  customBtn.addEventListener('click', () => colourInput.click());
  colourPickerEl.appendChild(customBtn);

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

  // Build stroke size buttons inside the stroke picker
  for (const size of STROKE_SIZES) {
    const btn = document.createElement('button');
    btn.className  = 'stroke-size-btn';
    btn.title      = size.label;
    btn.dataset.size = size.id;

    // Visual dot — a filled circle whose diameter indicates the stroke weight
    const dot = document.createElement('span');
    dot.className = 'stroke-size-dot';
    dot.style.width  = `${size.dot}px`;
    dot.style.height = `${size.dot}px`;
    btn.appendChild(dot);

    btn.addEventListener('click', () => handleStrokeSizeClick(size.id));

    strokePickerEl.appendChild(btn);
    strokeSizeButtons.set(size.id, btn);
  }

  // Apply initial stroke size active state
  updateStrokeSizeState();
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
  // Deactivate whatever is currently running
  deactivateCurrentTool();

  activeTool = toolName;

  // Activate the new tool (note and cursor have no activate/deactivate)
  if (activeTool === 'highlight') activateHighlight();
  if (activeTool === 'draw')      activateDraw();
  if (activeTool === 'eraser')    activateEraser();
  if (activeTool === 'select')    activateSelect();

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
}

/**
 * Sends the currently selected stroke width to the draw tool.
 */
function applyStrokeSizeToActiveTool() {
  const sizeDef = STROKE_SIZES.find(s => s.id === activeStrokeSize);
  if (!sizeDef) return;
  if (activeTool === 'draw')      setDrawStrokeWidth(sizeDef.width);
  if (activeTool === 'highlight') setHighlightStrokeWidth(sizeDef.width);
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
 */
function updateColourPickerVisibility() {
  const colourVisible = activeTool !== null && COLOUR_TOOLS.has(activeTool);
  const strokeVisible = activeTool !== null && STROKE_TOOLS.has(activeTool);

  colourPickerEl.style.display  = colourVisible ? 'flex' : 'none';
  colourSepEl.style.display     = colourVisible ? 'block' : 'none';
  strokePickerEl.style.display  = strokeVisible ? 'flex' : 'none';

  if (colourVisible) {
    applyColourToActiveTool();
  }
  if (strokeVisible) {
    applyStrokeSizeToActiveTool();
  }
}

/**
 * Syncs swatch active classes with the current activeColour state.
 * If activeColour is a hex string (custom), marks the custom button active.
 */
function updateSwatchState() {
  const isPreset = COLOURS.some(c => c.name === activeColour);
  for (const [name, swatch] of swatchButtons) {
    swatch.classList.toggle('active', name === activeColour);
  }
  const customBtn = document.getElementById('btn-custom-colour');
  customBtn?.classList.toggle('active', !isPreset);
}

/**
 * Syncs stroke size button active classes with the current activeStrokeSize state.
 */
function updateStrokeSizeState() {
  for (const [id, btn] of strokeSizeButtons) {
    btn.classList.toggle('active', id === activeStrokeSize);
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
// Exports
// ---------------------------------------------------------------------------

export { init, setActiveTool, getActiveTool, updateStatus };
