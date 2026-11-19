// Regression test for "Natively won't open when clicking app icon / Spotlight in macOS undetectable mode".
//
// Root cause: when undetectable mode hides Dock & Tray icons, clicking Natively.app
// triggers `activate` (or `second-instance`). Previously `activate` only called
// `toggleMainWindow()` when `!appState.isVisible()`, doing nothing if the launcher was
// already visible behind another window (and calling showInactive() otherwise), while
// `centerAndShowWindow()` passed `inactive=true` in undetectable mode. On macOS
// accessory policy (`app.dock.hide()`), `showInactive()` / `focus()` alone leaves the
// launcher buried beneath the active foreground app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.resolve(__dirname, '../../../electron/main.ts'), 'utf8');
const whSource = readFileSync(path.resolve(__dirname, '../../../electron/WindowHelper.ts'), 'utf8');

function extractMethodBody(source, signatureNeedle) {
  const idx = source.indexOf(signatureNeedle);
  assert.ok(idx >= 0, `could not locate ${signatureNeedle}`);
  let i = source.indexOf('{', idx);
  assert.ok(i >= 0, `no brace after ${signatureNeedle}`);
  i++;
  let depth = 1;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces for ${signatureNeedle}`);
  return source.slice(start, i - 1);
}

test('activate delegates existing windows to presentExistingWindow and requests raise on recreate', () => {
  const body = extractMethodBody(mainSource, 'app.on("activate"');
  assert.match(body, /reassertUndetectableStealth\s*\(/);
  assert.match(body, /requestRaiseOnReady\s*\(/);
  assert.match(body, /presentExistingWindow\s*\(/);
  assert.doesNotMatch(body, /if\s*\(\s*!appState\.isVisible\(\)\s*\)/);
});

test('presentExistingWindow raises launcher unconditionally while keeping overlay stealth-safe', () => {
  const body = extractMethodBody(mainSource, 'public presentExistingWindow(');
  assert.match(body, /getCurrentWindowMode\(\)\s*===\s*'overlay'/);
  assert.match(body, /this\.windowHelper\.raiseLauncherWindow\(false\)/);
});

test('centerAndShowWindow raises launcher on explicit show in launcher mode', () => {
  const body = extractMethodBody(whSource, 'public centerAndShowWindow(');
  assert.match(body, /this\.switchToOverlay\(/);
  assert.match(body, /this\.raiseLauncherWindow\(true\)/);
});

test('raiseLauncherWindow restores, brings to front, focuses, and re-asserts stealth afterward', () => {
  const raiseBody = extractMethodBody(whSource, 'public raiseLauncherWindow(');
  const focusHelperBody = extractMethodBody(whSource, 'private focusAndRaiseWindow(');
  const focusIdx = focusHelperBody.search(/app\.focus\(\s*\{\s*steal:\s*true\s*\}\s*\)/);
  const moveTopIdx = focusHelperBody.search(/win\.moveTop\(\s*\)/);
  const winFocusIdx = focusHelperBody.search(/win\.focus\(\s*\)/);

  assert.match(raiseBody, /win\.isMinimized\(\)/);
  assert.match(raiseBody, /win\.restore\(\)/);
  assert.match(raiseBody, /this\.focusAndRaiseWindow\(win\)/);
  assert.ok(focusIdx >= 0 && moveTopIdx > focusIdx && winFocusIdx > moveTopIdx, 'must focus app, raise window, and focus window');
  assert.ok(
    raiseBody.indexOf('reassertUndetectableStealth') > raiseBody.indexOf('focusAndRaiseWindow(win)'),
    'must re-assert undetectable stealth after raising so Dock stays hidden',
  );
  assert.match(raiseBody, /setTimeout\(/, 'must re-focus once after accessory transition settles if needed');
});
