/** Calls-only mode: no chat list, so show the demo users with a call button each. */
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useCall } from "commskit/call";
import { useOptionalBlocking } from "commskit/moderation";
import { Avatar, useTheme } from "commskit/theme";
import { useApp, type RootStackParamList } from "../Main";
import { HeaderButton } from "./HeaderButton";

export function PeopleScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "People">) {
  const { session } = useApp();
  const { startCall } = useCall();
  const blocking = useOptionalBlocking();
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const people = session.users.filter((u) => u.id !== session.userId);
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <View style={[s.header, { borderColor: c.border, backgroundColor: c.surface }]}>
        <Text style={[s.title, { color: c.text }]} accessibilityRole="header">
          Calls
        </Text>
        <HeaderButton testID="open-settings" icon="cog-outline" label="Settings" onPress={() => navigation.navigate("Settings")} />
      </View>
      <FlatList
        data={people}
        keyExtractor={(u) => u.id}
        renderItem={({ item }) => {
          const blocked = blocking?.isBlockedPair(item.id) ?? false;
          return (
            <View style={[s.row, { borderColor: c.border, backgroundColor: c.surface }]}>
              <Avatar name={item.name} id={item.id} size={44} />
              <Text style={[s.name, { color: c.text }]}>{item.name}</Text>
              <Pressable
                testID={`call-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Call ${item.name}`}
                accessibilityState={{ disabled: blocked }}
                disabled={blocked}
                onPress={() => void startCall(item.id, { peerName: item.name })}
                style={[s.call, { backgroundColor: blocked ? c.border : c.callAccept }]}
              >
                <MaterialCommunityIcons name="phone" size={22} color="#fff" />
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 22, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, fontSize: 17, fontWeight: "600" },
  call: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
});
