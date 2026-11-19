import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRunningUnderTest } from "./engramBridge";

export const SLACK_BRAIN_REF_FILENAME = "💬 Slack Brain (Últimas 48h).md";
export const SLACK_BRAIN_DISK_FILENAME = "slack-brain-latest.md";
export const SLACK_CHANNELS_CONFIG_FILENAME = "slack-channels.json";
export const DEFAULT_SLACK_WINDOW_HOURS = 48;
export const MAX_SLACK_DIGEST_CHARS = 14_000;

export interface SlackChannelConfig {
  id: string;
  name: string;
  maxMessages?: number;
  includeThreads?: boolean;
  includeRegex?: string;
  excludeRegex?: string;
  compactForms?: boolean;
}

export const DEFAULT_SLACK_CHANNELS: readonly SlackChannelConfig[] = [];

export interface SlackRawAttachment {
  fallback?: string;
  title?: string;
  text?: string;
  pretext?: string;
}

export interface SlackRawMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  attachments?: SlackRawAttachment[];
  replies?: SlackRawMessage[];
}

export interface SlackChannelSnapshot {
  id: string;
  name: string;
  messages: SlackRawMessage[];
}

export interface SlackNormalizedReply {
  ts: string;
  timestampLabel: string;
  author: string;
  text: string;
}

export interface SlackNormalizedMessage {
  ts: string;
  timestampLabel: string;
  author: string;
  text: string;
  replies: SlackNormalizedReply[];
}

export interface SlackChannelDigest {
  id: string;
  name: string;
  messages: SlackNormalizedMessage[];
}

export interface NormalizeChannelOptions {
  nowMs?: number;
  windowHours?: number;
  maxMessages?: number;
  maxRepliesPerThread?: number;
  userMap?: Record<string, string>;
  tzOffsetMinutes?: number;
  includeRegex?: string;
  excludeRegex?: string;
  compactForms?: boolean;
}

export interface BuildSlackBrainOptions {
  generatedAtIso?: string;
  windowHours?: number;
  maxChars?: number;
}

const NOISE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "bot_add",
  "bot_remove",
]);

const MAX_PARENT_TEXT_CHARS = 320;
const MAX_REPLY_TEXT_CHARS = 220;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Resolve the local disk path for the generated Slack Brain Markdown digest. */
export function resolveSlackBrainDiskPath(userDataDir?: string): string {
  if (userDataDir && userDataDir.trim()) {
    return path.join(userDataDir.trim(), SLACK_BRAIN_DISK_FILENAME);
  }
  let baseDir: string | undefined;
  try {
    const electronMod = require("electron") as typeof import("electron");
    baseDir = electronMod?.app?.getPath?.("userData");
  } catch {
    baseDir = undefined;
  }
  if (!baseDir) {
    baseDir = path.join(os.homedir(), "Library", "Application Support", "Natively");
  }
  return path.join(baseDir, SLACK_BRAIN_DISK_FILENAME);
}

/** Resolve the user's private Slack channels JSON config path (`~/.natively/slack-channels.json`). */
export function resolveSlackChannelsConfigPath(homeDir?: string): string {
  const baseHome = homeDir && homeDir.trim() ? homeDir.trim() : os.homedir();
  return path.join(baseHome, ".natively", SLACK_CHANNELS_CONFIG_FILENAME);
}

/** Load and validate user-configured Slack channels from JSON (`[]` when absent or invalid). */
export function loadSlackChannelsConfig(configPath?: string): SlackChannelConfig[] {
  const target = configPath && configPath.trim() ? configPath.trim() : resolveSlackChannelsConfigPath();
  try {
    if (!fs.existsSync(target)) return [];
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.channels) ? parsed.channels : [];
    const out: SlackChannelConfig[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim().replace(/^#/, "") : "";
      if (!id || !name) continue;
      const cfg: SlackChannelConfig = { id, name };
      if (typeof item.maxMessages === "number" && Number.isFinite(item.maxMessages)) {
        cfg.maxMessages = Math.max(1, Math.floor(item.maxMessages));
      }
      if (typeof item.includeThreads === "boolean") cfg.includeThreads = item.includeThreads;
      if (typeof item.includeRegex === "string" && item.includeRegex.trim()) {
        cfg.includeRegex = item.includeRegex;
      }
      if (typeof item.excludeRegex === "string" && item.excludeRegex.trim()) {
        cfg.excludeRegex = item.excludeRegex;
      }
      if (typeof item.compactForms === "boolean") cfg.compactForms = item.compactForms;
      out.push(cfg);
    }
    return out;
  } catch (err: any) {
    console.warn("[SlackBrain] Failed to load channel config (ignored):", err?.message);
    return [];
  }
}

