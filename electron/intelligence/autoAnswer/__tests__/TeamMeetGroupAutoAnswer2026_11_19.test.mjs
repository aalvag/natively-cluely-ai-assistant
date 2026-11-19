// Group-meeting Auto-Answer policy for `team-meet`:
// - Passes modeTemplateType from main.ts to SimpleAutoAnswerEngine and AutoAnswerJudge.
// - Keeps 1-on-1 interview prompts byte-identical when modeTemplateType !== 'team-meet'.
// - In `team-meet`, always includes the USER's identity and recently addressed teammates
//   across recent turns (including Spanish/English standup handoffs), uses GROUP_MEETING_JUDGE_RULES,
//   gives the judge the full JUDGE_DEADLINE_MS, and fails silent on judge timeout/error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FakeClock } from './fakeClock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DIST = path.resolve(__dirname, '../../../../dist-electron/electron/intelligence/autoAnswer');
const {
  buildJudgePrompt,
  isGroupMeetingMode,
  recentAddressedOthers,
  JUDGE_DEADLINE_MS,
  JUDGE_PROMPT_RULES,
  GROUP_MEETING_JUDGE_RULES,
} = require(path.join(DIST, 'AutoAnswerJudge.js'));
const { SimpleAutoAnswerEngine, EARLY_JUDGE_MS, QUESTION_JUDGE_DEADLINE_MS } = require(path.join(DIST, 'SimpleAutoAnswer.js'));

const flush = () => new Promise((r) => setImmediate(r));

test('isGroupMeetingMode recognizes team-meet case-insensitively and rejects interview/empty modes', () => {
  assert.equal(isGroupMeetingMode('team-meet'), true);
  assert.equal(isGroupMeetingMode(' TEAM-MEET '), true);
  assert.equal(isGroupMeetingMode('technical-interview'), false);
  assert.equal(isGroupMeetingMode('general'), false);
  assert.equal(isGroupMeetingMode(null), false);
  assert.equal(isGroupMeetingMode(undefined), false);
});

test('non-team-meet judge prompts remain byte-identical with explicit modeTemplateType', () => {
  const base = {
    candidateText: 'Why did you choose PostgreSQL over a document store?',
    recentTurns: [{ role: 'interviewer', text: 'Let us talk about storage.', timestamp: 0 }],
    modeName: 'Technical Interview',
    questionId: 'q-int-1',
    userName: 'Alex Rivera',
  };
  const promptBase = buildJudgePrompt(base);
  const promptTyped = buildJudgePrompt({ ...base, modeTemplateType: 'technical-interview' });
  assert.equal(promptTyped, promptBase);
  assert.ok(promptBase.endsWith(JUDGE_PROMPT_RULES));
});

test('recentAddressedOthers detects English and Spanish standup handoffs and excludes USER and discourse words', () => {
  const texts = [
    'Bueno, perfecto. Vamos, Sam. Cuéntame cómo vas con el PR.',
    'Dale, Maya, revisaste eso? Gracias, Carlos.',
    'Alex, what about your ticket? Okay, team, let us continue.',
    'Entendido, staging sigue pendiente.',
  ];
  const others = recentAddressedOthers(texts, 'Alex', ['Alec']);
  assert.deepEqual(others, ['Sam', 'Maya', 'Carlos']);
});

test('team-meet prompt always carries USER identity, prior-turn peer addressees, and GROUP_MEETING_JUDGE_RULES', () => {
  const prompt = buildJudgePrompt({
    candidateText: 'Perfecto. ¿Algún bloqueo?',
    recentTurns: [
      { role: 'interviewer', text: 'Sam, cuéntame cómo vas con el endpoint.', timestamp: 10 },
      { role: 'interviewer', text: 'Sigo esperando revisión del PR 123.', timestamp: 20 },
    ],
    modeName: 'Team Meet',
    modeTemplateType: 'team-meet',
    questionId: 'q-tm-1',
    userName: 'Alex Rivera',
  });

  assert.ok(prompt.includes("The USER's name is Alex."), 'must include USER first name even without vocatives in candidate');
  assert.ok(prompt.includes('Other participants recently addressed by name in this meeting: Sam.'), 'must propagate peer addressee from recent turns');
  assert.ok(prompt.endsWith(GROUP_MEETING_JUDGE_RULES), 'must use group meeting rules');
  assert.ok(prompt.includes('WHEN IN DOUBT in a group meeting, choose "silent".'));
  assert.ok(!prompt.includes('WHEN IN DOUBT, ANSWER.'));
});

test('SimpleAutoAnswerEngine passes modeTemplateType, waits full deadline, and fails silent on timeout in team-meet', async () => {
  function runCase({ modeTemplateType }) {
    const clock = new FakeClock();
    const seen = [];
    const dispatched = [];
    const events = [];
    const host = {
      isEnabled: () => true,
      isMeetingActive: () => true,
      meetingGeneration: () => 1,
      engineAccepting: () => true,
      recentTurns: () => [],
      dispatch: (q) => { dispatched.push(q.text); },
      judgeCandidate: (req) => {
        seen.push(req);
        return new Promise(() => {}); // deliberate hang -> timeout
      },
      modeName: () => (modeTemplateType === 'team-meet' ? 'Team Meet' : 'Technical Interview'),
      modeTemplateType: () => modeTemplateType,
      userName: () => 'Alex Rivera',
      telemetry: (e) => { events.push(e); },
      log: () => {},
    };
    const engine = new SimpleAutoAnswerEngine(host, clock);
    engine.onMeetingStart();
    engine.ingest({
      speaker: 'interviewer',
      text: 'This is probably not for you, Maya, how do you see this?',
      final: true,
      timestamp: clock.now(),
      origin: 'stt',
      punctuationSource: 'provider',
    });
    return {
      seen, dispatched, events,
      advance: async (ms) => { for (let t = 0; t < ms; t += 20) { clock.advance(20); await flush(); } },
    };
  }

  // Team Meet: waits past QUESTION_JUDGE_DEADLINE_MS and fails silent at JUDGE_DEADLINE_MS.
  const tm = runCase({ modeTemplateType: 'team-meet' });
  await tm.advance(EARLY_JUDGE_MS + QUESTION_JUDGE_DEADLINE_MS + 100);
  assert.equal(tm.seen.length, 1);
  assert.equal(tm.seen[0].modeTemplateType, 'team-meet');
  assert.equal(tm.events.some((e) => e.name === 'auto_answer_judged' && e.judgeOutcome === 'timeout'), false, 'no early timeout at 1.9s in team-meet');
  assert.equal(tm.dispatched.length, 0);

  await tm.advance(JUDGE_DEADLINE_MS - QUESTION_JUDGE_DEADLINE_MS + 100);
  assert.equal(tm.events.some((e) => e.name === 'auto_answer_judged' && e.judgeOutcome === 'timeout'), true);
  assert.equal(tm.dispatched.length, 0, 'team-meet must fail silent on judge timeout even with "?"');

  // Technical Interview: keeps short timeout + '?' fallback dispatch unchanged.
  const iv = runCase({ modeTemplateType: 'technical-interview' });
  await iv.advance(EARLY_JUDGE_MS + QUESTION_JUDGE_DEADLINE_MS + 150);
  assert.equal(iv.seen[0].modeTemplateType, 'technical-interview');
  assert.equal(iv.dispatched.length, 1, 'interview keeps fallback dispatch on "?" timeout');
});
