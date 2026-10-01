---
name: "Elite Kitchens Lead OS"
description: "Premium, calm, light business software for customer conversations."
colors:
  bg: "#f7f7f4"
  panel: "#fdfdfc"
  nav: "#f3f3ef"
  ink: "#252724"
  muted: "#686b64"
  line: "#e6e7e1"
  hover: "#f0f1eb"
  selected: "#e9ece4"
  accent: "#465c45"
  in: "#fff"
  out: "#e9ede3"
  out-ink: "#252d25"
  unread: "#465c45"
  ok: "#267393"
  err: "#a52d28"
  primary-hover: "#42483d"
  ghost-hover: "#e5e7df"
  danger-hover: "#862520"
  nav-hover: "#e9ebe4"
  nav-active: "#e6e8e0"
  field-bg: "#fafbf7"
  field-border: "#e1e4db"
  field-hover-border: "#bdc5b6"
  search-bg: "#f1f2ed"
  composer-bg: "#f2f3ed"
typography:
  headline:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.025em"
  title:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  field: "4px"
  control: "6px"
  message: "8px"
  message-tail: "2px"
  avatar: "50%"
spacing:
  tight: "4px"
  compact: "8px"
  control-gap: "9px"
  field: "12px"
  panel: "18px"
  section: "20px"
  wide: "22px"
  dialog: "26px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.in}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-ghost:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  button-ghost-hover:
    backgroundColor: "{colors.ghost-hover}"
  button-danger:
    backgroundColor: "{colors.err}"
    textColor: "{colors.in}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  field:
    backgroundColor: "{colors.field-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "9px 10px"
    width: "100%"
  navigation-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    width: "100%"
  unread-count:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.accent}"
    rounded: "{rounded.field}"
    padding: "2px 7px"
  conversation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "15px 12px"
  message-incoming:
    backgroundColor: "{colors.in}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.message}"
    padding: "9px 12px 6px"
  message-outgoing:
    backgroundColor: "{colors.out}"
    textColor: "{colors.out-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.message}"
    padding: "9px 12px 6px"
  profile-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "10px 1px 12px"
  document:
    textColor: "{colors.ink}"
    padding: "8px 5px"
---

# Design System: Elite Kitchens Lead OS

## Overview

**Creative North Star: "Premium, calm, light business software"**

Off-white surfaces, charcoal typography and restrained navigation give customer conversations priority. Compact, controlled spacing supports daily work; subtle selections and a small set of meaningful colours make state visible without making the interface loud.

This documents the implemented plain HTML/CSS/JavaScript interface in `public/app.css` and `public/index.html`. The confirmed direction rejects gradients, nested cards, oversized controls and generic dashboard decoration. No new brand metaphor or business claim is implied.

**Key Characteristics:**

- Light neutral surfaces and charcoal text.
- Compact spacing and a clear name, message, metadata hierarchy.
- Restrained navigation and subtle selected states.
- Customer messages and media take visual priority.
- Minimal borders and shadows, reserved for structural separation.

## Colors

The palette is warm, quiet and predominantly neutral. The frontmatter preserves the implemented values and names; the sidecar's generated tonal ramps are preview aids, not additional application tokens.

### Primary

- **Charcoal (`ink`)** anchors reading, selected tab underlines and primary actions.
- **Muted green (`accent`, `unread`)** identifies unread activity, links, successful profile feedback and keyboard focus. It is deliberately sparse.

### Neutral

- **Off-white workspace (`bg`)**, **near-white panel (`panel`)** and **pale navigation (`nav`)** separate the principal working regions.
- **Secondary grey (`muted`)** supports snippets, captions and metadata; avoid using it for the main conversation content.
- **Quiet divider (`line`)** separates panes, headers and footers.
- **Hover wash (`hover`)** and **selected wash (`selected`)** identify interactive rows without adding an outline or shadow.
- **Incoming white (`in`)** and **outgoing pale green (`out`, `out-ink`)** distinguish message direction.
- Field and search surface tokens distinguish editable areas from their surrounding panel. Navigation has its own restrained hover and active washes.

