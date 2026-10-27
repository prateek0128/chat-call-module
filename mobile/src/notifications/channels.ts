/** Android notification channels used by the backend's pushes (PROTOCOL §8). Pure. */

/** Chat messages and missed calls. */
export const MESSAGES_CHANNEL_ID = "messages";
/** Incoming calls (max importance, may bypass Do Not Disturb). */
export const CALL_CHANNEL_ID = "call_ringtone";

export interface ChannelNames {
  messages?: string;
  calls?: string;
}

/** Channel definitions for expo-notifications' `setNotificationChannelAsync` (importance values from the module). */
export const channelDefinitions = (Notifications: any, names: ChannelNames = {}) => {
  const Importance = Notifications?.AndroidImportance || {};
  const Visibility = Notifications?.AndroidNotificationVisibility || {};
  return [
    {
      id: MESSAGES_CHANNEL_ID,
      channel: { name: names.messages || "Messages", importance: Importance.DEFAULT ?? 3, sound: "default", showBadge: true },
    },
    {
      id: CALL_CHANNEL_ID,
      channel: {
        name: names.calls || "Incoming calls",
        importance: Importance.MAX ?? 5,
        sound: "default",
        vibrationPattern: [0, 1000, 1000, 1000],
        bypassDnd: true,
        lockscreenVisibility: Visibility.PUBLIC ?? 1,
        showBadge: false,
      },
    },
  ];
};
