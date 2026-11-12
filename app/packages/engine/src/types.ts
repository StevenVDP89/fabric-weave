/** Normalised, tool-agnostic view of a semantic model used by every rule. */

export type DataType =
  | 'string'
  | 'int64'
  | 'double'
  | 'decimal'
  | 'boolean'
  | 'dateTime'
  | 'binary'
  | 'variant'
  | 'unknown';

export interface ColumnInfo {
  name: string;
  dataType: DataType;
  description?: string;
  isHidden: boolean;
  isCalculated: boolean;
  isKey: boolean;
  formatString?: string;
  /** TMDL summarizeBy value, lower-cased (none | sum | average | ...). Undefined = default (sum for numbers). */
  summarizeBy?: string;
  sortByColumn?: string;
  displayFolder?: string;
  dataCategory?: string;
  lineageTag?: string;
  /** Synonyms already stored in Copilot/schema.json. Preserved on write, never scored or edited (the Q&A visual that used them is being retired). */
  synonyms: string[];
  /** Visibility inside the Copilot AI data schema; undefined = no explicit entry. */
  aiVisibility?: 'Visible' | 'Hidden';
}

export interface MeasureInfo {
  name: string;
  expression: string;
  description?: string;
  isHidden: boolean;
  formatString?: string;
  displayFolder?: string;
  lineageTag?: string;
  synonyms: string[];
  aiVisibility?: 'Visible' | 'Hidden';
}

export interface HierarchyInfo {
  name: string;
  levels: string[];
  lineageTag?: string;
}

export interface TableInfo {
  name: string;
  description?: string;
  isHidden: boolean;
  /** dataCategory: Time marks a date table. */
  dataCategory?: string;
  isCalculatedTable: boolean;
  lineageTag?: string;
  columns: ColumnInfo[];
  measures: MeasureInfo[];
  hierarchies: HierarchyInfo[];
  partitionMode?: string;
  synonyms: string[];
  /** Visibility inside the Copilot AI data schema; undefined = no explicit schema entry. */
  aiVisibility?: 'Visible' | 'Hidden';
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

export interface CopilotArtifacts {
  /** Markdown of Copilot/Instructions/instructions.md (undefined = part missing). */
  instructions?: string;
  /** Copilot/settings.json indexingEnabled (undefined = part missing). */
  indexingEnabled?: boolean;
  /** True when Copilot/schema.json exists and scopes the model. */
  hasSchema: boolean;
  examplePrompts: string[];
  verifiedAnswerCount: number;
}

export interface GovernanceInfo {
  qnaEnabled?: boolean;
  /** Approved for Copilot flag. null/undefined = unknown (API not available). */
  approvedForCopilot?: boolean | null;
  endorsement?: 'None' | 'Promoted' | 'Certified' | 'MasterData' | null;
  /** True when the model's workspace sits on a paid, Copilot-eligible capacity. */
  capacityEligible?: boolean | null;
  lastRefreshSucceeded?: boolean | null;
  lastRefreshAt?: string | null;
  storageMode?: string | null;
  isGitConnected?: boolean | null;
}

export interface ModelSnapshot {
  name: string;
  compatibilityLevel?: number;
  culture?: string;
  discourageImplicitMeasures: boolean;
  tables: TableInfo[];
  relationships: RelationshipInfo[];
  copilot: CopilotArtifacts;
  governance: GovernanceInfo;
  /** True when TMDL definition could not be read (scanner-only quick scoring). */
  metadataOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Rule catalog & results
// ---------------------------------------------------------------------------

export type CategoryId =
  | 'foundation'
  | 'naming'
  | 'descriptions'
  | 'instructions'
  | 'schema'
  | 'examples'
  | 'governance';

export type Severity = 'critical' | 'major' | 'minor' | 'info';

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

export interface RuleDefinition {
  id: string;
  category: CategoryId;
  title: string;
  /** Relative weight inside its category. */
  weight: number;
  severity: Severity;
  rationale: string;
  remediation: string;
  fixKind: FixKind;
  /** Rule needs the full definition (not available from scanner metadata). */
  deepOnly?: boolean;
  /** Rule uses an LLM judge for a qualitative second opinion. */
  llm?: boolean;
}

export interface GateDefinition {
  id: string;
  title: string;
  cap: number;
  rationale: string;
}

export interface Catalog {
  version: string;
  categories: Record<CategoryId, { title: string; weight: number }>;
  tiers: { min: number; label: string }[];
  gates: GateDefinition[];
  rules: RuleDefinition[];
}

export interface Finding {
  ruleId: string;
  objectType: 'model' | 'table' | 'column' | 'measure' | 'relationship' | 'copilot';
  /** Table.Column / Table[Measure] style path. */
  objectPath: string;
  message: string;
  fixKind: FixKind;
  /** Free-form data for the fix generators. */
  data?: Record<string, unknown>;
}

export interface RuleResult {
  ruleId: string;
  /** 0..1. null = not applicable / unknown (excluded from weighting). */
  score: number | null;
  evidence: string;
  findings: Finding[];
}

export interface CategoryScore {
  id: CategoryId;
  title: string;
  weight: number;
  /** 0..100 for this category. */
  score: number;
  /** Points contributed to the overall score. */
  points: number;
}

export interface GateResult {
  id: string;
  title: string;
  cap: number;
  triggered: boolean;
}

export interface ScoreResult {
  catalogVersion: string;
  mode: 'deep' | 'quick';
  modelName: string;
  /** 0..100 after gates. */
  score: number;
  rawScore: number;
  tier: string;
  categories: CategoryScore[];
  gates: GateResult[];
  rules: RuleResult[];
  findings: Finding[];
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

// ---------------------------------------------------------------------------
// Fix & patch
// ---------------------------------------------------------------------------

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

export interface ObjectRef {
  type: 'table' | 'column' | 'measure';
  table: string;
  name?: string;
}

export interface FixProposal {
  id: string;
  ruleIds: string[];
  title: string;
  /** Short human readable summary of what will change. */
  summary: string;
  risk: 'low' | 'medium' | 'high';
  /** AI generated content needs human review before apply. */
  requiresReview: boolean;
  generatedBy: 'rule' | 'llm' | 'template';
  changes: Change[];
  /** Estimated improvement if applied (points of overall score). */
  estimatedGain?: number;
}

export interface BusinessContext {
  /**
   * The owner's own account of the model (what it is for, who asks, terms, defaults, preferred measures, quirks),
   * written by hand or captured by the interview agent. It is the primary grounding for generated AI instructions.
   * The structured fields below are older entries and stay readable.
   */
  description?: string;
  domain?: string;
  audience?: string;
  glossary?: { term: string; meaning: string }[];
  defaultTimeFrame?: string;
  fiscalYearStart?: string;
  preferredMeasures?: string[];
  notes?: string;
}

/** Map of definition part path -> text content. */
export type DefinitionParts = Record<string, string>;
