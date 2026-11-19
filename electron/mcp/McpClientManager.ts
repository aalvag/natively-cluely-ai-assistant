import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import os from "os";
import fs from "fs";

export type McpBackendKind = "codegraph" | "gitnexus";

export const CODEGRAPH_REF_PREFIX = "mcp_codegraph_path:";
export const LEGACY_GITNEXUS_REF_PREFIX = "mcp_gitnexus_path:";

const MCP_TOOL_TIMEOUT_MS = 2_500;
const MAX_MCP_CONTEXT_CHARS = 6_000;
const MAX_SEARCH_TERMS = 2;
const MAX_ACTIVE_REPOS = 3;
const MAX_QUERIED_REPOS_PER_TURN = 2;

export interface RepoServerConnection {
  repoPath: string;
  backend: McpBackendKind;
  client: Client;
  transport: StdioClientTransport;
}

const STOP_WORDS = new Set([
  "que", "qué", "hace", "hacen", "la", "el", "de", "del", "en", "para", "por", "un", "una",
  "los", "las", "es", "son", "con", "como", "cómo", "cual", "cuál", "cuales", "cuáles",
  "donde", "dónde", "quien", "quién", "me", "se", "te", "mi", "tu", "su", "al", "a", "y",
  "o", "no", "si", "sí", "dame", "busca", "muestrame", "muéstrame", "encuentra", "dime",
  "teoria", "teoría", "subi", "subí", "puse", "activo", "esta", "está", "este", "esto",
  "endpoint", "endpoints", "servicio", "servicios", "service", "services", "peticion",
  "petición", "peticiones", "request", "requests", "api", "apis", "llamada", "llamadas",
  "what", "which", "how", "where", "when", "who", "why", "the", "a", "an", "in", "to",
  "for", "of", "with", "is", "are", "was", "were", "does", "did", "can", "could", "show",
  "find", "tell", "about", "there", "this", "that", "from", "into",
]);

/** Build an augmented PATH so macOS GUI launches find ~/.local/bin and Homebrew tools. */
export function buildAugmentedEnv(): Record<string, string> {
  const extraDirs = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const merged = Array.from(new Set([...current, ...extraDirs].filter(Boolean)));
  return {
    ...(process.env as Record<string, string>),
    PATH: merged.join(path.delimiter),
  };
}

/** Resolve the `codegraph` binary path across user-local, Homebrew, and PATH locations. */
export function resolveCodegraphBinary(): string | null {
  const candidates = [
    process.env.NATIVELY_CODEGRAPH_BIN,
    path.join(os.homedir(), ".local", "bin", "codegraph"),
    "/opt/homebrew/bin/codegraph",
    "/usr/local/bin/codegraph",
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable candidates and continue checking.
    }
  }
  return null;
}

/** Parse a mode reference file entry that points to a local MCP-indexed repository. */
export function parseMcpReferenceMarker(ref: { fileName?: string; content?: string } | null | undefined): {
  backendHint: McpBackendKind;
  repoPath: string;
} | null {
  const content = typeof ref?.content === "string" ? ref.content.trim() : "";
  if (content.startsWith(CODEGRAPH_REF_PREFIX)) {
    const repoPath = content.slice(CODEGRAPH_REF_PREFIX.length).trim();
    return repoPath ? { backendHint: "codegraph", repoPath } : null;
  }
  if (content.startsWith(LEGACY_GITNEXUS_REF_PREFIX)) {
    const repoPath = content.slice(LEGACY_GITNEXUS_REF_PREFIX.length).trim();
    return repoPath ? { backendHint: "gitnexus", repoPath } : null;
  }
  return null;
}

/** Select the MCP backend for `repoPath`, preferring CodeGraph whenever available. */
export function selectMcpBackend(repoPath: string, backendHint?: McpBackendKind): {
  backend: McpBackendKind;
  command: string;
  args: string[];
} {
  const codegraphBin = resolveCodegraphBinary();
  const hasCodegraphIndex = fs.existsSync(path.join(repoPath, ".codegraph"));
  const hasGitnexusIndex = fs.existsSync(path.join(repoPath, ".gitnexus"));

  const shouldUseCodegraph =
    Boolean(codegraphBin) &&
    (hasCodegraphIndex || backendHint === "codegraph" || !hasGitnexusIndex);

  if (shouldUseCodegraph && codegraphBin) {
    return {
      backend: "codegraph",
      command: codegraphBin,
      args: ["serve", "--mcp", "--no-watch", "--path", repoPath],
    };
  }

  return {
    backend: "gitnexus",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "gitnexus", "mcp"],
  };
}

