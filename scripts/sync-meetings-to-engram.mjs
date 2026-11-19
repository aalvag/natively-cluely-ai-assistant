#!/usr/bin/env node
/**
 * Sync historical work/Team-Meet meetings from Natively's natively.db into Engram
 * (`--project dailys` by default, idempotent per meeting via `--topic`).
 *
 * Run with Electron's Node ABI so better-sqlite3 loads cleanly:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/sync-meetings-to-engram.mjs [--dry-run] [--limit 60]
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const bridge = require(path.join(REPO, 'dist-electron/electron/services/knowledge/engramBridge.js'));

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    limit: 60,
    since: '',
    project: bridge.DAILY_BRAIN_ENGRAM_PROJECT,
    dbPath: path.join(os.homedir(), 'Library', 'Application Support', 'Natively', 'natively.db'),
    outMarkdown: path.join(os.homedir(), 'Library', 'Application Support', 'Natively', 'daily-brain-latest.md'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit' && argv[i + 1]) opts.limit = Math.max(1, Number(argv[++i]) || 60);
    else if (a === '--since' && argv[i + 1]) opts.since = String(argv[++i]);
    else if (a === '--project' && argv[i + 1]) opts.project = String(argv[++i]);
    else if (a === '--db' && argv[i + 1]) opts.dbPath = String(argv[++i]);
    else if (a === '--out-md' && argv[i + 1]) opts.outMarkdown = String(argv[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = new Database(opts.dbPath, { readonly: true });

  const rows = db
    .prepare(
      `SELECT id, title, created_at, summary_status, summary_json, user_notes
       FROM meetings
       WHERE (? = '' OR created_at >= ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(opts.since, opts.since, opts.limit);

  const entries = [];
  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    let detailedSummary;
    try {
      detailedSummary = JSON.parse(row.summary_json || '{}')?.detailedSummary;
    } catch {
      detailedSummary = undefined;
    }

    const input = {
      id: row.id,
      title: row.title,
      date: row.created_at,
      detailedSummary,
      userNotes: row.user_notes,
      summaryStatus: row.summary_status,
    };

    if (!bridge.isWorkDailyCandidate(input)) {
      skipped++;
      continue;
    }

    const formatted = bridge.formatMeetingForEngram(input);
    entries.push(formatted);

    if (opts.dryRun) {
      console.log(`[DRY-RUN] ${formatted.dateIso.slice(0, 10)} | ${formatted.title} -> topic=${formatted.topicKey}`);
      saved++;
      continue;
    }

    const res = await bridge.saveMeetingToEngramAsync(formatted, { project: opts.project });
    if (res.ok) {
      saved++;
      console.log(`[OK] ${formatted.dateIso.slice(0, 10)} | ${formatted.title}`);
    } else {
      failed++;
      console.warn(`[FAIL] ${formatted.title}: ${res.error}`);
    }
  }

  const fs = await import('node:fs');
  const digest = bridge.buildRollingDailyBrainMarkdown(entries);
  if (!opts.dryRun && entries.length > 0) {
    fs.writeFileSync(opts.outMarkdown, digest + '\n', 'utf8');
    console.log(`[Digest] Wrote ${Math.min(entries.length, 7)} recent dailys to ${opts.outMarkdown}`);
  }

  db.close();
  console.log(`Done: synced=${saved}, skipped=${skipped}, failed=${failed}, candidates=${entries.length}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
