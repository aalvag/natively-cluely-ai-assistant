import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DAILY_BRAIN_ENGRAM_PROJECT = "dailys";
export const DAILY_BRAIN_REF_FILENAME = "🧠 Daily Brain (Últimas Dailys).md";
export const ENGRAM_TOPIC_PREFIX = "natively-meeting-";

const ENGRAM_SAVE_TIMEOUT_MS = 10_000;
const MAX_ENGRAM_CONTENT_CHARS = 3_600;
const MAX_ROLLING_DAILYS = 7;

/** Prevent test runners from polluting the user's real ~/.engram/engram.db. */
export function isRunningUnderTest(): boolean {
  return Boolean(
    process.env.NATIVELY_TEST_USERDATA ||
      process.env.NATIVELY_TEST_USER_DATA_DIR ||
      process.env.NODE_ENV === "test" ||
      process.env.NODE_TEST_CONTEXT ||
      process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-")) ||
      process.argv.some((arg) => arg === "--test" || arg.startsWith("--test-"))
  );
}

const INTERVIEW_MODE_RE = /\b(?:technical-interview|looking-for-work|senior front interview|hackerrank|interview)\b/i;
const INTERVIEW_TITLE_RE = /\b(?:interview|entrevista|coding exercise|assessment|mock|reason for leaving)\b/i;
const SKIP_TITLE_RE = /^(?:untitled session|chat session|new session)$/i;
const WORK_TITLE_RE = /\b(?:daily|standup|1:1|sync|retro|planning|refinement|onboarding|pr reviews|technical debt|screening|compliance)\b/i;

export interface MeetingDailyInput {
  id: string;
  title?: string | null;
  date?: string | null;
  detailedSummary?: any;
  userNotes?: string | null;
  summaryStatus?: string | null;
  modeName?: string | null;
  modeTemplateType?: string | null;
  fallbackLines?: string[];
}

export interface FormattedDailyEntry {
  meetingId: string;
  dateIso: string;
  title: string;
  topicKey: string;
  summaryLines: string[];
  decisions: string[];
  actionItems: string[];
  risksAndOpen: string[];
  content: string;
}

/** Resolve the `engram` CLI binary path across Homebrew, PATH, and user locations. */
export function resolveEngramBinary(): string | null {
  const candidates = [
    process.env.NATIVELY_ENGRAM_BIN,
    "/opt/homebrew/bin/engram",
    "/usr/local/bin/engram",
    path.join(os.homedir(), ".local", "bin", "engram"),
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue checking remaining candidate paths.
    }
  }
  return null;
}

/** Extract mode metadata from a saved meeting's detailedSummary payload. */
export function resolveMeetingModeMeta(detailedSummary: any): {
  modeName: string;
  templateType: string;
} {
  const m = detailedSummary?.mode ?? {};
  return {
    modeName: String(m.selectedModeName || m.detectedModeName || "").trim(),
    templateType: String(m.selectedTemplateType || m.summaryModeUsed || "").trim(),
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const text = String((item as any).text || (item as any).title || "").trim();
        const owner = String((item as any).owner || "").trim();
        const deadline = String((item as any).deadline || "").trim();
        if (!text) return "";
        const suffix = [owner, deadline].filter(Boolean).join(" · ");
        return suffix ? `${text} (${suffix})` : text;
      }
      return "";
    })
    .filter(Boolean);
}

/** Decide whether a saved meeting belongs in the shared work `dailys` brain (never leaks job interviews). */
export function isWorkDailyCandidate(input: MeetingDailyInput): boolean {
  if (!input?.id) return false;
  if (input.summaryStatus === "failed") return false;

  const title = String(input.title || "").trim();
  if (!title || SKIP_TITLE_RE.test(title)) return false;

  const dsMeta = resolveMeetingModeMeta(input.detailedSummary);
  const modeName = String(input.modeName || dsMeta.modeName || "").trim();
  const templateType = String(input.modeTemplateType || dsMeta.templateType || "").trim();

  if (INTERVIEW_MODE_RE.test(modeName) || INTERVIEW_MODE_RE.test(templateType)) {
    return false;
  }
  if (INTERVIEW_TITLE_RE.test(title)) {
    return false;
  }

  const hasContent = Boolean(
    asStringList(input.detailedSummary?.tldr).length ||
      asStringList(input.detailedSummary?.decisions).length ||
      asStringList(input.detailedSummary?.actionItemsStructured).length ||
      asStringList(input.detailedSummary?.actionItems).length ||
      asStringList(input.detailedSummary?.keyPoints).length ||
      (typeof input.detailedSummary?.overview === "string" && input.detailedSummary.overview.trim()) ||
      (typeof input.userNotes === "string" && input.userNotes.trim()) ||
      (Array.isArray(input.fallbackLines) && input.fallbackLines.length > 0)
  );
  if (!hasContent) return false;

  if (templateType === "team-meet" || /^team meet$/i.test(modeName)) {
    return true;
  }
  return WORK_TITLE_RE.test(title);
}

