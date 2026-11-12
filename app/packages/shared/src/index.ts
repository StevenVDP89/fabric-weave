/**
 * Browser-safe contracts shared by the data registration package and frontend.
 *
 * Keep each record shape aligned with its decorated runtime entity in
 * `@rayfin-app/data`. This package must stay isomorphic, so do not import the
 * decorated classes here.
 */
export type WriteMode = 'in-place' | 'propose-only' | 'clone';

export interface ModelAssessmentRecord {
  id: string;
  workspace_id: string;
  workspace_name: string;
  model_id: string;
  model_name: string;
  /** Overall score x10 (973 means 97.3). */
  score10: number;
  tier: string;
  mode: 'deep' | 'quick';
  categories_json: string;
  findings_count: number;
  top_findings_json: string;
  stats_json: string;
  catalog_version: string;
  assessed_at: Date;
  assessed_by: string;
  approved_for_copilot?: boolean;
}

export interface ChangeSetRecord {
  id: string;
  workspace_id: string;
  model_id: string;
  model_name: string;
  mode: WriteMode;
  status: 'applied' | 'rolled-back' | 'proposed' | 'failed';
  proposal_ids: string;
  change_count: number;
  score_before10: number;
  score_after10: number;
  summary: string;
  snapshot_id?: string;
  snapshot_sig?: string;
  result_digest?: string;
  target_model_id?: string;
  created_at: Date;
  created_by: string;
}

export interface SnapshotChunkRecord {
  id: string;
  snapshot_id: string;
  seq: number;
  data: string;
}

export interface BusinessContextRecord {
  id: string;
  workspace_id: string;
  model_id: string;
  domain?: string;
  audience?: string;
  description?: string;
  glossary_json?: string;
  default_time_frame?: string;
  fiscal_year_start?: string;
  preferred_measures?: string;
  notes?: string;
  context_text?: string;
  updated_at: Date;
  updated_by: string;
}

export interface WorkspaceSettingRecord {
  id: string;
  workspace_id: string;
  workspace_name: string;
  write_mode: WriteMode;
  in_scope: boolean;
  sig?: string;
  updated_at: Date;
  updated_by: string;
}

export interface AuditLogRecord {
  id: string;
  at: Date;
  actor: string;
  action: string;
  workspace_id?: string;
  model_id?: string;
  details?: string;
  outcome: 'ok' | 'warning' | 'error';
}

export type UniversalAppSchema = {
  ModelAssessment: ModelAssessmentRecord;
  ChangeSet: ChangeSetRecord;
  SnapshotChunk: SnapshotChunkRecord;
  BusinessContext: BusinessContextRecord;
  WorkspaceSetting: WorkspaceSettingRecord;
  AuditLog: AuditLogRecord;
};