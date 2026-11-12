import type { WriteMode } from '@rayfin-app/shared';

export type { WriteMode };

/*
 * Types that cross the function boundary are declared here instead of imported from the engine:
 * the function type generator inlines types from this package but cannot resolve names that come from
 * other packages. The compiler checks every function result against these shapes, so they cannot drift.
 */

export type CategoryId = 'foundation' | 'naming' | 'descriptions' | 'instructions' | 'schema' | 'examples' | 'governance';

export type FixKind =
  | 'add-description'
  | 'set-instructions'
  | 'hide-object'
  | 'set-format-string'
  | 'set-summarize-none'
  | 'set-indexing'
  | 'set-example-prompts'
  | 'add-measure'
  | 'set-qna'
  | 'set-ai-visibility'
  | 'rename'
  | 'mark-date-table'
  | 'manual';

export interface Finding {
  ruleId: string;
  objectType: 'model' | 'table' | 'column' | 'measure' | 'relationship' | 'copilot';
  objectPath: string;
  message: string;
  fixKind: FixKind;
}

export interface CategoryScore {
  id: CategoryId;
  title: string;
  weight: number;
  score: number;
  points: number;
}

export interface GateResult {
  id: string;
  title: string;
  cap: number;
  triggered: boolean;
}

export interface RelationshipInfo {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  isActive: boolean;
  crossFilter: 'single' | 'both';
  fromCardinality: 'one' | 'many';
  toCardinality: 'one' | 'many';
}

export interface JudgeResult {
  descriptionQuality: number | null;
  descriptionIssues: { path: string; problem: string }[];
  instructionQuality: number | null;
  notes: string;
}

export interface BusinessContext {
  /** The owner's own description of the model. Older entries carry the structured fields below instead. */
  description?: string;
  domain?: string;
  audience?: string;
  glossary?: { term: string; meaning: string }[];
  defaultTimeFrame?: string;
  fiscalYearStart?: string;
  preferredMeasures?: string[];
  notes?: string;
}

export interface ObjectRef {
  type: 'table' | 'column' | 'measure';
  table: string;
  name?: string;
}

export type Change =
  | { op: 'setDescription'; target: ObjectRef; value: string }
  | { op: 'setProperty'; target: ObjectRef; property: string; value: string }
  | { op: 'setHidden'; target: ObjectRef; value: boolean }
  | { op: 'setAiVisibility'; target: ObjectRef; value: 'Visible' | 'Hidden' }
  | { op: 'setInstructions'; value: string }
  | { op: 'setIndexing'; value: boolean }
  | { op: 'setExamplePrompts'; value: string[] }
  | { op: 'setQna'; value: boolean }
  | { op: 'addMeasure'; table: string; name: string; expression: string; formatString?: string; description?: string; displayFolder?: string }
  | { op: 'rename'; target: ObjectRef; value: string };

export interface FixProposal {
  id: string;
  ruleIds: string[];
  title: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  requiresReview: boolean;
  generatedBy: 'rule' | 'llm' | 'template';
  changes: Change[];
  estimatedGain?: number;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';
export type CheckLevel = 'tenant' | 'workspace' | 'model';
export type AgentSurface = 'copilot' | 'mcp' | 'data-agent';

export interface AvailabilityCheck {
  id: string;
  level: CheckLevel;
  title: string;
  status: CheckStatus;
  detail: string;
  action?: string;
  owner: 'app' | 'model-owner' | 'workspace-admin' | 'tenant-admin';
  link?: string;
  surfaces: AgentSurface[];
}

export interface SurfaceStatus {
  surface: AgentSurface;
  label: string;
  status: CheckStatus;
  blockers: string[];
}

export interface AgentAvailability {
  checks: AvailabilityCheck[];
  surfaces: SurfaceStatus[];
  tenantSettingsReadable: boolean;
  evaluatedAt: string;
}
export interface WorkspaceView {
  id: string;
  name: string;
  capacityId: string | null;
  writeMode: WriteMode;
  inScope: boolean;
  /** False until someone saves a setting for the workspace; changes stay blocked until then. */
  configured: boolean;
  /** True when the stored mode was not signed by this app and is being ignored. An administrator must save it again. */
  unverified: boolean;
  /** True when the caller may change this workspace's write mode: a workspace Admin, or an app administrator. */
  canEdit: boolean;
}

export interface AssessmentSummary {
  score: number;
  tier: string;
  mode: 'deep' | 'quick';
  assessedAt: string;
  findingsCount: number;
  approvedForCopilot: boolean | null;
}

export interface ModelView {
  workspaceId: string;
  workspaceName: string;
  id: string;
  name: string;
  description: string | null;
  assessment: AssessmentSummary | null;
  /** True when Fabric lets the caller write to this model. Changes also need the workspace to be enabled for them. */
  canWrite: boolean;
}

export interface ScoreView {
  catalogVersion: string;
  mode: 'deep' | 'quick';
  modelName: string;
  score: number;
  rawScore: number;
  tier: string;
  categories: CategoryScore[];
  gates: GateResult[];
  rules: { ruleId: string; score: number | null; evidence: string; findingCount: number }[];
  findings: Finding[];
  findingsTotal: number;
  stats: {
    tables: number;
    visibleTables: number;
    columns: number;
    visibleColumns: number;
    measures: number;
    visibleMeasures: number;
    relationships: number;
  };
  computedAt: string;
}

export interface TreeColumn {
  name: string;
  dataType: string;
  hidden: boolean;
  calculated: boolean;
  description: string | null;
  aiVisibility: string | null;
}

export interface TreeMeasure {
  name: string;
  expression: string;
  hidden: boolean;
  description: string | null;
  formatString: string | null;
  displayFolder: string | null;
  aiVisibility: string | null;
}

export interface TreeTable {
  name: string;
  hidden: boolean;
  calculated: boolean;
  description: string | null;
  aiVisibility: string | null;
  columns: TreeColumn[];
  measures: TreeMeasure[];
}

export interface TreeView {
  tables: TreeTable[];
  relationships: RelationshipInfo[];
  instructions: string | null;
  examplePrompts: string[];
  hasSchema: boolean;
  indexingEnabled: boolean | null;
  verifiedAnswerCount: number;
  truncated: boolean;
}

export interface AssessmentView {
  workspaceId: string;
  workspaceName: string;
  modelId: string;
  modelName: string;
  score: ScoreView;
  tree: TreeView;
  judge: JudgeResult | null;
  judgeError: string | null;
  businessContext: BusinessContext | null;
  lastRefresh: { status: string | null; endTime: string | null } | null;
  assessedAt: string;
  /** True when Fabric lets the caller write to this model. The server checks again before any write. */
  canWrite: boolean;
}

export interface ScoreHeadline {
  score: number;
  tier: string;
  categories: { id: string; title: string; score: number }[];
}

/** What one proposal is worth when applied on its own, per readiness category. Drives the live score in the Fix workbench. */
export interface ProposalImpact {
  proposalId: string;
  gain: number;
  categories: { id: string; gain: number }[];
}

export interface ProposalView {
  proposals: FixProposal[];
  before: ScoreHeadline;
  projected: ScoreHeadline;
  impacts: ProposalImpact[];
  /** Why changes cannot be written to this model right now, e.g. its Direct Lake source is gone. Empty when nothing blocks. */
  writeBlockers: string[];
  notes: string[];
  generator: string;
  businessContextUsed: boolean;
  /** Fingerprint of the model definition these proposals were built from. Send it back with applyFixes. */
  baseDigest: string;
}

export interface DefinitionDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  before?: string;
  after?: string;
}