const EMPTY_DIFF_NOISE_RE = /^no transcript or previous output was provided\b/i;

function dedupeNormalizedItems(items: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of items) {
    const clean = raw.trim();
    if (!clean || EMPTY_DIFF_NOISE_RE.test(clean)) continue;
    const base = clean.replace(/\s+\([^)]{1,40}\)$/, "").trim().toLowerCase();
    const existing = seen.get(base);
    // Prefer the variant that carries an explicit (Owner) or longer metadata suffix.
    if (!existing || clean.length > existing.length) {
      seen.set(base, clean);
    }
  }
  return Array.from(seen.values());
}

function appendSection(lines: string[], heading: string, items: string[], maxItems = 8): void {
  if (items.length === 0) return;
  lines.push(`## ${heading}`);
  for (const item of items.slice(0, maxItems)) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

/** Format one saved work meeting/daily into a compact, idempotent Engram observation. */
export function formatMeetingForEngram(input: MeetingDailyInput): FormattedDailyEntry {
  const ds = input.detailedSummary && typeof input.detailedSummary === "object" ? input.detailedSummary : {};
  const title = String(input.title || "Untitled Meeting").trim();
  const dateIso = String(input.date || new Date().toISOString()).slice(0, 16);

  const tldr = asStringList(ds.tldr);
  const keyPoints = asStringList(ds.keyPoints);
  const overview = typeof ds.overview === "string" ? ds.overview.trim() : "";
  const summaryLines = tldr.length > 0 ? tldr : keyPoints.length > 0 ? keyPoints : overview ? [overview] : [];

  const decisions = dedupeNormalizedItems([...asStringList(ds.decisions), ...asStringList(ds.whatChanged)]);
  const structuredActions = asStringList(ds.actionItemsStructured);
  const actionItems = dedupeNormalizedItems(
    structuredActions.length > 0 ? structuredActions : asStringList(ds.actionItems)
  );
  const risksAndOpen = dedupeNormalizedItems([...asStringList(ds.risks), ...asStringList(ds.openQuestions)]);

  const lines: string[] = [
    `Date: ${dateIso} | Meeting ID: ${input.id}`,
    "",
  ];
  appendSection(lines, "Summary", summaryLines, 5);
  appendSection(lines, "Decisions", decisions, 8);
  appendSection(lines, "Action Items", actionItems, 8);
  appendSection(lines, "Blockers & Open Questions", risksAndOpen, 6);

  const userNotes = typeof input.userNotes === "string" ? input.userNotes.trim() : "";
  if (userNotes) {
    lines.push("## Notes", userNotes.slice(0, 600), "");
  } else if (summaryLines.length === 0 && decisions.length === 0 && actionItems.length === 0 && Array.isArray(input.fallbackLines)) {
    appendSection(lines, "Transcript Excerpt", input.fallbackLines, 8);
  }

  const content = lines.join("\n").trim().slice(0, MAX_ENGRAM_CONTENT_CHARS);
  return {
    meetingId: input.id,
    dateIso,
    title,
    topicKey: `${ENGRAM_TOPIC_PREFIX}${input.id}`,
    summaryLines,
    decisions,
    actionItems,
    risksAndOpen,
    content,
  };
}

/** Build a rolling Markdown digest of recent dailys for Natively's live Team Meet Reference File. */
export function buildRollingDailyBrainMarkdown(
  entries: FormattedDailyEntry[],
  maxEntries: number = MAX_ROLLING_DAILYS
): string {
  const recent = entries.slice(0, Math.max(1, maxEntries));
  const out: string[] = [
    "# Daily Brain — Últimas Dailys, Decisiones y Pendientes",
    "",
    "Contexto acumulado de reuniones de equipo recientes para responder preguntas sobre decisiones, pendientes y bloqueos.",
    "",
  ];

  for (const entry of recent) {
    out.push(`## [${entry.dateIso.slice(0, 10)}] ${entry.title}`);
    if (entry.summaryLines.length > 0) {
      out.push(`- **Resumen:** ${entry.summaryLines.slice(0, 2).join(" ")}`);
    }
    if (entry.decisions.length > 0) {
      out.push("- **Decisiones:**");
      for (const d of entry.decisions.slice(0, 5)) out.push(`  - ${d}`);
    }
    if (entry.actionItems.length > 0) {
      out.push("- **Action Items:**");
      for (const a of entry.actionItems.slice(0, 5)) out.push(`  - ${a}`);
    }
    if (entry.risksAndOpen.length > 0) {
      out.push("- **Bloqueos / Abierto:**");
      for (const r of entry.risksAndOpen.slice(0, 4)) out.push(`  - ${r}`);
    }
    out.push("");
  }

  return out.join("\n").trim();
}

/** Persist one formatted meeting into Engram idempotently via `--topic`. Never throws. */
export async function saveMeetingToEngramAsync(
  entry: FormattedDailyEntry,
  opts: { project?: string; engramBin?: string | null; allowInTest?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (!opts.allowInTest && isRunningUnderTest() && !process.env.ENGRAM_DATA_DIR && opts.engramBin === undefined) {
    return { ok: false, error: "skipped in test environment" };
  }
  const engramBin = opts.engramBin !== undefined ? opts.engramBin : resolveEngramBinary();
  if (!engramBin) {
    return { ok: false, error: "engram binary not found" };
  }

  const project = opts.project || DAILY_BRAIN_ENGRAM_PROJECT;
  const args = [
    "save",
    `[${entry.dateIso.slice(0, 10)}] ${entry.title}`,
    entry.content,
    "--type",
    "meeting",
    "--project",
    project,
    "--scope",
    "project",
    "--topic",
    entry.topicKey,
  ];

  try {
    await execFileAsync(engramBin, args, { timeout: ENGRAM_SAVE_TIMEOUT_MS });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Refresh the single rolling Daily Brain reference file attached to Team Meet mode. */
export async function refreshTeamMeetDailyBrainReference(entries: FormattedDailyEntry[]): Promise<boolean> {
  if (entries.length === 0) return false;
  try {
    const { ModesManager } = require("../ModesManager") as typeof import("../ModesManager");
    const modesMgr = ModesManager.getInstance();
    const teamMeet = modesMgr.getModes().find((m) => m.templateType === "team-meet" || m.name === "Team Meet");
    if (!teamMeet) return false;

    const existing = modesMgr.getReferenceFiles(teamMeet.id).filter((f) => f.fileName === DAILY_BRAIN_REF_FILENAME);
    for (const stale of existing) {
      modesMgr.deleteReferenceFile(stale.id);
    }

    const digest = buildRollingDailyBrainMarkdown(entries, MAX_ROLLING_DAILYS);
    const created = modesMgr.addReferenceFile({
      modeId: teamMeet.id,
      fileName: DAILY_BRAIN_REF_FILENAME,
      content: digest,
    });
    await modesMgr.indexReferenceFile(created);
    return true;
  } catch (err: any) {
    console.warn("[EngramBridge] Team Meet reference refresh skipped (non-fatal):", err?.message);
    return false;
  }
}

/** Post-meeting hook: sync the saved work meeting to Engram and refresh Team Meet's rolling digest. */
export async function syncSavedMeetingToDailyBrain(input: MeetingDailyInput): Promise<void> {
  try {
    if (isRunningUnderTest()) return;
    if (!isWorkDailyCandidate(input)) return;
    const formatted = formatMeetingForEngram(input);
    const engramRes = await saveMeetingToEngramAsync(formatted);
    if (engramRes.ok) {
      console.log("[EngramBridge] Saved meeting to Engram:", { id: input.id, title: input.title });
    } else if (engramRes.error !== "engram binary not found") {
      console.warn("[EngramBridge] Engram save skipped:", engramRes.error);
    }

    const { DatabaseManager } = require("../../db/DatabaseManager") as typeof import("../../db/DatabaseManager");
    const recent = DatabaseManager.getInstance().getRecentMeetings(30);
    const formattedRecent: FormattedDailyEntry[] = [formatted];
    for (const m of recent) {
      if (m.id === input.id) continue;
      if (isWorkDailyCandidate(m)) {
        formattedRecent.push(formatMeetingForEngram(m));
      }
      if (formattedRecent.length >= MAX_ROLLING_DAILYS) break;
    }
    await refreshTeamMeetDailyBrainReference(formattedRecent);
  } catch (err: any) {
    console.warn("[EngramBridge] Non-fatal post-save sync failure:", err?.message);
  }
}
