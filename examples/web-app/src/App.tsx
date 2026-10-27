import { useMemo, useState } from "react";
import { AppearanceProvider, Avatar, ChatApp, CommsStack, Dialog, Icon, useChat, useChatApi, type CommsConfig } from "commskit-web";
import { Login, type Session } from "./Login";

const SESSION_KEY = "commskit.demo.session";

const loadSession = (): Session | null => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  const signIn = (s: Session) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* private mode: the session lasts until reload */
    }
    setSession(s);
  };
  const signOut = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    setSession(null);
  };

  return (
    <AppearanceProvider>
      <div className="app-shell">{session ? <Chat key={`${session.baseUrl}|${session.userId}`} session={session} onSignOut={signOut} /> : <Login onSignIn={signIn} />}</div>
    </AppearanceProvider>
  );
}

function Chat({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const config = useMemo<CommsConfig>(
    () => ({ baseUrl: session.baseUrl, getToken: () => session.token, getUserId: () => session.userId }),
    [session],
  );
  return (
    <CommsStack config={config}>
      <Shell session={session} onSignOut={onSignOut} />
    </CommsStack>
  );
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const api = useChatApi();
  const chat = useChat();
  // ?open=U2 opens that chat straight away (used with ?user=U1 to open two tabs quickly).
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("open"));
  const [picking, setPicking] = useState(false);

  const open = async (id: string) => {
    setPicking(false);
    try {
      await api.startChat(id); // creates the chat if it does not exist yet
    } catch {
      /* the chat screen shows its own errors */
    }
    chat.refresh();
    setSelected(id);
  };

  return (
    <>
      <ChatApp
        selectedPeerId={selected}
        onSelectedChange={setSelected}
        list={{
          title: "Chats",
          headerActions: (
            <>
              <button type="button" className="ck-icon-btn" aria-label="New chat" title="New chat" onClick={() => setPicking(true)}>
                <Icon name="edit" />
              </button>
              <button type="button" className="ck-btn ck-btn-small" onClick={onSignOut} aria-label={`Sign out ${session.userName}`} title={`Signed in as ${session.userName}`} style={{ whiteSpace: "nowrap" }}>
                Sign out
              </button>
            </>
          ),
        }}
      />
      {picking ? (
        <Dialog label="New chat" onClose={() => setPicking(false)}>
          <div className="ck-sheet-head">
            <h2 className="ck-dialog-title">New chat</h2>
            <button type="button" className="ck-btn" onClick={() => setPicking(false)}>
              Close
            </button>
          </div>
          <ul className="ck-blocked-list ck-sheet-scroll" aria-label="People">
            {session.people
              .filter((p) => p.id !== session.userId)
              .map((p) => (
                <li key={p.id} className="ck-blocked-row">
                  <Avatar name={p.name} id={p.id} size={40} />
                  <span className="ck-row-name">{p.name}</span>
                  <button type="button" className="ck-btn ck-btn-primary" aria-label={`Chat with ${p.name}`} onClick={() => void open(p.id)}>
                    Chat
                  </button>
                </li>
              ))}
          </ul>
        </Dialog>
      ) : null}
    </>
  );
}
