# Comms kit design system

One design language for the browser demo (`examples/backend/demo-server-python/demo.html`) and the React Native UI
(`commskit/chat-ui`, `commskit/call-ui`). Values come from [tokens.json](tokens.json); hosts
override them through a theme. No product branding: the default accent is a neutral indigo.

## Principles
- **Content first.** Chrome is quiet (surfaces, hairline borders); colour is reserved for the accent, outgoing bubbles, presence and call actions.
- **One accent.** Accent marks the primary action on each screen (Send, Call, Accept). Destructive = `danger`.
- **Predictable states.** Every screen defines loading, empty, error and reconnecting states (below).
- **Touch-sized.** Interactive targets ≥ `layout.tapTarget` (44 px/pt).
- **Calm motion.** Transform/opacity only, `motion.duration.*`, and none when the user prefers reduced motion.

## Layout
| Width | Layout |
|---|---|
| < `breakpointTablet` (700) | One pane. List full screen → chat full screen with back button. Call screen full screen. |
| 700 – 1023 | Split: list `listWidthMin` (300) + chat. |
| ≥ `breakpointDesktop` (1024) | Split: list clamp(300, 30%, 400) + chat, centred max 1440. |

Use dynamic viewport height (`100dvh` / `useWindowDimensions`), safe-area insets on all edges,
and keep the composer above the virtual keyboard (`visualViewport` on web, `KeyboardAvoidingView` /
keyboard events on native). No horizontal scrolling at any width ≥ 320.

## Components

### Conversation list
- **Header:** own avatar, title "Chats", connection state, actions.
- **Search field:** filters by name.
- **Row**, 72 px tall:
  - Avatar (48) with a presence dot.
  - Name (`title`, semibold), ellipsised.
  - Time on the right (`caption`; accent when unread).
  - Preview line (`small`, `textMuted`). The preview shows, in order of priority:
    - "typing…" in the accent colour
    - "You: " prefix with ticks for your own messages
    - "📷 Photo" or "📎 file name" for attachments
    - call icon + text, red when missed or declined
  - Unread badge (accent pill, `onAccent` text, max "99+").
  - Selected row: `accentSoft` background.
- **States:**
  - Loading: 6 skeleton rows.
  - Empty: an illustration-free message.
  - Search with no hits: "No chats match".

### Chat header
- Back button (single-pane only).
- Avatar (40) and name.
- Subtitle: "online", "typing…" in accent, or "offline".
- Call button (only when the call feature is mounted and `onCall` is provided).

### Message list
- Wallpaper background.
- Newest at the bottom. Loads older pages when scrolled to the top, keeping the scroll position.
- **Date separator chip** before the first message of each day: "Today", "Yesterday", or the date.
- **Grouping:**
  - Consecutive messages from the same sender within 5 min form a group.
  - Only the first bubble in a group gets the tail and the larger top margin (`space.sm`); others get `space.xxs`.
- **Bubble:**
  - Shape: `radius.bubble`, max width `bubbleMaxWidthPct`% (85% on phones).
  - Incoming: `bubbleIn` / `bubbleInText`, left aligned.
  - Outgoing: `bubbleOut` / `bubbleOutText`, right aligned.
  - Time and ticks sit inline at the bottom right (`caption`).
  - Ticks: ✓ sent, ✓✓ delivered (`tickOut`), ✓✓ read (`tickReadOut`).
  - Images: rounded and clickable to a full-screen viewer. Files: a card with icon, name and size.
- **Call entry:** centred chip with a direction icon, title ("Voice call", "Missed voice call"), detail (duration or "Incoming"/"Outgoing"), time, and an optional "Call back" action.
- **Typing indicator:** an incoming-side bubble with 3 dots (staggered opacity/translate loop).
- **Jump-to-latest button:** appears when scrolled up more than one screen. Shows the count of new messages.
- **States:**
  - Loading: skeleton bubbles.
  - Empty: "Say hi 👋".
  - Error: inline banner with Retry.

### Composer
- Attach button, an auto-growing text field (1 → `composerMaxLines` lines), and a Send button (accent; disabled when empty).
- Enter sends; Shift+Enter adds a new line (web). Send is a button (native).
- **Attachment preview sheet:** thumbnail or file card, name, size, Cancel / Send. The 10 MB limit is checked before upload, with an error toast.
- Disabled state with a reason, e.g. "Chat is not enabled".

### Connection banner
A slim bar under the header:
- Reconnecting: "Connecting…", in `warning` tint.
- Offline after retries: "Offline. Retrying in Ns", with a Retry action.

### Call screens
These are full screen with a vertical gradient from `callBackgroundStart` to `callBackgroundEnd`. Each shows a large avatar (128), the name (`display`), a status line, and a control row.

