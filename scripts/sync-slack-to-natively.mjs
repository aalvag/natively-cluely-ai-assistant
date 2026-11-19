#!/usr/bin/env node
/**
 * Sync recent Slack messages and active threads from configured channels into Natively's
 * local Slack Brain Markdown digest and Team Meet's `mode_reference_files`.
 *
 * Run with Electron's Node ABI so better-sqlite3 loads cleanly:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/sync-slack-to-natively.mjs [--from-json snapshot.json] [--dry-run]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const bridge = require(path.join(REPO, 'dist-electron/electron/services/knowledge/slackBrainBridge.js'));

const MAX_THREADS_PER_CHANNEL = 6;

function parseChannelsSpec(spec) {
  if (!spec || !spec.trim()) return null;
  const parsed = [];
  for (const rawItem of spec.split(',')) {
    const item = rawItem.trim();
    if (!item) continue;
    const colonIdx = item.indexOf(':');
    if (colonIdx > 0) {
      parsed.push({
        id: item.slice(0, colonIdx).trim(),
        name: item.slice(colonIdx + 1).trim().replace(/^#/, ''),
        maxMessages: 10,
        includeThreads: true,
      });
    } else {
      parsed.push({
        id: item,
        name: item,
        maxMessages: 10,
        includeThreads: true,
      });
    }
  }
  return parsed.length > 0 ? parsed : null;
}

function parseArgs(argv) {
  const defaultUserData = path.join(os.homedir(), 'Library', 'Application Support', 'Natively');
  const opts = {
    fromJson: '',
    channelsSpec: process.env.NATIVELY_SLACK_CHANNELS || '',
    channelsFile: bridge.resolveSlackChannelsConfigPath(),
    hours: bridge.DEFAULT_SLACK_WINDOW_HOURS,
    dbPath: path.join(defaultUserData, 'natively.db'),
    outMd: path.join(defaultUserData, bridge.SLACK_BRAIN_DISK_FILENAME),
    tokenFile: path.join(os.homedir(), '.natively', 'slack.env'),
    noDb: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-json' && argv[i + 1]) opts.fromJson = path.resolve(argv[++i]);
    else if (arg === '--channels' && argv[i + 1]) opts.channelsSpec = String(argv[++i]);
    else if (arg === '--channels-file' && argv[i + 1]) opts.channelsFile = path.resolve(argv[++i]);
    else if (arg === '--hours' && argv[i + 1]) opts.hours = Math.max(1, Number(argv[++i]) || bridge.DEFAULT_SLACK_WINDOW_HOURS);
    else if (arg === '--db' && argv[i + 1]) opts.dbPath = path.resolve(argv[++i]);
    else if (arg === '--out-md' && argv[i + 1]) opts.outMd = path.resolve(argv[++i]);
    else if (arg === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (arg === '--no-db') opts.noDb = true;
    else if (arg === '--dry-run') opts.dryRun = true;
  }

  return opts;
}

function readSlackToken(tokenFile) {
  const direct = (process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN || '').trim();
  if (direct) return direct;

  if (tokenFile && fs.existsSync(tokenFile)) {
    const raw = fs.readFileSync(tokenFile, 'utf8');
    const envMap = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envMap[key] = val;
    }
    const fromFile = (envMap.SLACK_USER_TOKEN || envMap.SLACK_BOT_TOKEN || '').trim();
    if (fromFile) return fromFile;
  }

  return '';
}

async function slackApiGet(endpoint, params, token) {
  const url = new URL(`https://slack.com/api/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status} on ${endpoint}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error on ${endpoint}: ${data.error || 'unknown_error'}`);
  }
  return data;
}

function collectReferencedUserIds(channels) {
  const ids = new Set();
  const mentionRe = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/gi;

  const inspectMessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.user === 'string' && /^U[A-Z0-9]+$/i.test(msg.user)) {
      ids.add(msg.user);
    }
    const textSources = [msg.text || ''];
    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        if (att?.text) textSources.push(att.text);
        if (att?.fallback) textSources.push(att.fallback);
      }
    }
    for (const src of textSources) {
      for (const match of src.matchAll(mentionRe)) {
        ids.add(match[1]);
      }
    }
    if (Array.isArray(msg.replies)) {
      for (const r of msg.replies) inspectMessage(r);
    }
  };

  for (const ch of channels) {
    for (const m of ch.messages || []) {
      inspectMessage(m);
    }
  }
  return Array.from(ids);
}

async function resolveUsersFromApi(userIds, token, existingMap = {}) {
  const userMap = { ...existingMap };
  for (const uid of userIds) {
    if (userMap[uid]) continue;
    try {
      const data = await slackApiGet('users.info', { user: uid }, token);
      const profile = data.user?.profile || {};
      const displayName =
        profile.display_name ||
        profile.real_name ||
        data.user?.real_name ||
        data.user?.name;
      if (displayName && String(displayName).trim()) {
        userMap[uid] = String(displayName).trim();
      }
    } catch {
      // Best-effort user lookup; keep raw @U... fallback on permission/rate error.
    }
  }
  return userMap;
}

async function fetchSnapshotFromSlackApi(channels, hours, token) {
  const nowMs = Date.now();
  const oldestSec = Math.floor((nowMs - hours * 3_600_000) / 1000);
  const snapshots = [];

  for (const ch of channels) {
    const limit = Math.max(20, (ch.maxMessages ?? 10) * 3);
    const history = await slackApiGet(
      'conversations.history',
      { channel: ch.id, oldest: oldestSec, limit },
      token,
    );
    const messages = Array.isArray(history.messages) ? history.messages : [];

    if (ch.includeThreads !== false) {
      let fetchedThreads = 0;
      for (const msg of messages) {
        if (fetchedThreads >= MAX_THREADS_PER_CHANNEL) break;
        if ((msg.reply_count || 0) <= 0 || !msg.ts) continue;
        try {
          const thread = await slackApiGet(
            'conversations.replies',
            { channel: ch.id, ts: msg.thread_ts || msg.ts, limit: 15 },
            token,
          );
          msg.replies = Array.isArray(thread.messages) ? thread.messages : [];
          fetchedThreads++;
        } catch (err) {
          console.warn(`[Slack] Thread fetch skipped for #${ch.name} (${msg.ts}): ${err.message}`);
        }
      }
    }

    snapshots.push({ id: ch.id, name: ch.name, messages });
  }

  const userIds = collectReferencedUserIds(snapshots);
  const userMap = await resolveUsersFromApi(userIds, token);

  return {
    generatedAtIso: new Date(nowMs).toISOString(),
    nowMs,
    userMap,
    channels: snapshots,
  };
}

function writeFileAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function upsertSlackBrainInDatabase(dbPath, markdown) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Natively database not found at ${dbPath}`);
  }
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const teamMeet = db
      .prepare(
        `SELECT id, name FROM modes
         WHERE template_type = 'team-meet' OR name = 'Team Meet'
         LIMIT 1`,
      )
      .get();

    if (!teamMeet) {
      throw new Error('Team Meet mode not found in natively.db');
    }

    const existing = db
      .prepare(
        `SELECT id, content FROM mode_reference_files
         WHERE mode_id = ? AND file_name = ?`,
      )
      .all(teamMeet.id, bridge.SLACK_BRAIN_REF_FILENAME);

    if (existing.length === 1 && String(existing[0].content || '').trim() === markdown.trim()) {
      return { status: 'unchanged', modeId: teamMeet.id, fileId: existing[0].id };
    }

    const newFileId = `ref_${crypto.randomUUID()}`;
    const applyUpsert = db.transaction(() => {
      for (const stale of existing) {
        db.prepare('DELETE FROM mode_reference_chunks WHERE file_id = ?').run(stale.id);
        db.prepare('DELETE FROM mode_reference_index_state WHERE file_id = ?').run(stale.id);
        db.prepare('DELETE FROM mode_reference_files WHERE id = ?').run(stale.id);
      }
      db.prepare(
        `INSERT INTO mode_reference_files (id, mode_id, file_name, content)
         VALUES (?, ?, ?, ?)`,
      ).run(newFileId, teamMeet.id, bridge.SLACK_BRAIN_REF_FILENAME, markdown);
    });

    applyUpsert();
    return {
      status: existing.length > 0 ? 'updated' : 'inserted',
      modeId: teamMeet.id,
      fileId: newFileId,
      replacedCount: existing.length,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fromCliOrEnv = parseChannelsSpec(opts.channelsSpec);
  const fromFile = fromCliOrEnv ? [] : bridge.loadSlackChannelsConfig(opts.channelsFile);
  const channelConfigs = fromCliOrEnv || (fromFile.length > 0 ? fromFile : bridge.DEFAULT_SLACK_CHANNELS);
  const configById = new Map(channelConfigs.map((c) => [c.id, c]));

  let snapshot;
  if (opts.fromJson) {
    if (!fs.existsSync(opts.fromJson)) {
      console.error(`Snapshot JSON file not found: ${opts.fromJson}`);
      process.exit(1);
    }
    const parsed = JSON.parse(fs.readFileSync(opts.fromJson, 'utf8'));
    snapshot = {
      generatedAtIso: parsed.generatedAtIso || new Date().toISOString(),
      nowMs: parsed.nowMs || (parsed.generatedAtIso ? Date.parse(parsed.generatedAtIso) : Date.now()),
      userMap: parsed.userMap || {},
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
    };
  } else {
    if (channelConfigs.length === 0) {
      console.error(
        `No Slack channels configured.\nCreate ${opts.channelsFile} or pass --channels <id:name,...>.`,
      );
      process.exit(1);
    }
    const token = readSlackToken(opts.tokenFile);
    if (!token) {
      console.error(
        'Missing Slack API token.\n' +
          'Set SLACK_USER_TOKEN or SLACK_BOT_TOKEN in your environment or in ~/.natively/slack.env,\n' +
          'or run with --from-json <snapshot.json>.',
      );
      process.exit(1);
    }
    snapshot = await fetchSnapshotFromSlackApi(channelConfigs, opts.hours, token);
  }

  // Order channels according to channelConfigs when present, keeping any extra snapshot channels after.
  const orderIdx = new Map(channelConfigs.map((c, idx) => [c.id, idx]));
  const orderedChannels = [...snapshot.channels].sort((a, b) => {
    const ia = orderIdx.has(a.id) ? orderIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
    const ib = orderIdx.has(b.id) ? orderIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });

  const digests = orderedChannels.map((ch) => {
    const cfg = configById.get(ch.id);
    return bridge.normalizeSlackChannelSnapshot(ch, {
      nowMs: snapshot.nowMs,
      windowHours: opts.hours,
      maxMessages: cfg?.maxMessages ?? 10,
      userMap: snapshot.userMap,
      includeRegex: cfg?.includeRegex,
      excludeRegex: cfg?.excludeRegex,
      compactForms: cfg?.compactForms,
    });
  });

  const markdown = bridge.buildSlackBrainMarkdown(digests, {
    generatedAtIso: snapshot.generatedAtIso,
    windowHours: opts.hours,
  });

  const totalMessages = digests.reduce((sum, d) => sum + d.messages.length, 0);
  const totalReplies = digests.reduce(
    (sum, d) => sum + d.messages.reduce((rSum, m) => rSum + m.replies.length, 0),
    0,
  );

  if (!markdown) {
    console.log(`[SlackBrain] No messages found in the last ${opts.hours}h across ${digests.length} channels; skipping write.`);
    return;
  }

  console.log(
    `[SlackBrain] Built digest: channels=${digests.filter((d) => d.messages.length > 0).length}/${digests.length}, messages=${totalMessages}, replies=${totalReplies}, chars=${markdown.length}`,
  );

  if (opts.dryRun) {
    console.log('--- DRY RUN PREVIEW ---');
    console.log(markdown.slice(0, 1500));
    return;
  }

  writeFileAtomically(opts.outMd, markdown + '\n');
  console.log(`[Disk] Wrote ${opts.outMd}`);

  if (!opts.noDb) {
    const dbResult = upsertSlackBrainInDatabase(opts.dbPath, markdown);
    console.log(`[DB] ${dbResult.status}: file="${bridge.SLACK_BRAIN_REF_FILENAME}" mode=${dbResult.modeId} id=${dbResult.fileId}`);
  }
}

main().catch((err) => {
  console.error('[SlackBrain] Sync failed:', err?.message || err);
  process.exit(1);
});
