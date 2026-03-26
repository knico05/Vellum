/**
 * floatingtoolbar.js — Draggable floating tool palette for tablet/pen use
 *
 * A compact pill-shaped toolbar that floats over the canvas. Designed for
 * situations where keyboard shortcuts aren't available (tablet + stylus).
 *
 * Behaviour:
 *   - Displays the core annotation tools as large-tap-target icon buttons.
 *   - Reflects the currently active tool (synced via the 'tool-changed' event).
 *   - Can be dragged anywhere on screen — position persists until next open.
 *   - Press + drag the grip handle to reposition; tap a tool button to activate.
 *
 * Tools shown: cursor, draw, highlight, eraser, select
 * Also shows: fit-page and screenshot as quick-access actions.
 *
 * Exports: initFloatingToolbar()
 */

'use strict';

import { setActiveTool } from './toolbar.js';

// ---------------------------------------------------------------------------
// Tool definitions (subset of main toolbar, reordered for tablet priority)
// ---------------------------------------------------------------------------

const FLOAT_TOOLS = [
  {
    id: 'cursor',
    title: 'Cursor',
    svg: `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.5 1.5L2.5 11L5 8.5L6.5 12.5L8.5 11.5L7 7.5L10.5 7.5Z" fill="currentColor"/>
    </svg>`,
  },
  {
    id: 'draw',
    title: 'Draw',
    svg: `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 2L12 4.5L5.5 11L2.5 11.5L3 8.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <line x1="7.5" y1="4" x2="10" y2="6.5" stroke="currentColor" stroke-width="1.4"/>
    </svg>`,
  },
  {
    id: 'highlight',
    title: 'Highlight',
    svg: `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="4" width="11" height="5" rx="1" fill="currentColor" opacity="0.55"/>
      <line x1="1.5" y1="11" x2="12.5" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'eraser',
    title: 'Eraser',
    svg: `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.5 2L12 5.5L6 11.5H2.5L1.5 10.5L7 5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M5 8L8.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <line x1="1.5" y1="11.5" x2="12.5" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'select',
    title: 'Select',
    svg: `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.5 2"/>
      <path d="M5 5L5 9M9 5L9 9M5 5L9 5M5 9L9 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
  },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let barEl     = null;
let activeTool = null;

// Drag state for repositioning the toolbar itself
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  barEl = document.createElement('div');
  barEl.id = 'floating-toolbar';

  // Drag grip handle
  const grip = document.createElement('div');
  grip.className   = 'float-grip';
  grip.title       = 'Drag to reposition';
  grip.innerHTML   = `<svg width="10" height="16" viewBox="0 0 10 16" fill="none">
    <circle cx="3" cy="3"  r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="7" cy="3"  r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="3" cy="8"  r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="7" cy="8"  r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="3" cy="13" r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="7" cy="13" r="1.5" fill="currentColor" opacity="0.5"/>
  </svg>`;
  barEl.appendChild(grip);

  // Separator after grip
  const sep = document.createElement('div');
  sep.className = 'float-sep';
  barEl.appendChild(sep);

  // Tool buttons
  for (const tool of FLOAT_TOOLS) {
    const btn = document.createElement('button');
    btn.className   = 'float-btn';
    btn.title       = tool.title;
    btn.innerHTML   = tool.svg;
    btn.dataset.tool = tool.id;

    btn.addEventListener('pointerdown', (e) => {
      // Don't start a toolbar drag from a tool button
      e.stopPropagation();
    });
    btn.addEventListener('click', () => {
      setActiveTool(tool.id === 'cursor' ? null : tool.id);
    });

    barEl.appendChild(btn);
  }

  document.body.appendChild(barEl);

  // Sync with active tool changes from main toolbar / shortcuts
  document.addEventListener('tool-changed', (e) => {
    activeTool = e.detail;
    updateButtonStates();
  });

  // Drag to reposition
  grip.addEventListener('pointerdown', onGripDown);

  // Default position: bottom-center
  positionDefault();
}

// ---------------------------------------------------------------------------
// Button state
// ---------------------------------------------------------------------------

function updateButtonStates() {
  for (const btn of barEl.querySelectorAll('.float-btn')) {
    const toolId = btn.dataset.tool;
    const isActive = toolId === 'cursor'
      ? activeTool === null
      : toolId === activeTool;
    btn.classList.toggle('active', isActive);
  }
}

// ---------------------------------------------------------------------------
// Drag to reposition
// ---------------------------------------------------------------------------

function onGripDown(e) {
  e.preventDefault();
  isDragging = true;

  const rect = barEl.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  // Use window-level listeners so drag works even if pointer leaves the grip
  window.addEventListener('pointermove', onGripMove);
  window.addEventListener('pointerup',   onGripUp);
}

function onGripMove(e) {
  if (!isDragging) return;
  const x = e.clientX - dragOffsetX;
  const y = e.clientY - dragOffsetY;

  // Clamp to viewport
  const maxX = window.innerWidth  - barEl.offsetWidth;
  const maxY = window.innerHeight - barEl.offsetHeight;

  barEl.style.left   = `${Math.max(0, Math.min(maxX, x))}px`;
  barEl.style.top    = `${Math.max(0, Math.min(maxY, y))}px`;
  barEl.style.bottom = 'auto';
  barEl.style.transform = 'none';
}

function onGripUp() {
  isDragging = false;
  window.removeEventListener('pointermove', onGripMove);
  window.removeEventListener('pointerup',   onGripUp);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positionDefault() {
  // Centre at the bottom of the screen, above the canvas edge
  barEl.style.bottom    = '28px';
  barEl.style.left      = '50%';
  barEl.style.transform = 'translateX(-50%)';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initFloatingToolbar };
