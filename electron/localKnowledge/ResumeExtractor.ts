// electron/localKnowledge/ResumeExtractor.ts
//
// Turns resume text into a structured profile, using a local model when one is
// running and deterministic parsing when one is not.
//
// The fallback is not a nicety. electron/services/knowledge/OkfExtractor.ts
// states the principle this follows: "extraction must work even when every
// provider is unavailable." A user who uploads a resume with Ollama stopped
// should still get their name, roles, and skills, because a profile that
// silently fails to build looks identical to a feature that does not work.
//
// Everything the model returns passes through
// electron/localKnowledge/profileNormalization.ts before it is stored. The
// model proposes; deterministic code decides the date format, the ordering, and
// the flattened skill list. See that file for why each of those is not left to
// the model.

import type { LocalIngestedDocument } from './DocumentReader';
import {
  canonicalizeProfile,
  isUsableProfile,
  type CanonicalProfileFacts,
} from './profileNormalization';

export type ExtractionMode = 'local_llm' | 'llm' | 'heuristic';

export interface ExtractProfileOptions {
  /** Optional custom LLM generator (e.g. Gemini, OpenAI, Claude, Groq, DeepSeek). */
  llmGenerateFn?: (system: string, user: string) => Promise<string>;
  /** Defaults to the address LLMHelper uses (electron/LLMHelper.ts:396). */
  ollamaUrl?: string;
  /** Ollama model tag. When absent, the first installed model is used. */
  model?: string;
  /** Injected for tests, so date-dependent ordering is not wall-clock dependent. */
  now?: Date;
  /** Injected for tests, and so a caller can supply its own transport. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ExtractProfileResult {
  structured_data: CanonicalProfileFacts;
  extractionMode: ExtractionMode;
  /** Non-fatal problems worth surfacing in diagnostics, never to the model. */
  warnings: string[];
}

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resumes are short. This cap exists for the pathological case: a 40-page CV,
 * or a text file the user mislabelled. Truncating keeps the request inside a
 * small local model's context instead of failing the whole extraction.
 */
const MAX_PROMPT_CHARS = 20_000;

const EXTRACTION_INSTRUCTIONS = [
  'You extract structured data from a resume. Return JSON only, with no prose and no code fences.',
  '',
  'Use exactly this shape. Omit any field the resume does not state:',
  '{',
  '  "name": "string",',
  '  "experience": [{"role": "string", "company": "string", "start_date": "YYYY-MM", "end_date": "YYYY-MM", "bullets": ["string"]}],',
  '  "education": [{"degree": "string", "field": "string", "institution": "string"}],',
  '  "projects": [{"name": "string", "description": "string", "technologies": ["string"], "highlights": ["string"]}],',
  '  "skills": {"languages": ["string"], "frameworks": ["string"], "tools": ["string"]}',
  '}',
  '',
  'Rules:',
  '- Copy facts from the resume. Never infer, complete, or invent a value.',
  '- If a role has not ended, set "end_date" to "Present".',
  '- If the resume gives only a year with no month, omit that date field entirely.',
  '- Order experience with the most recent role first.',
  '- Keep bullets as the resume wrote them. Do not summarize or rewrite them.',
  '- Group skills under the headings the resume uses. If it has no headings, put them all under "skills".',
].join('\n');

/** Strip the code fence a model adds despite being told not to. */
function extractJsonPayload(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // Fall back to the outermost braces, which survives a leading apology line.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);

  return text;
}

interface InstalledModel {
  name: string;
  capabilities: string[];
}

/** Read the installed models and their capabilities from Ollama. */
async function listInstalledModels(
  ollamaUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<InstalledModel[]> {
  const response = await fetchImpl(`${ollamaUrl}/api/tags`, {
    signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    models?: Array<{ name?: unknown; capabilities?: unknown }>;
  };
  return (data?.models ?? [])
    .filter((entry) => typeof entry?.name === 'string' && entry.name)
    .map((entry) => ({
      name: String(entry.name),
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [],
    }));
}

function pickChatModel(models: InstalledModel[]): string | null {
  const usable = models.find(
    (model) =>
      model.capabilities.length === 0
        ? !/embed/i.test(model.name)
        : model.capabilities.includes('completion'),
  );
  return usable ? usable.name : null;
}

/** One non-streaming JSON-mode chat call. */
async function requestExtraction(
  resumeText: string,
  model: string,
  ollamaUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  suppressThinking: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: EXTRACTION_INSTRUCTIONS },
      { role: 'user', content: resumeText },
    ],
    stream: false,
    format: 'json',
    options: {
      temperature: 0,
      top_p: 0.9,
    },
  };

  if (suppressThinking) body.think = false;

  const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama /api/chat ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { message?: { content?: unknown }; response?: unknown };
  const content = data?.message?.content ?? data?.response ?? '';
  return typeof content === 'string' ? content : '';
}

// --- Deterministic fallback -------------------------------------------------

