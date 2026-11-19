// Tests that generateMeetingSummary prefers the user's selected Antigravity model
// ahead of Codex CLI (instead of waiting 60s on a Codex CLI timeout first), while
// preserving Codex-first ordering for non-Antigravity selections and full fallback.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const cjs = createRequire(path.join(root, 'package.json'));

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-oauth-order-'));
const electronStub = new Module('electron');
electronStub.exports = {
  app: { isReady: () => true, getPath: (n) => (n === 'userData' ? tmpUserData : os.tmpdir()), getAppPath: () => root, getName: () => 'natively-test', getVersion: () => '0.0.0-test', isPackaged: false, on: () => {} },
  shell: { openPath: async () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: async () => [] },
  net: { isOnline: () => true },
};
electronStub.loaded = true;
cjs.cache[cjs.resolve('electron')] = electronStub;
const { LLMHelper } = cjs(path.join(root, 'dist-electron/electron/LLMHelper.js'));

const helpers = [];
function createTestHelper() {
  const h = new LLMHelper(undefined, false);
  helpers.push(h);
  return h;
}

after(() => {
  for (const h of helpers) {
    try { h.scrubKeys(); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Summary OAuth provider ordering', () => {
  test('resolveSummaryOAuthOrder puts antigravity first only when an antigravity model is active', () => {
    assert.deepEqual(LLMHelper.resolveSummaryOAuthOrder('antigravity:gemini-4-hydrogen'), ['antigravity', 'codex']);
    assert.deepEqual(LLMHelper.resolveSummaryOAuthOrder('gpt-5.6-luna'), ['codex', 'antigravity']);
    assert.deepEqual(LLMHelper.resolveSummaryOAuthOrder(null), ['codex', 'antigravity']);
    assert.deepEqual(LLMHelper.resolveSummaryOAuthOrder(''), ['codex', 'antigravity']);
  });

  test('antigravity selected: tries Antigravity first and skips Codex when it succeeds', async () => {
    const h = createTestHelper();
    const calls = [];
    h.currentModelId = 'antigravity:gemini-4-hydrogen';
    h.hasNatively = () => false;
    h.isCodexAvailable = () => true;
    h.generateWithCodexCli = async () => { calls.push('codex'); return 'codex summary'; };
    h.antigravityFallbackModel = () => 'gemini-4-hydrogen';
    h.streamWithAntigravity = async function* () { calls.push('antigravity'); yield 'antigravity summary'; };

    const out = await h.generateMeetingSummary('Summarise.', 'Alex: shipped feature A.');
    assert.match(out, /antigravity summary/);
    assert.deepEqual(calls, ['antigravity']);
  });

  test('antigravity selected but fails: falls back cleanly to Codex', async () => {
    const h = createTestHelper();
    const calls = [];
    h.currentModelId = 'antigravity:gemini-4-hydrogen';
    h.hasNatively = () => false;
    h.isCodexAvailable = () => true;
    h.generateWithCodexCli = async () => { calls.push('codex'); return 'codex fallback summary'; };
    h.antigravityFallbackModel = () => 'gemini-4-hydrogen';
    h.streamWithAntigravity = async function* () { calls.push('antigravity'); throw new Error('ag unavailable'); };

    const out = await h.generateMeetingSummary('Summarise.', 'Alex: shipped feature A.');
    assert.match(out, /codex fallback summary/);
    assert.deepEqual(calls, ['antigravity', 'codex']);
  });

  test('non-antigravity selected: keeps Codex CLI ahead of Antigravity', async () => {
    const h = createTestHelper();
    const calls = [];
    h.currentModelId = 'gpt-5.6-luna';
    h.hasNatively = () => false;
    h.isCodexAvailable = () => true;
    h.generateWithCodexCli = async () => { calls.push('codex'); return 'codex primary summary'; };
    h.antigravityFallbackModel = () => 'gemini-4-hydrogen';
    h.streamWithAntigravity = async function* () { calls.push('antigravity'); yield 'antigravity fallback'; };

    const out = await h.generateMeetingSummary('Summarise.', 'Alex: shipped feature A.');
    assert.match(out, /codex primary summary/);
    assert.deepEqual(calls, ['codex']);
  });
});
