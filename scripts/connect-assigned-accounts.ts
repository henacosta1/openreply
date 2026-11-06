// Unified login only: connects every Instagram account an already-stored token
// was granted, the same way the OAuth callback does, without another login.
// Usage: npx tsx --env-file=.env scripts/connect-assigned-accounts.ts <username-already-connected>
import { prisma } from "@/lib/db/client";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getAssignedInstagramAccounts,
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

async function main() {
  const source = await prisma.instagramAccount.findFirst({
    where: { username: process.argv[2], provider: "META" },
  });
  if (!source) throw new Error(`No META account named ${process.argv[2]}`);
  const token = decryptToken(source.accessToken);

  for (const { id } of await getAssignedInstagramAccounts(token)) {
    const info = await getUserInfo(token, id);
    const instagramId = info.user_id ?? info.id;
    const check = await canConnectInstagramAccount({
      workspaceId: source.workspaceId,
      instagramId,
    });
    if (!check.allowed) {
      console.log(`${info.username}: skipped (${check.reason})`);
      continue;
    }
    const sub = await subscribeInstagramAccountToWebhooks(instagramId, token).catch(
      (e) => (console.warn(`${info.username}: webhook subscribe failed`, e.message), null)
    );
    const data = {
      username: info.username,
      name: info.name,
      accessToken: source.accessToken,
      tokenExpiresAt: source.tokenExpiresAt,
      webhookSubscribed: Boolean(sub?.success),
    };
    await prisma.instagramAccount.upsert({
      where: { instagramId },
      update: data,
      create: { ...data, instagramId, workspaceId: source.workspaceId, provider: "META" },
    });
    console.log(`${info.username}: connected, webhook ${data.webhookSubscribed ? "on" : "off"}`);
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