/** Extract high-signal technical tokens from a user question for graph symbol fallback lookups. */
export function extractQueryTerms(userMessage: string): string[] {
  const tokens = String(userMessage ?? "")
    .replace(/[^a-zA-Z0-9_\-/]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));

  return Array.from(new Set(tokens));
}

/** Rank linked repository paths by relevance to `userMessage`, preserving input order on ties. */
export function rankReposForMessage(repoPaths: string[], userMessage: string): string[] {
  const lowerMsg = String(userMessage ?? "").toLowerCase();
  const msgTokens = new Set(lowerMsg.split(/[^a-z0-9]+/).filter(Boolean));

  const scored = repoPaths.map((repoPath, index) => {
    const baseName = path.basename(repoPath).toLowerCase();
    const baseTokens = baseName.split(/[-_\s]+/).filter((t) => t.length >= 2);
    let score = 0;

    if (baseName && lowerMsg.includes(baseName)) {
      score += 3;
    }
    for (const token of baseTokens) {
      if (msgTokens.has(token) || (token.length >= 3 && lowerMsg.includes(token))) {
        score += 2;
      }
    }
    if (lowerMsg.includes("backoffice") && baseName.includes("admin")) {
      score += 1;
    }
    return { repoPath, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((item) => item.repoPath);
}

function readToolText(result: any): string {
  const chunks = Array.isArray(result?.content) ? result.content : [];
  return chunks
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class McpClientManager {
  private servers = new Map<string, RepoServerConnection>();
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  public repoPath: string | null = null;
  public backend: McpBackendKind | null = null;

  private syncPrimaryFields(preferredRepoPath?: string): void {
    const picked =
      (preferredRepoPath && this.servers.get(preferredRepoPath)) ||
      this.servers.values().next().value ||
      null;

    if (picked) {
      this.client = picked.client;
      this.transport = picked.transport;
      this.repoPath = picked.repoPath;
      this.backend = picked.backend;
    } else {
      this.client = null;
      this.transport = null;
      this.repoPath = null;
      this.backend = null;
    }
  }

  /** Return all currently active repository paths managed by MCP servers. */
  public getActiveRepoPaths(): string[] {
    if (this.servers.size > 0) {
      return Array.from(this.servers.keys());
    }
    return this.repoPath ? [this.repoPath] : [];
  }

  /** Start a CodeGraph (preferred) or legacy GitNexus MCP stdio server for `repoPath`. */
  public async startServer(repoPath: string, backendHint?: McpBackendKind): Promise<void> {
    if (this.servers.has(repoPath)) {
      this.syncPrimaryFields(repoPath);
      return;
    }

    if (this.servers.size >= MAX_ACTIVE_REPOS) {
      const oldestRepo = this.servers.keys().next().value;
      if (oldestRepo) {
        await this.stopServer(oldestRepo);
      }
    } else if (this.servers.size === 0 && this.transport) {
      await this.stopServer();
    }

    const launch = selectMcpBackend(repoPath, backendHint);
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      stderr: "pipe",
      cwd: repoPath,
      env: buildAugmentedEnv(),
    });

    transport.onerror = (err) => {
      console.error(`[MCP ${path.basename(repoPath)}] Transport error:`, err);
    };

    transport.stderr?.on("data", (data: any) => {
      console.error(`[MCP ${launch.backend} ${path.basename(repoPath)} stderr]: ${data.toString()}`);
    });

    const client = new Client(
      {
        name: "natively-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    this.servers.set(repoPath, {
      repoPath,
      backend: launch.backend,
      client,
      transport,
    });
    this.syncPrimaryFields(this.servers.size === 1 ? repoPath : undefined);
    console.log(`[MCP] Connected to ${launch.backend} server for ${repoPath}`);
  }

  /** Ensure MCP servers match all repositories linked to the currently active mode (up to MAX_ACTIVE_REPOS). */
  public async ensureServerForActiveMode(): Promise<string | null> {
    try {
      const { ModesManager } = require("../services/ModesManager");
      const activeMode = ModesManager.getInstance().getActiveMode();
      if (!activeMode) return this.repoPath;

      const refFiles = ModesManager.getInstance().getReferenceFiles(activeMode.id) || [];
      const markers: Array<{ backendHint: McpBackendKind; repoPath: string }> = [];
      const seenPaths = new Set<string>();
      for (const ref of refFiles) {
        const marker = parseMcpReferenceMarker(ref);
        if (!marker || seenPaths.has(marker.repoPath)) continue;
        seenPaths.add(marker.repoPath);
        markers.push(marker);
        if (markers.length >= MAX_ACTIVE_REPOS) break;
      }

      if (markers.length === 0) {
        return this.repoPath;
      }

      const targetPaths = new Set(markers.map((m) => m.repoPath));
      for (const existingPath of Array.from(this.servers.keys())) {
        if (!targetPaths.has(existingPath)) {
          await this.stopServer(existingPath);
        }
      }

      for (const marker of markers) {
        if (this.servers.has(marker.repoPath)) continue;
        try {
          console.log(`[MCP] Auto-starting ${marker.backendHint} server for mode "${activeMode.name}" at ${marker.repoPath}`);
          await this.startServer(marker.repoPath, marker.backendHint);
        } catch (err) {
          console.warn(`[MCP] Failed to start ${marker.backendHint} server for ${marker.repoPath} (non-fatal):`, err);
        }
      }

      const firstActive = markers.find((m) => this.servers.has(m.repoPath));
      if (firstActive) {
        this.syncPrimaryFields(firstActive.repoPath);
      }
      return this.repoPath;
    } catch (e) {
      console.warn("[MCP] ensureServerForActiveMode failed (non-fatal):", e);
    }
    return this.repoPath;
  }

  public async getTools(): Promise<ListToolsResult> {
    if (!this.client) {
      throw new Error("MCP Client is not initialized.");
    }
    return await this.client.listTools();
  }

  private async executeToolOnClient(client: Client, name: string, args: Record<string, any>): Promise<any> {
    const call = client.callTool({ name, arguments: args });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP tool "${name}" timed out after ${MCP_TOOL_TIMEOUT_MS}ms`)), MCP_TOOL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async executeTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.client) {
      throw new Error("MCP Client is not initialized.");
    }
    return await this.executeToolOnClient(this.client, name, args);
  }

  /** Retrieve bounded repository context for `userMessage` across linked CodeGraph/GitNexus servers. */
  public async resolveMcpContext(userMessage: string, _llmHelper?: any): Promise<string> {
    await this.ensureServerForActiveMode();

    const targets: Array<{ repoPath: string; backend: McpBackendKind; client: Client }> = [];
    if (this.servers.size > 0) {
      const rankedPaths = rankReposForMessage(Array.from(this.servers.keys()), userMessage).slice(
        0,
        MAX_QUERIED_REPOS_PER_TURN
      );
      for (const repoPath of rankedPaths) {
        const conn = this.servers.get(repoPath);
        if (conn) targets.push(conn);
      }
    } else if (this.client && this.repoPath) {
      targets.push({
        repoPath: this.repoPath,
        backend: this.backend ?? "codegraph",
        client: this.client,
      });
    }

    if (targets.length === 0) return "";

    const perRepoBudget =
      targets.length > 1 ? Math.floor(MAX_MCP_CONTEXT_CHARS / targets.length) : MAX_MCP_CONTEXT_CHARS;

    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        const repoName = path.basename(target.repoPath);
        const availableTools = await target.client.listTools();
        const toolNames = new Set(availableTools.tools.map((t: any) => t.name));

        if (toolNames.has("codegraph_context") || toolNames.has("codegraph_search")) {
          return await this.resolveCodegraphContext(target.client, userMessage, repoName, toolNames, perRepoBudget);
        }
        return await this.resolveLegacyGitNexusContext(target.client, userMessage, repoName, toolNames, perRepoBudget);
      })
    );

    const blocks: string[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled" && item.value) {
        blocks.push(item.value);
      } else if (item.status === "rejected") {
        console.error("[MCP] Error in resolveMcpContext:", item.reason);
      }
    }

    if (blocks.length === 0) return "";
    return blocks.join("\n").slice(0, MAX_MCP_CONTEXT_CHARS);
  }

  private async resolveCodegraphContext(
    client: Client,
    userMessage: string,
    repoName: string,
    toolNames: Set<string>,
    maxChars: number
  ): Promise<string> {
    const sections: string[] = [];

    if (toolNames.has("codegraph_context")) {
      try {
        const res = await this.executeToolOnClient(client, "codegraph_context", {
          task: userMessage,
          includeCode: true,
          maxNodes: 8,
        });
        const text = readToolText(res);
        if (text && !/no (?:relevant )?symbols found|error:/i.test(text.slice(0, 120))) {
          sections.push(`### CodeGraph Context:\n${text}`);
        }
      } catch (e: any) {
        console.warn(`[MCP ${repoName}] codegraph_context failed:`, e?.message);
      }
    }

    if (sections.length === 0 && toolNames.has("codegraph_search")) {
      const terms = extractQueryTerms(userMessage).slice(0, MAX_SEARCH_TERMS);
      for (const term of terms) {
        try {
          const res = await this.executeToolOnClient(client, "codegraph_search", { query: term, limit: 8 });
          const text = readToolText(res);
          if (text && !/no (?:symbols|results) found|error:/i.test(text.slice(0, 120))) {
            sections.push(`### CodeGraph Search ("${term}"):\n${text}`);
          }
        } catch (e: any) {
          console.warn(`[MCP ${repoName}] codegraph_search failed for "${term}":`, e?.message);
        }
      }
    }

    if (sections.length === 0) return "";
    const header = `--- LOCAL CODEBASE CONTEXT (via CodeGraph MCP: ${repoName}) ---\n`;
    const footer = `\n--- END LOCAL CODEBASE CONTEXT ---\n`;
    const bodyLimit = Math.max(100, maxChars - header.length - footer.length);
    const body = sections.join("\n\n").slice(0, bodyLimit);
    return `${header}${body}${footer}`;
  }

  private async resolveLegacyGitNexusContext(
    client: Client,
    userMessage: string,
    repoName: string,
    toolNames: Set<string>,
    maxChars: number
  ): Promise<string> {
    const sections: string[] = [];
    const cleanedWords = extractQueryTerms(userMessage).map((w) => w.toLowerCase());

    if (toolNames.has("cypher") && cleanedWords.length > 0) {
      for (const term of cleanedWords.slice(0, 3)) {
        try {
          const cypherQuery = `MATCH (n) WHERE (toLower(n.filePath) CONTAINS "${term}" OR toLower(n.name) CONTAINS "${term}") AND n.filePath ENDS WITH ".ts" AND NOT toLower(n.filePath) CONTAINS "spec" AND NOT toLower(n.filePath) CONTAINS "test" RETURN n.name, n.filePath LIMIT 25`;
          const cypherRes = await this.executeToolOnClient(client, "cypher", { query: cypherQuery, repo: repoName });
          const markdown = readToolText(cypherRes);
          if (markdown.includes("|") && !markdown.includes("error")) {
            sections.push(`### Code Graph Symbols for "${term}":\n${markdown}`);
          }
        } catch (e: any) {
          console.warn(`[MCP ${repoName}] Cypher query failed for "${term}":`, e?.message);
        }
      }
    }

    if (toolNames.has("context") && cleanedWords.length > 0) {
      for (const term of cleanedWords.slice(0, MAX_SEARCH_TERMS)) {
        try {
          const ctxRes = await this.executeToolOnClient(client, "context", { name: term, repo: repoName });
          const text = readToolText(ctxRes);
          if (text.length > 30 && !text.includes("error") && !text.includes("not_found")) {
            sections.push(`### Detailed Symbol Context for "${term}":\n${text}`);
          }
        } catch {
          // Non-fatal fallback miss.
        }
      }
    }

    if (toolNames.has("query") && cleanedWords.length > 0) {
      for (const term of cleanedWords.slice(0, MAX_SEARCH_TERMS)) {
        try {
          const queryRes = await this.executeToolOnClient(client, "query", { query: term, repo: repoName });
          const text = readToolText(queryRes);
          if (text.length > 30 && !text.includes("Error:")) {
            sections.push(`### Execution Flows & Processes for "${term}":\n${text}`);
          }
        } catch (e: any) {
          console.warn(`[MCP ${repoName}] query tool failed for "${term}":`, e?.message);
        }
      }
    }

    if (sections.length === 0) return "";
    const header = `--- LOCAL CODEBASE CONTEXT (via GitNexus MCP: ${repoName}) ---\n`;
    const footer = `\n--- END LOCAL CODEBASE CONTEXT ---\n`;
    const bodyLimit = Math.max(100, maxChars - header.length - footer.length);
    const body = sections.join("\n\n").slice(0, bodyLimit);
    return `${header}${body}${footer}`;
  }

  /** Stop one specific repository MCP server, or all active servers if `repoPath` is omitted. */
  public async stopServer(repoPath?: string): Promise<void> {
    if (repoPath) {
      const entry = this.servers.get(repoPath);
      if (entry) {
        this.servers.delete(repoPath);
        try {
          await entry.transport.close();
        } catch {
          // Ignore close errors during teardown.
        }
        this.syncPrimaryFields();
        console.log(`[MCP] Server stopped for ${repoPath}.`);
      }
      return;
    }

    for (const entry of this.servers.values()) {
      try {
        await entry.transport.close();
      } catch {
        // Ignore close errors during teardown.
      }
    }
    if (this.servers.size === 0 && this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors during teardown.
      }
    }
    this.servers.clear();
    this.syncPrimaryFields();
    console.log("[MCP] Server stopped.");
  }
}

export const mcpClient = new McpClientManager();
