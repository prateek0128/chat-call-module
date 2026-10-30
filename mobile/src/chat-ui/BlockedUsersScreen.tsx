import { slot } from "../theme";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useBlocking } from "../moderation/hooks";
import type { BlockedUser } from "../moderation/ModerationStore";
import { announce, Avatar, ScalePressable, useSafeInsets, useTheme, type EdgeInsets, type Theme } from "../theme";
import { textStyle } from "./primitives";

export interface BlockedUsersScreenProps {
  /** Load `GET /moderation/blocks` on mount (default true). */
  loadOnMount?: boolean;
  insets?: Partial<EdgeInsets>;
  /** Called after a successful unblock. */
  onUnblocked?: (userId: string) => void;
}

/** "Blocked users" settings screen: list from GET /moderation/blocks with an Unblock button per row. Needs <ModerationProvider>. */
export const DefaultBlockedUsersScreen = memo(function BlockedUsersScreen({ loadOnMount = true, insets, onUnblocked }: BlockedUsersScreenProps) {
  const theme = useTheme();
  const s = useStyles(theme);
  const safe = useSafeInsets(insets);
  const { blockedUsers, listBlocked, unblock } = useBlocking();
  const [loading, setLoading] = useState(loadOnMount);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    listBlocked()
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [listBlocked]);
  useEffect(() => {
    if (loadOnMount) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onUnblock = async (u: BlockedUser) => {
    setBusy(u.userId);
    try {
      await unblock(u.userId);
      announce(`${u.username || "User"} unblocked`);
      onUnblocked?.(u.userId);
    } catch {
      announce("Couldn't unblock. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const empty = loading ? "Loading..." : failed ? "Couldn't load blocked users." : "You haven't blocked anyone.";
  return (
    <View style={[s.fill, { paddingBottom: safe.bottom }]}>
      <FlatList
        data={blockedUsers}
        keyExtractor={(u) => u.userId}
        accessibilityLabel="Blocked users"
        renderItem={({ item }) => {
          const name = item.username || "Unknown";
          return (
            <View style={s.row}>
              <Avatar name={name} id={item.userId} uri={item.avatar} size={40} />
              <Text style={s.name} numberOfLines={1}>
                {name}
              </Text>
              <ScalePressable
                onPress={() => void onUnblock(item)}
                disabled={busy === item.userId}
                accessibilityLabel={`Unblock ${name}`}
                accessibilityState={{ busy: busy === item.userId }}
                style={s.unblock}
              >
                <Text style={s.unblockText}>Unblock</Text>
              </ScalePressable>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyText}>{empty}</Text>
            {failed ? (
              <ScalePressable onPress={load} accessibilityLabel="Retry" style={s.unblock}>
                <Text style={s.unblockText}>Retry</Text>
              </ScalePressable>
            ) : null}
          </View>
        }
      />
    </View>
  );
});

const useStyles = (theme: Theme) =>
  useMemo(
    () =>
      StyleSheet.create({
        fill: { flex: 1, backgroundColor: theme.colors.surface },
        row: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        name: { ...textStyle(theme, "body", theme.colors.text, "medium"), flex: 1, marginLeft: theme.space.md },
        unblock: {
          minHeight: theme.layout.tapTarget,
          paddingHorizontal: theme.space.md,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surfaceSunken,
          alignItems: "center",
          justifyContent: "center",
        },
        unblockText: textStyle(theme, "small", theme.colors.accent, "semibold"),
        empty: { alignItems: "center", padding: theme.space.xl, gap: theme.space.md },
        emptyText: textStyle(theme, "body", theme.colors.textMuted),
      }),
    [theme],
  );

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const BlockedUsersScreen = slot("BlockedUsersScreen", DefaultBlockedUsersScreen);
