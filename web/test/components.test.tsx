import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppearanceSheet, ChatScreen, ConversationListScreen, DefaultAvatar, type CommsComponents } from "../src";
import { dto, renderChat, resMessages, user } from "./harness";

describe("component slots (AppearanceProvider components)", () => {
  it("renders the host's MessageBubble and Composer in a chat", async () => {
    const MyBubble: CommsComponents["MessageBubble"] = ({ message }) => <div data-testid="my-bubble">{message.content}</div>;
    const MyComposer: CommsComponents["Composer"] = () => <div data-testid="my-composer" />;
    const r = await renderChat(<ChatScreen peerId="U2" />, { appearance: { components: { MessageBubble: MyBubble, Composer: MyComposer } } });
    r.socket.receive({ type: "res_users", users: [user("U2", "Bob")] });
    r.socket.receive(resMessages([dto(1, { content: "hello there" })]));
    const bubbles = await screen.findAllByTestId("my-bubble");
    expect(bubbles[0].textContent).toBe("hello there");
    expect(screen.getByTestId("my-composer")).toBeTruthy();
    expect(r.container.querySelector(".ck-bubble")).toBeNull();
  });

  it("renders the host's ConversationRow and Avatar (which may wrap the default)", async () => {
    const MyRow: CommsComponents["ConversationRow"] = ({ conversation }) => <div data-testid="my-row">{String(conversation.user_id)}</div>;
    const MyAvatar: CommsComponents["Avatar"] = (p) => (
      <span data-testid="my-avatar">
        <DefaultAvatar {...p} />
      </span>
    );
    const r = await renderChat(<ConversationListScreen onSelect={() => {}} />, { appearance: { components: { ConversationRow: MyRow, Avatar: MyAvatar } } });
    r.socket.receive({ type: "res_users", users: [user("U2", "Bob"), user("U3", "Carol")] });
    expect((await screen.findAllByTestId("my-row")).map((e) => e.textContent)).toEqual(["U2", "U3"]);
    expect(r.container.querySelector(".ck-row")).toBeNull();
  });

  it("without components, the built-ins render", async () => {
    const r = await renderChat(<ConversationListScreen onSelect={() => {}} />);
    r.socket.receive({ type: "res_users", users: [user("U2", "Bob")] });
    expect(await screen.findAllByRole("option")).toHaveLength(1);
  });

  it("every UI piece is replaceable: header, dialogs and sheets too", async () => {
    const MyHeader: CommsComponents["ChatHeader"] = () => <div data-testid="my-header" />;
    const MySheet: CommsComponents["AppearanceSheet"] = () => <div data-testid="my-sheet" />;
    const r = await renderChat(
      <>
        <ChatScreen peerId="U2" />
        <AppearanceSheet onClose={() => {}} />
      </>,
      { appearance: { components: { ChatHeader: MyHeader, AppearanceSheet: MySheet } } },
    );
    r.socket.receive({ type: "res_users", users: [user("U2", "Bob")] });
    expect(await screen.findByTestId("my-header")).toBeTruthy();
    expect(screen.getByTestId("my-sheet")).toBeTruthy();
    expect(r.container.querySelector(".ck-chat-header")).toBeNull();
  });
});
