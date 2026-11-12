import { authenticated, entity, int, text, uuid } from '@microsoft/rayfin-core';
/** Rollback snapshots are gzip+base64 encoded and stored in fixed-size chunks. */
@entity()
@authenticated(['create', 'read', 'delete'])
export class SnapshotChunk {
  @uuid() id!: string;
  @text({ max: 40 }) snapshot_id!: string;
  @int() seq!: number;
  @text({ max: 3800 }) data!: string;
}