### Semantic states

- **Read blue (`ok`)** marks read receipts; it is not a general success colour.
- **Error red (`err`)** marks failed messages, validation errors and destructive actions.
- Primary, ghost and danger hover tokens belong to their corresponding button variants.

**The Sparse Colour Rule.** Use colour to communicate interaction, message direction or status; do not tint whole working areas for decoration.

## Typography

**Body and interface font:** the system stack in the frontmatter, led by Segoe UI Variable Text and Segoe UI. There is no separate display face or web-font dependency.

The hierarchy relies on size, weight and spacing rather than decorative fonts. Retain sentence case and the compact reading rhythm.

### Hierarchy

- **Headline:** Inbox uses the `headline` token.
- **Title:** The conversation name uses `title`; customer summary text uses the same size at weight 600 with slightly tightened tracking.
- **Body:** Messages and the desktop composer use `body`.
- **Label:** Profile labels and secondary customer details use `label`.
- **Button:** Action labels use `button`; small variants use 13px.
- **List:** Customer names are 15px/550, unread names 700, previews 13px and times 11px. Names and snippets truncate in rows.
- **Metadata:** Times and counts use tabular numerals. Message metadata is 11px; date separators are 12px.
- **Phone:** List names and editable fields become 16px; conversation headers remain compact.

## Layout

The viewport-filling workspace uses independently scrolling conversation lists, message history and profile content. Keep headers, the composer and profile Save footer outside the scrolling content. Use dynamic viewport height and safe-area padding where already implemented.

Desktop has navigation, list, conversation and an optional profile pane:

| Viewport | Navigation | List | Conversation | Open profile |
| --- | --- | --- | --- | --- |
| 1440px and above | 196px | 328px | Remaining width | 304px in grid |
| 1280–1439px | 176px | 300px | Remaining width | 288px in grid |
| 900–1279px | 68px icon rail | 310px | Remaining width | 350px fixed overlay |
| 899px and below | Hidden | One screen | One screen | Full-width screen |

On phones, application state switches between inbox and conversation. Customer profile opens as a full screen with a leading Back control. Do not compress the four desktop panes into a phone canvas.

Spacing is intentionally compact and follows observed values rather than a newly imposed scale. Desktop list rows use 15px vertical and 12px horizontal padding; phone rows use 16px vertical padding. Message history uses 20px by 28px on wide screens and 16px by 12px on phones. Profile forms use 20px top/side padding, expanding the sides to 22px on phones.

Message bubbles cap at the lesser of 82% and 560px on desktop and at 88% on phones. The media gallery uses two columns on desktop and three on phones, where its profile screen has more width.

## Elevation & Depth

The workspace is flat at rest. Tonal surfaces, whitespace and a few structural dividers provide separation; ordinary rows, messages and profile sections have no shadow. The exceptions are the compact profile overlay and confirmation dialogs.

### Shadow Vocabulary

- **Profile overlay:** `-10px 0 32px #242a2214`, only below 1280px; removed when the profile fills the phone screen.
- **Dialog:** `0 16px 50px #20271c26`, paired with backdrop `#242a224f`.
- **Media viewer:** an opaque-looking dark scrim (`#20231ff5`) provides contrast for the customer's photo or video. It does not establish a dark application theme.

**The Structural Depth Rule.** Reserve elevation for an overlay that sits above another working surface.

## Shapes

The navigation brand mark displays the original E and K from the owner's supplied logo at 47 × 24px. CSS clips two regions of the unchanged transparent source image; preserve the original letterforms and use the compact mark in the narrow rail. Asset provenance is recorded in `docs/BRAND_ASSETS.md`.

