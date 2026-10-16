// Ambient declarations for optional/private premium modules when the submodule is not checked out.

declare module '*/premium/electron/knowledge/ContextAssembler' {
  export interface PromptAssemblyResult {
    systemPrompt?: string;
    userPrompt?: string;
    contextBlock?: string;
    [key: string]: any;
  }
}

declare module '*/premium/electron/knowledge/CompanyResearchEngine' {
  export interface SearchProvider {
    search?(query: string): Promise<any>;
    [key: string]: any;
  }
}

declare module '*/premium/electron/knowledge/TavilySearchProvider' {
  export class TavilySearchProvider {
    constructor(apiKey: string);
    search?(query: string): Promise<any>;
  }
}

declare module '*/premium/electron/knowledge/NativelySearchProvider' {
  export class NativelySearchProvider {
    constructor(apiKey: string, trialToken?: string);
    search?(query: string): Promise<any>;
  }
}
