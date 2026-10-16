import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import os from "os";
import fs from "fs";

export class McpClientManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  public repoPath: string | null = null;

  /**
   * Inicializa el cliente MCP usando GitNexus en el directorio indicado.
   */
  public async startServer(repoPath: string): Promise<void> {
    if (this.client && this.repoPath === repoPath) {
      return; // Already connected to this repo
    }

    if (this.client) {
      await this.stopServer();
    }

    this.repoPath = repoPath;

    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const args = ["-y", "gitnexus", "mcp"];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: process.env.PATH
        ? `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`
        : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
    };

    this.transport = new StdioClientTransport({
      command,
      args,
      stderr: "pipe",
      cwd: repoPath,
      env
    });

    this.transport.onerror = (err) => {
      console.error("[MCP] Transport error:", err);
    };

    this.transport.stderr?.on("data", (data: any) => {
      console.error(`[MCP Server Log]: ${data.toString()}`);
    });

    this.client = new Client(
      {
        name: "natively-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {}
      }
    );

    await this.client.connect(this.transport);
    console.log(`[MCP] Connected to GitNexus server for ${repoPath}`);
  }

  /**
   * Verifica si el modo activo tiene un repo GitNexus vinculado y conecta el servidor si no lo está.
   */
  public async ensureServerForActiveMode(): Promise<string | null> {
    try {
      const { ModesManager } = require("../services/ModesManager");
      const activeMode = ModesManager.getInstance().getActiveMode();
      if (!activeMode) return this.repoPath;

      const refFiles = ModesManager.getInstance().getReferenceFiles(activeMode.id) || [];
      const mcpFile = refFiles.find((f: any) =>
        f.fileName?.includes("GitNexus") ||
        (typeof f.content === "string" && f.content.startsWith("mcp_gitnexus_path:"))
      );

      if (mcpFile && typeof mcpFile.content === "string" && mcpFile.content.startsWith("mcp_gitnexus_path:")) {
        const targetPath = mcpFile.content.replace("mcp_gitnexus_path:", "").trim();
        if (targetPath && targetPath !== this.repoPath) {
          console.log(`[MCP] Auto-starting GitNexus server for active mode "${activeMode.name}" at ${targetPath}`);
          await this.startServer(targetPath);
        }
        return targetPath;
      }
    } catch (e) {
      console.warn("[MCP] ensureServerForActiveMode failed (non-fatal):", e);
    }
    return this.repoPath;
  }

  public async getTools(): Promise<ListToolsResult> {
    if (!this.client) {
      throw new Error("MCP Client no está inicializado.");
    }
    return await this.client.listTools();
  }

  public async executeTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.client) {
      throw new Error("MCP Client no está inicializado.");
    }
    const finalArgs = { ...args };
    if (this.repoPath && !finalArgs.repo) {
      finalArgs.repo = path.basename(this.repoPath);
    }
    return await this.client.callTool({
      name,
      arguments: finalArgs,
    });
  }

  /**
   * Extrae contexto relevante del código usando GitNexus MCP (Cypher graph, symbols, context, query).
   */
  public async resolveMcpContext(userMessage: string, llmHelper?: any): Promise<string> {
    await this.ensureServerForActiveMode();
    if (!this.client || !this.repoPath) return "";

    const repoName = path.basename(this.repoPath);

    try {
      const availableTools = await this.getTools();
      const toolNames = new Set(availableTools.tools.map((t: any) => t.name));

      let contextBuilder = `--- LOCAL CODEBASE CONTEXT (via GitNexus MCP: ${repoName}) ---\n`;
      let hasData = false;

      // 1. Filtrar palabras genéricas y extraer términos de dominio
      const genericStopWords = new Set([
        "que", "qué", "hace", "hacen", "la", "el", "de", "del", "en", "para", "por", "un", "una",
        "los", "las", "es", "son", "con", "como", "cómo", "cual", "cuál", "cuales", "cuáles",
        "donde", "dónde", "quien", "quién", "me", "se", "te", "mi", "tu", "su", "al", "a", "y",
        "o", "no", "si", "sí", "dame", "busca", "muestrame", "muéstrame", "encuentra", "dime",
        "teoria", "teoría", "subi", "subí", "puse", "activo", "esta", "está", "este", "esto",
        "endpoint", "endpoints", "servicio", "servicios", "service", "services", "peticion",
        "petición", "peticiones", "request", "requests", "api", "apis", "llamada", "llamadas",
        "what", "which", "how", "the", "a", "an", "in", "to", "for", "of", "with", "is", "are"
      ]);

      const cleanedWords = userMessage
        .replace(/[^a-zA-Z0-9_\-\/]/g, " ")
        .split(/\s+/)
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length >= 3 && !genericStopWords.has(w));

      // 2. Cypher Graph Query: Extraer funciones, métodos, servicios y archivos reales
      if (toolNames.has("cypher") && cleanedWords.length > 0) {
        for (const term of cleanedWords.slice(0, 3)) {
          try {
            const cypherQuery = `MATCH (n) WHERE (toLower(n.filePath) CONTAINS "${term}" OR toLower(n.name) CONTAINS "${term}") AND n.filePath ENDS WITH ".ts" AND NOT toLower(n.filePath) CONTAINS "spec" AND NOT toLower(n.filePath) CONTAINS "test" RETURN n.name, n.filePath LIMIT 25`;
            const cypherRes = await this.executeTool("cypher", { query: cypherQuery, repo: repoName });
            const markdown = cypherRes?.content?.[0]?.text;
            
            if (markdown && markdown.includes("|") && !markdown.includes("error")) {
              contextBuilder += `### Code Graph Symbols for "${term}":\n${markdown}\n\n`;
              hasData = true;
            }
          } catch (e: any) {
            console.warn(`[MCP] Cypher query failed for "${term}":`, e?.message);
          }
        }
      }

      // 3. Consultar `context` para los primeros símbolos relevantes
      if (toolNames.has("context") && cleanedWords.length > 0) {
        for (const term of cleanedWords.slice(0, 2)) {
          try {
            const ctxRes = await this.executeTool("context", { name: term, repo: repoName });
            const text = ctxRes?.content?.[0]?.text;
            if (text && text.length > 30 && !text.includes("error") && !text.includes("not_found")) {
              contextBuilder += `### Detailed Symbol Context for "${term}":\n${text}\n\n`;
              hasData = true;
            }
          } catch { /* non-fatal */ }
        }
      }

      // 4. Consultar `query` de GitNexus para flujos conceptuales
      if (toolNames.has("query") && cleanedWords.length > 0) {
        for (const term of cleanedWords.slice(0, 2)) {
          try {
            const queryRes = await this.executeTool("query", { query: term, repo: repoName });
            const text = queryRes?.content?.[0]?.text;
            if (text && text.length > 30 && !text.includes("Error:")) {
              contextBuilder += `### Execution Flows & Processes for "${term}":\n${text}\n\n`;
              hasData = true;
            }
          } catch (e: any) {
            console.warn(`[MCP] query tool failed for "${term}":`, e?.message);
          }
        }
      }

      if (hasData) {
        contextBuilder += "--- END LOCAL CODEBASE CONTEXT ---\n";
        return contextBuilder;
      }

      return "";
    } catch (e: any) {
      console.error("[MCP] Error in resolveMcpContext:", e);
      return "";
    }
  }

  public async stopServer(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch { /* noop */ }
      this.transport = null;
    }
    this.client = null;
    this.repoPath = null;
    console.log("[MCP] Server stopped.");
  }
}

export const mcpClient = new McpClientManager();
