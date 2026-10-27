import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../src";
import { dto, renderChat, resMessages, user } from "./harness";

const withWidth = (w: number) =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = this.classList?.contains("ck-app") ? w : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });

const setup = async () => {
  const r = await renderChat(<ChatApp />);
  r.socket.receive({ type: "res_users", users: [user("U2", "Bob", { chat_id: 2 })] });
  r.socket.receive(resMessages([dto(1, { content: "hello from bob" })]));
  return r;
};

afterEach(() => vi.restoreAllMocks());

describe("ChatApp responsive layout", () => {
  it("phone width: one pane at a time, back returns to the list (Escape too)", async () => {
    withWidth(390);
    await setup();
    expect(document.querySelector(".ck-app")?.getAttribute("data-layout")).toBe("single");
    expect(screen.queryByRole("log")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /^Bob/ }));
    expect(await screen.findByRole("log", { name: "Messages with Bob" })).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(await screen.findByRole("listbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^Bob/ }));
    await screen.findByRole("log");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("log")).toBeNull());
  });

  it("tablet / desktop width: list and chat side by side, no back button, placeholder until a chat is picked", async () => {
    withWidth(1000);
    await setup();
    expect(document.querySelector(".ck-app")?.getAttribute("data-layout")).toBe("split");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByText("Select a chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^Bob/ }));
    expect(await screen.findByRole("log")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to chats" })).toBeNull();
    expect(screen.getByRole("option", { name: /^Bob/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("split list width follows the design tokens (300 px at tablet widths)", async () => {
    withWidth(768);
    await setup();
    expect((document.querySelector(".ck-pane-list") as HTMLElement).style.width).toBe("300px");
  });
});
