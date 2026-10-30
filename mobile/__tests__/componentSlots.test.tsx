/** Host component slots (`components` on ThemeProvider): replacements render instead of the built-ins. */
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";
import type { Conversation } from "../src/chat/types";
import { ConversationList, type ChatUiSlots } from "../src/chat-ui";
import { CallButton, type CallUiSlots } from "../src/call-ui";
import { Avatar, DefaultAvatar, ThemeProvider, type AvatarProps } from "../src/theme";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const RN = require("react-native");

const mounted: ReactTestRenderer[] = [];
const render = (el: ReactElement, components?: any): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <ThemeProvider colorScheme="light" components={components}>
        {el}
      </ThemeProvider>,
    );
  });
  mounted.push(r);
  return r;
};
afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));
const realError = console.error;
const realReduceMotion = RN.AccessibilityInfo.isReduceMotionEnabled;
beforeAll(() => {
  RN.AccessibilityInfo.isReduceMotionEnabled = () => ({ then: (cb: (v: boolean) => void) => (cb(false), { catch: () => undefined }) });
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  RN.AccessibilityInfo.isReduceMotionEnabled = realReduceMotion;
  console.error = realError;
});

const conv = (over: Partial<Conversation>): Conversation => ({ user_id: "1", username: "Asha", chat_id: 1, unread_count: 0, ...over }) as Conversation;
const hasTestId = (r: ReactTestRenderer, id: string) => r.root.findAll((n) => n.props?.testID === id).length > 0;

describe("component slots", () => {
  it("renders the host's ConversationRow instead of the built-in", () => {
    const MyRow: NonNullable<ChatUiSlots["ConversationRow"]> = ({ conversation }) => {
      const { Text } = RN;
      return <Text testID="my-row">{conversation.username}</Text>;
    };
    const r = render(<ConversationList conversations={[conv({}), conv({ user_id: "2", username: "Bina" })]} loaded onOpenConversation={() => {}} />, { ConversationRow: MyRow } satisfies ChatUiSlots);
    expect(r.root.findAll((n) => n.props?.testID === "my-row" && typeof n.type === "string")).toHaveLength(2);
  });

  it("renders the host's Avatar, which may wrap DefaultAvatar", () => {
    const MyAvatar = (p: AvatarProps) => {
      const { View } = RN;
      return (
        <View testID="my-avatar">
          <DefaultAvatar {...p} />
        </View>
      );
    };
    expect(hasTestId(render(<Avatar name="Asha" />, { Avatar: MyAvatar }), "my-avatar")).toBe(true);
    expect(hasTestId(render(<Avatar name="Asha" />), "my-avatar")).toBe(false);
  });

  it("call-ui components are replaceable too (CallButton)", () => {
    const MyButton: NonNullable<CallUiSlots["CallButton"]> = () => {
      const { View } = RN;
      return <View testID="my-call-button" />;
    };
    const r = render(<CallButton icon="mic" accessibilityLabel="Mute" onPress={() => {}} />, { CallButton: MyButton } satisfies CallUiSlots);
    expect(hasTestId(r, "my-call-button")).toBe(true);
  });
});
