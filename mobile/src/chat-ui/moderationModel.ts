/** Moderation UI copy and menu model. Pure. */
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, type ReportCategory } from "../moderation/ModerationStore";

export interface ModerationMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface ModerationMenuInput {
  isBlocked: boolean;
  onReport?: () => void;
  onBlock?: () => void;
  onUnblock?: () => void;
}

/** Header overflow items: "Report", then "Block" or "Unblock". */
export const moderationMenuItems = (m: ModerationMenuInput): ModerationMenuItem[] => {
  const items: ModerationMenuItem[] = [];
  if (m.onReport) items.push({ label: "Report", onPress: m.onReport, destructive: true });
  if (m.isBlocked && m.onUnblock) items.push({ label: "Unblock", onPress: m.onUnblock });
  else if (!m.isBlocked && m.onBlock) items.push({ label: "Block", onPress: m.onBlock, destructive: true });
  return items;
};

export type BlockedComposerKind = "blocked" | "blocked_by_other";

/** Text of the composer's blocked state. */
export const blockedComposerText = (kind: BlockedComposerKind, name?: string | null): string =>
  kind === "blocked" ? `You blocked ${name || "this contact"}.` : "You can't reply to this conversation";

export interface ReportCategoryOption {
  id: ReportCategory;
  label: string;
}

export const reportCategoryOptions = (categories: readonly ReportCategory[] = REPORT_CATEGORIES): ReportCategoryOption[] =>
  categories.map((id) => ({ id, label: REPORT_CATEGORY_LABELS[id] || id }));

/** Report can be submitted once a category is picked ("other" needs a reason). */
export const canSubmitReport = (category: ReportCategory | null, reason: string): boolean =>
  !!category && (category !== "other" || reason.trim().length > 0);
