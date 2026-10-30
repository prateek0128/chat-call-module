/**
 * Component slots: every UI component can be replaced by the host via `<AppearanceProvider components={{ ... }}>`.
 * A replacement receives the same props as the built-in (so it keeps the chat behaviour) and may render the
 * exported `Default<Name>` itself. Each exported component below is wrapped with `slot()`.
 */
import React, { ComponentProps, ComponentType, createContext, ReactNode, useContext } from "react";
import type { ChatApp } from "./ChatApp";
import type { ChatHeader, ChatScreen } from "./ChatScreen";
import type { Composer } from "./Composer";
import type { ConversationListScreen, ConversationRow } from "./ConversationListScreen";
import type { ChatWallpaper } from "./appearance";
import type { Linkified, MessageBubble, MessageList } from "./messages";
import type { InAppMessageBanners } from "./notifications";
import type { AppearanceSheet, AttachmentPreviewSheet, BlockedUsersScreen, DocumentViewer, ImageLightbox, ReportSheet } from "./sheets";
import type { Avatar, ConfirmDialog, ConnectionBanner, Dialog, Icon, LiveRegion, PopupMenu, ToastStack } from "./ui";

export interface CommsComponents {
  AppearanceSheet: ComponentType<ComponentProps<typeof AppearanceSheet>>;
  AttachmentPreviewSheet: ComponentType<ComponentProps<typeof AttachmentPreviewSheet>>;
  Avatar: ComponentType<ComponentProps<typeof Avatar>>;
  BlockedUsersScreen: ComponentType<ComponentProps<typeof BlockedUsersScreen>>;
  ChatApp: ComponentType<ComponentProps<typeof ChatApp>>;
  ChatHeader: ComponentType<ComponentProps<typeof ChatHeader>>;
  ChatScreen: ComponentType<ComponentProps<typeof ChatScreen>>;
  ChatWallpaper: ComponentType<ComponentProps<typeof ChatWallpaper>>;
  Composer: ComponentType<ComponentProps<typeof Composer>>;
  ConfirmDialog: ComponentType<ComponentProps<typeof ConfirmDialog>>;
  ConnectionBanner: ComponentType<ComponentProps<typeof ConnectionBanner>>;
  ConversationListScreen: ComponentType<ComponentProps<typeof ConversationListScreen>>;
  ConversationRow: ComponentType<ComponentProps<typeof ConversationRow>>;
  Dialog: ComponentType<ComponentProps<typeof Dialog>>;
  DocumentViewer: ComponentType<ComponentProps<typeof DocumentViewer>>;
  Icon: ComponentType<ComponentProps<typeof Icon>>;
  ImageLightbox: ComponentType<ComponentProps<typeof ImageLightbox>>;
  InAppMessageBanners: ComponentType<ComponentProps<typeof InAppMessageBanners>>;
  Linkified: ComponentType<ComponentProps<typeof Linkified>>;
  LiveRegion: ComponentType<ComponentProps<typeof LiveRegion>>;
  MessageBubble: ComponentType<ComponentProps<typeof MessageBubble>>;
  MessageList: ComponentType<ComponentProps<typeof MessageList>>;
  PopupMenu: ComponentType<ComponentProps<typeof PopupMenu>>;
  ReportSheet: ComponentType<ComponentProps<typeof ReportSheet>>;
  ToastStack: ComponentType<ComponentProps<typeof ToastStack>>;
}

const EMPTY: Partial<CommsComponents> = {};
const ComponentsContext = createContext<Partial<CommsComponents>>(EMPTY);

export const ComponentsProvider: React.FC<{ components?: Partial<CommsComponents>; children?: ReactNode }> = ({ components, children }) => (
  <ComponentsContext.Provider value={components || EMPTY}>{children}</ComponentsContext.Provider>
);

/** Wraps a built-in component so a host replacement (`components[name]`) is rendered instead, when given. */
export const slot = <P extends object>(name: string, Default: ComponentType<P>): ComponentType<P> => {
  const Slotted = (props: P) => {
    const Replacement = (useContext(ComponentsContext) as Record<string, ComponentType<P> | undefined>)[name] || Default;
    return React.createElement(Replacement as ComponentType<any>, props);
  };
  Slotted.displayName = name;
  return Slotted;
};
