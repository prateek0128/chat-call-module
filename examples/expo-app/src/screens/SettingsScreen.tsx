/** Settings: Appearance sheet, Blocked users, a standalone ReportSheet, push status, log out. */
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useComms, useConnectionStatus } from "commskit/core";
import { useBlocking } from "commskit/moderation";
import { AppearanceSheet, ReportSheet } from "commskit/chat-ui";
import { useAppearance, useTheme } from "commskit/theme";
import { pickWallpaperImage } from "../pickers";
import { useApp, type RootStackParamList } from "../Main";
import type { DemoUser } from "../session";

export function SettingsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Settings">) {
  const { session, push, logout, chat, calls } = useApp();
  const { client } = useComms();
  const status = useConnectionStatus();
  const { blockedIds } = useBlocking();
  const appearance = useAppearance();
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [reportPeer, setReportPeer] = useState<DemoUser | null>(null);
  const others = session.users.filter((u) => u.id !== session.userId);

  const doLogout = () =>
    Alert.alert("Log out", `Sign out ${session.userName}? This unregisters this phone for push.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: async () => {
          await logout(); // DELETE /devices/{id} first, then drop the token
          client.disconnect();
        },
      },
    ]);

  const Row = ({ label, value, onPress, testID, danger }: { label: string; value?: string; onPress?: () => void; testID?: string; danger?: boolean }) => (
    <Pressable
      testID={testID}
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={[s.row, { borderColor: c.border, backgroundColor: c.surface }]}
    >
      <Text style={[s.rowLabel, { color: danger ? c.danger : c.text }]}>{label}</Text>
      {value ? <Text style={[s.rowValue, { color: c.textMuted }]} numberOfLines={2}>{value}</Text> : null}
    </Pressable>
  );
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: c.textMuted }]}>{title}</Text>
      {children}
    </View>
  );

  const pushText = push.result?.registered
    ? `Registered (${push.result.permission})${push.result.voipToken ? " + VoIP" : ""}`
    : push.error || "Registering…";

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <Section title="Account">
          <Row label="Signed in as" value={`${session.userName} (${session.userId})`} />
          <Row label="Server" value={session.baseUrl} />
          <Row label="Mode" value={[chat && "chat", calls && "calls"].filter(Boolean).join(" + ")} />
          <Row label="Connection" value={status.status} />
          <Row label="Push" value={pushText} />
        </Section>

        <Section title="Appearance">
          <Row testID="settings-appearance" label="Theme & wallpaper" value={`${appearance.mode} · ${appearance.preset}`} onPress={() => setAppearanceOpen(true)} />
        </Section>

        <Section title="Privacy">
          <Row testID="settings-blocked" label="Blocked users" value={blockedIds.length ? String(blockedIds.length) : undefined} onPress={() => navigation.navigate("Blocked")} />
          {others.map((u) => (
            <Row key={u.id} testID={`settings-report-${u.id}`} label={`Report ${u.name}`} onPress={() => setReportPeer(u)} />
          ))}
        </Section>

        <Section title="Session">
          <Row testID="logout" label="Log out" danger onPress={doLogout} />
        </Section>
      </ScrollView>

      <AppearanceSheet visible={appearanceOpen} onClose={() => setAppearanceOpen(false)} pickImage={chat ? pickWallpaperImage : undefined} insetBottom={insets.bottom} />
      <ReportSheet
        visible={!!reportPeer}
        peerId={reportPeer?.id ?? ""}
        name={reportPeer?.name}
        onClose={() => setReportPeer(null)}
        onSubmitted={({ blocked }) => blocked && Alert.alert("Report sent", `${reportPeer?.name} is now blocked.`)}
        insetBottom={insets.bottom}
      />
    </View>
  );
}

const s = StyleSheet.create({
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", marginHorizontal: 16, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  rowLabel: { fontSize: 16, fontWeight: "500" },
  rowValue: { fontSize: 14, flexShrink: 1, textAlign: "right" },
});
