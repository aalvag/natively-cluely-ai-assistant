// Shared production reference-file ingestion for Modes Manager uploads.
//
// The dialog IPC and the gated E2E benchmark ingress both call this use case so
// benchmark parsing/persistence cannot silently drift from the user-facing path.
//
// Senior-review fix (2026-07-16, audit ab9dc2f0): this module previously
// duplicated the SAFE_DOCUMENT_EXTENSIONS format list, BOM/symlink safety,
// PDF worker pin, and PDF/DOCX/text parsing. Migrated to the shared
// SafeDocumentTextExtractor.extractSafeDocumentText so a format/safety
// fix in the shared utility automatically applies here AND to the
// Profile Intelligence upload path (premium/electron/knowledge/
// DocumentReader.ts which has used it since commit 41edd51). The
// MODE_REFERENCE_FILE_EXTENSIONS / MODE_REFERENCE_FILE_MAX_BYTES exports
// remain ON the file (re-exported from the shared utility) so callers
// that imported them from this module keep working.

import * as crypto from 'crypto';
import { ModesManager } from './ModesManager';
import {
  extractSafeDocumentText,
  SAFE_DOCUMENT_EXTENSIONS,
  SAFE_DOCUMENT_MAX_BYTES,
} from './SafeDocumentTextExtractor';

// Retain the Modes-facing exports while sharing one document-format contract.
export const MODE_REFERENCE_FILE_EXTENSIONS = SAFE_DOCUMENT_EXTENSIONS;
export const MODE_REFERENCE_FILE_MAX_BYTES = SAFE_DOCUMENT_MAX_BYTES;

export interface ModeReferenceFileIngestResult {
  id: string;
  fileName: string;
  /**
   * Extracted text content. Bug fix (2026-07-26): this was previously
   * omitted from the returned result, even though it was fully available
   * (`extracted.content`) — the renderer pushes this result straight into
   * its `referenceFiles` list (ModesSettings.tsx's `uploadFile`) and then
   * renders `file.content.length` unconditionally, so every successful
   * upload crashed the Modes settings panel until the next full reload
   * (which re-fetches via `modes:get-reference-files`, whose `rowToFile`
   * mapping always included `content`).
   */
  content: string;
  pageCount?: number;
  extractedPageCount?: number;
  binarySha256: string;
  contentSha256: string;
}

export interface ModeReferenceFileIngestOptions {
  modeId: string;
  filePath: string;
  onIndexStatus?: (status: 'indexing' | 'done', fileId: string) => void;
}

/**
 * Parse, persist, and begin indexing a user-selected regular file. Callers must
 * perform UI/authorization policy; this use case delegates file safety, format
 * checks, and PDF/DOCX/text parsing to the shared SafeDocumentTextExtractor.
 */
export const ingestModeReferenceFile = async (
  options: ModeReferenceFileIngestOptions,
): Promise<ModeReferenceFileIngestResult> => {
  const extracted = await extractSafeDocumentText(options.filePath);
  const contentSha256 = crypto.createHash('sha256').update(extracted.content).digest('hex');
  const manager = ModesManager.getInstance();
  const file = manager.addReferenceFile({
    modeId: options.modeId,
    fileName: extracted.fileName,
    content: extracted.content,
    pageCount: extracted.pageCount,
    extractedPageCount: extracted.extractedPageCount,
  });

  options.onIndexStatus?.('indexing', file.id);
  void (async () => {
    try {
      await manager.indexReferenceFile(file);
      const finalStatus = manager.getReferenceFileIndexStatus(file.id);
      if (finalStatus?.status === 'failed' || finalStatus?.status === 'lexical_only') {
        // The caller's application lifecycle owns retries; this preserves the
        // normal upload's non-blocking response behavior.
      }
    } catch (error: any) {
      console.warn('[ModeReferenceFileIngestion] index failed (lexical fallback remains):', error?.message);
    } finally {
      options.onIndexStatus?.('done', file.id);
    }
  })();

  return {
    id: file.id,
    fileName: extracted.fileName,
    content: extracted.content,
    pageCount: extracted.pageCount,
    extractedPageCount: extracted.extractedPageCount,
    binarySha256: extracted.binarySha256,
    contentSha256,
  };
};

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'target',
  '.next', '.nuxt', '.output', '.venv', 'venv', 'env', 'vendor',
  'coverage', '.turbo', '.cache', '.idea', '.vscode', '__pycache__',
  '.pytest_cache', '.mypy_cache', 'bin', 'obj',
]);

