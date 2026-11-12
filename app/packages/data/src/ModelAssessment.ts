import { authenticated, boolean, date, entity, int, set, text, uuid } from '@microsoft/rayfin-core';
/** Latest AI-readiness assessment per semantic model (one row per model). Scores are stored x10 (973 = 97.3). */
@entity()
@authenticated(['create', 'read', 'update'])
export class ModelAssessment {
  @uuid() id!: string;
  @text({ max: 40 }) workspace_id!: string;
  @text({ max: 200 }) workspace_name!: string;
  @text({ max: 40, unique: true }) model_id!: string;
  @text({ max: 200 }) model_name!: string;
  @int() score10!: number;
  @text({ max: 30 }) tier!: string;
  @set('deep', 'quick') mode!: 'deep' | 'quick';
  @text({ max: 1500 }) categories_json!: string;
  @int() findings_count!: number;
  @text({ max: 3500 }) top_findings_json!: string;
  @text({ max: 600 }) stats_json!: string;
  @text({ max: 20 }) catalog_version!: string;
  @date() assessed_at!: Date;
  @text({ max: 200 }) assessed_by!: string;
  @boolean({ optional: true }) approved_for_copilot?: boolean;
}
