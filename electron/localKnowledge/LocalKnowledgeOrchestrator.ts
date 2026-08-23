// electron/localKnowledge/LocalKnowledgeOrchestrator.ts
//
// The local implementation of the knowledge orchestrator the free tree calls.
//
// `processQuestion()` is the method that matters. Its consumers impose a real
// contract, and each of the decisions below exists because of one of them:
//
// - It runs inside a 2000 ms grounding budget
//   (electron/IntelligenceEngine.ts:1636). Overrunning it does not degrade the
//   answer gracefully; `withTimeout` discards the whole result and the turn
//   proceeds with no grounding at all.
// - `factualRecall: true` bypasses the mode-compatibility gate that otherwise
//   blocks profile injection (electron/LLMHelper.ts:2740), so it must mean the
//   content really is the candidate's own plain facts.
// - Returning null is legal and means "no grounding available". It is not an
//   error, and callers treat it as an ordinary ungrounded turn.
//
// The evidence itself is selected by the free tree's own deterministic
// selector, `buildManualProfileEvidenceRoute`, rather than by logic invented
// here. That keeps one implementation of "which facts answer this question"
// and inherits its source-authorization filtering.

import { buildManualProfileEvidenceRoute } from '../llm/profileAnswerBackend';
import type { AnswerType } from '../llm/AnswerPlanner';
import type {
  ManualProfileRouteResult,
  StructuredJobFacts,
  StructuredProfileFacts,
} from '../llm/manualProfileIntelligence';
import { readLocalDocument } from './DocumentReader';
import { extractStructuredProfile, type ExtractProfileOptions } from './ResumeExtractor';
import { ProfileIndex } from './ProfileIndex';
import { DocType, type IngestResult, type PromptAssemblyResult } from './types';

/**
 * How long retrieval may take before the deterministic evidence is returned
 * without it.
 *
 * The outer budget is 2000 ms and expiring it loses everything, so the vector
 * search is capped well below that. The deterministic route costs no I/O, so
 * this trade always returns something rather than risking the whole result on
 * a slow embedding call.
 */
const RETRIEVAL_BUDGET_MS = 1200;

/** Answer shapes that are the candidate's own plain facts. */
const FACTUAL_RECALL_ANSWER_TYPES: ReadonlySet<AnswerType> = new Set<AnswerType>([
  'identity_answer',
  'profile_fact_answer',
  'project_answer',
  'skills_answer',
  'skill_experience_answer',
  'experience_answer',
]);

/**
 * Answer shapes that are an introduction.
 *
 * `resume_jd_intro_answer` is included because "tell me about myself for this
 * role" is still an intro, just one that draws on the job description too.
 */
const INTRO_ANSWER_TYPES: ReadonlySet<AnswerType> = new Set<AnswerType>([
  'identity_answer',
  'resume_jd_intro_answer',
]);

export interface LocalKnowledgeOrchestratorDependencies {
  profileIndex: ProfileIndex;
  /** Passed through to the resume extractor; mainly a test seam. */
  extractionOptions?: ExtractProfileOptions;
  retrievalBudgetMs?: number;
}

export class LocalKnowledgeOrchestrator {
  private readonly profileIndex: ProfileIndex;
  private readonly extractionOptions: ExtractProfileOptions;
  private readonly retrievalBudgetMs: number;
  private knowledgeMode = false;

  constructor(depsOrIndex: LocalKnowledgeOrchestratorDependencies | ProfileIndex | any) {
    if (depsOrIndex instanceof ProfileIndex || (depsOrIndex && typeof depsOrIndex.get === 'function')) {
      this.profileIndex = depsOrIndex;
      this.extractionOptions = {};
      this.retrievalBudgetMs = RETRIEVAL_BUDGET_MS;
    } else if (depsOrIndex && depsOrIndex.profileIndex) {
      this.profileIndex = depsOrIndex.profileIndex;
      this.extractionOptions = depsOrIndex.extractionOptions ?? {};
      this.retrievalBudgetMs = depsOrIndex.retrievalBudgetMs ?? RETRIEVAL_BUDGET_MS;
    } else if (depsOrIndex && typeof depsOrIndex.exec === 'function') {
      this.profileIndex = new ProfileIndex(depsOrIndex);
      this.extractionOptions = {};
      this.retrievalBudgetMs = RETRIEVAL_BUDGET_MS;
    } else {
      this.profileIndex = depsOrIndex?.profileIndex;
      this.extractionOptions = depsOrIndex?.extractionOptions ?? {};
      this.retrievalBudgetMs = depsOrIndex?.retrievalBudgetMs ?? RETRIEVAL_BUDGET_MS;
    }
  }

