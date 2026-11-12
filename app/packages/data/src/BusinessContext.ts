import { authenticated, date, entity, text, uuid } from '@microsoft/rayfin-core';
/** Business context supplied (or AI-drafted and confirmed) per model; grounds every AI-generated fix. */
@entity()
@authenticated(['create', 'read', 'update', 'delete'])
export class BusinessContext {
  @uuid() id!: string;
  @text({ max: 40 }) workspace_id!: string;
  @text({ max: 40, unique: true }) model_id!: string;
  @text({ max: 200, optional: true }) domain?: string;
  @text({ max: 300, optional: true }) audience?: string;
  @text({ max: 1500, optional: true }) description?: string;
  @text({ max: 3800, optional: true }) glossary_json?: string;
  @text({ max: 100, optional: true }) default_time_frame?: string;
  @text({ max: 40, optional: true }) fiscal_year_start?: string;
  @text({ max: 800, optional: true }) preferred_measures?: string;
  @text({ max: 1000, optional: true }) notes?: string;
  /** The context in the owner's own words (typed, dictated or captured by the interview agent). When set, the older columns above are ignored. */
  @text({ max: 4000, optional: true }) context_text?: string;
  @date() updated_at!: Date;
  @text({ max: 200 }) updated_by!: string;
}