export interface ApplyResultView {
  changeSetId: string;
  mode: WriteMode;
  status: 'applied' | 'proposed' | 'failed';
  applied: number;
  skipped: { op: string; reason: string }[];
  before: ScoreHeadline;
  after: ScoreHeadline;
  /** True when the model was re-read from Fabric and the new score matches the expected one. */
  verified: boolean;
  message: string;
  targetModelId: string | null;
  changedParts: DefinitionDiff[];
}

export interface RollbackResultView {
  changeSetId: string;
  status: 'rolled-back';
  restoredParts: number;
  before: ScoreHeadline;
  after: ScoreHeadline;
  message: string;
}

export interface PortfolioModel {
  workspaceId: string;
  workspaceName: string;
  modelId: string;
  name: string;
  configuredBy: string | null;
  createdDate: string | null;
  targetStorageMode: string | null;
  isRefreshable: boolean | null;
  lastRefresh: { status: string; endTime: string } | null;
  usage: { reportsCount: number | null; views30d: number | null; uniqueUsers30d: number | null; lastActivity: string | null } | null;
  quickScore: { score: number; tier: string; categories: Record<string, number> } | null;
  tables: number | null;
  measures: number | null;
  scanError: string | null;
  deepScore: number | null;
  deepAssessedAt: string | null;
}

export interface PortfolioQuery {
  search?: string;
  tier?: string;
  sortBy?: 'score' | 'name' | 'usage' | 'workspace';
  sortDir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** Outcome of the latest scan, written by the notebooks to Files/app/run_status.json. */
export interface RunStatusView {
  status: 'Running' | 'Succeeded' | 'Failed';
  stage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  models: number | null;
}

export interface PortfolioView {
  available: boolean;
  reason: string | null;
  generatedAt: string | null;
  /** Null when the notebooks have not reported a run status (older install, or no scan yet). */
  lastRun: RunStatusView | null;
  totals: {
    workspaces: number;
    models: number;
    scored: number;
    averageScore: number | null;
    tiers: Record<string, number>;
    withUsage: number;
    unusedModels: number;
  };
  total: number;
  models: PortfolioModel[];
}

export interface ServiceStatus {
  fabricTokenOk: boolean;
  fabricError: string | null;
  llm: { configured: boolean; name: string; deployment: string | null };
  portfolio: { configured: boolean; available: boolean; generatedAt: string | null };
  /** True when SIGNING_KEY is set. In-place changes and rollback are refused without it. */
  snapshotSigning: boolean;
  actor: string;
  /** Sign-in values for the caller (lower-case). Any of them can go in the APP_ADMINS secret. */
  identities: string[];
  /** True when the caller is an app administrator: sees every workspace and model and may change any of them. */
  isAdmin: boolean;
  /** False when APP_ADMINS is empty. Optional: without administrators, everyone is limited to what Fabric lets them reach. */
  adminsConfigured: boolean;
  /** What the app found out about the caller's own access in Fabric. */
  access: AccessStatus;
}

export interface AccessStatus {
  /** How the caller's access was worked out. 'unresolved' means it could not be, so nothing is shown. */
  source: 'everything' | 'fabric-admin-api' | 'workspace-roles' | 'unresolved';
  /** What the app asks Fabric about the caller: an Entra object id, or a sign-in name. */
  userRef: string | null;
  /** Workspaces and models the caller can reach. Null when everything is reachable or the count is not known. */
  workspaces: number | null;
  models: number | null;
  note: string | null;
}

export interface BusinessContextDraft {
  context: BusinessContext;
  generator: string;
}

export interface InterviewTurn {
  question: string;
  answer: string;
}

export interface InterviewStep {
  done: boolean;
  question: string | null;
  summary: string;
  answered: number;
  maxQuestions: number;
}

export interface ApprovalResult {
  modelId: string;
  approvedForCopilot: boolean;
}