  // --- Shape the deterministic selector reads ------------------------------
  //
  // `buildManualProfileEvidenceRoute` takes an orchestrator and reads
  // `activeResume.structured_data` off it (electron/llm/profileAnswerBackend.ts:51).
  // Exposing these getters lets this class be passed to it directly.

  get activeResume(): { structured_data: StructuredProfileFacts | null } | null {
    const stored = this.profileIndex.get(DocType.RESUME);
    return stored ? { structured_data: (stored.structuredData as StructuredProfileFacts | null) } : null;
  }

  /**
   * A job description carries StructuredJobFacts, not a profile.
   *
   * `structured_data` is null today for every JD: the extractor structures
   * resumes only, so the selector's jd_* answer shapes cannot fire yet. The
   * JD's text is still indexed and still reachable through retrieval.
   */
  get activeJD(): { structured_data: StructuredJobFacts | null } | null {
    const stored = this.profileIndex.get(DocType.JD);
    return stored ? { structured_data: (stored.structuredData as StructuredJobFacts | null) } : null;
  }

  // --- Ingestion -----------------------------------------------------------

  private generateContentFn: any = null;

  /**
   * Read, structure, and index one document.
   *
   * Structured extraction runs inline because the deterministic answer path
   * needs it: without `structured_data` the selector has nothing to select and
   * every profile question falls back to raw passages. It is also the slow
   * step, since it waits on a local model.
   */
  async ingestDocument(filePath: string, docType: DocType): Promise<IngestResult> {
    const read = await readLocalDocument(filePath, docType);
    if (!read.success || !read.document) {
      return { success: false, error: read.error };
    }

    let extraction: { structured_data: Record<string, unknown>; extractionMode: string } | null = null;
    if (docType === DocType.RESUME) {
      const opts: ExtractProfileOptions = { ...this.extractionOptions };
      if (!opts.llmGenerateFn && typeof this.generateContentFn === 'function') {
        opts.llmGenerateFn = async (sys: string, usr: string) => {
          return await this.generateContentFn([{ text: sys }, { text: usr }]) || '';
        };
      }
      if (!opts.llmGenerateFn) {
        try {
          const { app } = require('electron');
          if (app && typeof app.getPath === 'function') {
            const { LLMHelper } = require('../LLMHelper');
            const { CredentialsManager } = require('../services/CredentialsManager');
            const credMgr = CredentialsManager.getInstance();
            const geminiKey = credMgr.getGeminiApiKey();
            const groqKey = credMgr.getGroqApiKey();
            const openaiKey = credMgr.getOpenaiApiKey();
            const claudeKey = credMgr.getClaudeApiKey();
            const deepseekKey = credMgr.getDeepseekApiKey();
            if (geminiKey || groqKey || openaiKey || claudeKey || deepseekKey) {
              const helper = new LLMHelper(geminiKey, false, undefined, undefined, groqKey, openaiKey, claudeKey, deepseekKey);
              opts.llmGenerateFn = async (sys: string, usr: string) => {
                return await helper.generateMeetingSummary(sys, usr, sys) || '';
              };
            }
          }
        } catch (e) {
          console.warn('[LocalKnowledgeOrchestrator] LLMHelper fallback init error:', e);
        }
      }
      const result = await extractStructuredProfile(read.document, opts);
      extraction = {
        structured_data: result.structured_data as unknown as Record<string, unknown>,
        extractionMode: result.extractionMode,
      };
    }

    try {
      await this.profileIndex.put(read.document, extraction);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `The document could not be saved: ${message}` };
    }
  }

  deleteDocumentsByType(docType: DocType): boolean {
    return this.profileIndex.deleteByType(docType);
  }

  // --- Knowledge mode ------------------------------------------------------

  setKnowledgeMode(enabled: boolean): void {
    this.knowledgeMode = Boolean(enabled);
  }

  isKnowledgeMode(): boolean {
    return this.knowledgeMode;
  }

  getStatus(): {
    hasResume: boolean;
    hasJD: boolean;
    activeMode: boolean;
    resumeSummary?: {
      name?: string;
      role?: string;
      totalExperienceYears?: number;
    };
  } {
    const resume = this.profileIndex.get(DocType.RESUME);
    const jd = this.profileIndex.get(DocType.JD);
    const structured = resume?.structuredData as any;
    return {
      hasResume: Boolean(resume),
      hasJD: Boolean(jd),
      activeMode: this.knowledgeMode,
      resumeSummary: structured ? {
        name: structured.name || structured.candidate_name,
        role: structured.role || structured.current_role || structured.experience?.[0]?.role,
        totalExperienceYears: structured.total_years_experience ?? (Array.isArray(structured.experience) ? structured.experience.length : 0),
      } : undefined,
    };
  }

  getProfileData(): Record<string, any> {
    const resume = this.profileIndex.get(DocType.RESUME);
    const jd = this.profileIndex.get(DocType.JD);
    const structured = (resume?.structuredData || {}) as any;
    return {
      hasProfile: Boolean(resume),
      profileMode: this.knowledgeMode,
      name: structured.name || structured.candidate_name || '',
      role: structured.role || structured.current_role || structured.experience?.[0]?.role || '',
      experience: structured.experience || [],
      skills: structured.skills || [],
      skillsFlat: structured.skills_flat || [],
      totalExperienceYears: structured.total_years_experience ?? (Array.isArray(structured.experience) ? structured.experience.length : 0),
      projects: structured.projects || [],
      education: structured.education || [],
      extractionMode: structured._extraction_mode || 'heuristic',
      rawResumeText: resume?.content || '',
      hasActiveJD: Boolean(jd),
      activeJD: jd ? {
        text: jd.content,
        title: (jd.structuredData as any)?.title || 'Target Role',
        company: (jd.structuredData as any)?.company || '',
      } : undefined,
    };
  }

  setGenerateContentFn(fn: any): void {
    this.generateContentFn = fn;
  }
  setLiveCoachingContentFn(_fn: any): void {}
  setSearchProviderResolver(_fn: any): void {}
  setEmbedFn(_fn: any): void {}
  setEmbedWithMetadataFn(_fn: any): void {}
  setActiveSpaceFn(_fn: any): void {}
  setEmbedQueryFn(_fn: any): void {}
  setFastQueryEmbedFn(_fn: any): void {}
  async ensureEmbeddingSpace(): Promise<void> {}
  setConversationContextProvider(_fn: any): void {}
  getCompanyResearchEngine(): { getCachedDossier: (_company: string) => null } {
    return { getCachedDossier: () => null };
  }
  private roleInsightService: any = null;
  private cachedCoverLetter: any = null;

  getRoleInsightService(): any {
    if (!this.roleInsightService) {
      const { LocalRoleInsightService } = require('./LocalRoleInsightService');
      this.roleInsightService = new LocalRoleInsightService(this.profileIndex, this.generateContentFn);
    }
    return this.roleInsightService;
  }

  getNegotiationTracker(): { getState: () => any; isActive: () => boolean } {
    return {
      getState: () => ({ round: 1, history: [] }),
      isActive: () => false,
    };
  }

  resetNegotiationSession(): void {}

  getNegotiationScript(): null {
    return null;
  }

  getCoverLetter(): any {
    return this.cachedCoverLetter;
  }

  async generateCoverLetterOnDemand(): Promise<any> {
    const resume = this.profileIndex.get(DocType.RESUME);
    const jd = this.profileIndex.get(DocType.JD);
    if (!resume) return null;

    const structured = (resume.structuredData || {}) as any;
    const candidateName = structured.name || structured.candidate_name || 'Candidate';
    const currentRole = structured.role || structured.current_role || structured.experience?.[0]?.role || 'Software Engineer';
    const skillsList = Array.isArray(structured.skills_flat) && structured.skills_flat.length > 0
      ? structured.skills_flat.slice(0, 10).join(', ')
      : (Array.isArray(structured.skills) ? structured.skills.slice(0, 10).join(', ') : '');
    const experienceSummary = Array.isArray(structured.experience)
      ? structured.experience.slice(0, 3).map((e: any) => `${e.role || 'Role'} at ${e.company || 'Company'}: ${(e.bullets || []).slice(0, 2).join(' ')}`).join('\n')
      : '';

    const targetTitle = (jd?.structuredData as any)?.title || 'Software Engineer';
    const targetCompany = (jd?.structuredData as any)?.company || 'your team';
    const jdText = jd?.content || '';

    const systemPrompt = `You write compelling, concise, and authentic cover letters. Return JSON only with no markdown fences, adhering to this exact schema:
{
  "greeting": "Dear Hiring Team at <Company>,",
  "opening_hook": "<1-2 sentences capturing interest, naming the target position and expressing enthusiasm>",
  "body_paragraphs": [
    "<Paragraph 1 connecting candidate's key experience to the role requirements>",
    "<Paragraph 2 detailing technical skills, impact, and why they excel in this environment>"
  ],
  "closing": "Sincerely,\\n<Candidate Name>",
  "full_text": "<Complete joined letter formatted with double newlines between sections>"
}`;

    const userPrompt = `Candidate Name: ${candidateName}
Current Role: ${currentRole}
Key Skills: ${skillsList}
Experience:
${experienceSummary}

Target Position: ${targetTitle}
Target Company: ${targetCompany}
Job Description Text:
${jdText.slice(0, 3000)}`;

    let generated: any = null;

    if (typeof this.generateContentFn === 'function') {
      try {
        const raw = await this.generateContentFn([{ text: systemPrompt }, { text: userPrompt }]);
        if (raw) {
          const text = typeof raw === 'string' ? raw : String(raw);
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            generated = JSON.parse(jsonMatch[0]);
          }
        }
      } catch (e) {
        console.warn('[LocalKnowledgeOrchestrator] generateCoverLetter error:', e);
      }
    }

    if (!generated) {
      try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
          const { LLMHelper } = require('../LLMHelper');
          const { CredentialsManager } = require('../services/CredentialsManager');
          if (CredentialsManager && typeof CredentialsManager.getInstance === 'function') {
            const credMgr = CredentialsManager.getInstance();
            const geminiKey = credMgr.getGeminiApiKey();
            const groqKey = credMgr.getGroqApiKey();
            const openaiKey = credMgr.getOpenaiApiKey();
            const claudeKey = credMgr.getClaudeApiKey();
            const deepseekKey = credMgr.getDeepseekApiKey();
            if (geminiKey || groqKey || openaiKey || claudeKey || deepseekKey) {
              const helper = new LLMHelper(geminiKey, false, undefined, undefined, groqKey, openaiKey, claudeKey, deepseekKey);
              const raw = await helper.generateMeetingSummary(systemPrompt, userPrompt, systemPrompt);
              if (raw) {
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  generated = JSON.parse(jsonMatch[0]);
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[LocalKnowledgeOrchestrator] generateCoverLetter fallback error:', e);
      }
    }

    if (!generated || !generated.greeting || !generated.body_paragraphs) {
      const greeting = `Dear Hiring Team at ${targetCompany},`;
      const opening_hook = `I am writing to express my strong enthusiasm for the ${targetTitle} position at ${targetCompany}. With a proven track record as a ${currentRole}, I am confident in delivering immediate value to your engineering team.`;
      const body_paragraphs = [
        `Throughout my career, I have specialized in building robust, scalable solutions. My background encompasses ${skillsList || 'full-stack architecture, API development, and modern product engineering'}. In my recent roles, I have consistently taken features from concept to production while maintaining high performance and code quality.`,
        `What excites me most about ${targetCompany} is the opportunity to solve complex problems and collaborate with a talented, high-impact team. I look forward to bringing my technical dedication and experience to your initiatives.`
      ];
      const closing = `Sincerely,\n${candidateName}`;
      const full_text = `${greeting}\n\n${opening_hook}\n\n${body_paragraphs.join('\n\n')}\n\n${closing}`;

      generated = {
        greeting,
        opening_hook,
        body_paragraphs,
        closing,
        full_text,
      };
    } else if (!generated.full_text) {
      generated.full_text = `${generated.greeting}\n\n${generated.opening_hook}\n\n${(generated.body_paragraphs || []).join('\n\n')}\n\n${generated.closing}`;
    }

    this.cachedCoverLetter = generated;
    return generated;
  }

  isIngesting(_docType: DocType): boolean {
    return false;
  }

  // --- The grounding path --------------------------------------------------

  /**
   * Assemble grounding for one question.
   *
   * Returns null when there is nothing to ground with, which every caller
   * already handles as an ordinary ungrounded turn.
   */
  async processQuestion(question: string): Promise<PromptAssemblyResult | null> {
    if (!this.knowledgeMode) return null;
    const text = typeof question === 'string' ? question.trim() : '';
    if (!text) return null;

    const hasResume = Boolean(this.profileIndex.get(DocType.RESUME));
    const hasJD = Boolean(this.profileIndex.get(DocType.JD));
    if (!hasResume && !hasJD) return null;

    // Deterministic and free of I/O, so it always completes inside the budget.
    let route: ManualProfileRouteResult | null = null;
    try {
      route = buildManualProfileEvidenceRoute({ question: text, orchestrator: this }).route;
    } catch {
      // A selector failure must not cost the turn its retrieved passages.
      route = null;
    }

    const passages = await this.retrieveWithinBudget(text);

    const sections: string[] = [];
    const factsBlock = route ? renderEvidenceBlock(route) : '';
    if (factsBlock) sections.push(factsBlock);
    if (passages) sections.push(passages);

    if (sections.length === 0) return null;

    const answerType = route?.answerType;
    return {
      contextBlock: sections.join('\n\n'),
      // `factualRecall` bypasses the mode gate, so it is set only when the
      // selector resolved the question to the candidate's own plain facts AND
      // there are facts rather than only free-text passages.
      factualRecall: Boolean(answerType && FACTUAL_RECALL_ANSWER_TYPES.has(answerType) && factsBlock),
      isIntroQuestion: Boolean(answerType && INTRO_ANSWER_TYPES.has(answerType)),
      // `introResponse` is deliberately absent. The free tree's own rule is
      // that deterministic logic selects evidence and never final prose
      // (ManualProfileRouteResult declares `answer?: never` for exactly this
      // reason), so the intro is written by the model from the block above
      // rather than precomputed here.
    };
  }

  /**
   * Run retrieval, giving up on it rather than on the whole result.
   *
   * A slow embedding call must not push `processQuestion` past the caller's
   * 2000 ms budget, because that discards the deterministic evidence too.
   */
  private async retrieveWithinBudget(question: string): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.retrievalBudgetMs);
    });

    try {
      const result = await Promise.race([
        this.profileIndex.retrieve(question, { topK: 6, hasTranscript: false }).catch(() => null),
        expired,
      ]);
      const formatted = result?.formattedContext?.trim();
      if (!formatted) return '';
      return `<profile_passages source="local_profile_documents" trust="medium">\n${formatted}\n</profile_passages>`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Render the selector's chosen evidence as a grounding block.
 *
 * The tag-with-attributes shape matches what the free tree already feeds the
 * model elsewhere, such as the `<candidate_identity_fact source=... trust=...>`
 * block at electron/LLMHelper.ts:2717, so the prompt stays internally
 * consistent.
 */
function renderEvidenceBlock(route: ManualProfileRouteResult): string {
  const lines: string[] = [];

  for (const item of route.items ?? []) {
    const value = renderValue(item.value);
    if (!value) continue;
    lines.push(`- ${item.field} (${item.sourceKind}, confidence ${item.confidence}): ${value}`);
  }

  if (lines.length === 0) return '';

  return [
    `<candidate_profile source="local_profile" trust="high" answer_type="${route.answerType}">`,
    ...lines,
    '</candidate_profile>',
  ].join('\n');
}

/** Flatten an evidence value into one readable line. */
function renderValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return value.map(renderValue).filter(Boolean).join('; ');
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Experience and project entries are the common case, and reading as
    // "Role at Company (2022-03 to present)" beats dumping JSON at the model.
    const role = firstString(source, ['role', 'title', 'position', 'name']);
    const company = firstString(source, ['company', 'organization', 'employer', 'institution']);
    const start = firstString(source, ['start_date']);
    const end = firstString(source, ['end_date']);

    const head = [role, company].filter(Boolean).join(' at ');
    const span = start ? ` (${start} to ${end || 'present'})` : '';
    const detail = firstString(source, ['description', 'summary', 'degree', 'field']);

    const rendered = [head + span, detail].filter(Boolean).join(' - ');
    if (rendered.trim()) return rendered.trim();

    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  return '';
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