const SECTION_PATTERNS: Array<{ key: string; test: RegExp }> = [
  { key: 'experience', test: /^(work\s+)?(experience|employment|professional experience|work history|career history|background|experiencia|experiencia laboral|experiencia profesional|historial laboral|trayectoria)\b/i },
  { key: 'education', test: /^(education|academic background|studies|formaci[oó]n|educaci[oó]n|estudios|certificaciones)\b/i },
  { key: 'skills', test: /^(technical\s+)?skills\b|^technologies\b|^tech stack\b|^habilidades\b|^competencias\b|^conocimientos\b|^tecnolog[ií]as\b|^herramientas\b/i },
  { key: 'projects', test: /^(personal\s+)?projects\b|^proyectos\b/i },
];

/** A heading is a short line that names a known section. */
function sectionKeyFor(line: string): string | null {
  const text = line.trim().replace(/[:\-_]+$/, '');
  if (!text || text.length > 50) return null;
  for (const { key, test } of SECTION_PATTERNS) {
    if (test.test(text)) return key;
  }
  return null;
}

function splitIntoSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = 'header';
  sections.set(current, []);

  for (const line of content.split('\n')) {
    const key = sectionKeyFor(line);
    if (key) {
      current = key;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)!.push(line);
  }

  return sections;
}

function guessName(headerLines: string[]): string {
  for (const line of headerLines.slice(0, 8)) {
    const text = line.trim();
    if (!text || text.length > 60) continue;
    if (/[@|]|https?:|\d{3}/.test(text)) continue;
    const words = text.split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    if (!/^[A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F'.\-]*$/.test(words[0])) continue;
    return text;
  }
  return '';
}

const MONTH_NAMES = 'jan(?:uary)?|ene(?:ro)?|feb(?:ruary|rero)?|mar(?:ch|zo)?|apr(?:il)?|abr(?:il)?|may(?:o)?|jun(?:e|io)?|jul(?:y|io)?|aug(?:ust)?|ago(?:sto)?|sep(?:t(?:ember)?)?|set(?:iembre)?|septiembre|oct(?:ober|ubre)?|nov(?:ember|iembre)?|dec(?:ember)?|dic(?:iembre)?';

const DATE_RANGE = new RegExp(
  `((?:${MONTH_NAMES})\\.?\\s+\\d{4}|\\d{4}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{4}|\\d{4})`
  + '\\s*(?:[-–—\\u2013\\u2014]|to|until|through|a|hasta)\\s*'
  + `((?:${MONTH_NAMES})\\.?\\s+\\d{4}|\\d{4}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{4}|\\d{4}|present|current|now|actualidad|presente|hoy|en curso|a la fecha)`,
  'i',
);

function heuristicExperience(lines: string[]): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  let bullets: string[] = [];
  let lastNonDateLine = '';

  const flush = () => {
    if (!current) return;
    if (bullets.length) current.bullets = bullets.slice(0, 12);
    entries.push(current);
    current = null;
    bullets = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    const range = line.match(DATE_RANGE);
    if (range) {
      flush();
      const withoutDates = line
        .replace(range[0], '')
        .replace(/[|]/g, ',')
        .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
        .replace(/[\s,;:.\-–—\u2013\u2014]+$/, '')
        .trim();
      const parts = withoutDates.split(/\s+[-–—\u2013\u2014]\s+|,\s*|\s+at\s+|\s+en\s+/i).map((p) => p.trim()).filter(Boolean);
      current = { start_date: range[1], end_date: range[2] };
      if (parts[0]) current.role = parts[0];
      if (parts[1]) current.company = parts[1];

      // If company or role was not on the same line, check preceding line
      if (!current.role || !current.company) {
        if (lastNonDateLine && lastNonDateLine.length < 80 && !lastNonDateLine.startsWith('•') && !lastNonDateLine.startsWith('-')) {
          const prevParts = lastNonDateLine.split(/\s+[-–—\u2013\u2014|]\s+|,\s*|\s+at\s+|\s+en\s+/i).map((p) => p.trim()).filter(Boolean);
          if (!current.company && prevParts[0]) {
            current.company = prevParts[0];
          }
          if (!current.role && prevParts[1]) {
            current.role = prevParts[1];
          } else if (!current.role && prevParts[0] && current.company !== prevParts[0]) {
            current.role = prevParts[0];
          }
        }
      }
      continue;
    }

    if (!current) {
      lastNonDateLine = line;
      continue;
    }
    const bullet = line.replace(/^[•‣◦⁃∙*\-–—]\s*/, '').trim();
    if (bullet && bullet.length > 5) bullets.push(bullet);
    lastNonDateLine = line;
  }

  flush();
  return entries;
}

function heuristicSkills(lines: string[]): Record<string, string[]> {
  const skills: Record<string, string[]> = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DATE_RANGE.test(line)) continue;
    if (line.length > 90) continue;

    // `Languages: Python, Go` keeps its category; a bare list does not have one.
    const labelled = line.match(/^([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F\s/&+]{1,30}):\s*(.+)$/);
    const category = labelled ? labelled[1].trim().toLowerCase() : 'skills';
    const body = labelled ? labelled[2] : line;
    const values = body.split(/[,;|•·]/).map((v) => v.trim()).filter((v) => v.length > 1 && v.length < 40 && !DATE_RANGE.test(v));
    if (!values.length) continue;
    skills[category] = [...(skills[category] ?? []), ...values];
  }
  return skills;
}

