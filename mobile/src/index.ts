/**
 * commskit — re-exports core only. Import features from their own entry points
 * so Metro bundles only what you use:
 *   import { ChatProvider } from "commskit/chat";
 *   import { CallProvider } from "commskit/call";
 */
export * from "./core";
