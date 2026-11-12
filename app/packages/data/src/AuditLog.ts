import { authenticated, date, entity, set, text, uuid } from '@microsoft/rayfin-core';
/** Append-only trail of every read-heavy and write action Fabric Weave performs. */
@entity()
@authenticated(['create', 'read'])
export class AuditLog {
  @uuid() id!: string;
  @date() at!: Date;
  @text({ max: 200 }) actor!: string;
  @text({ max: 60 }) action!: string;
  @text({ max: 40, optional: true }) workspace_id?: string;
  @text({ max: 40, optional: true }) model_id?: string;
  @text({ max: 1800, optional: true }) details?: string;
  @set('ok', 'warning', 'error') outcome!: 'ok' | 'warning' | 'error';
}
