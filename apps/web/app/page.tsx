import { forUser } from "@psl/db";
import { currentUser } from "../lib/auth.ts";
import { getDeps } from "../lib/deps.ts";
import { ConnectButtons, ItemActions, LoginPicker, LogoutButton } from "../components/client.tsx";

export const dynamic = "force-dynamic";

export default async function Home() {
  const deps = await getDeps();
  const userId = await currentUser();

  if (!userId) {
    // users is readable before login (demo picker only, ADR 0007).
    const users = await deps.webDb.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
    return (
      <>
        <h1>plaid-sync-ledger</h1>
        <p className="sub">Pick a demo user. Each one only ever sees their own data, enforced by Postgres row-level security.</p>
        <LoginPicker users={users} />
      </>
    );
  }

  // Everything below runs under RLS for this user. No query filters by user_id.
  const data = await forUser(deps.webDb, userId, async (tx) => ({
    me: await tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
    items: await tx.item.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, plaidItemId: true, status: true, lastSyncedAt: true, _count: { select: { transactions: true } } },
    }),
    transactions: await tx.transaction.findMany({
      where: { removedAt: null },
      orderBy: [{ date: "desc" }, { plaidTransactionId: "asc" }],
      take: 100,
      select: {
        plaidTransactionId: true,
        date: true,
        name: true,
        merchantName: true,
        amount: true,
        isoCurrencyCode: true,
        pending: true,
      },
    }),
  }));

  return (
    <>
      <header>
        <div>
          <h1>{data.me?.name}&apos;s ledger</h1>
          <p className="sub">Synced from Plaid by a background worker. Refresh to see new data.</p>
        </div>
        <LogoutButton />
      </header>

      <ConnectButtons linkAvailable={deps.linkAvailable} />

      <h2>Connected items</h2>
      {data.items.length === 0 ? (
        <p className="muted">No bank connected yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Plaid item</th>
                <th>Status</th>
                <th>Last sync</th>
                <th className="num">Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <code>{i.plaidItemId}</code>
                  </td>
                  <td>
                    <span className={`pill ${i.status}`}>{i.status.replace("_", " ")}</span>
                  </td>
                  <td className="muted">{i.lastSyncedAt ? i.lastSyncedAt.toISOString().replace("T", " ").slice(0, 19) : "never"}</td>
                  <td className="num">{i._count.transactions}</td>
                  <td>
                    <ItemActions itemId={i.id} status={i.status} linkAvailable={deps.linkAvailable} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Latest transactions</h2>
      {data.transactions.length === 0 ? (
        <p className="muted">Nothing synced yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.plaidTransactionId}>
                  <td className="muted">{t.date.toISOString().slice(0, 10)}</td>
                  <td>{t.merchantName ?? t.name}</td>
                  {/* Decimal rendered from its string form: no float on the way to the screen either. */}
                  <td className="num">
                    {t.amount.toFixed(2)} {t.isoCurrencyCode ?? ""}
                  </td>
                  <td className="muted">{t.pending ? "pending" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
