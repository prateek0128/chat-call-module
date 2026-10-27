import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationListScreen } from "../src";
import { dto, renderChat, user } from "./harness";

const lastMsg = (content: string, over: Record<string, unknown> = {}) => ({ ...dto(1, { content }), ...over });

const people = () => [
  user("U2", "Bob", { chat_id: 2, unread_count: 2, last_message: lastMsg("see you at lunch", { chat_id: 2 }) }),
  user("U3", "Carol", { chat_id: 3, unread_count: 0, last_message: lastMsg("thanks for the report", { chat_id: 3 }) }),
  user("U4", "Dave", { chat_id: 4, unread_count: 1, last_message: lastMsg("ok", { chat_id: 4 }) }),
];

const renderList = async (users = people(), onSelect: (id: string) => void = () => {}) => {
  const r = await renderChat(<ConversationListScreen onSelect={onSelect} />);
  r.socket.receive({ type: "res_users", users });
  return r;
};

describe("ConversationListScreen", () => {
  it("shows 6 skeleton rows until the list arrives, then an empty state when there are no chats", async () => {
    const { container, socket } = await renderChat(<ConversationListScreen onSelect={() => {}} />);
    expect(container.querySelectorAll(".ck-skeleton-row")).toHaveLength(6);
    socket.receive({ type: "res_users", users: [] });
    expect(await screen.findByText("No chats yet")).toBeTruthy();
    expect(container.querySelectorAll(".ck-skeleton-row")).toHaveLength(0);
  });

  it("All / Unread filter chips show counts and filter the rows", async () => {
    await renderList();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    const unread = screen.getByRole("button", { name: "Unread, 2 chats" });
    expect(unread.textContent).toBe("Unread 2");
    fireEvent.click(unread);
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-peer"))).toEqual(["U2", "U4"]);
    expect(unread.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("empty unread filter shows its own empty state", async () => {
    await renderList([user("U3", "Carol", { last_message: lastMsg("hello") })]);
    fireEvent.click(screen.getByRole("button", { name: "Unread, 0 chats" }));
    expect(screen.getByText("No unread chats")).toBeTruthy();
  });

  it("search matches names AND last-message text (accent / case insensitive)", async () => {
    await renderList();
    const box = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(box, { target: { value: "REPORT" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-peer"))).toEqual(["U3"]);
    fireEvent.change(box, { target: { value: "bo" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-peer"))).toEqual(["U2"]);
    fireEvent.change(box, { target: { value: "nothing like this" } });
    expect(screen.getByText("No chats match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("blocked rows replace the preview, hide presence and still open", async () => {
    const onSelect = vi.fn();
    await renderList(
      [
        user("U2", "Bob", { is_blocked: true, status: "online", last_message: lastMsg("secret") }),
        user("U3", "Carol", { blocked_by_other: true, status: "online", last_message: lastMsg("secret 2") }),
      ],
      onSelect,
    );
    const bob = screen.getByRole("option", { name: /^Bob/ });
    expect(within(bob).getByText("You blocked this contact")).toBeTruthy();
    expect(within(bob).queryByText("secret")).toBeNull();
    expect(bob.querySelector(".ck-presence-dot")).toBeNull();
    expect(within(screen.getByRole("option", { name: /^Carol/ })).getByText("Blocked by Carol")).toBeTruthy();
    fireEvent.click(bob);
    expect(onSelect).toHaveBeenCalledWith("U2", expect.objectContaining({ user_id: "U2" }));
  });

  it("unread badge caps at 99+ and the row label mentions the count", async () => {
    await renderList([user("U2", "Bob", { unread_count: 150, last_message: lastMsg("x") }), user("U3", "Carol", { unread_count: 7, last_message: lastMsg("y") })]);
    expect(screen.getByRole("option", { name: /^Bob/ }).querySelector(".ck-badge")?.textContent).toBe("99+");
    expect(screen.getByRole("option", { name: /^Carol/ }).querySelector(".ck-badge")?.textContent).toBe("7");
  });

  it("previews: own message gets 'You:' + ticks, typing wins, deleted is italic", async () => {
    const { socket } = await renderList([
      user("U2", "Bob", { chat_id: 2, last_message: lastMsg("mine", { sender_id: "U1", sender_type: "user", is_read: true, chat_id: 2 }) }),
      user("U3", "Carol", { chat_id: 3, last_message: lastMsg("x", { message_type: "deleted", content: null, chat_id: 3 }) }),
    ]);
    const bob = screen.getByRole("option", { name: /^Bob/ });
    expect(bob.textContent).toContain("You: ");
    expect(bob.querySelector(".ck-row-tick")?.getAttribute("data-state")).toBe("read");
    expect(screen.getByRole("option", { name: /^Carol/ }).querySelector(".is-italic")?.textContent).toBe("This message was deleted");
    socket.receive({ type: "typing_status", user_id: "U2", chat_id: 2, is_typing: true });
    await waitFor(() => expect(bob.textContent).toContain("typing…"));
  });

  it("is keyboard navigable: arrows move between rows, Enter selects, search arrow-down jumps to the list", async () => {
    const onSelect = vi.fn();
    await renderList(people(), onSelect);
    const rows = () => screen.getAllByRole("option");
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]); // roving tabindex: one tab stop
    rows()[0].focus();
    fireEvent.keyDown(rows()[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    fireEvent.keyDown(rows()[1], { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[2]));
    fireEvent.keyDown(rows()[2], { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("U4", expect.anything());
    const box = screen.getByRole("searchbox", { name: "Search chats" });
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]));
  });

  it("exposes roles and labels: listbox, options, labelled header buttons", async () => {
    await renderList();
    expect(screen.getByRole("listbox", { name: "Conversations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blocked users" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("the Appearance button opens the global sheet; Escape closes it", async () => {
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const dlg = screen.getByRole("dialog", { name: "Appearance" });
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
  });
});
