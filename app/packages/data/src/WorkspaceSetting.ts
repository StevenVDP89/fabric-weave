import { authenticated, boolean, date, entity, set, text, uuid } from '@microsoft/rayfin-core';
/** Per-workspace scope and write-back mode. */
@entity()
@authenticated(['create', 'read', 'update'])
export class WorkspaceSetting {
  @uuid() id!: string;
  @text({ max: 40, unique: true }) workspace_id!: string;
  @text({ max: 200 }) workspace_name!: string;
  @set('in-place', 'propose-only', 'clone') write_mode!: 'in-place' | 'propose-only' | 'clone';
  @boolean({ default: true }) in_scope!: boolean;
  /** HMAC over workspace, mode and scope. A row without a valid one is treated as propose-only. */
  @text({ max: 64, optional: true }) sig?: string;
  @date() updated_at!: Date;
  @text({ max: 200 }) updated_by!: string;
}