Fields, counters and gallery tiles use restrained small corners; buttons and rows use the control radius. Messages and dialogs use the message radius. Incoming and outgoing bubbles reduce the appropriate bottom corner to the message-tail radius. Only avatars and unread dots are circular.

Do not put profile sections inside additional rounded cards. Fieldsets are borderless groups with concise legends. Borders identify pane edges, fields, tab selection and the deliberate destructive-action boundary.

## Components

### Buttons

Primary actions are charcoal with white text; secondary actions use a light tonal fill. Filled danger buttons belong to confirmation dialogs. The profile's Delete customer action uses red text on an unfilled background. Link buttons are underlined secondary text.

Standard controls have a minimum height of 40px; phone buttons and icon buttons have a minimum height of 44px. Small button variants retain the minimum height with tighter padding. Disabled buttons use opacity 0.5 and a default cursor. Icon-only controls require an accessible name.

Hover changes the background for filled and ghost controls. The common keyboard focus ring is 2px of accent with a 3px offset. Background transitions use 150ms ease-out only when reduced motion is not requested.

### Chips and counts

The Inbox count is a compact square-cornered tonal counter, not a large pill. Per-conversation unread counts use a small circular green badge with white text; an unread dot may be used when a number is unnecessary. Retain numeric and text cues alongside colour.

Conversation-status filters sit in one compact row beneath the inbox caption: Inbox, Booked, Quoted, Won and Closed. Use the existing selected wash and charcoal text, a 5px corner radius, 36px minimum desktop height and 44px phone height. Each button exposes its pressed state and unread count accessibly. The header status selector uses the same restrained field styling; on phones it occupies a second header row so customer navigation retains space.

### Containers and conversation rows

Panes are the principal containers. Selected conversation rows use the selected wash; their avatars receive a slightly stronger tint. Unread rows increase name weight and darken the preview. Keep names, snippets and timestamps at distinct levels of emphasis. Rows remain keyboard operable with a visible focus ring.

### Inputs and fields

Profile fields have a pale fill, a thin border and the field radius. Labels sit above controls. Hover strengthens the border; invalid fields use the error colour. The profile Save footer remains reachable beneath scrolling sections.

Search is a borderless, filled field with a drawn search icon. The composer uses a borderless tonal textarea, 15px desktop text and 16px phone text, with a 160px maximum height.

### Navigation

The rail uses a pale background, subdued labels and a quiet active fill. Inbox is the working destination. Future tools are text in the Coming later disclosure, not active navigation.

Customer sections remain **Details**, **Media** and **Documents**. A charcoal underline and stronger text identify the selected tab. Preserve tab semantics and focus behaviour when reusing this pattern.

### Messages and customer assets

Incoming and outgoing messages use tonal separation, compact padding and a quiet metadata line. Read receipts use read blue; failed messages receive a thin error outline and explanatory text.

Document rows use a drawn document icon, a readable filename, secondary file information and underlined actions. Media grids group assets by month. Unavailable assets use explanatory rows rather than blank image tiles. Customer media supplies the imagery; do not introduce decorative stock images.

## Do's and Don'ts

### Do:

- Do keep the workspace light, calm and compact.
- Do give conversations, customer media and readable text priority over chrome.
- Do use subtle fills for selection and sparse colour for meaningful state.
- Do keep profile tabs stable and Save reachable while content scrolls.
- Do preserve visible focus, useful labels and the implemented phone touch targets.
- Do derive new styling from the frontmatter and current CSS before adding another token.

### Don't:

- Don't add gradients, decorative shadows or nested cards.
- Don't enlarge routine controls or introduce generic dashboard decoration.
- Don't turn future destinations into apparently working features.
- Don't replace the existing messaging interface or alter backend contracts to implement a visual pattern.
- Don't introduce a dark sidebar or apply the media viewer's dark scrim to the workspace.
- Don't invent brand claims, metaphors, decorative imagery or new font dependencies.
