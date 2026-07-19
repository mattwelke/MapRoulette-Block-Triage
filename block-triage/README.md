# Block Triage

A small local web app for reviewing area polygons (e.g. the "blocks" you
generate before setting up a MapRoulette challenge) and finding the ones
that have no real work to do — cul-de-sac islands, thin slivers between
divided-highway carriageways, etc.

It runs entirely in your browser. No build step, no server, no account.

## Which interface?

Opening `index.html` (double-click it, or `open index.html` / drag it into
a browser window) asks which interface you want:

- **Local file triage** (`local.html`) — load a GeoJSON file, review areas
  on a map, split/combine/keep/remove, then export the result. Nothing
  here ever touches MapRoulette. See [Local file triage](#local-file-triage)
  below.
- **Live MapRoulette editing** (`live.html`) — load a challenge straight
  from the MapRoulette API and edit its tasks directly: split, combine
  (bridging distant areas together), queue-delete. Every change is applied
  to MapRoulette itself, live. See
  [Live MapRoulette editing](#live-maproulette-editing) below.

These are two independent, self-contained pages (own JS files, no shared
state) — pick whichever matches what you're doing; there's no toggle to
switch modes mid-session, just navigate back to `index.html`.

## Local file triage

1. Open `local.html` (or get there via `index.html`'s chooser).
2. Load some areas to review, one of two ways:
   - Click **Open GeoJSON…** and pick your file (a `FeatureCollection` of
     `Polygon` features — see `sample-data/blocks.geojson` for an example,
     which is real output for Oakville, Ontario).
   - To build a GeoJSON from scratch instead of reviewing an existing one,
     click **New (blank)** — this starts an empty session with no source
     file, so **Add new area…** works right away with nothing pre-loaded.
   There's nothing to reload from if you refresh the browser mid-session
   with either of these, so export before you do.
3. The map loads every polygon. Anything smaller than the **small area**
   threshold or below the **skinny (compactness)** threshold is
   automatically flagged orange as a likely candidate to remove — tune
   both thresholds in the sidebar and the map/list update live.
4. The currently-selected area pulses gently on the map (a soft dark
   highlight fading in and out) so it stays easy to pick out of a dense
   cluster — especially useful right before splitting or removing
   something you don't want to get wrong.
5. Click a polygon (on the map or in the sidebar list) to select it, then:
   - **Remove** — drops it from the in-memory GeoJSON and the map
     immediately (not just marked - actually gone), so you can click that
     same spot right after with **Add new area…** to redraw something in
     its place.
   - **Keep** — explicitly keep it even if flagged (green)
   - **Reset** — back to unreviewed
   - Keyboard shortcuts once a feature is selected: `x` remove, `g` keep,
     `r` reset, `j`/`k` next/previous in the current filtered list.
   - `Ctrl+Z` (or the **Undo** button) undoes the last change — a removal,
     a status change, a split, a combine, an added area — whether it came
     from a popup button, a keyboard shortcut, or an accidental
     quick-remove click. `Ctrl+Shift+Z` (or **Redo**) reapplies it. History
     is per-file and clears when you load a new file.
6. The sidebar list is sorted smallest-area-first by default, and can be
   filtered to just "Flagged, undecided" so you can plow through the
   likely junk first.
7. Check **Quick remove mode** (top bar) to skip the popup entirely: while
   it's on, clicking an area on the map removes it immediately, no
   confirmation. This is meant for flying through a cluster of obvious
   junk quickly — use **Undo** to recover from a mis-click. Sidebar-list
   clicks still open the review popup regardless of this mode, since
   that's the more deliberate review path.
8. Click **Export filtered GeoJSON** to download the current in-memory
   dataset — every removed feature is already gone, so there's no
   filtering step at export time; kept and still-unreviewed features come
   out as-is.
9. Open a feature's popup and click **Split…** to divide it into two —
   useful when one polygon covers both a legitimate block and something
   like a hydro corridor or a large patch of forest. Click points across
   the area to draw a cut line, then `Enter`, double-click, or the
   **Finish** button to complete it (`Esc` or **Cancel** to back out).
   The cut needs to fully cross the area (past both edges) to produce two
   separate pieces; both come out **unreviewed** so you decide on each
   independently. This is undoable like any other action.
10. Click **Add new area…** (top bar) to draw a brand new polygon from
    scratch — for spots your block-generating code missed entirely, or a
    spot you just cleared with Remove. Same click-to-add-point / `Enter`
    or double-click to finish / `Esc` to cancel interaction as splitting,
    just needs 3+ points instead of 2. The new area starts **unreviewed**
    and is included in exports and undo/redo like anything else.
11. Click **Combine areas…** (top bar) to merge two or more areas back
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
selecting areas rather than for the usual select/quick-remove behavior —
this includes clicks that land on top of other areas, since a cut line
very often needs to cross right over them.

Your marks are saved to the browser's `localStorage` as you go (keyed to
the loaded file's name/size/feature count), so a refresh won't lose your
progress. Marks for one file don't affect another.

**Kept** decisions are also written into the exported file itself, as a
`_blockTriageStatus: "kept"` property on that feature. If you later
re-open that exported file — a different machine, a cleared browser, or
just a new session — it's recognized as already-kept without needing the
original `localStorage` data. The property name is deliberately
namespaced/underscore-prefixed so it reads as tool-internal metadata; it
shouldn't affect how MapRoulette itself processes the file (MapRoulette
tasks only care about a feature's geometry and whichever specific
properties your challenge template references), but it's worth a quick
check the first time you upload a file carrying it, just to be sure.

## Live MapRoulette editing

`live.html` loads a challenge's tasks directly from the MapRoulette API
and edits them there, live — there's no file to load or export; every
action here (split, combine, delete) is a real, remote change to your
challenge the moment you confirm it.

**Setup:**
- **API key** — from the bottom of https://maproulette.org/user/profile.
  Stored in `localStorage` so you don't have to re-enter it every session;
  **Clear** forgets it. Treat it like any other credential — it can
  create/delete real tasks in your challenges.
- **Challenge ID** — type it in; also persists via `localStorage`.
- **Test connection** — a harmless `GET /user/whoami` call to confirm the
  key (and your browser's ability to reach the API at all) works before
  you rely on it for anything real.
- **Max concurrent requests** — caps how many MapRoulette API requests this
  tool will have in flight at once, across every queue (defaults to 3,
  persists via `localStorage`). Each queue's own processing loop is already
  sequential internally, so this mostly matters when multiple queues end up
  being processed at the same time (e.g. via "Process all pending") — it
  keeps the combined request rate bounded instead of letting every queue
  hammer the API in parallel.
- **Load challenge from MapRoulette** — pulls every task in the given
  Challenge ID directly from the API (paging through 500 at a time under
  the hood). Each task's geometry becomes an area here, stamped with
  `mr_taskId` / `mr_challengeId` / `mr_taskStatus` properties. If you
  already have areas loaded, it confirms first, since it replaces what's
  currently on screen.

A persistent red **LIVE: editing MapRoulette challenge &lt;id&gt;** banner
runs across the top of the page the whole time, so there's never any
doubt that the actions here have real, remote consequences.

**Area size coloring.** Unlike local file triage (which tracks a
reviewed/kept/flagged status per area), live editing colors every area by
how its size compares to a **target area limit** (set in the sidebar,
defaulting to 5,000 m²):
- **Oversized** (orange-red) — at least 2× the target limit, drawing
  attention to it as a candidate to split.
- **Undersized** (yellow) — at most half the target limit, suggesting you
  look for a neighboring area to combine it with.
- **Normal** (blue) — anything in between; no action suggested.

Changing the target area limit re-colors the map, the list, and the stats
immediately — there's no separate "flagged" status here, just this
size-based classification recomputed live from each area's current area.

**Per-area actions** (in the popup, alongside Split): for a linked area
(one with a MapRoulette task, loaded or already added), a button reading
**Remove task from challenge** or **Cancel pending removal**. For an
unlinked area (freshly drawn, or a split/combine result that hasn't been
added yet), a button reading **Queue for adding** / **Cancel pending add**,
plus a separate **Add now** button that creates it immediately, bypassing
the queue.

Both directions work as queues rather than immediate actions, for the same
reason: MapRoulette's task endpoints can be slow, and doing a whole batch
one popup at a time, waiting on each request, isn't a great way to work.
**Process all pending N** (near the top of the MapRoulette panel) runs
every queue below - add, delete, boundary-edit, split - one after another
in a single click, so you don't have to hunt down each queue's own button;
each queue still asks for its own confirmation exactly where it normally
would (add doesn't need one, the rest do).

- **Adding**: every new, unlinked area (drawn, split, or combined) is
  automatically queued to be added — it shows a green dashed outline on the
  map and in the list. **Process add queue N** (in the MapRoulette panel)
  creates them all, one at a time with a short pause between each; no
  confirmation is needed since creating a task isn't destructive. If you
  don't want to wait for the batch, that area's popup's **Add now** button
  creates it right away instead (and drops it out of the queue).
- **Removing**: clicking **Remove task from challenge** doesn't delete
  anything right away — it queues the removal (red dashed outline) and
  nothing is deleted until you process that queue. **Process delete queue
  N** confirms once for the whole batch, then deletes them one at a time
  with a short pause between each so as not to hammer the API.

Either way, whatever succeeds disappears from (or appears in) the map, the
list, and the stats immediately. Anything that fails stays exactly as it
was (unqueued, reported at the end so you know what to retry) — a failed
add stays unlinked, a failed removal stays linked.

**Splitting** applies locally right away, same as combining or drawing a
new area — clicking **Split…**, drawing the cut, and finishing it
immediately replaces the area with its resulting pieces (an orange dashed
outline on the map and in the list). Only the MapRoulette side is queued:
**Process split queue N** (in the MapRoulette panel) syncs it, one split at
a time — if the area was task-linked, its old task is deleted and a new
task is created for every piece still standing.

While a split's pieces are still pending (not yet processed), each is
off-limits to everything else — combining, editing its boundary, quick
queue-delete, and re-splitting are all refused (with an explanation) —
except one thing: each piece's popup offers **Drop this piece**, which
discards just that piece (its geometry is gone, not merged anywhere) and
leaves the rest of the group pending. At least one piece must remain; to
back out of the split entirely, undo it (`Ctrl+Z`) instead. Dropping a
piece is its own undoable step, separate from the split itself — undoing
once brings back the dropped piece, undoing again reverses the whole
split back to the original area.

### Drawing new areas

Click **Add new area…**, then click points on the map to build the outline
(3+ points, `Enter`/double-click/**Finish** to complete, `Esc`/**Cancel** to
back out) — same interaction as splitting, just for a whole new polygon.

### Combining areas

Click **Combine areas…**, then click 2+ adjacent areas (map or list) to
merge them, `Enter`/**Finish** to commit (`Esc`/**Cancel** to back out) —
same behavior as local file triage: they need to actually touch (or be
separated only by a hairline gap, e.g. two pieces from an earlier split),
or it's rejected with an explanation rather than producing a
`MultiPolygon`.

The constituent areas' MapRoulette tasks (if any) are left untouched
remotely — combining is local-only until you act on the result — and the
merged result is automatically queued to be added as its own new task (see
"Per-area actions" above), or use "Add now" on it to link it right away.

### Editing a boundary (drag to reshape)

Click **Edit boundary…** on an area's popup to reposition its existing
points by dragging them — this is deliberately its own opt-in mode
(entered only through that button) rather than always-draggable points, so
a stray click or drag on the map never silently reshapes something. While
editing:
- Drag any point (mouse or touch) to move it; the outline updates live as
  you drag.
- `Enter`/**Finish** commits the new shape (`Esc`/**Cancel** discards it
  entirely, leaving the area exactly as it was). This is undoable like any
  other change.

If the area was already linked to a MapRoulette task, finishing an edit
doesn't touch MapRoulette right away — it queues the change (the area
shows a blue dashed outline) since there's no in-place geometry update
used here, only delete-then-recreate (the same mechanic split already uses
for a linked area). **Process boundary-edit queue N** (in the MapRoulette
panel) applies every queued edit, one at a time: deletes the old task and
creates a new one with the edited shape. Editing an area that isn't linked
yet is purely local — nothing to queue until you add it.

### Replacing areas

Click **Replace areas…**, then click one or more areas (map or list) to
select them for replacement — `Enter`/**Finish** confirms the selection,
`Esc`/**Cancel** backs out with nothing changed. Once confirmed, the
selected areas disappear from the map and list right away (this part is
immediate, not queued, since you need to see the empty space to draw into
it) — then draw one or more replacement areas with **Add new area…**, same
interaction as always. When you've drawn everything you want, `Enter`/
**Finish** again to complete the replace (`Esc`/**Cancel** at this point
restores the areas you selected and drops whatever you'd drawn so far,
undoing the whole operation). You need at least one area selected and at
least one replacement drawn to finish.

Only the MapRoulette side is queued: the replacement areas show a teal
dashed outline until you run **Process replace queue N** (in the
MapRoulette panel), which deletes any MapRoulette tasks the replaced areas
had and creates new tasks for the replacements, one group at a time. While
a replace is pending, its replacement areas are off-limits to everything
else (combining, splitting, editing, quick queue-delete) until they're
processed. Finishing a replace (the local swap) is a single undoable
action, same as split/combine/add — `Ctrl+Z` restores the original areas
and removes the drawn replacements in one step.

**Locked (already-resolved) tasks.** If a loaded task's `mr_taskStatus` is
`Fixed` or `Already_Fixed`, it's shown grey on the map and treated as
locked — there's nothing structurally left to do with a task someone's
already resolved. Locked areas can still be clicked to open the popup (so
you can see its status at a glance), but can't be split, combined, edited,
or queued for removal — each of those actions shows an explanatory alert
instead of doing anything (the popup omits Edit boundary entirely for a
locked area).

**Locked (checked out right now) tasks.** This tool also watches for a
task currently being checked out on MapRoulette (i.e. someone's locked it
by starting work on it there, or via another API client) — shown as a
distinct brown, separate from the grey of an already-resolved task, since
it's a temporary condition rather than a permanent one. The same
restrictions apply. A few things worth understanding about how this
works:
- Any active lock counts, including one held by the same MapRoulette
  account as the API key configured here — e.g. if you have the task open
  in the MapRoulette site yourself. This is deliberately simple: it just
  checks whether `lockedBy` is set at all, with no "is it me" carve-out.
- MapRoulette's API has no push/webhook mechanism for lock changes, so
  this can only ever be as fresh as the last check — there's no way to
  react the instant a task gets locked. This tool polls in the background
  every ~60 seconds (jittered by a few seconds either way, so multiple
  people running this tool against the same challenge don't all hit the
  API in lockstep) whenever a challenge ID and some loaded areas are
  present.
- Right before anything that would actually delete a task — processing
  the delete queue, or committing to a split on a task-linked area — it
  does one more on-demand check of just that moment's lock state first,
  since a background poll landing up to a minute earlier isn't good
  enough right at the point something irreversible is about to happen.
  If a queued area turns out to be freshly locked when its turn in the
  queue comes up, it's skipped (not deleted) and called out in the final
  summary rather than silently dropped.
- A **"Task lock checks: ..."** line in the MapRoulette panel shows when
  polling last ran and what it found (or that it's paused, and why).

**Quick queue-delete mode** (checkbox in the MapRoulette panel) mirrors
local triage's Quick remove mode but for the delete queue: while it's on,
clicking an area on the map queues it for removal (or unqueues it if
already queued) instead of opening the popup. It only applies to map
clicks (sidebar-list clicks still open the popup), only queues areas
actually linked to a MapRoulette task, and refuses locked areas with the
same explanatory alert as everywhere else. Nothing is actually deleted
until you run **Process delete queue**.

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
  the challenge ID, and geometry.
- Every request carries a `From: Block Triage - tronnalegacy@pm.me`
  header, so it's identifiable on MapRoulette's end as coming from this
  tool rather than the official site/app.

## Basemaps

The layer switcher (top-right of the map) toggles between standard
OpenStreetMap tiles and Esri World Imagery (aerial photos) — the aerial
view is often the fastest way to visually confirm "yep, that's a traffic
island, there's no building going there." Both pages also have an
**Oakville addresses (skfd)** overlay (an OSM community address layer for
Oakville, https://skfd.github.io/oakville-address-layer/ - off by default,
specific to that one town) and a **Reference layer** entry - see below.

## Reference layer

**Load reference layer…** (top bar, in both `local.html` and `live.html`)
loads any GeoJSON file as a plain visual overlay — teal to keep it clearly
distinct from the working areas. This is purely for context: it's never
selectable, never counted in the stats, never touched by undo/redo, and
never included in a local-triage export. Point/LineString/Polygon
geometries all render (Leaflet handles the mix natively). Use it for
things like an existing building footprints file, a boundary you're
drawing against, or any other dataset you want visible while you triage
or edit a live challenge. Loading a new one replaces the old; **Clear**
removes it entirely.

Polygons also get a thin checkered band just inside their boundary, on top
of the plain fill — the flat fill color alone isn't always enough
contrast to tell a filled area from empty space against some basemaps, so
the pattern gives a second, sharper visual cue for where the boundary
actually is. It only appears once you're zoomed in a lot (past zoom 18);
at ordinary zoom levels it'd just be a hairline, so it's left out
entirely rather than shown too thin to see.

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
  `local.js`/`live.js` if you ever produce those.
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
  reverses a split, but rejects areas that are genuinely far apart rather
  than bridging the gap between them. Same behavior in both `local.html`
  and `live.html`.

## Testing

The app itself has no dependencies to install — but the test suite
(`tests/`) is written with [Playwright](https://playwright.dev) and drives
the app's HTML files directly as `file://` URLs (mostly `local.html` and
`live.html`, plus `index.html` for the chooser), the same way you'd use
the app by hand. Install once, then run:

```sh
npm install
npm test
```

`npm test` runs every file in `tests/` in sequence and prints a pass/fail
summary (`tests/run-all.js`). To run a single test while working on
something, just `node tests/some-test.js` directly — each one exits
non-zero on failure.

Two environment variables configure the browser launch, since the exact
Chromium binary and any outbound-proxy requirement are specific to your
machine, not something the repo should hardcode:
- `PW_EXECUTABLE_PATH` — path to a Chromium binary (omit to use
  Playwright's own bundled browser, which `npm install` downloads for you)
- `PW_PROXY_SERVER` — e.g. `http://127.0.0.1:33007`, if your network needs
  one (omit otherwise)

MapRoulette-facing tests never talk to the real API — they use
Playwright's request interception (`page.route(...)`) to simulate
MapRoulette's responses (a small, hand-built set of synthetic tasks with a
predictable mix of locked/unlocked statuses - see `mrChallengeSampleTasks()`
in `tests/support.js`), so they're deterministic and don't need real
credentials.
