/** Chat list: the kit's ConversationListScreen (+ Appearance action, + Settings). */
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ConversationListScreen } from "commskit/chat-ui";
import { pickWallpaperImage } from "../pickers";
import { useApp, type RootStackParamList } from "../Main";
import { HeaderButton } from "./HeaderButton";

export function InboxScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Inbox">) {
  const { session } = useApp();
  return (
    <ConversationListScreen
      title="Chats"
      me={{ id: session.userId, name: session.userName }}
      onOpenConversation={(peerId, conversation) => navigation.navigate("Chat", { peerId, chatId: conversation.chat_id ?? null })}
      showAppearanceAction
      pickWallpaperImage={pickWallpaperImage}
      renderHeaderActions={() => <HeaderButton testID="open-settings" icon="cog-outline" label="Settings" onPress={() => navigation.navigate("Settings")} />}
      emptyTitle="No chats yet"
      emptyText="Sign in as another demo user on a second phone (or the browser demo) and say hi."
    />
  );
}
