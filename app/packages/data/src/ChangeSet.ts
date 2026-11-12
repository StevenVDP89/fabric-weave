import { authenticated, date, entity, int, set, text, uuid } from '@microsoft/rayfin-core';
/** One applied (or proposed) batch of fixes, with the score delta and a pointer to the rollback snapshot. */
@entity()
@authenticated(['create', 'read', 'update'])
export class ChangeSet {
  @uuid() id!: string;
  @text({ max: 40 }) workspace_id!: string;
  @text({ max: 40 }) model_id!: string;
  @text({ max: 200 }) model_name!: string;
  @set('in-place', 'propose-only', 'clone') mode!: 'in-place' | 'propose-only' | 'clone';
  @set('applied', 'rolled-back', 'proposed', 'failed') status!: 'applied' | 'rolled-back' | 'proposed' | 'failed';
  @text({ max: 1000 }) proposal_ids!: string;
  @int() change_count!: number;
  @int() score_before10!: number;
  @int() score_after10!: number;
  @text({ max: 1000 }) summary!: string;
  @text({ max: 40, optional: true }) snapshot_id?: string;
  @text({ max: 64, optional: true }) snapshot_sig?: string;
  /** sha256 of the definition read back after the change; rollback refuses to overwrite later edits unless told to. */
  @text({ max: 64, optional: true }) result_digest?: string;
  @text({ max: 40, optional: true }) target_model_id?: string;
  @date() created_at!: Date;
  @text({ max: 200 }) created_by!: string;
}
