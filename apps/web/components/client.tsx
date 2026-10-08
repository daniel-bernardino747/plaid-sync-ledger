"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

async function post(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `request failed (${res.status})`);
  return json;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );
  return { busy, error, run };
}

export function LoginPicker({ users }: { users: { id: string; name: string }[] }) {
  const { busy, error, run } = useAction();
  return (
    <div className="row">
      {users.map((u) => (
        <button key={u.id} className="primary" disabled={busy} onClick={() => run(() => post("/api/session", { userId: u.id }))}>
          Continue as {u.name}
        </button>
      ))}
      {users.length === 0 && <p className="muted">No users yet. Run the seed: pnpm --filter @psl/db seed</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function LogoutButton() {
  const { busy, run } = useAction();
  return (
    <button disabled={busy} onClick={() => run(() => post("/api/logout"))}>
      Sign out
    </button>
  );
}

/** Opens Plaid Link with a server-issued link token. Used for new Items and update mode. */
function LinkLauncher({ linkToken, onSuccess, onDone }: { linkToken: string; onSuccess: (publicToken: string) => void; onDone: () => void }) {
  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess: (pt) => pt && onSuccess(pt), onExit: () => onDone() });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

export function ConnectButtons({ linkAvailable }: { linkAvailable: boolean }) {
  const { busy, error, run } = useAction();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  return (
    <div className="row">
      {linkAvailable && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => run(async () => setLinkToken(String((await post("/api/plaid/link-token")).linkToken)))}
        >
          Connect a bank
        </button>
      )}
      <button disabled={busy} onClick={() => run(() => post("/api/plaid/sandbox-connect"))}>
        Connect sandbox bank (no Link UI)
      </button>
      {linkToken && (
        <LinkLauncher
          linkToken={linkToken}
          onSuccess={(publicToken) => run(() => post("/api/plaid/exchange", { publicToken }))}
          onDone={() => setLinkToken(null)}
        />
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function ItemActions({ itemId, status, linkAvailable }: { itemId: string; status: string; linkAvailable: boolean }) {
  const { busy, error, run } = useAction();
  const [linkToken, setLinkToken] = useState<string | null>(null);

  if (status === "needs_reauth") {
    return (
      <div className="row">
        {linkAvailable ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => run(async () => setLinkToken(String((await post("/api/plaid/link-token", { itemId })).linkToken)))}
          >
            Reconnect
          </button>
        ) : (
          <span className="muted">Reconnecting runs Plaid Link in update mode: set PLAID_TARGET=sandbox.</span>
        )}
        {linkToken && (
          <LinkLauncher
            linkToken={linkToken}
            // Update mode returns no new token to exchange; the server verifies with /item/get.
            onSuccess={() => run(() => post(`/api/items/${itemId}/reauth-complete`))}
            onDone={() => setLinkToken(null)}
          />
        )}
        {error && <span className="error">{error}</span>}
      </div>
    );
  }
  if (status !== "active") return null;
  return (
    <div className="row">
      <button disabled={busy} onClick={() => run(() => post(`/api/items/${itemId}/sandbox-reset-login`))}>
        Simulate login required
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