/** Normalize Slack mrkdwn tokens, mentions, links, and HTML entities into compact plain text. */
export function cleanSlackText(raw: string, userMap?: Record<string, string>): string {
  if (!raw) return "";
  let text = raw
    .replace(/<@(U[A-Z0-9]+)(?:\|([^>]+))?>/gi, (_match, id: string, label?: string) => {
      const mapped = userMap?.[id]?.trim();
      if (mapped) return mapped;
      if (label && label.trim()) return label.trim();
      return `@${id}`;
    })
    .replace(/<mailto:([^|>]+)(?:\|([^>]+))?>/gi, (_match, addr: string, label?: string) => {
      return (label || addr).trim();
    })
    .replace(/<#(C[A-Z0-9]+)\|([^>]+)>/gi, (_match, _id: string, name: string) => `#${name.trim()}`)
    .replace(/<#(C[A-Z0-9]+)\|?>/gi, (_match, id: string) => `#${id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]+)?>/gi, (_match, scope: string) => `@${scope}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, (_match, _url: string, label: string) => label.trim())
    .replace(/<(https?:\/\/[^>]+)>/gi, (_match, url: string) => {
      const prMatch = url.match(/console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/[^/]+\/pull-requests\/(\d+)/i);
      if (prMatch) {
        return `PR #${prMatch[1]}`;
      }
      if (/console\.aws\.amazon\.com\/codebuild\//i.test(url)) {
        return "[CodeBuild]";
      }
      if (/slack\.com\/lists\//i.test(url)) {
        return "[Slack List]";
      }
      return url.trim();
    });

  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function extractFormField(text: string, labelPattern: string): string {
  const re = new RegExp(
    `\\*(?:${labelPattern}):?\\*\\s*(.+?)(?=\\s*(?:\\*[^*]+\\*|•|:[a-z0-9_+-]+:|$))`,
    "i"
  );
  const match = text.match(re);
  if (!match) return "";
  return match[1]
    .replace(EMAIL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compact structured incident and support-report forms so real titles, platforms,
 * and flows survive truncation while stripping repetitive headers and client emails.
 */
export function compactStructuredSlackText(text: string): string {
  if (!text) return "";

  const isIncidentForm =
    /\*(?:Plataforma|¿Flujo de negocio afectado\?|Título)/i.test(text) &&
    /(?:Reportar incidentes|Formulario de Incidente|\*Impacto\*|\*¿A qué equipo perteneces\?\*)/i.test(text);

  if (isIncidentForm) {
    const platform = extractFormField(text, "Plataforma");
    const flow = extractFormField(text, "¿?Flujo(?: de negocio)? afectado\\??");
    const title = extractFormField(text, "T[íi]tulo(?:\\s*\\([^)]*\\))?");
    const desc =
      extractFormField(text, "Descripci[óo]n(?:\\s+del\\s+(?:incidente|problema))?") ||
      (/\*(?:Detalle):?\*\s*(?!\*T[íi]tulo)/i.test(text) ? extractFormField(text, "Detalle") : "");

    if (platform || flow || title || desc) {
      const scope = [platform || "N/A", flow].filter(Boolean).join(" / ");
      const head = title || "Sin título";
      const body = desc && desc.toLowerCase() !== head.toLowerCase() ? ` — ${desc}` : "";
      return `[Incidente · ${scope}] ${head}${body}`.trim();
    }
  }

  const isSupportForm = /(?:\*Reporte de consultas\*|\*Validación\/Datos del cliente\*)/i.test(text);
  if (isSupportForm) {
    const platform = extractFormField(text, "Plataforma");
    const flow = extractFormField(text, "¿?Flujo(?: de negocio)? afectado\\??");
    const title = extractFormField(text, "T[íi]tulo(?:\\s*\\([^)]*\\))?");
    const desc = extractFormField(text, "Descripci[óo]n(?:\\s+del\\s+(?:problema|caso|incidente))?");

    if (platform || flow || title || desc) {
      const scope = [platform || "N/A", flow].filter(Boolean).join(" / ");
      const head = title || "Consulta";
      const body = desc && desc.toLowerCase() !== head.toLowerCase() ? ` — ${desc}` : "";
      return `[Soporte · ${scope}] ${head}${body}`.trim();
    }
  }

  return text;
}

function getRawMessageBody(msg: SlackRawMessage): string {
  const direct = typeof msg?.text === "string" ? msg.text.trim() : "";
  if (direct) return direct;

  if (Array.isArray(msg?.attachments)) {
    for (const att of msg.attachments) {
      if (!att || typeof att !== "object") continue;
      const parts = [att.title, att.pretext, att.text]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(" — ");
      const fallback = typeof att.fallback === "string" ? att.fallback.trim() : "";
      if (fallback) return fallback;
    }
  }
  return "";
}

/** Decide whether a Slack event is membership noise or an empty stub (e.g. empty USLACKBOT OTPs). */
export function isNoiseSlackMessage(msg: SlackRawMessage): boolean {
  if (!msg || typeof msg !== "object") return true;
  if (msg.subtype && NOISE_SUBTYPES.has(msg.subtype)) {
    return true;
  }
  return getRawMessageBody(msg).length === 0;
}

/** Extract cleaned human-readable text from a Slack message or its attachment fallback. */
export function extractMessageText(msg: SlackRawMessage, userMap?: Record<string, string>): string {
  const raw = getRawMessageBody(msg);
  if (!raw) return "";
  return cleanSlackText(raw, userMap);
}

function resolveAuthor(msg: SlackRawMessage, userMap?: Record<string, string>): string {
  if (msg.user && userMap?.[msg.user]?.trim()) {
    return userMap[msg.user].trim();
  }
  if (msg.username && msg.username.trim()) {
    return msg.username.trim();
  }
  if (msg.user && msg.user.trim()) {
    return msg.user.trim();
  }
  if (msg.bot_id && msg.bot_id.trim()) {
    return msg.bot_id.trim();
  }
  return "bot";
}

function formatSlackTimestamp(tsSeconds: number, tzOffsetMinutes?: number): string {
  const baseMs = tsSeconds * 1000;
  const offsetMin = tzOffsetMinutes ?? -new Date(baseMs).getTimezoneOffset();
  const shifted = new Date(baseMs + offsetMin * 60_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function buildDedupeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compileOptionalRegex(pattern?: string): RegExp | null {
  if (!pattern || !pattern.trim()) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** Filter, normalize, compact, deduplicate, and bound one Slack channel snapshot within the lookback window. */
export function normalizeSlackChannelSnapshot(
  snapshot: SlackChannelSnapshot,
  opts: NormalizeChannelOptions = {}
): SlackChannelDigest {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? DEFAULT_SLACK_WINDOW_HOURS;
  const cutoffMs = nowMs - windowHours * 3_600_000;
  const maxMessages = Math.max(1, opts.maxMessages ?? 10);
  const maxReplies = Math.max(0, opts.maxRepliesPerThread ?? 3);
  const includeRe = compileOptionalRegex(opts.includeRegex);
  const excludeRe = compileOptionalRegex(opts.excludeRegex);
  const shouldCompact = opts.compactForms !== false;

  const valid = (snapshot.messages || [])
    .filter((msg) => {
      const tsNum = Number(msg?.ts);
      if (!Number.isFinite(tsNum) || tsNum * 1000 < cutoffMs) return false;
      if (isNoiseSlackMessage(msg)) return false;
      return extractMessageText(msg, opts.userMap).length > 0;
    })
    .sort((a, b) => Number(b.ts) - Number(a.ts));

  const seenSignatures = new Set<string>();
  const normalized: SlackNormalizedMessage[] = [];

  for (const msg of valid) {
    const cleaned = extractMessageText(msg, opts.userMap);
    if (!cleaned) continue;

    const author = resolveAuthor(msg, opts.userMap);
    const haystack = `${author} ${cleaned}`;
    if (includeRe && !includeRe.test(haystack)) continue;
    if (excludeRe && excludeRe.test(haystack)) continue;

    const finalBody = shouldCompact ? compactStructuredSlackText(cleaned) : cleaned;
    const sig = buildDedupeSignature(finalBody);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    const replies: SlackNormalizedReply[] = [];
    if (Array.isArray(msg.replies) && msg.replies.length > 0 && maxReplies > 0) {
      const cleanReplies = msg.replies
        .filter((reply) => reply && reply.ts !== msg.ts && !isNoiseSlackMessage(reply))
        .map((reply) => ({
          reply,
          tsNum: Number(reply.ts),
          text: extractMessageText(reply, opts.userMap),
        }))
        .filter((item) => Number.isFinite(item.tsNum) && item.text.length > 0)
        .sort((a, b) => a.tsNum - b.tsNum)
        .slice(-maxReplies);

      for (const item of cleanReplies) {
        replies.push({
          ts: item.reply.ts,
          timestampLabel: formatSlackTimestamp(item.tsNum, opts.tzOffsetMinutes),
          author: resolveAuthor(item.reply, opts.userMap),
          text: truncateText(item.text, MAX_REPLY_TEXT_CHARS),
        });
      }
    }

    normalized.push({
      ts: msg.ts,
      timestampLabel: formatSlackTimestamp(Number(msg.ts), opts.tzOffsetMinutes),
      author,
      text: truncateText(finalBody, MAX_PARENT_TEXT_CHARS),
      replies,
    });

    if (normalized.length >= maxMessages) break;
  }

  return {
    id: snapshot.id,
    name: snapshot.name,
    messages: normalized,
  };
}

/** Build a compact, bounded Markdown digest across non-empty Slack channel digests. */
export function buildSlackBrainMarkdown(
  digests: SlackChannelDigest[],
  opts: BuildSlackBrainOptions = {}
): string {
  const nonEmpty = digests.filter((d) => d.messages.length > 0);
  if (nonEmpty.length === 0) return "";

  const windowHours = opts.windowHours ?? DEFAULT_SLACK_WINDOW_HOURS;
  const generatedAt = (opts.generatedAtIso ?? new Date().toISOString()).slice(0, 16);
  const maxChars = Math.max(200, opts.maxChars ?? MAX_SLACK_DIGEST_CHARS);

  const lines: string[] = [
    `# Slack Brain — Actividad Reciente (Últimas ${windowHours}h)`,
    `_Actualizado: ${generatedAt}_`,
    "",
    "Contexto reciente de canales clave de Slack (PRs, despliegues, incidentes y soporte técnico) para consultas en vivo.",
    "",
  ];

  for (const digest of nonEmpty) {
    lines.push(`## #${digest.name}`);
    for (const msg of digest.messages) {
      lines.push(`- [${msg.timestampLabel}] **${msg.author}:** ${msg.text}`);
      for (const reply of msg.replies) {
        lines.push(`  - ↳ **${reply.author}:** ${reply.text}`);
      }
    }
    lines.push("");
  }

  const out: string[] = [];
  let totalChars = 0;
  for (const line of lines) {
    const addition = (out.length > 0 ? 1 : 0) + line.length;
    if (totalChars + addition > maxChars) {
      break;
    }
    out.push(line);
    totalChars += addition;
  }

  while (out.length > 0 && (out[out.length - 1] === "" || out[out.length - 1].startsWith("## #"))) {
    out.pop();
  }

  return out.join("\n").trim();
}

/**
 * Ingest the latest Slack Brain Markdown file from disk into Team Meet's reference files
 * and index it immediately when content changed. Never throws.
 */
export async function syncSlackBrainFromDiskIntoTeamMeet(
  opts: { markdownPath?: string; allowInTest?: boolean } = {}
): Promise<boolean> {
  try {
    if (!opts.allowInTest && isRunningUnderTest()) {
      return false;
    }

    const diskPath = opts.markdownPath || resolveSlackBrainDiskPath();
    if (!fs.existsSync(diskPath)) {
      return false;
    }

    const content = fs.readFileSync(diskPath, "utf8").trim();
    if (!content) {
      return false;
    }

    const { ModesManager } = require("../ModesManager") as typeof import("../ModesManager");
    const modesMgr = ModesManager.getInstance();
    const teamMeet = modesMgr
      .getModes()
      .find((m) => m.templateType === "team-meet" || m.name === "Team Meet");
    if (!teamMeet) {
      return false;
    }

    const existing = modesMgr
      .getReferenceFiles(teamMeet.id)
      .filter((f) => f.fileName === SLACK_BRAIN_REF_FILENAME);

    if (existing.length === 1 && existing[0].content.trim() === content) {
      return false;
    }

    for (const stale of existing) {
      modesMgr.deleteReferenceFile(stale.id);
    }

    const created = modesMgr.addReferenceFile({
      modeId: teamMeet.id,
      fileName: SLACK_BRAIN_REF_FILENAME,
      content,
    });
    await modesMgr.indexReferenceFile(created);
    return true;
  } catch (err: any) {
    console.warn("[SlackBrain] Team Meet reference sync skipped (non-fatal):", err?.message);
    return false;
  }
}
