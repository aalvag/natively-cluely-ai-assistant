import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);

const {
  CODEGRAPH_REF_PREFIX,
  LEGACY_GITNEXUS_REF_PREFIX,
  buildAugmentedEnv,
  extractQueryTerms,
  parseMcpReferenceMarker,
  rankReposForMessage,
  selectMcpBackend,
  McpClientManager,
} = require(path.join(REPO, 'dist-electron/electron/mcp/McpClientManager.js'));

test('parseMcpReferenceMarker recognizes both CodeGraph and legacy GitNexus markers', () => {
  assert.deepEqual(
    parseMcpReferenceMarker({ content: `${CODEGRAPH_REF_PREFIX}/Users/dev/demo-web` }),
    { backendHint: 'codegraph', repoPath: '/Users/dev/demo-web' },
  );
  assert.deepEqual(
    parseMcpReferenceMarker({ content: `${LEGACY_GITNEXUS_REF_PREFIX}/Users/dev/legacy` }),
    { backendHint: 'gitnexus', repoPath: '/Users/dev/legacy' },
  );
  assert.equal(parseMcpReferenceMarker({ content: 'ordinary markdown notes' }), null);
});

test('selectMcpBackend picks codegraph when binary exists and .codegraph or no .gitnexus is present', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-'));
  const fakeBin = path.join(tmpRoot, 'codegraph');
  fs.writeFileSync(fakeBin, '#!/bin/sh\n');
  const prev = process.env.NATIVELY_CODEGRAPH_BIN;
  process.env.NATIVELY_CODEGRAPH_BIN = fakeBin;

  try {
    const repo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    const picked = selectMcpBackend(repo);
    assert.equal(picked.backend, 'codegraph');
    assert.equal(picked.command, fakeBin);
    assert.deepEqual(picked.args, ['serve', '--mcp', '--no-watch', '--path', repo]);

    // Legacy .gitnexus-only repo without .codegraph respects gitnexus hint
    const legacyRepo = path.join(tmpRoot, 'legacy');
    fs.mkdirSync(path.join(legacyRepo, '.gitnexus'), { recursive: true });
    const legacyPicked = selectMcpBackend(legacyRepo, 'gitnexus');
    assert.equal(legacyPicked.backend, 'gitnexus');
  } finally {
    if (prev === undefined) delete process.env.NATIVELY_CODEGRAPH_BIN;
    else process.env.NATIVELY_CODEGRAPH_BIN = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('buildAugmentedEnv includes ~/.local/bin and Homebrew for packaged macOS GUI launches', () => {
  const env = buildAugmentedEnv();
  assert.ok(env.PATH.includes(path.join(os.homedir(), '.local', 'bin')));
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
});

test('extractQueryTerms strips conversational stopwords and keeps domain identifiers', () => {
  const terms = extractQueryTerms('¿Cómo funciona passkeys authentication en demo-web?');
  assert.ok(terms.includes('passkeys'));
  assert.ok(terms.includes('authentication'));
  assert.ok(terms.includes('demo-web'));
  assert.ok(!terms.includes('como'));
});

test('rankReposForMessage prioritizes matching repository names and preserves order on ties', () => {
  const repos = ['/Users/dev/demo-web', '/Users/dev/demo-admin', '/Users/dev/demo-api'];

  assert.deepEqual(rankReposForMessage(repos, 'where is the backoffice approval route in admin?'), [
    '/Users/dev/demo-admin',
    '/Users/dev/demo-web',
    '/Users/dev/demo-api',
  ]);
  assert.deepEqual(rankReposForMessage(repos, 'check the web checkout component'), [
    '/Users/dev/demo-web',
    '/Users/dev/demo-admin',
    '/Users/dev/demo-api',
  ]);
  assert.deepEqual(rankReposForMessage(repos, 'how are sessions validated?'), repos);
});

test('McpClientManager.resolveMcpContext calls codegraph_context and formats bounded output', async () => {
  const mgr = new McpClientManager();
  mgr.repoPath = '/Users/dev/demo-web';
  mgr.client = {
    async listTools() {
      return { tools: [{ name: 'codegraph_context' }, { name: 'codegraph_search' }] };
    },
    async callTool({ name, arguments: args }) {
      if (name === 'codegraph_context') {
        assert.equal(args.task, 'where is passkey login handled?');
        return { content: [{ type: 'text', text: '## Code Context\n- usePasskeyLoginButton' }] };
      }
      return { content: [] };
    },
  };

  const ctx = await mgr.resolveMcpContext('where is passkey login handled?');
  assert.match(ctx, /via CodeGraph MCP: demo-web/);
  assert.match(ctx, /usePasskeyLoginButton/);
});

test('McpClientManager.resolveMcpContext queries multiple linked servers in parallel and merges bounded context', async () => {
  const mgr = new McpClientManager();
  const makeMockClient = (symbol) => ({
    async listTools() {
      return { tools: [{ name: 'codegraph_context' }] };
    },
    async callTool() {
      return { content: [{ type: 'text', text: `## Code Context\n- ${symbol}` }] };
    },
  });

  mgr.servers.set('/Users/dev/demo-web', {
    repoPath: '/Users/dev/demo-web',
    backend: 'codegraph',
    client: makeMockClient('useWebOnboarding'),
    transport: { async close() {} },
  });
  mgr.servers.set('/Users/dev/demo-admin', {
    repoPath: '/Users/dev/demo-admin',
    backend: 'codegraph',
    client: makeMockClient('AdminApprovalModal'),
    transport: { async close() {} },
  });

  const ctx = await mgr.resolveMcpContext('where does admin approve web onboarding?');
  assert.match(ctx, /via CodeGraph MCP: demo-web/);
  assert.match(ctx, /useWebOnboarding/);
  assert.match(ctx, /via CodeGraph MCP: demo-admin/);
  assert.match(ctx, /AdminApprovalModal/);
  assert.ok(ctx.length <= 6000);
});
