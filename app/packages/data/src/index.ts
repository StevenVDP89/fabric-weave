import type { UniversalAppSchema } from '@rayfin-app/shared';
import { AuditLog } from './AuditLog.js';
import { BusinessContext } from './BusinessContext.js';
import { ChangeSet } from './ChangeSet.js';
import { ModelAssessment } from './ModelAssessment.js';
import { SnapshotChunk } from './SnapshotChunk.js';
import { WorkspaceSetting } from './WorkspaceSetting.js';

/**
 * Fabric Weave's Rayfin data schema. `UniversalAppSchema` in `@rayfin-app/shared`
 * must stay in step with `schema` below.
 */
export type { UniversalAppSchema };
export { AuditLog, BusinessContext, ChangeSet, ModelAssessment, SnapshotChunk, WorkspaceSetting };

export const schema = [ModelAssessment, ChangeSet, SnapshotChunk, BusinessContext, WorkspaceSetting, AuditLog];