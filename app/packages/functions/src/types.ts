/**
 * Function schema types for RayfinClient.
 *
 * AUTO-GENERATED — do not edit manually.
 * Re-generated automatically when function source files change.
 *
 * If this file is not updating automatically, run:
 *   rayfin dev functions apply
 *
 * The schema is a closed object type: only the function names listed
 * below are accepted by RayfinClient.functions.<name>.invoke(...).
 * Adding, renaming, or changing the signature of a udf.func() call
 * regenerates this file and surfaces type errors at every consumer.
 *
 * IMPORTANT: This file must NOT import any Node.js packages — it is
 * resolved by the frontend app's TypeScript compiler.
 */

export type AppFunctionsSchema = {
  listWorkspaces: {
    input: Record<string, never>;
    output: { id: string; name: string; capacityId: null | string; writeMode: 'in-place' | 'propose-only' | 'clone'; inScope: boolean; configured: boolean; unverified: boolean; canEdit: boolean }[];
  };
  saveWorkspaceSetting: {
    input: { workspaceId: string; writeMode: 'in-place' | 'propose-only' | 'clone'; inScope: boolean };
    output: { id: string; name: string; capacityId: null | string; writeMode: 'in-place' | 'propose-only' | 'clone'; inScope: boolean; configured: boolean; unverified: boolean; canEdit: boolean };
  };
  listModels: {
    input: { workspaceId: string };
    output: { workspaceId: string; workspaceName: string; id: string; name: string; description: null | string; assessment: null | { score: number; tier: string; mode: 'deep' | 'quick'; assessedAt: string; findingsCount: number; approvedForCopilot: null | false | true }; canWrite: boolean }[];
  };
  assessModel: {
    input: { workspaceId: string; modelId: string; useJudge: boolean };
    output: { workspaceId: string; workspaceName: string; modelId: string; modelName: string; score: { catalogVersion: string; mode: 'deep' | 'quick'; modelName: string; score: number; rawScore: number; tier: string; categories: { id: 'foundation' | 'naming' | 'descriptions' | 'instructions' | 'schema' | 'examples' | 'governance'; title: string; weight: number; score: number; points: number }[]; gates: { id: string; title: string; cap: number; triggered: boolean }[]; rules: { ruleId: string; score: null | number; evidence: string; findingCount: number }[]; findings: { ruleId: string; objectType: 'model' | 'table' | 'column' | 'measure' | 'relationship' | 'copilot'; objectPath: string; message: string; fixKind: 'add-description' | 'set-instructions' | 'hide-object' | 'set-format-string' | 'set-summarize-none' | 'set-indexing' | 'set-example-prompts' | 'add-measure' | 'set-qna' | 'set-ai-visibility' | 'rename' | 'mark-date-table' | 'manual' }[]; findingsTotal: number; stats: { tables: number; visibleTables: number; columns: number; visibleColumns: number; measures: number; visibleMeasures: number; relationships: number }; computedAt: string }; tree: { tables: { name: string; hidden: boolean; calculated: boolean; description: null | string; aiVisibility: null | string; columns: { name: string; dataType: string; hidden: boolean; calculated: boolean; description: null | string; aiVisibility: null | string }[]; measures: { name: string; expression: string; hidden: boolean; description: null | string; formatString: null | string; displayFolder: null | string; aiVisibility: null | string }[] }[]; relationships: { name: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; isActive: boolean; crossFilter: 'single' | 'both'; fromCardinality: 'one' | 'many'; toCardinality: 'one' | 'many' }[]; instructions: null | string; examplePrompts: string[]; hasSchema: boolean; indexingEnabled: null | false | true; verifiedAnswerCount: number; truncated: boolean }; judge: null | { descriptionQuality: null | number; descriptionIssues: { path: string; problem: string }[]; instructionQuality: null | number; notes: string }; judgeError: null | string; businessContext: null | { description?: undefined | string; domain?: undefined | string; audience?: undefined | string; glossary?: undefined | { term: string; meaning: string }[]; defaultTimeFrame?: undefined | string; fiscalYearStart?: undefined | string; preferredMeasures?: undefined | string[]; notes?: undefined | string }; lastRefresh: null | { status: null | string; endTime: null | string }; assessedAt: string; canWrite: boolean };
  };
  getFixProposals: {
    input: { workspaceId: string; modelId: string; useAi: boolean };
    output: { proposals: { id: string; ruleIds: string[]; title: string; summary: string; risk: 'low' | 'medium' | 'high'; requiresReview: boolean; generatedBy: 'rule' | 'llm' | 'template'; changes: ({ op: 'setDescription'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: string } | { op: 'setProperty'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; property: string; value: string } | { op: 'setHidden'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: boolean } | { op: 'setAiVisibility'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: 'Visible' | 'Hidden' } | { op: 'setInstructions'; value: string } | { op: 'setIndexing'; value: boolean } | { op: 'setExamplePrompts'; value: string[] } | { op: 'setQna'; value: boolean } | { op: 'addMeasure'; table: string; name: string; expression: string; formatString?: undefined | string; description?: undefined | string; displayFolder?: undefined | string } | { op: 'rename'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: string })[]; estimatedGain?: undefined | number }[]; before: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; projected: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; impacts: { proposalId: string; gain: number; categories: { id: string; gain: number }[] }[]; writeBlockers: string[]; notes: string[]; generator: string; businessContextUsed: boolean; baseDigest: string };
  };
  applyFixes: {
    input: { workspaceId: string; modelId: string; proposals: { id: string; ruleIds: string[]; title: string; summary: string; risk: 'low' | 'medium' | 'high'; requiresReview: boolean; generatedBy: 'rule' | 'llm' | 'template'; changes: ({ op: 'setDescription'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: string } | { op: 'setProperty'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; property: string; value: string } | { op: 'setHidden'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: boolean } | { op: 'setAiVisibility'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: 'Visible' | 'Hidden' } | { op: 'setInstructions'; value: string } | { op: 'setIndexing'; value: boolean } | { op: 'setExamplePrompts'; value: string[] } | { op: 'setQna'; value: boolean } | { op: 'addMeasure'; table: string; name: string; expression: string; formatString?: undefined | string; description?: undefined | string; displayFolder?: undefined | string } | { op: 'rename'; target: { type: 'table' | 'column' | 'measure'; table: string; name?: undefined | string }; value: string })[]; estimatedGain?: undefined | number }[]; baseDigest: string };
    output: { changeSetId: string; mode: 'in-place' | 'propose-only' | 'clone'; status: 'applied' | 'proposed' | 'failed'; applied: number; skipped: { op: string; reason: string }[]; before: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; after: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; verified: boolean; message: string; targetModelId: null | string; changedParts: { path: string; status: 'added' | 'modified' | 'removed'; before?: undefined | string; after?: undefined | string }[] };
  };
  rollbackChangeSet: {
    input: { changeSetId: string; discardLaterEdits: boolean };
    output: { changeSetId: string; status: 'rolled-back'; restoredParts: number; before: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; after: { score: number; tier: string; categories: { id: string; title: string; score: number }[] }; message: string };
  };
  getAgentReadiness: {
    input: { workspaceId: string; modelId: string };
    output: { checks: { id: string; level: 'model' | 'tenant' | 'workspace'; title: string; status: 'pass' | 'fail' | 'warn' | 'unknown'; detail: string; action?: undefined | string; owner: 'app' | 'model-owner' | 'workspace-admin' | 'tenant-admin'; link?: undefined | string; surfaces: ('copilot' | 'mcp' | 'data-agent')[] }[]; surfaces: { surface: 'copilot' | 'mcp' | 'data-agent'; label: string; status: 'pass' | 'fail' | 'warn' | 'unknown'; blockers: string[] }[]; tenantSettingsReadable: boolean; evaluatedAt: string };
  };
  setApprovedForCopilot: {
    input: { workspaceId: string; modelId: string; approved: boolean };
    output: { modelId: string; approvedForCopilot: boolean };
  };
  draftBusinessContext: {
    input: { workspaceId: string; modelId: string };
    output: { context: { description?: undefined | string; domain?: undefined | string; audience?: undefined | string; glossary?: undefined | { term: string; meaning: string }[]; defaultTimeFrame?: undefined | string; fiscalYearStart?: undefined | string; preferredMeasures?: undefined | string[]; notes?: undefined | string }; generator: string };
  };
  interviewBusinessContext: {
    input: { workspaceId: string; modelId: string; turns: { question: string; answer: string }[]; existing: string; finish: boolean };
    output: { done: boolean; question: null | string; summary: string; answered: number; maxQuestions: number };
  };
  getPortfolio: {
    input: { query: { search?: undefined | string; tier?: undefined | string; sortBy?: undefined | 'workspace' | 'score' | 'name' | 'usage'; sortDir?: undefined | 'asc' | 'desc'; offset?: undefined | number; limit?: undefined | number } };
    output: { available: boolean; reason: null | string; generatedAt: null | string; lastRun: null | { status: 'Running' | 'Succeeded' | 'Failed'; stage: null | string; startedAt: null | string; finishedAt: null | string; error: null | string; models: null | number }; totals: { workspaces: number; models: number; scored: number; averageScore: null | number; tiers: { [k: string]: number }; withUsage: number; unusedModels: number }; total: number; models: { workspaceId: string; workspaceName: string; modelId: string; name: string; configuredBy: null | string; createdDate: null | string; targetStorageMode: null | string; isRefreshable: null | false | true; lastRefresh: null | { status: string; endTime: string }; usage: null | { reportsCount: null | number; views30d: null | number; uniqueUsers30d: null | number; lastActivity: null | string }; quickScore: null | { score: number; tier: string; categories: { [k: string]: number } }; tables: null | number; measures: null | number; scanError: null | string; deepScore: null | number; deepAssessedAt: null | string }[] };
  };
  getServiceStatus: {
    input: Record<string, never>;
    output: { fabricTokenOk: boolean; fabricError: null | string; llm: { configured: boolean; name: string; deployment: null | string }; portfolio: { configured: boolean; available: boolean; generatedAt: null | string }; snapshotSigning: boolean; actor: string; identities: string[]; isAdmin: boolean; adminsConfigured: boolean; access: { source: 'everything' | 'fabric-admin-api' | 'workspace-roles' | 'unresolved'; userRef: null | string; workspaces: null | number; models: null | number; note: null | string } };
  };
};
