import { UserDataFunctions, type AudienceType, type RayfinContext } from '@microsoft/fabric-user-data-functions';
import type {
  AgentAvailability,
  ApplyResultView,
  ApprovalResult,
  AssessmentView,
  BusinessContextDraft,
  FixProposal,
  InterviewStep,
  InterviewTurn,
  ModelView,
  PortfolioQuery,
  PortfolioView,
  ProposalView,
  RollbackResultView,
  ServiceStatus,
  WorkspaceView,
  WriteMode,
} from './contracts.js';
import { applyFixes, rollbackChangeSet } from './lib/apply.js';
import { guarded } from './lib/guard.js';
import {
  assessModel,
  draftBusinessContext,
  getAgentReadiness,
  getFixProposals,
  getPortfolio,
  getServiceStatus,
  interviewBusinessContext,
  listModels,
  listWorkspaces,
  saveWorkspaceSetting,
  setApprovedForCopilot,
} from './lib/ops.js';
import type { AppSchema } from './lib/runtime.js';

const udf = new UserDataFunctions();

udf.func(
  'listWorkspaces',
  async (ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>): Promise<WorkspaceView[]> =>
    guarded('listWorkspaces', ctx, () => listWorkspaces(ctx)),
  [],
);

udf.func(
  'saveWorkspaceSetting',
  async (
    workspaceId: string,
    writeMode: WriteMode,
    inScope: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<WorkspaceView> => guarded('saveWorkspaceSetting', ctx, () => saveWorkspaceSetting(ctx, workspaceId, writeMode, inScope)),
  [],
);

udf.func(
  'listModels',
  async (
    workspaceId: string,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<ModelView[]> => guarded('listModels', ctx, () => listModels(ctx, workspaceId)),
  [],
);

udf.func(
  'assessModel',
  async (
    workspaceId: string,
    modelId: string,
    useJudge: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<AssessmentView> => guarded('assessModel', ctx, () => assessModel(ctx, workspaceId, modelId, useJudge)),
  [],
);

udf.func(
  'getFixProposals',
  async (
    workspaceId: string,
    modelId: string,
    useAi: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<ProposalView> => guarded('getFixProposals', ctx, () => getFixProposals(ctx, workspaceId, modelId, useAi)),
  [],
);

udf.func(
  'applyFixes',
  async (
    workspaceId: string,
    modelId: string,
    proposals: FixProposal[],
    baseDigest: string,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<ApplyResultView> => guarded('applyFixes', ctx, () => applyFixes(ctx, workspaceId, modelId, proposals, baseDigest)),
  [],
);

udf.func(
  'rollbackChangeSet',
  async (
    changeSetId: string,
    discardLaterEdits: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<RollbackResultView> => guarded('rollbackChangeSet', ctx, () => rollbackChangeSet(ctx, changeSetId, discardLaterEdits === true)),
  [],
);

udf.func(
  'getAgentReadiness',
  async (
    workspaceId: string,
    modelId: string,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<AgentAvailability> => guarded('getAgentReadiness', ctx, () => getAgentReadiness(ctx, workspaceId, modelId)),
  [],
);

udf.func(
  'setApprovedForCopilot',
  async (
    workspaceId: string,
    modelId: string,
    approved: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<ApprovalResult> => guarded('setApprovedForCopilot', ctx, () => setApprovedForCopilot(ctx, workspaceId, modelId, approved)),
  [],
);

udf.func(
  'draftBusinessContext',
  async (
    workspaceId: string,
    modelId: string,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<BusinessContextDraft> => guarded('draftBusinessContext', ctx, () => draftBusinessContext(ctx, workspaceId, modelId)),
  [],
);

udf.func(
  'interviewBusinessContext',
  async (
    workspaceId: string,
    modelId: string,
    turns: InterviewTurn[],
    existing: string,
    finish: boolean,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<InterviewStep> =>
    guarded('interviewBusinessContext', ctx, () => interviewBusinessContext(ctx, workspaceId, modelId, turns, existing, finish)),
  [],
);

udf.func(
  'getPortfolio',
  async (
    query: PortfolioQuery,
    ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>,
  ): Promise<PortfolioView> => guarded('getPortfolio', ctx, () => getPortfolio(ctx, query)),
  [],
);

udf.func(
  'getServiceStatus',
  async (ctx: RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>): Promise<ServiceStatus> =>
    guarded('getServiceStatus', ctx, () => getServiceStatus(ctx)),
  [],
);
