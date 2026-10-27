/**
 * App-wide user_id -> {name, avatar} cache, shared by chat and call.
 * Chat feeds it from `res_users` / `res_messages.info`; call feeds it from
 * `incoming_call` and reads it to show the peer's name. Hosts may seed it too
 * (`directory.remember([{user_id, username, avatar}])`).
 */

export interface UserProfile {
  name?: string;
  avatar?: string;
}

export interface UserLike {
  user_id?: string | null;
  username?: string | null;
  avatar?: string | null;
}

type Listener = () => void;

/** A name that is just the user's id is not a real name (legacy `caller_name` quirk). */
const isRealName = (userId: string, name?: string | null): name is string =>
  !!name && name.trim() !== "" && name !== userId;

export class UserDirectory {
  private profiles = new Map<string, UserProfile>();
  private listeners = new Set<Listener>();
  private version = 0;

  remember(users: ReadonlyArray<UserLike | null | undefined>): void {
    let changed = false;
    for (const u of users) {
      if (!u?.user_id) continue;
      const id = String(u.user_id);
      const prev = this.profiles.get(id) || {};
      const next: UserProfile = { ...prev };
      if (isRealName(id, u.username)) next.name = u.username;
      if (typeof u.avatar === "string" && u.avatar.trim() !== "") next.avatar = u.avatar;
      if (next.name !== prev.name || next.avatar !== prev.avatar) {
        this.profiles.set(id, next);
        changed = true;
      }
    }
    if (changed) {
      this.version += 1;
      this.listeners.forEach((l) => l());
    }
  }

  get(userId?: string | null): UserProfile | undefined {
    return userId ? this.profiles.get(String(userId)) : undefined;
  }

  getName(userId?: string | null): string | undefined {
    return this.get(userId)?.name;
  }

  getAvatar(userId?: string | null): string | undefined {
    return this.get(userId)?.avatar;
  }

  /** Changes on every update; usable as a `useSyncExternalStore` snapshot. */
  getVersion = (): number => this.version;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  clear(): void {
    this.profiles.clear();
    this.version += 1;
    this.listeners.forEach((l) => l());
  }
}
