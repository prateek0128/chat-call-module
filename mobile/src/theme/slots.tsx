/**
 * Component slots: hosts replace a built-in component via `<ThemeProvider components={{ ... }}>` (or
 * `<AppearanceProvider components>`). A replacement receives the same props as the default and may render
 * the exported default itself. chat-ui and call-ui read their slots with `useSlot`.
 */
import React, { ComponentType, createContext, memo, ReactNode, useContext } from "react";
import type { AvatarProps } from "./Avatar";

/** Slot name -> replacement. `Avatar` is typed here; `ChatUiSlots` (chat-ui) types the chat components. */
export type ComponentSlots = { Avatar?: ComponentType<AvatarProps> } & { [slot: string]: ComponentType<any> | undefined };

const EMPTY: ComponentSlots = {};
const SlotsContext = createContext<ComponentSlots>(EMPTY);

export const SlotsProvider: React.FC<{ components?: ComponentSlots; children?: ReactNode }> = ({ components, children }) => (
  <SlotsContext.Provider value={components || EMPTY}>{children}</SlotsContext.Provider>
);

/** Wraps a built-in component so a host replacement (`components[name]`) is rendered instead, when given. */
export const slot = <P extends object>(name: string, Default: ComponentType<P>): ComponentType<P> => {
  const Slotted = (props: P) => {
    const Replacement = useContext(SlotsContext)[name] || Default;
    return React.createElement(Replacement as ComponentType<any>, props);
  };
  Slotted.displayName = name;
  return memo(Slotted) as unknown as ComponentType<P>;
};
