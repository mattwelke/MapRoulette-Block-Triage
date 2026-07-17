# Block Triage

A small local web app for reviewing a GeoJSON file of area polygons (e.g.
the "blocks" you generate before setting up a MapRoulette challenge) and
marking the ones that have no real work to do — cul-de-sac islands, thin
slivers between divided-highway carriageways, etc. — before you upload
the challenge or feed the areas into your address-import workflow.

It runs entirely in your browser. No build step, no server, no account.

## Usage

1. Open `index.html` directly in a browser (double-click it, or
   `open index.html` / drag it into a browser window).
2. Click **Open GeoJSON…** and pick your file (a `FeatureCollection` of
   `Polygon` features — see `sample-data/blocks.geojson` for an example,
   which is real output for Oakville, Ontario). Or, to build a GeoJSON
   from scratch instead of reviewing an existing one, click
   **New (blank)** — this starts an empty session with no source file, so
   **Add new area…** works right away with nothing pre-loaded. There's
   nothing to reload from if you refresh the browser mid-session, so
   export before you do.
3. The map loads every polygon. Anything smaller than the **small area**
   threshold or below the **skinny (compactness)** threshold is
   automatically flagged orange as a likely candidate to exclude — tune
   both thresholds in the sidebar and the map/list update live.
4. Click a polygon (on the map or in the sidebar list) to select it, then:
   - **Exclude** — mark it to be dropped from the exported file (red)
   - **Keep** — explicitly keep it even if flagged (green)
   - **Reset** — back to unreviewed
   - Keyboard shortcuts once a feature is selected: `x` exclude, `g` keep,
     `r` reset, `j`/`k` next/previous in the current filtered list.
   - `Ctrl+Z` (or the **Undo** button) undoes the last status change —
     whether it came from a popup button, a keyboard shortcut, or an
     accidental quick-exclude click. `Ctrl+Shift+Z` (or **Redo**) reapplies
     it. History is per-file and clears when you load a new file.
5. The sidebar list is sorted smallest-area-first by default, and can be
   filtered to just "Flagged, undecided" so you can plow through the
   likely junk first.
6. Check **Quick exclude mode** (top bar) to skip the popup entirely:
   while it's on, clicking an area on the map immediately marks it
   excluded, and clicking it again undoes that (back to unreviewed).
   This is meant for flying through a cluster of obvious junk quickly;
   sidebar-list clicks still open the review popup regardless of this
   mode, since that's the more deliberate review path. Turn it back off
   to return to the click-then-confirm popup workflow.
7. Click **Export filtered GeoJSON** to download a copy of the original
   file with every *excluded* feature removed. Everything else (kept and
   still-unreviewed features) is preserved as-is.
8. Open a feature's popup and click **Split…** to divide it into two —
   useful when one polygon covers both a legitimate block and something
   like a hydro corridor or a large patch of forest. Click points across
   the area to draw a cut line, then `Enter`, double-click, or the
   **Finish** button to complete it (`Esc` or **Cancel** to back out).
   The cut needs to fully cross the area (past both edges) to produce two
   separate pieces; both come out **unreviewed** so you decide on each
   independently. This is undoable like any other action.
9. Click **Add new area…** (top bar) to draw a brand new polygon from
   scratch — for spots your block-generating code missed entirely. Same
   click-to-add-point / `Enter` or double-click to finish / `Esc` to
   cancel interaction as splitting, just needs 3+ points instead of 2. The
   new area starts **unreviewed** and is included in exports and undo/redo
   like anything else.
