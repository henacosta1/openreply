import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  automation: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  instagramAccount: { findFirst: vi.fn(), findMany: vi.fn() },
  workspace: { findUnique: vi.fn() },
  sync: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    automation: state.automation, instagramAccount: state.instagramAccount, workspace: state.workspace,
    $transaction: (run: (tx: unknown) => unknown) => run({ automation: state.automation }),
  },
}));
vi.mock("@/lib/campaigns/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/campaigns/links")>()),
  syncCampaignLinks: state.sync,
}));

import { callTool, listTools } from "../lib/integrations/mcp";

const writer = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read", "campaigns:write"] };
const campaign = {
  name: "Not only steak", postId: "18016590008978681", postUrl: "https://www.instagram.com/reel/DfMS-vRRT-H/",
  keywords: ["IDEAS"], wholeWordMatch: false, publicReplyEnabled: true, publicReplyMessages: ["Check your DMs 📩", " "],
  openingDmEnabled: true, openingDmMessage: "G'day!", openingDmButtonLabel: "Send it",
  dmMessage: "5 ways", trackedDestinationUrl: "https://chimmy.com.au/pages/ad", linkButtonLabel: "Shop Chimmy",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.workspace.findUnique.mockResolvedValue({ id: "workspace" });
  state.instagramAccount.findFirst.mockResolvedValue({ id: "account" });
  state.automation.create.mockImplementation(async ({ data }) => ({ id: "new", ...data }));
  state.automation.findFirst.mockResolvedValue({ id: "new", instagramAccountId: "account", trackedLinks: [] });
  state.automation.update.mockResolvedValue({ id: "new" });
});

describe("write-scoped MCP tools", () => {
  it("advertises write tools only to write keys", () => {
    expect(listTools(writer).map(tool => tool.name)).toEqual([
      "list_campaigns", "get_campaign", "get_campaign_stats", "list_instagram_accounts",
      "create_campaign", "update_campaign", "set_campaign_active",
    ]);
    expect(listTools({ ...writer, scopes: ["campaigns:write"] }).every(tool => !tool.annotations.readOnlyHint)).toBe(true);
  });

  it("creates campaigns paused, workspace-scoped and like the builder", async () => {
    await callTool(writer, "create_campaign", campaign);
    const { data } = state.automation.create.mock.calls[0][0];
    expect(data).toMatchObject({
      workspaceId: "workspace", instagramAccountId: "account", isActive: false, postId: campaign.postId,
      keywords: ["IDEAS"], wholeWordMatch: false, publicReplyMessages: ["Check your DMs 📩"], publicReplyMessage: "Check your DMs 📩",
      openingDmMessage: "G'day!", linkButtonLabel: "Shop Chimmy",
    });
    expect(data.trackedLinks.create[0]).toMatchObject({ workspaceId: "workspace", destinationUrl: campaign.trackedDestinationUrl });
    expect(state.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "workspace" });
  });

  it("goes live at creation only when asked", async () => {
    await callTool(writer, "create_campaign", { ...campaign, isActive: true });
    expect(state.automation.create.mock.calls[0][0].data.isActive).toBe(true);
  });

  it("rejects unknown fields, invalid campaigns and foreign accounts", async () => {
    await expect(callTool(writer, "create_campaign", { ...campaign, workspaceId: "other" })).rejects.toMatchObject({ status: 400 });
    await expect(callTool(writer, "create_campaign", { ...campaign, keywords: [] })).rejects.toMatchObject({ status: 400 });
    await expect(callTool(writer, "create_campaign", { ...campaign, postId: null })).rejects.toMatchObject({ status: 400 });
    state.instagramAccount.findFirst.mockResolvedValue(null);
    await expect(callTool(writer, "create_campaign", { ...campaign, instagramAccountId: "foreign" })).rejects.toMatchObject({ status: 400 });
    expect(state.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({ id: "foreign", workspaceId: "workspace" });
    expect(state.automation.create).not.toHaveBeenCalled();
  });

  it("updates and toggles only campaigns in the key's workspace", async () => {
    await callTool(writer, "set_campaign_active", { id: "new", isActive: true });
    expect(state.automation.findFirst.mock.calls[0][0].where).toEqual({ id: "new", workspaceId: "workspace" });
    expect(state.automation.update.mock.calls[0][0]).toEqual({ where: { id: "new" }, data: { isActive: true } });
    await callTool(writer, "update_campaign", { id: "new", changes: { keywords: ["RECIPE"] } });
    expect(state.automation.update.mock.calls[1][0].data).toEqual({ keywords: ["RECIPE"] });
    await expect(callTool(writer, "update_campaign", { id: "new", changes: {} })).rejects.toMatchObject({ status: 400 });
    await expect(callTool(writer, "update_campaign", { id: "new", changes: { reportShareEnabled: true } })).rejects.toMatchObject({ status: 400 });
    state.automation.findFirst.mockResolvedValue(null);
    await expect(callTool(writer, "set_campaign_active", { id: "foreign", isActive: true })).rejects.toMatchObject({ status: 404 });
  });
});
