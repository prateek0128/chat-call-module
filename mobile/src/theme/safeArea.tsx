/**
 * Safe-area insets without a hard dependency: `react-native-safe-area-context` is an OPTIONAL
 * peer, lazily required once. Without it (or without its <SafeAreaProvider>) insets are zero,
 * unless the host passes `insets` explicitly to a screen.
 */
import { useContext, createContext } from "react";

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const FallbackContext = createContext<EdgeInsets | null>(null);

let insetsContext: typeof FallbackContext | null = null;
const resolveContext = (): typeof FallbackContext => {
  if (insetsContext) return insetsContext;
  try {
    // Optional peer; enable metro `transformer.allowOptionalDependencies` if it is not installed.
    const mod = require("react-native-safe-area-context");
    insetsContext = (mod && mod.SafeAreaInsetsContext) || FallbackContext;
  } catch {
    insetsContext = FallbackContext;
  }
  return insetsContext as typeof FallbackContext;
};

/** `override` (host-provided) > SafeAreaProvider insets > zero. */
export const useSafeInsets = (override?: Partial<EdgeInsets> | null): EdgeInsets => {
  // The context object is fixed for the app's lifetime, so this is a stable hook call.
  const fromProvider = useContext(resolveContext());
  const base = fromProvider || ZERO_INSETS;
  return override ? { ...base, ...override } : base;
};
