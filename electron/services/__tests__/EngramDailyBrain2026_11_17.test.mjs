import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);

const {
  isWorkDailyCandidate,
  isRunningUnderTest,
  formatMeetingForEngram,
  buildRollingDailyBrainMarkdown,
  saveMeetingToEngramAsync,
  syncSavedMeetingToDailyBrain,
} = require(path.join(REPO, 'dist-electron/electron/services/knowledge/engramBridge.js'));

const sampleSummary = {
  schemaVersion: 3,
  title: 'PR reviews, technical debt, and ReviewBot',
  tldr: ['Discussed PR blocks from unrelated technical debt.', 'Agreed to route tech debt tickets through Slack tagging Alex.'],
  decisions: [{ text: 'Use dedicated Slack channel for technical debt triage.', owner: 'Alex' }],
  whatChanged: [
    'Use dedicated Slack channel for technical debt triage.',
    'Store review hashes locally rather than in the repository.',
    'No transcript or previous output was provided, so no meeting events or decisions could be extracted.',
  ],
  actionItemsStructured: [
    { text: 'Update ReviewBot hash storage', owner: 'Sam', deadline: 'Friday' },
  ],
  risks: ['Permission gaps for Jira ticket creation.'],
  openQuestions: ['Which repo rolls out first?'],
  mode: { selectedModeName: 'Team Meet', selectedTemplateType: 'team-meet' },
};

test('isWorkDailyCandidate accepts Team Meet work sessions and filters out interviews and failed/empty runs', () => {
  assert.equal(
    isWorkDailyCandidate({
      id: 'm1',
      title: 'PR reviews, technical debt, and ReviewBot',
      summaryStatus: 'completed',
      detailedSummary: sampleSummary,
    }),
    true,
  );

  assert.equal(
    isWorkDailyCandidate({
      id: 'm2',
      title: 'Frontend/backend interview: Next.js',
      summaryStatus: 'completed',
      detailedSummary: {
        ...sampleSummary,
        mode: { selectedModeName: 'Technical Interview', selectedTemplateType: 'technical-interview' },
      },
    }),
    false,
  );

  assert.equal(
    isWorkDailyCandidate({
      id: 'm3',
      title: 'Untitled Session',
      summaryStatus: 'failed',
      detailedSummary: sampleSummary,
    }),
    false,
  );
});

test('formatMeetingForEngram extracts TLDR, decisions, owners, and stable topic key', () => {
  const formatted = formatMeetingForEngram({
    id: 'abc-123',
    title: 'Daily Frontend',
    date: '2026-11-17T13:00:00.000Z',
    detailedSummary: sampleSummary,
    userNotes: 'Check Zod PR before noon',
  });

  assert.equal(formatted.topicKey, 'natively-meeting-abc-123');
  assert.match(formatted.content, /## Summary/);
  assert.match(formatted.content, /## Decisions/);
  assert.equal(formatted.decisions.filter((d) => d.includes('dedicated Slack channel')).length, 1);
  assert.ok(formatted.decisions[0].includes('(Alex)'));
  assert.ok(!formatted.decisions.some((d) => /No transcript or previous output/i.test(d)));
  assert.match(formatted.content, /Update ReviewBot hash storage \(Sam · Friday\)/);
  assert.match(formatted.content, /Check Zod PR before noon/);

  const md = buildRollingDailyBrainMarkdown([formatted], 5);
  assert.match(md, /# Daily Brain/);
  assert.match(md, /\[2026-11-17\] Daily Frontend/);
});

test('saveMeetingToEngramAsync degrades cleanly when engram binary is unavailable', async () => {
  const formatted = formatMeetingForEngram({
    id: 'no-bin',
    title: 'Daily Sync',
    date: '2026-11-17T13:00:00.000Z',
    detailedSummary: sampleSummary,
  });
  const res = await saveMeetingToEngramAsync(formatted, { engramBin: null });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test('isRunningUnderTest prevents test runs from writing into real ~/.engram/engram.db', async () => {
  assert.equal(isRunningUnderTest(), true);
  const formatted = formatMeetingForEngram({
    id: 'test-guard-check',
    title: '1:1 with Priya',
    date: '2026-11-18T13:00:00.000Z',
    detailedSummary: sampleSummary,
  });
  const res = await saveMeetingToEngramAsync(formatted);
  assert.equal(res.ok, false);
  assert.match(res.error, /test environment/);

  await syncSavedMeetingToDailyBrain({
    id: 'test-guard-sync',
    title: '1:1 with Priya',
    date: '2026-11-18T13:00:00.000Z',
    summaryStatus: 'completed',
    detailedSummary: sampleSummary,
  });
});
