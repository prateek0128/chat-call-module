/** Responsive layout decision (DESIGN_SYSTEM.md "Layout"). Pure. */
import { layout as layoutTokens } from "./tokens";

export type LayoutTokens = typeof layoutTokens;

export interface LayoutDecision {
  /** `single`: list and chat are separate screens (back button). `split`: side by side. */
  mode: "single" | "split";
  /** List pane width in split mode; equal to `width` in single mode. */
  listWidth: number;
  /** Width available to the chat pane. */
  chatWidth: number;
  /** Max content width (centred) on very wide screens. */
  contentWidth: number;
  /** Max bubble width in px for the chat pane. */
  bubbleMaxWidth: number;
}

export const MAX_CONTENT_WIDTH = 1440;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * < breakpointTablet: single pane.
 * breakpointTablet..breakpointDesktop-1: split, list = listWidthMin.
 * >= breakpointDesktop: split, list = clamp(listWidthMin, 30%, listWidthMax), centred max 1440.
 */
export const decideLayout = (width: number, tokens: LayoutTokens = layoutTokens): LayoutDecision => {
  const w = Math.max(0, Math.floor(width));
  if (w < tokens.breakpointTablet) {
    // Phones: bubbles may use 85% (DESIGN_SYSTEM "85% on phones").
    return { mode: "single", listWidth: w, chatWidth: w, contentWidth: w, bubbleMaxWidth: Math.round(w * 0.85) };
  }
  const contentWidth = Math.min(w, MAX_CONTENT_WIDTH);
  const listWidth =
    w < tokens.breakpointDesktop ? tokens.listWidthMin : Math.round(clamp(contentWidth * 0.3, tokens.listWidthMin, tokens.listWidthMax));
  const chatWidth = contentWidth - listWidth;
  return { mode: "split", listWidth, chatWidth, contentWidth, bubbleMaxWidth: Math.round((chatWidth * tokens.bubbleMaxWidthPct) / 100) };
};
