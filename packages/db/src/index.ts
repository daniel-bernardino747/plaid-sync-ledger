import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client.ts";

export { PrismaClient, Prisma };
export * from "./generated/prisma/enums.ts";
export type * from "./generated/prisma/models.ts";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

/**
 * One client per database role (ADR 0007). Which role a process uses is decided
 * by the connection string it is given, never by a flag in code:
 * - DATABASE_URL_WEB    -> app_web, subject to RLS
 * - DATABASE_URL_SYSTEM -> app_system, BYPASSRLS, background processes only
 */
export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  const adapter = new PrismaPg({ connectionString, max: opts.max ?? 10 });
  return new PrismaClient({ adapter });
}

/**
 * Runs `fn` inside a transaction whose RLS context is `userId`.
 *
 * `set_config(..., true)` is transaction-local (same effect as SET LOCAL), so
 * the setting dies with the transaction and can never leak to the next request
 * that reuses this pooled connection. Outside this function an app_web
 * connection has no user context and every scoped table reads as empty.
 */
export async function forUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}
