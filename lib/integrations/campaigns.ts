import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import {
  CampaignMutationError,
  createAutomationRecord,
  createAutomationSchema,
  updateAutomationRecord,
  updateAutomationSchema,
} from "@/lib/campaigns/mutations";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

const summarySelect = {
  id: true, name: true, goal: true, instagramAccountId: true, isActive: true,
  postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
  keywords: true, matchAnyWord: true, dmMessage: true, createdAt: true, updatedAt: true,
} as const;

export async function listCampaigns(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.automation.findMany({
    where: { workspaceId: context.workspaceId }, select: summarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100,
  });
}

export async function listInstagramAccounts(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    select: { id: true, username: true, name: true, instagramId: true, webhookSubscribed: true },
    orderBy: [{ connectedAt: "desc" }, { id: "asc" }],
  });
}

// Safe projection shared by reads and the result of writes: no provider
// tokens, report-share secrets, recipient logs or account relations.
async function readCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId },
    select: {
      ...summarySelect, wholeWordMatch: true, dmTriggerEnabled: true,
      openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
      linkButtonLabel: true, requireFollow: true, followPromptMessage: true,
      followPromptButtonLabel: true, followUpEnabled: true, followUpMessage: true,
      followUpDelayMinutes: true, publicReplyEnabled: true, publicReplyMessage: true,
      publicReplyMessages: true,
      trackedLinks: {
        where: { workspaceId }, orderBy: TRACKED_LINK_ORDER,
        select: { destinationUrl: true, label: true, position: true },
      },
    },
  });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  const [primary, secondary] = campaign.trackedLinks;
  return {
    ...campaign, trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
  };
}

export async function getCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:read");
  return readCampaign(context.workspaceId, id);
}

export async function getCampaignStats(context: ServiceContext, id: string) {
  await getCampaign(context, id);
  const [statuses, rawClicks] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["status"], where: { workspaceId: context.workspaceId, automationId: id }, _count: { _all: true } }),
    prisma.linkClick.count({ where: { workspaceId: context.workspaceId, automationId: id } }),
  ]);
  return { campaignId: id, statuses, rawClicks, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
}

// Writes reuse the dashboard's validation and storage, so a campaign made by a
// service key is indistinguishable from one made in the builder.
const writableFields = new Set(Object.keys(updateAutomationSchema.shape).filter(key => key !== "reportShareEnabled"));

function rejectUnknownFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Campaign fields must be an object");
  const unknown = Object.keys(input).filter(key => !writableFields.has(key));
  if (unknown.length) throw new ApiError(`Unknown campaign fields: ${unknown.join(", ")}`);
  return input as Record<string, unknown>;
}

function firstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "campaign"}: ${issue.message}` : "Invalid campaign";
}

async function runMutation<T>(mutation: () => Promise<T>) {
  try { return await mutation(); }
  catch (error) {
    if (error instanceof CampaignMutationError) throw new ApiError(error.message, error.status);
    throw error;
  }
}

export async function createCampaign(context: ServiceContext, input: unknown) {
  requireScope(context, "campaigns:write");
  // Unlike the builder, a service key creates campaigns paused unless it asks
  // otherwise: going live sends real DMs.
  const parsed = createAutomationSchema.safeParse({ isActive: false, ...rejectUnknownFields(input) });
  if (!parsed.success) throw new ApiError(firstIssue(parsed.error));
  const created = await runMutation(() => createAutomationRecord(context.workspaceId, parsed.data));
  return readCampaign(context.workspaceId, created.id);
}

export async function updateCampaign(context: ServiceContext, id: string, changes: unknown) {
  requireScope(context, "campaigns:write");
  const parsed = updateAutomationSchema.safeParse(rejectUnknownFields(changes));
  if (!parsed.success) throw new ApiError(firstIssue(parsed.error));
  if (!Object.keys(parsed.data).length) throw new ApiError("No campaign changes given");
  await runMutation(() => updateAutomationRecord(context.workspaceId, id, parsed.data));
  return readCampaign(context.workspaceId, id);
}

export async function setCampaignActive(context: ServiceContext, id: string, isActive: boolean) {
  requireScope(context, "campaigns:write");
  await runMutation(() => updateAutomationRecord(context.workspaceId, id, { isActive }));
  return readCampaign(context.workspaceId, id);
}
