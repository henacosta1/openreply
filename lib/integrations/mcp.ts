import { z } from "zod";
import {
  createCampaign, getCampaign, getCampaignStats, listCampaigns, listInstagramAccounts,
  setCampaignActive, updateCampaign,
} from "./campaigns";
import { requireScope, type ServiceContext, type ServiceScope } from "./auth";
import { ApiError } from "./http";

const idSchema = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false };
const text = (maxLength: number) => ({ type: "string", maxLength });
const nullableText = (maxLength: number) => ({ type: ["string", "null"], maxLength });
const url = { type: "string", description: "https URL, or empty string for none" };
const campaignFields = {
  name: { ...text(100), minLength: 1 },
  goal: nullableText(120),
  instagramAccountId: { type: "string", description: "id from list_instagram_accounts; defaults to the most recently connected account" },
  postId: { type: ["string", "null"], description: "Instagram media id of the post or reel" },
  postUrl: { type: ["string", "null"], description: "Permalink of that post or reel" },
  matchAnyPost: { type: "boolean" }, pendingNextReel: { type: "boolean" },
  keywords: { type: "array", items: { type: "string", minLength: 1, maxLength: 50 }, maxItems: 10 },
  matchAnyWord: { type: "boolean" },
  wholeWordMatch: { type: "boolean", description: "false also matches a keyword inside a longer word" },
  dmTriggerEnabled: { type: "boolean", description: "also reply to DMs containing the keywords" },
  publicReplyEnabled: { type: "boolean" },
  publicReplyMessages: { type: "array", items: text(1000), maxItems: 10, description: "one is picked at random per comment" },
  openingDmEnabled: { type: "boolean" },
  openingDmMessage: nullableText(1000), openingDmButtonLabel: nullableText(64),
  requireFollow: { type: "boolean" },
  followPromptMessage: nullableText(1000), followPromptButtonLabel: nullableText(20),
  dmMessage: { ...text(1000), minLength: 1, description: "the DM that carries the link" },
  trackedDestinationUrl: url, linkButtonLabel: nullableText(20),
  secondaryDestinationUrl: url, secondaryButtonLabel: nullableText(20),
  followUpEnabled: { type: "boolean" }, followUpMessage: nullableText(1000),
  followUpDelayMinutes: { type: "integer", minimum: 0, maximum: 1440 },
  isActive: { type: "boolean", description: "create_campaign defaults to false (paused)" },
};

type Annotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
type Tool = { name: string; description: string; inputSchema: object; scope: ServiceScope; annotations: Annotations };
const read: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tools: Tool[] = [
  { name: "list_campaigns", scope: "campaigns:read", annotations: read, description: "List up to 100 campaigns in this workspace; use get_campaign for complete settings and destination links.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_campaign", scope: "campaigns:read", annotations: read, description: "Read campaign settings and ordered destination links. Missing links are null, not invented.", inputSchema: idSchema },
  { name: "get_campaign_stats", scope: "campaigns:read", annotations: read, description: "Read aggregate send outcomes and raw link requests, not recipient conversions.", inputSchema: idSchema },
  { name: "list_instagram_accounts", scope: "campaigns:read", annotations: read, description: "List the Instagram accounts connected to this workspace (ids for campaigns; no tokens).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_campaign", scope: "campaigns:write", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Create a comment-to-DM campaign with the same rules as the dashboard builder. Starts PAUSED unless isActive is true; once live it sends real DMs.",
    inputSchema: { type: "object", properties: campaignFields, required: ["name", "dmMessage"], additionalProperties: false } },
  { name: "update_campaign", scope: "campaigns:write", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Change fields of an existing campaign; omitted fields stay as they are.",
    inputSchema: { type: "object", properties: { id: idSchema.properties.id, changes: { type: "object", properties: campaignFields, additionalProperties: false } }, required: ["id", "changes"], additionalProperties: false } },
  { name: "set_campaign_active", scope: "campaigns:write", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Go live (true) or pause (false) a campaign. Live campaigns send real DMs.",
    inputSchema: { type: "object", properties: { id: idSchema.properties.id, isActive: { type: "boolean" } }, required: ["id", "isActive"], additionalProperties: false } },
];

export function listTools(context: ServiceContext) {
  return tools.filter(tool => context.scopes.includes(tool.scope))
    .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

const id = z.string().min(1).max(100);
export async function callTool(context: ServiceContext, name: string, args: unknown) {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new ApiError("Unknown tool", 404);
  requireScope(context, tool.scope);
  const parse = <T extends z.ZodTypeAny>(schema: T, message: string): z.infer<T> => {
    const input = schema.safeParse(args);
    if (!input.success) throw new ApiError(message);
    return input.data;
  };
  switch (name) {
    case "list_campaigns": parse(z.object({}).strict(), "Invalid tool arguments"); return listCampaigns(context);
    case "list_instagram_accounts": parse(z.object({}).strict(), "Invalid tool arguments"); return listInstagramAccounts(context);
    case "get_campaign": return getCampaign(context, parse(z.object({ id }).strict(), "Campaign id required").id);
    case "get_campaign_stats": return getCampaignStats(context, parse(z.object({ id }).strict(), "Campaign id required").id);
    case "create_campaign": return createCampaign(context, args);
    case "update_campaign": {
      const input = parse(z.object({ id, changes: z.unknown() }).strict(), "Campaign id and changes required");
      return updateCampaign(context, input.id, input.changes);
    }
    default: {
      const input = parse(z.object({ id, isActive: z.boolean() }).strict(), "Campaign id and isActive required");
      return setCampaignActive(context, input.id, input.isActive);
    }
  }
}
