import { FakePlaid } from "./server.ts";

const fake = new FakePlaid({
  port: Number(process.env.FAKE_PLAID_PORT ?? 4010),
  seed: Number(process.env.FAKE_PLAID_SEED ?? 42),
  clientId: process.env.PLAID_CLIENT_ID || "fake-client-id",
  secret: process.env.PLAID_SECRET || "fake-secret",
  initialSize: Number(process.env.FAKE_PLAID_INITIAL_SIZE ?? 230),
  batches: Number(process.env.FAKE_PLAID_BATCHES ?? 4),
  defaultWebhook: process.env.FAKE_PLAID_WEBHOOK_URL ?? null,
});
const url = await fake.listen();
process.stdout.write(`${JSON.stringify({ event: "fake_plaid_listening", url })}\n`);
const stop = () => void fake.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