10. Click **Combine areas…** (top bar) to merge two or more areas back
    into one — the undo for a split you've decided wasn't a good idea
    (e.g. it divided an area along nothing but empty space with no road,
    stream, or path to tell a MapRoulette mapper where the boundary is,
    leaving them unable to tell what's in scope). Click the areas to
    merge — on the map or in the sidebar list, both work — then `Enter`
    or **Finish** to combine (`Esc`/**Cancel** to back out). They need to
    actually share a boundary; combining two that don't touch would
    produce a `MultiPolygon`, which isn't supported, so it's rejected
    with an explanation instead. The combined area comes out
    **unreviewed**, and this is undoable too.

While drawing or combining, clicks are captured for placing points or
selecting areas rather than for the usual select/quick-exclude behavior —
this includes clicks that land on top of other areas, since a cut line
very often needs to cross right over them.

Your marks are saved to the browser's `localStorage` as you go (keyed to
the loaded file's name/size/feature count), so a refresh won't lose your
progress. Marks for one file don't affect another.

**Kept** decisions are also written into the exported file itself, as a
`_blockTriageStatus: "kept"` property on that feature (excluded features
are simply dropped, so they don't need a marker). If you later re-open
that exported file — a different machine, a cleared browser, or just a
new session — it's recognized as already-kept without needing the
original `localStorage` data. The property name is deliberately
namespaced/underscore-prefixed so it reads as tool-internal metadata; it
shouldn't affect how MapRoulette itself processes the file (MapRoulette
tasks only care about a feature's geometry and whichever specific
properties your challenge template references), but it's worth a quick
check the first time you upload a file carrying it, just to be sure.

## Basemaps

The layer switcher (top-right of the map) toggles between standard
OpenStreetMap tiles and Esri World Imagery (aerial photos) — the aerial
view is often the fastest way to visually confirm "yep, that's a traffic
island, there's no building going there."

It also has an **Oakville addresses (skfd)** overlay checkbox — an OSM
community address layer for Oakville
(https://skfd.github.io/oakville-address-layer/), shown as dots (with
street name labels at some zoom levels) for known addresses. It's off by
default; turn it on to see whether an area actually has addresses nearby
before deciding to exclude it. (This overlay is specific to Oakville; if
you triage a different town's blocks, just ignore or remove it.)

## Reference layer

**Load reference layer…** (top bar) loads any GeoJSON file as a plain
visual overlay — teal to keep it clearly distinct from the working areas,
and shown as a **Reference layer** entry in the layer switcher. Unlike the
file you open for review, this one is purely for context: it's never
selectable, never counted in the stats, never touched by undo/redo, and
never included in the export. Point/LineString/Polygon geometries all
render (Leaflet handles the mix natively). Use it for things like an
existing building footprints file, a boundary you're drawing against, or
any other dataset you want visible while you triage or draw from scratch.
Loading a new one replaces the old; **Clear** removes it entirely.

Polygons also get a thin checkered band just inside their boundary, on top
of the plain fill — the flat fill color alone isn't always enough
contrast to tell a filled area from empty space against some basemaps, so
the pattern gives a second, sharper visual cue for where the boundary
actually is. It only appears once you're zoomed in a lot (past zoom 18);
at ordinary zoom levels it'd just be a hairline, so it's left out
entirely rather than shown too thin to see.

## MapRoulette integration

If the GeoJSON you load came from MapRoulette (it carries `mr_taskId` /
`mr_challengeId` properties per feature, like a MapRoulette task export
does), Block Triage can talk to the MapRoulette API directly from your
browser to keep individual tasks in sync with what you do here.

**This is opt-in and off by default.** The sidebar's "MapRoulette" section
starts as just a single **Live sync with MapRoulette** checkbox — with it
off, the app is exactly the local-only review tool it's always been:
no MapRoulette UI, no API calls, safe to point at any GeoJSON including
one that happens to carry `mr_taskId`s you don't want touched this
session. Turning it on reveals the rest of the setup and — critically —
shows a persistent red **LIVE: syncing with MapRoulette challenge
&lt;id&gt;** banner across the top of the page the whole time it's on, so
there's never any doubt about whether the button you're about to click
has real, remote consequences. The toggle (like the API key and
challenge ID) persists across sessions via `localStorage`, so remember to
check the banner rather than assume based on habit.

**Setup** (once live sync is on):
- **API key** — from the bottom of https://maproulette.org/user/profile.
  Stored in `localStorage` so you don't have to re-enter it every session;
  **Clear** forgets it. Treat it like any other credential — it can
  create/delete real tasks in your challenges.
- **Challenge ID** — auto-filled from the loaded file's `mr_challengeId`
  the first time (won't overwrite one you've already typed in), or type it
  in directly for a from-scratch session with no file loaded yet.
- **Test connection** — a harmless `GET /user/whoami` call to confirm the
  key (and your browser's ability to reach the API at all) works before
  you rely on it for anything real.

**Per-area actions** (only appear while live sync is on) (in the popup, alongside Exclude/Keep/Reset/Split):
a button that reads **Add task to challenge** for an area with no linked
task (freshly drawn, or one you've removed), or **Remove task from
challenge** for one that has one (loaded from a file that had
`mr_taskId`, or created through this UI). Remove asks for confirmation
first, since it's a real, immediate delete on MapRoulette with no local
undo for it. Once it succeeds, the area disappears entirely from the map,
the list, the stats, and the in-memory GeoJSON — there's nothing left to
review locally once its task is gone from MapRoulette, so it's dropped
rather than left behind as a fresh unlinked area. (A *failed* remove
leaves the area exactly as it was — nothing is removed unless MapRoulette
confirms the delete.)

**Splitting a task-linked area**, while live sync is on, also asks for
confirmation up front (it tells you which task ID is involved), then
deletes that MapRoulette task and creates two new ones for the resulting
pieces, automatically, right after the local split completes. With live
sync off, splitting a MapRoulette-sourced area is purely local, same as
splitting anything else — no confirmation, no API calls, even if that
area's `mr_taskId` is sitting right there in its data. **Combining stays
local-only** regardless — the areas being merged keep whatever MapRoulette
tasks they had (untouched,
not deleted), and the merged result starts unlinked; use its own "Add
task to challenge" button if you want to link it to a fresh task.

**Exporting** writes `mr_taskId` back onto any feature that has one, so a
re-imported export recognizes the same linkage next time, the same way
`_blockTriageStatus` does for kept/excluded.

Some things worth knowing:
- **Local undo/redo never touches MapRoulette.** Once a task is deleted
  or created remotely, that's final — Ctrl+Z only rewinds what you see
  here. Undoing a split after its MapRoulette sync completed will restore
  the original area locally, but its old task ID is already gone from
  MapRoulette; clicking "Remove task from challenge" on it at that point
  will fail (404) since there's nothing left to delete.
- **CORS is unverified.** Whether MapRoulette's API allows a direct
  browser request from a local file isn't something the docs settle —
  that's exactly what **Test connection** is for. If it fails with a
  network/CORS error rather than an auth error, that's outside what this
  tool (or you) can fix from the browser side.
- Task priority and instructions aren't carried over to newly-created
  tasks (including split children) — they're created with just a name,
  the challenge ID, and geometry. Easy to extend if you want that later.

## Why compactness, not just area

Some artifacts (thin slivers between the two carriageways of a divided
road) aren't necessarily tiny in area, just very elongated. The
"skinny" threshold uses the
[Polsby–Popper compactness score](https://en.wikipedia.org/wiki/Polsby%E2%80%93Popper_test)
(`4π·area / perimeter²`), which is close to 1 for a circle/square and
close to 0 for a long thin shape, regardless of absolute size.

## Notes / limitations

- Only `Polygon` geometries are handled (matches the input data this was
  built against). `MultiPolygon` support would need a small extension to
  `app.js` if you ever produce those.
- Leaflet and Turf.js are vendored in `vendor/` (no CDN dependency) so the
  app works fully offline except for fetching basemap tile images.
- Splitting works by buffering the drawn cut line into a thin ("knife")
  polygon and subtracting it, rather than computing an exact line
  intersection — simple and robust, but it leaves a ~1m gap between the
  two resulting pieces. That's invisible at the zoom levels you'd
  actually review at and doesn't affect anything about the review
  workflow, just worth knowing it's not a mathematically exact cut.
- New/split/combined features get a synthetic id (e.g. `new-1`, `12a`,
  `12a+12b`) shown in the sidebar and popup instead of a plain array
  index, so you can still tell at a glance where they came from.
- Combining closes gaps up to ~1m before unioning (to reverse the exact
  gap splitting leaves behind), then shrinks back — so it reliably
  reverses a split, but won't bridge areas with a real, larger gap
  between them.