const IGNORED_FILE_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock',
  'poetry.lock', 'composer.lock', 'gemfile.lock', '.ds_store', 'thumbs.db',
]);

const MAX_FOLDER_FILES = 200;
const MAX_FOLDER_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ModeReferenceFolderIngestResult {
  totalFiles: number;
  ingestedFiles: ModeReferenceFileIngestResult[];
  skippedCount: number;
}

/**
 * Recursively scans a selected repository or project folder, filtering out build
 * artifacts and dependencies, and ingests all source code/document files into the mode.
 */
export const ingestModeReferenceFolder = async (
  options: {
    modeId: string;
    folderPath: string;
    onIndexStatus?: (status: 'indexing' | 'done', fileId: string) => void;
  },
): Promise<ModeReferenceFolderIngestResult> => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const rootDir = path.resolve(options.folderPath);

  const discoveredPaths: string[] = [];
  let totalBytes = 0;

  const scanDir = async (currentDir: string): Promise<void> => {
    if (discoveredPaths.length >= MAX_FOLDER_FILES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (discoveredPaths.length >= MAX_FOLDER_FILES) break;
      const fullPath = path.join(currentDir, entry.name);
      const lowerName = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(lowerName) && !lowerName.startsWith('.')) {
          await scanDir(fullPath);
        }
      } else if (entry.isFile()) {
        if (IGNORED_FILE_NAMES.has(lowerName) || lowerName.endsWith('.min.js') || lowerName.endsWith('.map')) {
          continue;
        }
        const ext = path.extname(lowerName);
        if (SAFE_DOCUMENT_EXTENSIONS.has(ext)) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size <= SAFE_DOCUMENT_MAX_BYTES && totalBytes + stat.size <= MAX_FOLDER_TOTAL_BYTES) {
              totalBytes += stat.size;
              discoveredPaths.push(fullPath);
            }
          } catch {}
        }
      }
    }
  };

  await scanDir(rootDir);

  const manager = ModesManager.getInstance();
  const ingestedFiles: ModeReferenceFileIngestResult[] = [];
  let skippedCount = 0;

  for (const filePath of discoveredPaths) {
    try {
      const extracted = await extractSafeDocumentText(filePath);
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      const contentSha256 = crypto.createHash('sha256').update(extracted.content).digest('hex');

      const file = manager.addReferenceFile({
        modeId: options.modeId,
        fileName: relPath, // Store relative path for rich contextual matching
        content: extracted.content,
        pageCount: extracted.pageCount,
        extractedPageCount: extracted.extractedPageCount,
      });

      options.onIndexStatus?.('indexing', file.id);
      void (async () => {
        try {
          await manager.indexReferenceFile(file);
        } catch (error: any) {
          console.warn('[ModeReferenceFileIngestion] folder file index failed:', error?.message);
        } finally {
          options.onIndexStatus?.('done', file.id);
        }
      })();

      ingestedFiles.push({
        id: file.id,
        fileName: relPath,
        content: extracted.content,
        pageCount: extracted.pageCount,
        extractedPageCount: extracted.extractedPageCount,
        binarySha256: extracted.binarySha256,
        contentSha256,
      });
    } catch {
      skippedCount++;
    }
  }

  return {
    totalFiles: ingestedFiles.length,
    ingestedFiles,
    skippedCount,
  };
};