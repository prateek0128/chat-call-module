# Design folder overview (`comms-kit/design`)

`design/` holds the kit's look: one data file (`tokens.json`) and one written spec (`DESIGN_SYSTEM.md`).
This document explains what is in them, who uses them, what breaks if they drift, and how to change a colour, add a theme or rebrand.

Related: [Web 01 Overview](../web/01-overview.md) | [Web 03 Using, running, deploying](../web/03-using-running-and-deploying.md) | [Web example](../example/web-example.md)

Everything here was verified by reading `design/tokens.json`, `design/DESIGN_SYSTEM.md` and the consumers listed in section 5. I did not run the Python browser tests (they need Chrome). **(unverified)** marks the rest.

## Table of contents
1. [What it is](#1-what-it-is)
2. [Why it exists](#2-why-it-exists)
3. [tokens.json in detail](#3-tokensjson-in-detail)
4. [DESIGN_SYSTEM.md summary](#4-design_systemmd-summary)
5. [Who consumes the tokens, and what enforces equality](#5-who-consumes-the-tokens-and-what-enforces-equality)
6. [What happens when they diverge](#6-what-happens-when-they-diverge)
7. [How to: change a colour, add a theme, rebrand](#7-how-to-change-a-colour-add-a-theme-rebrand)
8. [Guidance for designers](#8-guidance-for-designers)
9. [Inconsistencies noticed](#9-inconsistencies-noticed)

## 1. What it is

| File | Size | Role |
|---|---|---|
| `design/tokens.json` | 423 lines | The values: colours (light and dark), chat themes, wallpapers, avatar colours, radii, spacing, fonts, shadows, motion, layout numbers. Its `$comment` calls it the "single source of truth for the comms kit look". |
| `design/DESIGN_SYSTEM.md` | 172 lines | The rules: principles, layout by width, every component and state, call screens, motion, accessibility, appearance (themes and wallpapers). It uses token names rather than raw numbers. |

No product branding: the default accent is a neutral indigo.

**Important:** nothing reads `tokens.json` at runtime. Each platform keeps its own copy of the values, and tests compare the copies with the JSON (section 5). So the JSON is the reference you edit first, and the copies must follow.

## 2. Why it exists

- **One look on every surface.** Phone app (React Native), web package (`commskit-web`) and the plain HTML demo (`examples/backend/demo-server-python/demo.html`) all show the same colours, radii, spacing and themes.
- **Rebranding in one place.** A host changes the accent and bubble colours without touching component code (via a theme override, or by editing the tokens for a fork).
- **Tests that enforce it.** Because values are copied, tests deep-compare them so a typo or a one-sided change fails the build instead of shipping a mismatch (section 5).
- **A hand-over format for designers.** A designer can change numbers and colours in one JSON file and read the spec in one markdown file.

## 3. tokens.json in detail

Top-level keys: `$comment`, `color`, `avatarPalette`, `radius`, `space`, `font`, `shadow`, `motion`, `layout`, `themePresets`, `wallpapers`.
(The colour section is named `color`, singular.)

### 3.1 Sections and what they affect

| Section | Contents | What it affects |
|---|---|---|
| `color.light`, `color.dark` | 32 colour tokens each (same names in both): see 3.2 | Every surface, text, bubble, tick, status and call colour; web CSS variables `--ck-<kebab-name>` |
| `themePresets` | `order`, `labels`, and per-scheme (`light`, `dark`) overrides for 7 presets, each with 8 keys | The user-selectable chat theme: accent family and outgoing bubbles |
| `wallpapers` | per scheme: 8 `solids`, 5 `gradients` (pairs), `imageDimDefault`; shared `imageDimMax` (0.8), `imageMaxEdge` (1600) | Chat background choices and image import limits |
| `avatarPalette` | 8 colours | Fallback avatar background (picked from the user id) |
| `radius` | `sm` 6, `md` 10, `lg` 16, `xl` 22, `bubble` 18, `pill` 999 | Corner roundness of buttons, cards, sheets, bubbles, avatars |
| `space` | `xxs` 2, `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `xxl` 32 | Padding, gaps, margins |
| `font` | `family` (`Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`), `size` (caption 12, small 13, body 15, title 17, heading 22, display 28), `weight` (regular 400, medium 500, semibold 600, bold 700; strings), `lineHeight` 1.4 | All text. `family` is for web; native uses the system font unless the host sets `nativeFamily` |
| `shadow` | `sm`, `md`, `lg`, each with `css` (web string) and `rn` (native numbers) | Elevation of cards, menus, dialogs |
| `motion` | `duration` fast 120, base 200, slow 320 (ms); `easing` standard `[0.2,0,0,1]`, decelerate, accelerate (cubic-bezier points) | All animations |
| `layout` | `listWidthMin` 300, `listWidthMax` 400, `bubbleMaxWidthPct` 72, `breakpointTablet` 700, `breakpointDesktop` 1024, `composerMaxLines` 6, `tapTarget` 44 | One pane vs split, list width, bubble width, composer height, touch size |

### 3.2 The colour tokens (`color.light` / `color.dark`)

| Group | Tokens | Light value -> Dark value (selected) | What it affects |
|---|---|---|---|
| Accent | `accent`, `accentStrong`, `accentSoft`, `onAccent` | `#4F46E5` -> `#818CF8` (accent); `onAccent` `#FFFFFF` -> `#0B1020` | Primary buttons, focus ring, selected row (`accentSoft`), unread badge, links |
| Surfaces | `background`, `surface`, `surfaceAlt`, `surfaceSunken`, `border` | `#F3F4F6`, `#FFFFFF`, ... -> `#0B0F19`, `#111827`, ... | Page, panes, cards, inputs, hairlines |
| Text | `text`, `textMuted`, `textSubtle` | `#0F172A` -> `#E5E7EB`; `#64748B` -> `#94A3B8` | Body, secondary and tertiary text |
| Chat | `wallpaper`, `bubbleIn`, `bubbleInText`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut` | bubbleOut `#4F46E5` (both); bubbleIn `#FFFFFF` -> `#1F2937`; tickReadOut `#7DD3FC` | Chat background, bubbles, delivery ticks |
| Status | `online`, `success`, `danger`, `warning` | danger `#DC2626` -> `#F87171` | Presence dot, success / error / warning, destructive actions |
| Overlay | `overlay` | `rgba(15,23,42,0.55)` -> `rgba(0,0,0,0.6)` | Behind dialogs and sheets |
| Call | `callBackgroundStart`, `callBackgroundEnd`, `callText`, `callTextMuted`, `callControl`, `callControlActive`, `callAccept`, `callHangup` | gradient `#0F172A` -> `#1E1B4B` (light), `#020617` -> `#1E1B4B` (dark); accept `#16A34A`; hangup `#DC2626` | Call screens (mobile and the HTML demo; the web package has no call UI) |

### 3.3 The 7 theme presets (`themePresets`, order as listed)

Each preset overrides 8 keys (`accent`, `accentStrong`, `accentSoft`, `onAccent`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut`) on top of the light or dark base. `indigo` equals the base tokens.

| # | Preset (label) | `accent` light | `accent` dark |
|---|---|---|---|
| 1 | `indigo` (Indigo, default) | `#4F46E5` | `#818CF8` |
| 2 | `rose` (Rose) | `#E11D48` | `#FB7185` |
| 3 | `emerald` (Emerald) | `#047857` | `#34D399` |
| 4 | `ocean` (Ocean) | `#0369A1` | `#38BDF8` |
| 5 | `amber` (Amber) | `#B45309` | `#FBBF24` |
| 6 | `violet` (Violet) | `#7C3AED` | `#A78BFA` |
| 7 | `graphite` (Graphite) | `#334155` | `#CBD5E1` |

The outgoing bubble in dark mode is not always the accent (for example rose dark: accent `#FB7185`, `bubbleOut` `#BE123C`) so white bubble text keeps contrast.

### 3.4 Wallpapers (`wallpapers`)

| Key | Light | Dark |
|---|---|---|
| `solids` (8, indexed) | `#EEF0F5`, `#E8F1EC`, `#F3ECE4`, `#E6EEF6`, `#F1E8F0`, `#ECEAF6`, `#F5F0DC`, `#E5E7EB` | `#0B1120`, `#0F1F1A`, `#1C1712`, `#0C1824`, `#1C1020`, `#15132A`, `#1C1A0E`, `#111827` |
| `gradients` (5 pairs, indexed) | e.g. `#E0E7FF` -> `#FCE7F3` | e.g. `#1E1B4B` -> `#3B0A2A` |
| `imageDimDefault` | `0` | `0.35` |
| shared | `imageDimMax` 0.8, `imageMaxEdge` 1600 | |

Solids and gradients are indexed, so choosing "solid 3" keeps meaning when the user switches between light and dark.

### 3.5 Avatar palette

`#6366F1`, `#0EA5E9`, `#14B8A6`, `#F59E0B`, `#EF4444`, `#A855F7`, `#EC4899`, `#64748B`.

## 4. DESIGN_SYSTEM.md summary

| Section | Key rules |
|---|---|
| Principles | Content first (quiet chrome); one accent for the primary action per screen, destructive = `danger`; every screen defines loading, empty, error and reconnecting states; touch targets at least `layout.tapTarget` (44); calm motion (transform / opacity only, none under reduced motion). |
| Layout | Below 700 px: one pane (list, then chat with a back button). 700 to 1023: split, list 300 px. 1024 and up: split, list clamp(300, 30%, 400), content centred at max 1440. Use dynamic viewport height, safe-area insets, keep the composer above the keyboard, no horizontal scroll at 320 px and up. (`decideLayout` in `mobile/src/theme/layout.ts` implements this; `ChatApp` uses it.) |
| Components | Conversation list (72 px rows, avatar 48 with presence dot, preview priority: typing, "You:" + ticks, attachment label, call text; unread badge up to 99+; skeleton, empty and "No chats match" states). Chat header (back, avatar 40, subtitle online / typing / offline, call button only when `onCall` is given). Message list (wallpaper, newest at bottom, date separators, grouping within 5 minutes, bubble `radius.bubble` and max width `bubbleMaxWidthPct`%, ticks, image viewer, file cards, call entry chip, typing bubble, jump-to-latest with count). Composer (attach, auto-grow to `composerMaxLines`, Send; Enter sends and Shift+Enter newline on web; preview sheet with the 10 MB check; disabled-with-reason state). Connection banner ("Connecting...", "Offline. Retrying in Ns" + Retry). |
| Call screens | Full-screen vertical gradient `callBackgroundStart` to `callBackgroundEnd`; large avatar (128); states Outgoing, Incoming, Connecting, Active (MM:SS), Ended (auto-close 1.6 s), Failed (specific reasons such as "No answer", "Declined", "Microphone access is blocked"); pulse rings; Speaker control only where the platform can switch output. |
| Motion | Table of animations: pane slide 24 px + fade (`base`), new message fade + 8 px (`fast`), typing dots 1.2 s loop, incoming-call rings 2 s, button press scale 0.96, sheets fade + slide 16 px. With `prefers-reduced-motion` / OS reduce motion every animation becomes instant and loops stop. |
| Accessibility | Every icon button labelled; keyboard order list, header, messages, composer; arrow keys in the list, Escape closes viewers and sheets, focus trapped in modals and returned afterwards; `aria-live` polite announcements; text contrast at least 4.5:1 in both themes. |
| Appearance | Local preferences only (no backend change, nothing sent to the other person). Theme presets change only the accent family and outgoing bubbles and are checked for 4.5:1 contrast; mode (Auto / Light / Dark) is separate. Wallpapers: `default`, `solid`, `gradient`, `image` (cover, centred, dim overlay 0 to 0.8, black in dark and white in light; downscaled to 1600 px; if storage is full it is kept for the session). Scope: global, plus per-chat override ("This chat" / "All chats", "Reset this chat"). Appearance sheet: Mode, 7 theme swatches ("Rose theme"), wallpaper grid (Default, solids, gradients, Choose image), Dim slider, scope, live preview, no Save button. |

## 5. Who consumes the tokens, and what enforces equality

| Platform | File(s) | How it uses the tokens | Enforced by |
|---|---|---|---|
| React Native (mobile) | `mobile/src/theme/tokens.ts` | A hand-kept TypeScript copy ("Mirrors tokens.json value for value ... Change tokens.json first, then this file"). Exports `tokens` and groups (`colorTokens`, `radius`, `space`, `font`, `shadow`, `motion`, `layout`, `themePresets`, `wallpapers`, `avatarPalette`). | `mobile/__tests__/theme.test.ts` deep-equals `tokens` against `design/tokens.json` (minus `$comment`) |
| Mobile theme object | `mobile/src/theme/createTheme.ts` | `createTheme(overrides, scheme)` builds the theme from `tokens.ts`: base colours, then preset colours, then host `colors`, then host `schemes[scheme]` | `theme.test.ts` (light / dark colours equal JSON; override rules) |
| Mobile preset rules | `mobile/src/theme/tokens.ts` presets | White bubble text and `onAccent` contrast 4.5:1 | `mobile/__tests__/appearance.test.ts` (checks 4.5:1 on every outgoing bubble) |
| Web package | `web/src/appearance.tsx` (`themeCssVars`), `web/src/styles.css` | Imports `tokens` through the engine (`commskit/engine` re-exports `mobile/src/theme/tokens.ts` and `createTheme`), turns the theme into CSS variables `--ck-*` on `.ck-root` at runtime. `styles.css` only uses `var(--ck-*)`. | `web/test/appearance.test.tsx`: CSS variables equal `design/tokens.json` for light and dark (colours, radius, space, `--ck-tap`); all 7 presets in both schemes; `styles.css` contains none of five hard-coded brand hex values (`#4F46E5`, `#4338CA`, `#EEF2FF`, `#0F172A`, `#E5E7EB`) |
| Plain HTML demo | `examples/backend/demo-server-python/demo.css`, `examples/backend/demo-server-python/demo.js` | `demo.css` holds the values as CSS custom properties (`:root`, a dark block for `prefers-color-scheme` and a manual `[data-theme="dark"]` block, `[data-preset=...]` rules, `--wp-solid-N` / gradient variables). `demo.js` has the preset list, labels and counts (`PRESETS`, `WP_SOLIDS = 8`, `WP_GRADIENTS = 5`, `IMAGE_DIM_MAX`, `IMAGE_MAX_EDGE`). | `examples/backend/demo-server-python/ui_tests/test_tokens.py` (no browser needed): colours in light, dark-by-media-query and dark-manual blocks; both dark blocks identical; avatar / radius / space / font / shadow / motion scales; breakpoints in media queries; no leftover hard-coded brand colours; preset CSS equals tokens for all 7 presets; indigo equals base; preset list and wallpaper counts in `demo.js` match; wallpaper CSS equals tokens. Also `test_appearance.py` and `test_interactions.py` read tokens in real-Chrome tests. |
| Spec | `design/DESIGN_SYSTEM.md` | Text only; names tokens | Not tested |

Where the web package's own tests sit: `web/test/appearance.test.tsx` (token tests are in its "design tokens" block). I ran `npx vitest run` in `web/` on 2026-10-26: 88 tests passed, including those.

Run the enforcing tests:

```bash
# mobile (Jest)
cd mobile && npx jest __tests__/theme.test.ts __tests__/appearance.test.ts
# web (Vitest)
cd web && npx vitest run test/appearance.test.tsx
# demo CSS vs tokens (pytest, no browser needed for this file)
cd examples/backend/demo-server-python && ../../../backend/backend-python/.venv/Scripts/python -m pytest -q ui_tests/test_tokens.py
```

(The demo-server command uses the Windows venv path; on Linux / macOS use `../../../backend/backend-python/.venv/bin/python`. `pytest.ini` exists in `examples/backend/demo-server-python`. I did not run the mobile or pytest commands.)

## 6. What happens when they diverge

| You change | But forget | Result |
|---|---|---|
| `tokens.json` | `mobile/src/theme/tokens.ts` | `mobile/__tests__/theme.test.ts` fails. Web is derived from `tokens.ts`, so web also stays on the old value, and `web/test/appearance.test.tsx` fails too (it compares against the JSON). |
| `tokens.ts` | `tokens.json` | Same tests fail the other way round. |
| `tokens.json` / `tokens.ts` | `examples/backend/demo-server-python/demo.css` | `test_tokens.py` fails. The HTML demo shows the old look. |
| `demo.css` only | the others | `test_tokens.py` fails. |
| A hard-coded hex in `web/src/styles.css` | | The "no hard-coded brand colours" test fails for the five listed values; **other** hard-coded colours would not be caught (the file has a few literals: `#fff`, `#000`, `rgba(0,0,0,.45)` for overlays on media). |
| Not tested at all | | `DESIGN_SYSTEM.md` text versus the code; the web `styles.css` layout rules; contrast of host overrides. |

Tests only guard the copies; they do not make the JSON drive the apps. Without running the tests, platforms can silently drift.

## 7. How to: change a colour, add a theme, rebrand

Working directory is the kit root. Windows paths shown with `/` work in Git Bash; in PowerShell use `\`.

### 7.1 Change one colour in the kit itself (for example the light `danger`)

1. Edit `design/tokens.json`: `color.light.danger` (and `color.dark.danger` if needed).
2. Edit the same key in `mobile/src/theme/tokens.ts` (`colorTokens.light.danger`).
3. Edit `examples/backend/demo-server-python/demo.css`: `--danger` in `:root`. For a **dark** value edit **both** dark blocks (`:root:not([data-theme="light"])` inside `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`).
4. Web needs no edit (it reads `tokens.ts` through the engine). Rebuild: `cd web && npm run build`.
5. Run the tests from section 5. Also check contrast (4.5:1 for text on its surface, per the spec).

If you want to change a colour only for **your** product without forking the kit, use a theme override instead (7.4).

### 7.2 Add a theme preset (for example `teal`)

1. `design/tokens.json`, `themePresets`: append `"teal"` to `order`; add `labels.teal`; add `light.teal` and `dark.teal` objects with the 8 keys (`accent`, `accentStrong`, `accentSoft`, `onAccent`, `bubbleOut`, `bubbleOutText`, `tickOut`, `tickReadOut`).
2. `mobile/src/theme/tokens.ts`: same additions (`themePresets` and the `PresetName` list / order).
3. `examples/backend/demo-server-python/demo.css`: add `[data-preset="teal"]` rules for light, and the dark variants in the same way the existing presets are written (copy the `rose` blocks and change the values).
4. `examples/backend/demo-server-python/demo.js`: add `"teal"` to `PRESETS` and its label to `PRESET_LABELS` (`test_preset_lists_match_page` checks it).
5. Check that white `bubbleOutText` on `bubbleOut` and `onAccent` on `accent` reach 4.5:1 (`mobile/__tests__/appearance.test.ts` checks the mobile side).
6. Web: no code change if the AppearanceSheet builds swatches from `themePresets` (`AppearanceSheet` maps over `themePresets.order` in `web/src/sheets.tsx`); rebuild. Some tests assert a count of 7 (`web/test/appearance.test.tsx`: "7 named theme swatches", and the e2e step 10), `test_tokens.py`, and `DESIGN_SYSTEM.md` says "7": update those numbers.
7. Update `DESIGN_SYSTEM.md` (list of presets) and the READMEs that mention seven themes.

### 7.3 Rebrand (new accent, font, shape) for the whole kit

1. Pick the accent family and the matching outgoing bubble: edit `color.light` and `color.dark` (`accent*`, `onAccent`, `bubbleOut*`, `tick*`) **and** the `indigo` preset in `themePresets` (it must equal the base: `test_indigo_preset_equals_base_tokens`).
2. Optionally `font.family`, `radius.*`, `shadow.*`, `avatarPalette`, `wallpapers`.
3. Mirror every change into `mobile/src/theme/tokens.ts` and `examples/backend/demo-server-python/demo.css` (steps in 7.1).
4. Run all tests in section 5, then `cd web && npm run verify` and, if you use it, `cd examples/web-app && npm run e2e` (step 10 asserts the Rose dark accent `#fb7185`, so changing the `rose` preset will fail it on purpose and needs the test updated).
5. Replace logos / icons yourself (the kit has none; `useWebNotifications({ icon })` takes a URL).

### 7.4 Rebrand in your host app without editing the kit (recommended)

Web:

```tsx
<AppearanceProvider theme={{
  schemes: {
    light: { accent: "#0F766E", accentStrong: "#115E59", accentSoft: "#CCFBF1", bubbleOut: "#0F766E" },
    dark:  { accent: "#2DD4BF", accentStrong: "#14B8A6", accentSoft: "#042F2E", bubbleOut: "#0F766E" },
  },
  radius: { bubble: 14 },
}}>
```

Order of application (`createTheme`): base colours, then the user's preset, then your `colors`, then your `schemes[scheme]`. So the **user's chosen preset is overridden by your colour overrides for the keys you set**; to keep the preset selectable, override only keys outside the preset family, or hide the theme picker. Mobile has the same `theme` override. The HTML demo has no host override; edit `demo.css`.

## 8. Guidance for designers

Hand over:
- **Colours** as hex for light and dark (all 32 names in 3.2, or at least accent family, surfaces, text, bubbles). Say which are brand colours.
- **Theme presets:** for each, accent, strong accent, soft tint, text-on-accent, outgoing bubble and its text, tick colours, in light and dark.
- **Wallpapers:** 8 solids and 5 gradients per scheme (indexed so each solid pairs with a dark twin).
- **Type:** font family (and a web-safe fallback stack), the six sizes and four weights.
- **Shape and space:** radii, spacing scale, bubble radius, shadows (CSS strings; native numbers are derived by an engineer).
- **Motion:** three durations and the easing curve; keep to transform and opacity.
- **Layout numbers:** breakpoints (700 and 1024), list width range, bubble max width, tap target.

Checks before handing over:
- Text contrast at least 4.5:1 on its background in light and dark; white text on every outgoing bubble; `onAccent` on every accent.
- Touch targets 44 px.
- Do not rely on colour alone for state (ticks have glyph and label; blocked and error states have text).
- Provide dark values for everything you provide in light.
- Tell engineers whether the change is for the kit defaults (edit tokens.json and its copies) or for one product (host theme override).

Do not hand over: product logos inside the kit (it ships none), call screens for the web (not built), or per-component pixel values that are not in the token scale (they will not be covered by the tests).

## 9. Inconsistencies noticed

(Reported, not fixed.)
- `design/tokens.json` `$comment` names only the browser demo and React Native as consumers; the web package is a third consumer (through the engine copy).
- `DESIGN_SYSTEM.md` intro says it covers the browser demo and the React Native UI; it does not mention `commskit-web`.
- `DESIGN_SYSTEM.md` says the list search "filters by name"; the web list (and the e2e test) also searches last-message text.
- `DESIGN_SYSTEM.md` says the bubble max width is `bubbleMaxWidthPct`% (72) and 85% on phones, while the web CSS variable is `--ck-bubble-max` = `bubbleMaxWidthPct`% only; the web package applies only `--ck-bubble-max` (72%) at every width (checked in `web/src/appearance.tsx` and `styles.css`), so the 85% phone rule is not implemented on web.
- `web/src/styles.css` header says "No colour or size literals for design tokens", yet it has a few literal colours (`#fff`, `#000`, `rgba(0,0,0,0.45)`) for overlays; the test only guards five brand hex values.
- Three hand-kept copies of the same values (`tokens.json`, `mobile/src/theme/tokens.ts`, `demo.css`) rely on tests rather than a generator.