function heuristicEducation(lines: string[]): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length < 6) continue;
    const degreeMatch = line.match(/\b(B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|Ph\.?D\.?|Bachelor[a-z']*|Master[a-z']*|Doctorate|Associate|Ingenier[ií]a|Licenciatura|T[eé]cnico|Diplomado|Grado)\b[^,|]*/i);
    const institutionMatch = line.match(/\b([A-Z\u00C0-\u017F][A-Za-z\u00C0-\u017F.'-]*(?:\s+(?:of|and|the|de|y|la|el))?(?:\s+[A-Z\u00C0-\u017F][A-Za-z\u00C0-\u017F.'-]*)*\s+(?:University|College|Institute|School|Universidad|Instituto|Facultad))\b/i);
    if (!degreeMatch && !institutionMatch) continue;
    const entry: Record<string, unknown> = {};
    if (degreeMatch) entry.degree = degreeMatch[0].trim();
    if (institutionMatch) entry.institution = institutionMatch[1].trim();
    entries.push(entry);
  }
  return entries;
}

/** Structure a resume with no model available. Finds less, invents nothing. */
export function heuristicExtract(content: string): Record<string, unknown> {
  const sections = splitIntoSections(content);
  const allLines = content.split('\n');
  const out: Record<string, unknown> = {};

  const name = guessName(sections.get('header') ?? allLines);
  if (name) out.name = name;

  let experience = heuristicExperience(sections.get('experience') ?? []);
  if (experience.length === 0) {
    experience = heuristicExperience(allLines);
  }
  if (experience.length) out.experience = experience;

  let education = heuristicEducation(sections.get('education') ?? []);
  if (education.length === 0) {
    education = heuristicEducation(allLines);
  }
  if (education.length) out.education = education;

  const skills = heuristicSkills(sections.get('skills') ?? []);
  if (Object.keys(skills).length) out.skills = skills;

  return out;
}

// --- Entry point ------------------------------------------------------------

function warnDroppedDates(profile: CanonicalProfileFacts, warnings: string[]): void {
  const undated = (profile.experience ?? []).filter((entry) => !entry.start_date).length;
  if (undated > 0) {
    warnings.push(
      `${undated} role(s) gave no month-level dates, so tenure and gap answers are unavailable for them.`,
    );
  }
}

/**
 * Build a structured profile from an ingested resume.
 */
export async function extractStructuredProfile(
  document: Pick<LocalIngestedDocument, 'content'>,
  options: ExtractProfileOptions = {},
): Promise<ExtractProfileResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ollamaUrl = (options.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];

  const content = document.content ?? '';
  const resumeText = content.length > MAX_PROMPT_CHARS ? content.slice(0, MAX_PROMPT_CHARS) : content;
  if (content.length > MAX_PROMPT_CHARS) {
    warnings.push(`Resume text truncated to ${MAX_PROMPT_CHARS} characters for extraction.`);
  }

  // 1. Try provided LLM function (e.g. Gemini, Claude, OpenAI, Groq, DeepSeek)
  if (typeof options.llmGenerateFn === 'function') {
    try {
      const raw = await options.llmGenerateFn(EXTRACTION_INSTRUCTIONS, resumeText);
      if (raw) {
        const parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
        const profile = canonicalizeProfile(parsed, { now, extractionMode: 'llm' });
        if (isUsableProfile(profile)) {
          warnDroppedDates(profile, warnings);
          return { structured_data: profile, extractionMode: 'llm', warnings };
        }
      }
    } catch (e) {
      console.warn('[ResumeExtractor] Custom LLM extraction failed, trying Ollama/fallback:', e);
    }
  }

  // 2. Try Ollama local model
  if (fetchImpl) {
    try {
      const installed = await listInstalledModels(ollamaUrl, fetchImpl, timeoutMs).catch(() => []);
      const model = options.model ?? pickChatModel(installed);
      if (model) {
        const suppressThinking = installed
          .find((entry) => entry.name === model)
          ?.capabilities.includes('thinking') ?? false;
        const raw = await requestExtraction(resumeText, model, ollamaUrl, fetchImpl, timeoutMs, suppressThinking);
        const parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
        const profile = canonicalizeProfile(parsed, { now, extractionMode: 'local_llm' });
        if (isUsableProfile(profile)) {
          warnDroppedDates(profile, warnings);
          return { structured_data: profile, extractionMode: 'local_llm', warnings };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Local model extraction failed (${message}), so extraction used deterministic parsing.`);
    }
  }

  // 3. Robust heuristic fallback
  const profile = canonicalizeProfile(heuristicExtract(resumeText), { now, extractionMode: 'heuristic' });
  if (!isUsableProfile(profile)) {
    warnings.push('No profile fields could be read from this document.');
  }
  warnDroppedDates(profile, warnings);
  return { structured_data: profile, extractionMode: 'heuristic', warnings };
}
