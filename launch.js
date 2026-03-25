/**
 * launch.js — Development launcher
 *
 * VS Code (and other Electron-based tools) set ELECTRON_RUN_AS_NODE=1 in
 * their environment. This variable causes the Electron binary to run as plain
 * Node.js with no GUI, no Chromium, and no built-in Electron APIs.
 *
 * This script DELETES the variable before spawning the Electron binary,
 * ensuring Electron starts in normal app mode regardless of the parent
 * process environment.
 *
 * Usage: node launch.js  (via `npm start`)
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Delete the problematic variable before spawning
delete process.env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron'); // returns the binary path
const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: process.env,      // pass the cleaned env
  windowsHide: false,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
