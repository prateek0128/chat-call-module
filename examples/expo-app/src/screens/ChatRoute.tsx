/** One conversation: the kit's ChatScreen with appearance + moderation menus and, with calls on, the call button. */
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCall } from "commskit/call";
import { ChatScreen, type ChatScreenProps } from "commskit/chat-ui";
import { pickAttachment, pickWallpaperImage } from "../pickers";
import { useApp, type RootStackParamList } from "../Main";

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

export function ChatRoute(props: Props) {
  const { calls } = useApp();
  // useCall() only exists under <CallProvider> (not mounted in Chat mode).
  return calls ? <ChatWithCalls {...props} /> : <ChatBase {...props} />;
}

function ChatWithCalls(props: Props) {
  const { startCall } = useCall(); // the host bridges chat-ui -> call
  const { chatId, peerName } = props.route.params;
  return <ChatBase {...props} onCall={(peerId) => void startCall(peerId, { chatId: chatId ?? null, peerName })} />;
}

function ChatBase({ route, navigation, onCall }: Props & { onCall?: ChatScreenProps["onCall"] }) {
  const { peerId, chatId, peerName } = route.params;
  return (
    <ChatScreen
      peerId={peerId}
      chatId={chatId ?? null}
      peerName={peerName}
      onBack={navigation.goBack}
      onCall={onCall}
      pickAttachment={pickAttachment}
      appearanceMenu
      pickWallpaperImage={pickWallpaperImage}
      moderationMenu
    />
  );
}
