/** Render smoke tests (rn-mock) for the moderation UI: ReportSheet, BlockedUsersScreen, Composer blocked state, menu model. */
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";
import { CommsProvider } from "../src/core/CommsProvider";
import { ModerationProvider, ModerationStore } from "../src/moderation";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { BlockedUsersScreen, Composer, moderationMenuItems, ReportSheet, canSubmitReport, blockedComposerText } from "../src/chat-ui";
import { failureCopy } from "../src/call-ui";
import { flush } from "./helpers";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const realError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  console.error = realError;
});

const config = { baseUrl: "https://api.example.com", getToken: () => "jwt", getUserId: () => "me" };
const mounted: ReactTestRenderer[] = [];
afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

const render = (el: ReactElement, store?: ModerationStore): ReactTestRenderer => {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <ThemeProvider colorScheme="light">
        <CommsProvider config={config} autoConnect={false}>
          <ModerationProvider store={store}>{el}</ModerationProvider>
        </CommsProvider>
      </ThemeProvider>,
    );
  });
  mounted.push(r);
  return r;
};
const textOf = (r: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n == null) return;
    if (typeof n === "string") return void out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    (n.children || []).forEach(walk);
  };
  walk(r.toJSON());
  return out.join(" ");
};
const byLabel = (r: ReactTestRenderer, label: string) => r.root.find((n) => typeof n.type === "string" && n.props.accessibilityLabel === label);

let fetchCalls: any[] = [];
beforeEach(() => {
  fetchCalls = [];
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    fetchCalls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const body = url.endsWith("/moderation/reports")
      ? { report_id: 5 }
      : init.method === "GET"
        ? [{ user_id: "2", username: "Ravi" }, { user_id: "3", username: "Meera" }]
        : { status: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  });
});

describe("moderation UI", () => {
  it("ReportSheet: categories, Also block on by default, submit -> confirmation", async () => {
    const onSubmitted = jest.fn();
    const r = render(<ReportSheet visible peerId="9" name="Nia" onClose={() => {}} onSubmitted={onSubmitted} />);
    const text = textOf(r);
    for (const label of ["Spam", "Harassment or bullying", "Fake profile", "Underage user", "Something else"]) expect(text).toContain(label);
    expect(byLabel(r, "Also block Nia").props.accessibilityState).toEqual({ checked: true });
    expect(byLabel(r, "Send report").props.disabled).toBe(true); // no category yet
    act(() => byLabel(r, "Spam").props.onPress());
    act(() => byLabel(r, "Details").props.onChangeText("sends links"));
    await act(async () => {
      await byLabel(r, "Send report").props.onPress();
    });
    expect(fetchCalls[0]).toEqual({
      url: "https://api.example.com/moderation/reports",
      method: "POST",
      body: { user_id: "9", reason: "sends links", category: "spam", block: true },
    });
    expect(textOf(r)).toContain("Thanks for letting us know");
    expect(onSubmitted).toHaveBeenCalledWith({ reportId: "5", blocked: true });
  });

  it("ReportSheet: turning the block toggle off sends block:false", async () => {
    const r = render(<ReportSheet visible peerId="9" onClose={() => {}} />);
    act(() => byLabel(r, "Also block this user").props.onPress());
    act(() => byLabel(r, "Scam or fraud").props.onPress());
    await act(async () => {
      await byLabel(r, "Send report").props.onPress();
    });
    expect(fetchCalls[0].body).toMatchObject({ category: "scam", block: false });
  });

  it("BlockedUsersScreen lists blocked users and unblocks", async () => {
    const r = render(<BlockedUsersScreen insets={{ bottom: 0 }} />);
    await act(async () => {
      await flush(10);
    });
    expect(textOf(r)).toContain("Ravi");
    expect(textOf(r)).toContain("Meera");
    await act(async () => {
      byLabel(r, "Unblock Ravi").props.onPress();
      await flush(10);
    });
    expect(fetchCalls[1]).toMatchObject({ url: "https://api.example.com/moderation/blocks/2", method: "DELETE" });
    expect(textOf(r)).not.toContain("Ravi");
  });

  it("Composer blocked states", () => {
    const onUnblock = jest.fn();
    const r = render(<Composer onSend={() => true} blockedState={{ kind: "blocked", name: "Nia", onUnblock }} />);
    expect(textOf(r)).toContain("You blocked Nia.");
    act(() => byLabel(r, "Unblock Nia").props.onPress());
    expect(onUnblock).toHaveBeenCalled();
    const r2 = render(<Composer onSend={() => true} blockedState={{ kind: "blocked_by_other", name: "Nia" }} />);
    expect(textOf(r2)).toContain("You can't reply to this conversation");
    expect(r2.root.findAll((n) => n.props.accessibilityLabel === "Message")).toHaveLength(0);
  });

  it("menu model, report validation, blocked call copy", () => {
    const f = () => {};
    expect(moderationMenuItems({ isBlocked: false, onReport: f, onBlock: f, onUnblock: f }).map((i) => i.label)).toEqual(["Report", "Block"]);
    expect(moderationMenuItems({ isBlocked: true, onReport: f, onBlock: f, onUnblock: f }).map((i) => i.label)).toEqual(["Report", "Unblock"]);
    expect(canSubmitReport(null, "")).toBe(false);
    expect(canSubmitReport("other", " ")).toBe(false);
    expect(canSubmitReport("other", "why")).toBe(true);
    expect(blockedComposerText("blocked")).toBe("You blocked this contact.");
    expect(failureCopy("blocked")).toMatchObject({ retryable: false });
  });
});
