# Tweaking the design

Everything about the app's spacing and color palette is controlled from one
place: the `:root { ... }` block at the very top of `style.css` (look for the
`THEME` comment header). You shouldn't need to touch anything else in the
file, or any of the HTML/JS, to make the kinds of adjustments below.

## Spacing

```css
--space-scale: 1;
```

This one number multiplies every vertical gap in the sidebar and panels:
section-to-section spacing, heading margins, `<hr>` margins, label stacking,
status-line spacing. It doesn't touch font size, icon size, or map controls -
just vertical breathing room.

- `1` is the current default.
- Try `0.6` or `0.7` for noticeably tighter spacing.
- Try `1.2` or `1.4` for airier spacing.

Change the one line, reload the page, done - no other edits needed.

## Color palette

Also in that same `:root` block, under "Color palette":

```css
--unreviewed: var(--md-ref-palette-blue40, #3388ff);
--flagged: var(--md-ref-palette-orange60, #ff9800);
--kept: var(--md-ref-palette-green60, #43a047);
--locked: var(--md-ref-palette-grey60, #9e9e9e);
--active-lock: var(--md-ref-palette-purple40, #6d4c41);
--normal: var(--md-ref-palette-blue40, #3388ff);
--oversized: var(--md-ref-palette-red50, #e64a19);
--undersized: var(--md-ref-palette-yellow80, #fbc02d);
--overlap: var(--md-ref-palette-pink50, #e91e63);
--combine-action: var(--md-ref-palette-purple40, #9c27b0);
--replace-action: var(--md-ref-palette-cyan50, #00838f);
```

These are the map/list/legend status colors and the queue/action indicator
colors (the border + tint you see on a combined/replaced/queued area in the
feature list). Every one of them, plus the general UI roles further down
(surfaces, borders, text, the button fill), is referenced by `var()`
everywhere else in the file - change the value here once and it updates
everywhere that color is used.

Two ways to change one:

1. **Swap the hue, keep the M3 system** - point it at a different named hue
   from `vendor/material/m3-tokens.css`. Available hues: `blue`, `cyan`,
   `green`, `grey`, `grey-variant`, `orange`, `pink`, `purple`, `red`,
   `yellow`, plus `blue-variant`. Each has numbered steps from `0` (black) to
   `100` (white) in increments of 10 (plus `95`/`98`/`99`), where lower
   numbers are darker. For example, to make "oversized" areas use a deeper
   red:

   ```css
   --oversized: var(--md-ref-palette-red70, #e64a19);
   ```

2. **Bypass M3 entirely** - just replace the whole value with a literal hex,
   e.g.:

   ```css
   --kept: #2e7d32;
   ```

### The general UI roles

Below the status colors, the same block also aliases the surfaces/borders/
text colors and the filled-tonal button look (`--surface`, `--border`,
`--on-surface`, `--btn-bg`, `--btn-text`, etc.). These default to Material
3's own semantic tokens (`--md-sys-color-*` in `vendor/material/m3-tokens.css`),
which are themselves derived from a small set of "seed" hues (mostly the
`primary`/`secondary` reference palettes). Two ways to retheme these:

- **Retheme the whole app's accent color** - edit the `primary`/`secondary`
  reference-palette values directly in `vendor/material/m3-tokens.css`
  (search for `--md-ref-palette-primary` / `--md-ref-palette-secondary`).
  This is the same mechanism Material 3's own theming tools use, and it
  flows through to buttons, focus outlines, and every semantic color at
  once.
- **Override one role only** - just set it directly in style.css's theme
  block, e.g. to make buttons green-tinted instead of purple-tinted:

  ```css
  --btn-bg: #dcedc8;
  --btn-text: #33691e;
  ```

## Fonts

Roboto is vendored in `vendor/material/roboto-fonts.css` and set as the base
font in the same `:root` block (`--md-ref-typeface-brand`/`-plain`) plus
`html, body { font-family: ... }`. To use a different font, change both of
those and vendor the new font's files the same way (see that file for the
`@font-face` pattern) - fonts aren't a single-variable knob like spacing and
color since swapping typefaces usually also means bringing in new font
files.