| State | Status line | Controls |
|---|---|---|
| Outgoing | "Calling…", then "Ringing…" once `call_ringing` arrives | Mute, Speaker\*, Hang up |
| Incoming | "Incoming voice call" | Decline (`callHangup`), Accept (`callAccept`, gentle bounce) |
| Connecting | "Connecting…" | Mute, Speaker\*, Hang up |
| Active | running `MM:SS` timer | Mute (toggle), Speaker\* (toggle), Hang up |
| Ended | "Call ended · MM:SS", auto-closes after 1.6 s | none |
| Failed / rejected / busy / no answer | specific reason: "No answer", "Declined", "On another call", "Microphone access is blocked", "Couldn't connect" | Close; Call again (when it makes sense) |

\* Speaker appears only where the platform can switch the audio output: `setSinkId` on web, InCallManager on native.

- **Pulse:** the avatar has 2 expanding rings while ringing or calling.
- **Microphone blocked:** the failure screen explains how to enable the mic in browser or system settings.
- **Minimise:** on native, a "back" action minimises to a "Return to call" pill above the chat.

## Motion
| What | Animation |
|---|---|
| Pane change (single pane) | slide 24px + fade, `base` |
| New message | fade + translateY 8px → 0, `fast` |
| Typing dots | 3 × staggered opacity/translateY loop, 1.2 s |
| Incoming call | rings scale 1 → 1.7 + fade, 2 s loop; Accept bounce |
| Call state change | status line cross-fade, `base` |
| Buttons | scale 0.96 on press, `fast` |
| Sheets / modals | fade overlay + slide up 16px, `base` |

With `prefers-reduced-motion` or the OS reduce-motion setting, every animation above becomes an instant change. Loops stop.

## Accessibility
- **Labels:** every icon button has a label ("Call Bob", "Attach file", "Send message", "Mute microphone").
- **Web keyboard support:**
  - Tab order: list → header → messages → composer.
  - Arrow up/down move through the conversation list; Enter opens a conversation.
  - Escape closes viewers and sheets.
  - Focus is trapped in the call screen and modals, and returns to the trigger afterwards.
- **Screen readers:** an `aria-live` polite region announces new messages in the open chat and call status changes. On native, use `accessibilityLiveRegion` (Android) and `AccessibilityInfo.announceForAccessibility` (iOS).
- **Contrast:** text has at least 4.5:1 contrast on its surface in both themes.

## Appearance: chat themes and wallpapers

The user personalises the look on their own device. These are local preferences: no protocol or
backend change, and nothing is sent to the other person.

### Chat theme
- **Presets:** `tokens.json → themePresets`, in the order given by `order`: Indigo (default), Rose,
  Emerald, Ocean, Amber, Violet, Graphite.
- **What a preset changes:** only the accent family and outgoing bubbles (`accent`, `accentStrong`,
  `accentSoft`, `onAccent`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut`), on top of the
  light or dark base. The light/dark/auto mode is a separate setting and combines with any preset.
- **Contrast:** every preset is checked so that white bubble text and `onAccent` button text reach
  4.5:1.
- **Scope:** app-wide.

### Chat wallpaper
| Kind | Rendering |
|---|---|
| `default` | `color.<scheme>.wallpaper` + the subtle dot pattern |
| `solid` (index i) | `wallpapers.<scheme>.solids[i]`; the index keeps the choice in step across light/dark |
| `gradient` (index i) | linear gradient, top-left to bottom-right, from `wallpapers.<scheme>.gradients[i]` |
| `image` | the user's picture, `cover`, centred, with a dim overlay |

- **Dim:** a 0 to `imageDimMax` (0.8) overlay, black in dark mode and white in light mode. The default
  is `imageDimDefault` (light 0, dark 0.35). It applies to images only.
- **Image import:** downscaled so the longest edge is at most `imageMaxEdge` (1600 px) before saving, then
  stored locally. If storage is full, the image is kept for the session and a toast explains it.
- **Scope:** a global default, plus an optional **per-chat** override ("This chat only" or "All chats").
  Resetting a chat removes its override.

### Appearance sheet
- **Opening it:**
  - "Appearance" in the list header opens it in global mode.
  - "Wallpaper" in the chat header's overflow menu opens it in per-chat mode, defaulting to "This chat".
- **Sections:**
  1. Mode: Auto / Light / Dark (segmented control).
  2. Theme: 7 round swatches with a check on the selected one. Each has an accessible name such as
     "Rose theme".
  3. Wallpaper: a grid of tiles. The order is Default, solids, gradients, then "Choose image…", plus the
     current custom image if there is one.
  4. When an image is chosen: a Dim slider.
  5. Scope (per-chat mode only): "This chat" / "All chats", plus "Reset this chat".
- **Live preview:** a mini chat at the top (one incoming and one outgoing bubble on the selected
  wallpaper) updates instantly.
- **Saving:** changes apply immediately; there is no Save button. Escape or Done closes the sheet.
- **Motion:** theme changes cross-fade colours over `motion.duration.base`, with none under reduced
  motion.
