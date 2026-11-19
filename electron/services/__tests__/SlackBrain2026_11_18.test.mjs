import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const {
  SLACK_BRAIN_REF_FILENAME,
  cleanSlackText,
  compactStructuredSlackText,
  isNoiseSlackMessage,
  loadSlackChannelsConfig,
  normalizeSlackChannelSnapshot,
  buildSlackBrainMarkdown,
  syncSlackBrainFromDiskIntoTeamMeet,
} = require(path.join(REPO, 'dist-electron/electron/services/knowledge/slackBrainBridge.js'));

test('cleanSlackText resolves mentions, mailto links, channel tags, AWS/Slack list URLs, and entities', () => {
  const userMap = { U123ABC: 'Alex Rivera', U999XYZ: 'Sam Lee' };
  const raw =
    'PR by <mailto:alex@example.com|alex@example.com> &amp; <@U123ABC> ' +
    'reviewed by <@U999XYZ|sam> in <#C01EXAMPLE1|eng-pr-analysis> ' +
    '<!here> <https://acme.slack.com/lists/T01/F01?record_id=123> ' +
    '<https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo-web/pull-requests/101> ' +
    '<https://us-east-1.console.aws.amazon.com/codebuild/home?region=us-east-1#/builds/ci:123/view/new> ' +
    '<https://git.example.com/demo/pull-requests/101|PR #101> &lt;ok&gt;';

  const cleaned = cleanSlackText(raw, userMap);
  assert.equal(
    cleaned,
    'PR by alex@example.com & Alex Rivera reviewed by Sam Lee in #eng-pr-analysis @here [Slack List] PR #101 [CodeBuild] PR #101 <ok>',
  );
});

test('isNoiseSlackMessage filters membership events and empty USLACKBOT messages while preserving attachment alerts', () => {
  assert.equal(isNoiseSlackMessage({ ts: '1', subtype: 'channel_join', text: '<@U1> joined' }), true);
  assert.equal(isNoiseSlackMessage({ ts: '2', subtype: 'channel_leave', text: '<@U1> left' }), true);
  assert.equal(isNoiseSlackMessage({ ts: '3', user: 'USLACKBOT', text: '   ' }), true);
  assert.equal(
    isNoiseSlackMessage({
      ts: '4',
      bot_id: 'B1',
      text: '',
      attachments: [{ fallback: 'Build failed on release branch' }],
    }),
    false,
  );
  assert.equal(isNoiseSlackMessage({ ts: '5', user: 'U1', text: 'Deploy completed' }), false);
});

test('compactStructuredSlackText extracts title, platform, and flow from incident and support forms without client email PII', () => {
  const incidentRaw =
    ':ladybug: *Reportar incidentes - Automatizado (vía n8n)* *¿A qué equipo perteneces?* Tecnología ' +
    '*Plataforma* Web B2B *¿Flujo de negocio afectado?* Flujo Onboarding *Impacto* Economico ' +
    '*Categoría:* Funcional *Frecuencia* Siempre *Cantidad de Usuarios afectados* Más de 31 ' +
    '*Título (Resumen de lo que sería el incidente)* Token expiration screen shown on valid login';

  assert.equal(
    compactStructuredSlackText(incidentRaw),
    '[Incidente · Web B2B / Flujo Onboarding] Token expiration screen shown on valid login',
  );

  const supportRaw =
    'Pat Chen ha enviado *Reporte de consultas*. :white_check_mark: *Validación/Datos del cliente* ' +
    '• *¿Se validó en ADMIN?:* Si • *ID Cliente/ID Interno:* 999111 ' +
    '• *Correo principal:* customer.pii@example.com • *Correo usuario afectado:* customer.pii@example.com ' +
    ':page_facing_up: *Detalle* *Título* Company cannot complete registration ' +
    '*Descripción del problema* Redirects back to login without activation email ' +
    ':open_file_folder: *Caso* • *Número de caso:* 1 • *Flujo de negocio afectado:* Flujo Onboarding • *Plataforma:* Web B2B';

  const compactedSupport = compactStructuredSlackText(supportRaw);
  assert.equal(
    compactedSupport,
    '[Soporte · Web B2B / Flujo Onboarding] Company cannot complete registration — Redirects back to login without activation email',
  );
  assert.doesNotMatch(compactedSupport, /customer\.pii@example\.com/);
});

