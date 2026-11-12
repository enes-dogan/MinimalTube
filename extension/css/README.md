# MinimalTube stylesheets

Load them in this order:

| File | What it covers |
|---|---|
| `tokens.css` | Every colour, shadow, radius, type size, layer (z-index) and easing the UI uses. Start here. |
| `base.css` | Reset, page background, hidden scrollbars, shared keyframes, reduced-motion. |
| `buttons.css` | The shared pieces: text buttons (`.btn` + `.btn-primary` / `-ghost` / `-tint` / `-danger`, shapes `-rect` / `-sm` / `-block`), the ⋮ buttons, key hints (`.kbd`) and the one keyboard-focus ring. |
| `layout.css` | The player frame: stage, video, placeholder, scrims, the mouse-idle fade. |
| `controls.css` | Bottom control bar, seek bar, chapters and SponsorBlock marks, captions, centre flash. |
| `overlays.css` | Anything floating over the video or the page: spinner, errors, toasts, the Undo bar, title, description popup, the two centre dialogs ("Up next", "Unsubscribe?"), the save-playlist modal, the keyboard-shortcuts overlay and the welcome screen. |
| `indicators.css` | The round buttons on the video and the two download progress rings. |
| `panels.css` | The Settings card (over the whole app) and the queue / downloads side panel, including its rows. |
| `menus.css` | The ⋮ menus (queue rows and browse cards) and the shared "Save to" popover. |
| `browse.css` | Browse page: tabs, the OFFLINE badge, channel bar (Channels button, chips, "Showing only"), card grids, the video card and its watch-progress bar, the "new videos" pill, the skip link. |
| `mini-player.css` | The small floating player shown while browsing. |
| `popup.css` | The toolbar popup (`popup.html`). Loads `tokens.css`, then overrides two values. |

## Conventions

**Change a value in `tokens.css`, not in a component file.** Component files
contain no raw colours, radii, font sizes or z-index numbers, only tokens:

- colours by role (surfaces, accent, text, status), white washes in five steps
  (`--wash-1` … `--wash-5`), named shadows (`--shadow-pop`, `-menu`, `-dialog`, …);
- corner radii `--radius-xs` … `--radius-xl`, `--radius-pill`, `--radius-round`;
- type sizes `--fs-2xs` … `--fs-4xl`;
- layers `--z-*`, listed bottom to top in the order they stack (small numbers like
  `z-index: 2` only order things inside one component, such as the seek bar's parts);
- keyboard focus `--focus-ring` (and `--focus-ring-inset` inside panels).

**Buttons use the shared classes.** A new button gets `class="btn btn-primary"`
(or `-ghost`, `-tint`, `-danger`, plus `-rect` / `-sm` / `-block` inside dialogs
and panels); its own rule only sets layout such as margins or width.

**Things that look the same share a rule.** Parts of the UI that look identical
are written once as a grouped selector, with only the genuine differences listed
separately. For example:

- `#upNext` and `#confirmUnsub` — the same centre dialog; they differ only in
  positioning, countdown length and the destructive colour (`overlays.css`).
- `#dlIndicator` and `#bpDlIndicator` — the same progress ring in two places
  (`indicators.css`). Both slide left of the open side panel (`--dlShift`, set by
  `js/jobs.js`), so neither ever lies over the panel's header buttons.
- `#miniExpand` and `#miniClose` — the same corner button, different corner and
  hover colour (`mini-player.css`).
- `#feedGrid`, `#plGrid`, `#plItemsGrid`, `#dlGrid` — one card grid, and the same
  drag-to-reorder look for the three that can be reordered (`browse.css`).
- `.vMenuBtn` and `.plMenuBtn` — one ⋮ button in two sizes (`buttons.css`).

**Order still matters in a few places.** Some rules rely on being declared after
another rule of the same specificity; those carry a comment saying so (for
example `#browseActions button.active` must stay after `:hover`). Keep rules in
their current file and position unless you have checked the cascade.

**Class names come from the player's scripts (`js/`).** Rows (`.plItem`, `.plThumb`, `.plStatus`:
`side-panel.js`), cards (`.vCard`, `.vThumb`, `.vBadge`: `cards.js`), menus (`.rowMenuItem`,
`.menuOpen` on the row or ⋮ button whose menu is open: `menus.js`) and chips (`.subChip`:
`feed.js`) are built in JavaScript, so renaming a class means editing the matching file in
`js/` too.

**Nothing invisible may sit over something clickable.** An element that is only hidden
(`visibility` / `opacity`) still takes its place, and a box above the side panel swallows the
clicks meant for the panel's buttons. Take it out of the row (as `#bpDlIndicator` is) instead.

## Related

The JavaScript that builds the elements these rules style lives in `js/` (see `js/README.md`);
the server that feeds it is `server.py` plus the `minimaltube/` package.
