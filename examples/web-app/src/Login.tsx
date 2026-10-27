import { FormEvent, useEffect, useState } from "react";

export interface Session {
  /** REST / WebSocket base (the page's own origin when the dev proxy is used). */
  baseUrl: string;
  token: string;
  userId: string;
  userName: string;
  /** Everyone on the demo server (for the "New chat" picker). */
  people: DemoUser[];
}

export interface DemoUser {
  id: string;
  name: string;
}

const DEFAULT_SERVER = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || "http://localhost:8000";

const trim = (u: string) => u.trim().replace(/\/+$/, "");

export function Login({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [proxy, setProxy] = useState(true);
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = proxy ? window.location.origin : trim(server);

  const loadUsers = async () => {
    setError(null);
    setUsers(null);
    try {
      const res = await fetch(`${base}/dev/users`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { users: DemoUser[] };
      setUsers(data.users);
      return data.users;
    } catch (e) {
      setError(`Couldn't reach the demo server at ${base} (${(e as Error).message}). Is it running? ${proxy ? "The dev proxy forwards to COMMS_SERVER." : "Without the proxy the server must allow CORS (COMMS_CORS_ORIGINS)."}`);
      return null;
    }
  };

  const signIn = async (u: DemoUser, list: DemoUser[] | null = users) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/dev/token/${encodeURIComponent(u.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      onSignIn({ baseUrl: base, token, userId: u.id, userName: u.name, people: list || [u] });
    } catch (e) {
      setError(`Sign-in failed: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  useEffect(() => {
    // ?user=U1 signs in straight away (handy for opening two tabs as Alice and Bob).
    const wanted = new URLSearchParams(window.location.search).get("user");
    void loadUsers().then((list) => {
      const u = wanted && list?.find((x) => x.id === wanted);
      if (u) void signIn(u, list);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxy]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void loadUsers();
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={onSubmit} aria-labelledby="login-title">
        <h1 id="login-title">commskit web chat</h1>
        <p className="login-sub">Sign in as one of the demo users. Open a second tab or browser profile as someone else.</p>
        <label className="login-field">
          <span>Server URL</span>
          <input value={server} onChange={(e) => setServer(e.target.value)} disabled={proxy} inputMode="url" autoComplete="off" spellCheck={false} aria-label="Server URL" />
        </label>
        <label className="login-check">
          <input type="checkbox" checked={proxy} onChange={(e) => setProxy(e.target.checked)} />
          <span>Use the dev proxy (same origin, no CORS). It forwards to the server the dev server was started with.</span>
        </label>
        <button type="submit" className="ck-btn">
          Load users
        </button>
        {error ? (
          <p className="ck-error" role="alert">
            {error}
          </p>
        ) : null}
        {users ? (
          <ul className="login-users" aria-label="Demo users">
            {users.map((u) => (
              <li key={u.id}>
                <button type="button" className="ck-btn ck-btn-primary" disabled={busy} onClick={() => void signIn(u)}>
                  Sign in as {u.name} ({u.id})
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </main>
  );
}