test('normalizeSlackChannelSnapshot enforces window, newest-first order, regex filters, dedupe, and thread cap', () => {
  const nowSec = 1_795_050_000;
  const nowMs = nowSec * 1000;
  const userMap = { U1: 'Alex', U2: 'Pat', U3: 'Sam' };

  const snapshot = {
    id: 'C01EXAMPLE1',
    name: 'eng-pr-analysis',
    messages: [
      { ts: String(nowSec - 50 * 3600), user: 'U1', text: 'Old message outside window' },
      { ts: String(nowSec - 100), subtype: 'channel_join', user: 'U2', text: '<@U2> joined' },
      { ts: String(nowSec - 90), user: 'USLACKBOT', text: '' },
      {
        ts: String(nowSec - 3600),
        bot_id: 'B_STATUS',
        text: 'PR status update. Owner: <@U2> State: Deployed <https://acme.slack.com/lists/T1/F1?record_id=1>',
      },
      {
        ts: String(nowSec - 1800),
        bot_id: 'B_STATUS',
        text: 'PR status update. Owner: <@U2> State: Deployed <https://acme.slack.com/lists/T1/F1?record_id=2>',
      },
      {
        ts: String(nowSec - 600),
        user: 'U1',
        text: 'A'.repeat(400),
        replies: [
          { ts: String(nowSec - 600), user: 'U1', text: 'Parent duplicated in replies' },
          { ts: String(nowSec - 500), user: 'U2', text: 'First reply (dropped by maxReplies=2)' },
          { ts: String(nowSec - 400), user: 'U3', text: 'Second reply kept' },
          { ts: String(nowSec - 300), user: 'U1', text: 'B'.repeat(260) },
        ],
      },
    ],
  };

  const digest = normalizeSlackChannelSnapshot(snapshot, {
    nowMs,
    windowHours: 48,
    maxMessages: 10,
    maxRepliesPerThread: 2,
    userMap,
    tzOffsetMinutes: -180,
  });

  assert.equal(digest.messages.length, 2);
  assert.equal(digest.messages[0].author, 'Alex');
  assert.ok(digest.messages[0].text.length <= 320);
  assert.ok(digest.messages[0].text.endsWith('…'));
  assert.equal(digest.messages[0].replies.length, 2);
  assert.equal(digest.messages[0].replies[0].author, 'Sam');
  assert.equal(digest.messages[0].replies[0].text, 'Second reply kept');
  assert.ok(digest.messages[0].replies[1].text.length <= 220);
  assert.ok(digest.messages[0].replies[1].text.endsWith('…'));
  assert.equal(digest.messages[1].ts, String(nowSec - 1800));

  // Verify includeRegex / excludeRegex filtering against author + cleaned body
  const supportSnapshot = {
    id: 'C01EXAMPLE2',
    name: 'support-triage',
    messages: [
      {
        ts: String(nowSec - 200),
        username: 'Soporte B2C',
        text: '<@U1> ha enviado *Reporte de consultas*. • *Versión del app instalada:* 5.28.0',
      },
      {
        ts: String(nowSec - 150),
        username: 'Soporte B2B',
        text: '<@U2> ha enviado *Reporte de consultas*. *Título* Token failure *Plataforma:* Web B2B',
      },
    ],
  };
  const filtered = normalizeSlackChannelSnapshot(supportSnapshot, {
    nowMs,
    includeRegex: 'Soporte B2B|Web B2B',
    excludeRegex: 'Soporte B2C.*Versión del app instalada',
  });
  assert.equal(filtered.messages.length, 1);
  assert.equal(filtered.messages[0].author, 'Soporte B2B');
  assert.match(filtered.messages[0].text, /\[Soporte · Web B2B\] Token failure/);
});

test('loadSlackChannelsConfig reads valid JSON config and returns empty array when missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cfg-'));
  const cfgPath = path.join(tmpDir, 'slack-channels.json');
  try {
    assert.deepEqual(loadSlackChannelsConfig(cfgPath), []);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        channels: [
          { id: 'C01EXAMPLE1', name: '#eng-pr-analysis', maxMessages: 12, includeThreads: true },
          { id: '', name: 'invalid' },
        ],
      }),
      'utf8',
    );
    const loaded = loadSlackChannelsConfig(cfgPath);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'C01EXAMPLE1');
    assert.equal(loaded[0].name, 'eng-pr-analysis');
    assert.equal(loaded[0].maxMessages, 12);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildSlackBrainMarkdown formats channels and replies cleanly while respecting maxChars', () => {
  const digests = [
    { id: 'C1', name: 'empty-channel', messages: [] },
    {
      id: 'C2',
      name: 'incident-room',
      messages: [
        {
          ts: '1795040000',
          timestampLabel: '11-18 17:00',
          author: 'Alex',
          text: 'reCAPTCHA v3 verified on mobile and web',
          replies: [{ ts: '1795040100', timestampLabel: '11-18 17:01', author: 'Sam', text: 'Confirmed in prod' }],
        },
        {
          ts: '1795039000',
          timestampLabel: '11-18 16:40',
          author: 'Pat',
          text: 'X'.repeat(400),
          replies: [],
        },
      ],
    },
  ];

  const fullMd = buildSlackBrainMarkdown(digests, {
    generatedAtIso: '2026-11-18T22:00:00Z',
    windowHours: 48,
  });
  assert.match(fullMd, /^# Slack Brain — Actividad Reciente \(Últimas 48h\)/);
  assert.match(fullMd, /## #incident-room/);
  assert.doesNotMatch(fullMd, /#empty-channel/);
  assert.match(fullMd, /↳ \*\*Sam:\*\* Confirmed in prod/);

  const boundedMd = buildSlackBrainMarkdown(digests, {
    generatedAtIso: '2026-11-18T22:00:00Z',
    windowHours: 48,
    maxChars: 340,
  });
  assert.ok(boundedMd.length <= 340);
  assert.match(boundedMd, /Confirmed in prod/);
});

test('syncSlackBrainFromDiskIntoTeamMeet skips safely when running under test', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-brain-guard-'));
  const mdPath = path.join(tmpDir, 'slack-brain-latest.md');
  fs.writeFileSync(mdPath, '# Slack Brain\n- [11-18 17:00] **Alex:** Test', 'utf8');
  try {
    const updated = await syncSlackBrainFromDiskIntoTeamMeet({ markdownPath: mdPath });
    assert.equal(updated, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sync-slack-to-natively CLI writes markdown, is idempotent, and cleans stale index rows on update', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-brain-cli-'));
  const dbPath = path.join(tmpDir, 'natively.db');
  const outMdPath = path.join(tmpDir, 'slack-brain-latest.md');
  const snapPath = path.join(tmpDir, 'snapshot.json');
  const channelsPath = path.join(tmpDir, 'slack-channels.json');

  fs.writeFileSync(
    channelsPath,
    JSON.stringify([{ id: 'C01EXAMPLE1', name: 'eng-pr-analysis', maxMessages: 10, includeThreads: true }]),
    'utf8',
  );

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE modes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_type TEXT
    );
    CREATE TABLE mode_reference_files (
      id TEXT PRIMARY KEY,
      mode_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      page_count INTEGER,
      extracted_page_count INTEGER,
      FOREIGN KEY(mode_id) REFERENCES modes(id) ON DELETE CASCADE
    );
    CREATE TABLE mode_reference_index_state (
      file_id TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      embedding_space TEXT,
      embedded_chunk_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE mode_reference_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      embedding_space TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(file_id, chunk_index)
    );
    INSERT INTO modes (id, name, template_type) VALUES ('mode_team_meet', 'Team Meet', 'team-meet');
  `);
  db.close();

  const nowSec = 1_795_050_000;
  const runCli = () =>
    execFileSync(
      path.join(REPO, 'node_modules/.bin/electron'),
      [
        path.join(REPO, 'scripts/sync-slack-to-natively.mjs'),
        '--from-json',
        snapPath,
        '--channels-file',
        channelsPath,
        '--db',
        dbPath,
        '--out-md',
        outMdPath,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
      },
    );

  try {
    const snap1 = {
      generatedAtIso: '2026-11-18T22:00:00.000Z',
      nowMs: nowSec * 1000,
      userMap: { U1: 'Alex Rivera' },
      channels: [
        {
          id: 'C01EXAMPLE1',
          name: 'eng-pr-analysis',
          messages: [
            { ts: String(nowSec - 300), user: 'U1', text: 'PR merged for PROJ-101' },
          ],
        },
      ],
    };
    fs.writeFileSync(snapPath, JSON.stringify(snap1), 'utf8');

    const out1 = runCli();
    assert.match(out1, /\[DB\] inserted:/);
    assert.equal(fs.existsSync(outMdPath), true);

    const checkDb = new Database(dbPath, { readonly: true });
    const rows1 = checkDb
      .prepare('SELECT id, content FROM mode_reference_files WHERE mode_id = ? AND file_name = ?')
      .all('mode_team_meet', SLACK_BRAIN_REF_FILENAME);
    checkDb.close();
    assert.equal(rows1.length, 1);
    assert.match(rows1[0].content, /PR merged for PROJ-101/);
    const firstId = rows1[0].id;

    const seedIdxDb = new Database(dbPath);
    seedIdxDb
      .prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status) VALUES (?, ?, ?, 1, ?)')
      .run(firstId, 'hash1', 12345, 'ready');
    seedIdxDb
      .prepare('INSERT INTO mode_reference_chunks (file_id, chunk_index, text, created_at) VALUES (?, 0, ?, 12345)')
      .run(firstId, 'chunk0');
    seedIdxDb.close();

    const out2 = runCli();
    assert.match(out2, /\[DB\] unchanged:/);
    const checkDb2 = new Database(dbPath, { readonly: true });
    const rows2 = checkDb2
      .prepare('SELECT id FROM mode_reference_files WHERE mode_id = ? AND file_name = ?')
      .all('mode_team_meet', SLACK_BRAIN_REF_FILENAME);
    checkDb2.close();
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].id, firstId);

    snap1.channels[0].messages.push({
      ts: String(nowSec - 120),
      user: 'U1',
      text: 'Second PR deployed to release',
    });
    fs.writeFileSync(snapPath, JSON.stringify(snap1), 'utf8');

    const out3 = runCli();
    assert.match(out3, /\[DB\] updated:/);

    const checkDb3 = new Database(dbPath, { readonly: true });
    const rows3 = checkDb3
      .prepare('SELECT id, content FROM mode_reference_files WHERE mode_id = ? AND file_name = ?')
      .all('mode_team_meet', SLACK_BRAIN_REF_FILENAME);
    const staleState = checkDb3
      .prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?')
      .all(firstId);
    const staleChunks = checkDb3
      .prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ?')
      .all(firstId);
    checkDb3.close();

    assert.equal(rows3.length, 1);
    assert.notEqual(rows3[0].id, firstId);
    assert.match(rows3[0].content, /Second PR deployed to release/);
    assert.equal(staleState.length, 0);
    assert.equal(staleChunks.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
