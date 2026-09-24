# Block Triage

A small web app for reviewing area polygons (e.g. the "blocks" you
generate before setting up a MapRoulette challenge) and finding the ones
that have no real work to do — cul-de-sac islands, thin slivers between
divided-highway carriageways, etc.

It runs entirely in your browser, with no server-side code. You can open the
HTML files straight from disk, or host them as a static site (see
Deploying).

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
challenge once its queue is processed.

**Setup:**
- **API key** — from the bottom of https://maproulette.org/user/profile.
  Stored in `localStorage` so you don't have to re-enter it every session;
  **Clear** forgets it. Treat it like any other credential — it can
  create/delete real tasks in your challenges.
- **Challenge ID** — type it in; also persists via `localStorage`.
- **Test connection** — a harmless `GET /user/whoami` call to confirm the
  key (and your browser's ability to reach the API at all) works before
  you rely on it for anything real.
- **Load challenge from MapRoulette** — pulls every task in the given
  Challenge ID directly from the API (paging through 5000 at a time under
  the hood). Each task's geometry becomes an area here, stamped with
  `mr_taskId` / `mr_challengeId` / `mr_taskStatus` properties. If you
  already have areas loaded, it confirms first, since it replaces what's
  currently on screen.

Once a challenge finishes loading, the setup fields above collapse
automatically (leaving a one-line summary in their place) to free up
sidebar space for the queues below — a **Hide setup** / **Show setup**
button on the MapRoulette heading toggles it manually at any time.

The individual queue sections (add, delete, boundary-edit, split, replace,
combine, orphaned deletes, could-not-complete, completeable) are minimized
by default too, behind a **Show queues** / **Hide queues** toggle just
below **Process all pending** — that button already shows the total pending
count without needing them expanded, so most day-to-day processing never
needs the queues opened at all. Expand them when you want to check or
process one queue individually.

A persistent red **LIVE: editing MapRoulette challenge &lt;id&gt;** banner
runs across the top of the page the whole time, so there's never any
doubt that the actions here have real, remote consequences.

**Size coloring.** Unlike local file triage (which tracks a
reviewed/kept/flagged status per area), live editing colors every area by
how its size compares to a target, in one of two **coloring modes** (a
toggle in the sidebar, under "Coloring mode"):

- **Area (m²)** — the original approach. Compares each area's m² against a
  **target area limit** (defaulting to 5,000 m²):
  - **Oversized** (orange-red) — at least the target limit, drawing
    attention to it as a candidate to split.
  - **Undersized** (yellow) — at most half the target limit, suggesting
    you look for a neighboring area to combine it with.
  - **Normal** (blue) — anything in between; no action suggested.
- **Address count** — compares each area against a **target address
  count** and a **band width** (defaulting to 15 and ±5):
  - **Oversized** — at least target+band addresses inside it.
  - **Undersized** — at most target−band addresses inside it.
  - **Normal** — anything in between.

  Address counts come from a Town of Oakville address-points open-data
  extract, built into the app (`data/oakville-address-points.js`, just
  `[lng, lat]` pairs — no other attributes are kept, since only geometry
  matters for counting). Unlike the **Oakville addresses (skfd)** basemap
  overlay below, which is a raster image for visual reference only, this
  is real point data used to compute the count shown for each area. This
  makes the app currently Oakville-specific: the file would need swapping
  (and, if the layout of fields differs, `computeMetrics`/data-generation
  updated) to point this mode at a different town's data.

Each mode keeps its own target/band settings (so switching back and forth
doesn't clobber either), and re-colors the map, the list, and the stats
immediately — there's no separate "flagged" status here, just this
size-based classification recomputed live from each area's current
geometry.

**Could Not Complete highlighting.** Independent of coloring mode, any
area whose task is currently **Could Not Complete** on MapRoulette (the
status MapRoulette's own API calls `Too_Hard`) is always shown in teal,
overriding whatever the size-based category would otherwise be — a good
signal that the task is worth splitting, e.g. because the Oakville address
layer is missing unit numbers for part of it and a mapper might be able to
complete a subset. A linked area not already in this state gets a **Mark
as Could Not Complete** button in its popup (alongside "Per-area actions"
below) to set it directly, without splitting - useful the first time you
notice the problem, before you've decided whether/how to split it. Once
whatever was blocking it is fixed (e.g. the Oakville address layer gets
its missing unit numbers added), an area already in this state instead
gets a **Mark as Completeable** button - the reverse, making it workable
again (see "Marking Completeable" below for why this recreates the task
rather than just changing its status). Like every other action here that
changes something on MapRoulette, both queue the change rather than
applying it right away - see "Per-area actions" below. See "Splitting"
below for how this status carries through a split, including marking new
pieces the same way.

**Hiding by classification.** The sidebar's **Hide** section lists all six
classifications an area can fall into (normal, oversized, undersized,
locked, checked out, could not complete — see "Size coloring" and "Could
Not Complete highlighting" above, plus "Locked" below). Checking one hides
every area currently in that state from both the map and the sidebar list;
unchecking it brings them back. This is purely a display filter — hidden
areas' data and any queued actions on them are untouched and still process
normally in the background, they're just not shown while hidden. Since
classification is re-evaluated live, an area can drop in or out of view
as its status changes (e.g. splitting a hidden oversized area into two
normal-sized pieces makes the pieces visible again, if "Normal" isn't also
hidden). The checked set is remembered across reloads.

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
every queue below - add, delete, could-not-complete, completeable,
boundary-edit, split, replace, combine - one after another in a single
click, so you don't have to hunt down each queue's own button; processing
starts immediately, with no confirmation prompts along the way.

- **Adding**: every new, unlinked area (drawn, split, or combined) is
  automatically queued to be added — it shows a green dashed outline on the
  map and in the list. **Process add queue N** (in the MapRoulette panel)
  creates them all, one at a time. If you don't want to wait for the batch,
  that area's popup's **Add now** button creates it right away instead (and
  drops it out of the queue).
- **Removing**: clicking **Remove task from challenge** doesn't delete
  anything right away — it queues the removal (red dashed outline) and
  nothing is deleted until you process that queue. **Process delete queue
  N** starts right away and deletes them one at a time.
- **Marking Could Not Complete**: clicking **Mark as Could Not Complete**
  (or **Cancel pending mark** to undo it, as long as it's still only
  queued) doesn't change anything on MapRoulette right away either — it
  queues the status change (teal dashed outline) until you click **Process
  could-not-complete queue N**, which sets each one's status directly, no
  create/delete involved.
- **Marking Completeable**: the reverse — a Could Not Complete area's
  popup instead offers **Mark as Completeable**, which queues (green
  dashed outline) undoing that. Unlike the other direction, this *does*
  involve create/delete: MapRoulette's own server rejects a direct
  `Too_Hard` → `Created` status change (its status-transition rule only
  allows resetting to `Created` from `Deleted`/`Disabled`), so **Process
  completeable queue N** deletes the old task and creates a fresh one for
  the same geometry instead — a new MapRoulette task id for that area,
  genuinely `Created`, not just a status relabel. If the delete succeeds
  but the create fails, the area is queued into the **add** queue instead
  of being left silently unlinked.

In every case, whatever succeeds disappears from (or appears in) the map,
the list, and the stats immediately. Every MapRoulette request is itself
retried a couple of times with a short backoff before it's treated as a
failure at all (see "Retries and failure handling" below) — anything that
still fails after that stays queued rather than being dropped, so the next
time you process that queue (or click **Process all pending**), it tries
again automatically; a failed add stays unlinked and re-queued, a failed
removal stays linked and re-queued.

**Splitting** applies locally right away, same as combining or drawing a
new area — clicking **Split…**, drawing the cut, and finishing it
immediately replaces the area with its resulting pieces (an orange dashed
outline on the map and in the list). Only the MapRoulette side is queued:
**Process split queue N** (in the MapRoulette panel) syncs it, one split
at a time — if the area was task-linked, its old task is deleted
and a new task is created for every piece still standing.

While a split's pieces are still pending (not yet processed), each is
off-limits to combining, editing its boundary, and quick queue-delete (all
refused with an explanation) — but each piece's popup still offers two
things:
- **Drop this piece**, which discards just that piece (its geometry is
  gone, not merged anywhere) and leaves the rest of the group pending. At
  least one piece must remain; to back out of the split entirely, undo it
  (`Ctrl+Z`) instead. Dropping a piece is its own undoable step, separate
  from the split itself — undoing once brings back the dropped piece,
  undoing again reverses the whole split back to the original area.
- **Split…**, same as any other area — splitting a piece that's already
  part of a pending group doesn't start a second group, it just divides
  that one piece further and folds the new pieces into the same group, in
  its place. There's no limit to how many times you can keep dividing a
  piece this way before processing the queue; whenever it does get
  processed, the root area's old task (if it had one) is deleted once and
  a new task is created for every piece still standing, however many
  splits deep that ended up being. Each nested split is its own undo step
  too — undoing unwinds the most recent one first, leaving any splits
  further up the chain untouched, then keeps unwinding one step at a time
  back to the original area.

Every pending split piece's popup also offers a **Mark as Could Not
Complete** checkbox - not just when the area being split was already in
that state, since you might only notice the problem (e.g. missing unit
numbers) once you're looking at a smaller piece. Every new task created
by a split starts out as a normal, unstarted task (MapRoulette's `Created`
status) by default — check this on whichever piece(s) need it, and once
the split queue is processed, that piece's newly created task gets a
follow-up call setting it to Could Not Complete; any pieces left unchecked
stay `Created`, ready for a mapper to pick up. You can check as many
pieces as apply, or none, and a further nested split resets the checkbox
for its own new pieces (you decide again at that finer grain). If the
follow-up status call fails after the task was already created, it's
reported in the split queue's status line rather than silently retried,
since re-running "Process split queue" wouldn't recreate that task, just
leave it linked and unmarked — set its status manually on MapRoulette in
that case.

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

The merge itself happens locally right away — the merged area shows a
purple dashed outline and is off-limits to other structural actions (split,
edit boundary, another combine) until its group is processed or undone.
If none of the constituents were linked to a MapRoulette task, the merged
area is just queued for adding like any other new area (see "Per-area
actions" above), or use "Add now" on it to link it right away. If one or
more constituents *were* linked, nothing happens to MapRoulette until you
click **Process combine queue N** (in the MapRoulette panel): it deletes
every constituent's task and creates one new task for the merged area,
one combine group at a time — the same delete-then-create mechanic
split and replace already use, since there's no in-place merge on
MapRoulette's API.

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
panel) applies every queued edit, one at a time: deletes the old task
and creates a new one with the edited shape. Editing an area that isn't
linked yet is purely local — nothing to queue until you add it.

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

### Retries and failure handling

Every MapRoulette request (create, delete, fetch) is retried automatically
up to twice more (three attempts total) with a short, increasing delay if
it fails with a network error, a `429` (rate limited), or a `5xx` — the
kind of failure that's often just transient. A `4xx` other than `429`
(bad auth, not found, a conflict) fails immediately instead, since retrying
the same broken request won't fix it.

If a request still fails after those retries, what happens next depends on
what was being attempted:
- **Add or delete queue**: the area stays queued (with its green or red
  dashed outline) — the next time you process that queue, it tries again.
- **Boundary-edit queue**: if deleting the old task failed, the edit stays
  queued to retry in full. If the old task was deleted but creating its
  replacement failed, the area is now genuinely unlinked, so it's queued
  for adding instead.
- **Split, replace, and combine**: same idea — if creating a piece's
  replacement task fails after its original was already deleted, that
  piece is queued for adding. If *deleting* an original's task fails, there's
  no local area left to attach a retry to (the local change already
  happened), so the task's bare ID lands in a dedicated **orphaned
  deletes** queue instead of just being reported and forgotten, so old,
  "deleted" areas don't silently reappear as duplicates on a later reload. **Process orphaned deletes N** (in the
  MapRoulette panel) keeps retrying those.

## Tablets

Both pages adapt on touch devices at least phone-plus-sized, detected via
`(pointer: coarse) and (hover: none) and (min-width: 600px)`. There's no
upper width limit, so large 13"+ tablets get tablet mode too, even though
their landscape CSS width is wider than a 12.9" iPad Pro's:

- **Bigger text.** Every piece of text in the app is sized in `rem`, so a
  single bump to the root font size at that width scales everything at
  once — sidebar, popups, buttons, the works.
- **The per-area panel moves.** Tapping an area normally opens a Leaflet
  popup anchored right where you tapped. On tablets, it instead opens in a
  panel fixed to the right edge of the screen, vertically centered — the
  idea being you can hold the tablet horizontally and reach it with your
  right thumb without having to stretch across the map. It's the exact
  same content (and the same buttons) either way; only where it appears
  changes. Tapping the panel's own close button, or tapping empty map
  background, closes it — same as a normal popup would.

Outside that width range (phones, and regular desktop/laptop screens),
both of these are no-ops — text stays at its normal size and tapping an
area opens the usual Leaflet popup right at the tapped spot.

## Basemaps

The layer switcher (top-right of the map) toggles between standard
OpenStreetMap tiles, Esri World Imagery, and Ontario's own current aerial
imagery (**Aerial (Ontario 2023-2027)**, served via WMS from Ontario's
Geospatial GeoHub - the province's most recent orthophotography
acquisition cycle, generally sharper than Esri's over Ontario, though it's
labelled a beta service on their end and could change or move without
notice). The aerial views are often the fastest way to visually confirm
"yep, that's a traffic island, there's no building going there." Both
pages also have an
**Oakville addresses (skfd)** overlay (an OSM community address layer for
Oakville, https://skfd.github.io/oakville-address-layer/ - off by default,
specific to that one town) and a **Reference layer** entry - see below.
The Oakville address layer renders its tiles roughly 2x larger than the
other layers (via `tileSize`/`zoomOffset`, not by letting you zoom in any
farther) so its address numbers are actually readable at a normal zoom.

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

## Overlap check

**Highlight overlapping areas** (sidebar, in both `local.html` and
`live.html`) checks every currently-loaded area against every other one
for actual geometric overlap - usually a data-quality problem, since two
areas covering the same ground means something (a boundary, a split)
isn't right. Overlapping regions are drawn in pink (`#e91e63`), a color
not used anywhere else in this app, so they're unmistakable against the
regular status colors.

It's a snapshot, not a live overlay: it computes once when you turn it
on, and doesn't recompute as you keep editing - toggle it off and back on
to refresh after making changes. Loading a new file (or a new challenge,
in live mode) automatically turns it off and clears the previous result,
so you never end up looking at overlaps from a dataset that's no longer
loaded. A session that never checks this box doesn't pay any cost for
it existing - nothing related to it is set up until the first time you do.

Checking is all-pairs, but a bounding-box check comes first - actually
computing the precise intersection (`turf.intersect`) only runs for pairs
whose bounding boxes overlap at all, which keeps it fast even with
thousands of areas loaded, since most of them aren't anywhere near each
other.

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
- `PW_PROXY_SERVER` — e.g. `http://127.0.0.1:8080`, if your network needs
  one (omit otherwise)

MapRoulette-facing tests never talk to the real API — they use
Playwright's request interception (`page.route(...)`) to simulate
MapRoulette's responses (a small, hand-built set of synthetic tasks with a
predictable mix of locked/unlocked statuses - see `mrChallengeSampleTasks()`
in `tests/support.js`), so they're deterministic and don't need real
credentials.

## Deploying

The app has no real build step (it's vanilla HTML/JS/CSS with vendored
dependencies), but Netlify still wants a build command and a publish
directory, so `build.js` fills that role — it just copies everything the
site needs (`index.html`, `local.html`/`local.js`, `live.html`/`live.js`,
`style.css`, `manifest.json`, `icons/`, `vendor/`, `sample-data/`, `data/`,
`README.md`) into `dist/`, leaving
dev-only files (`tests/`, `node_modules/`, `build.js`/`package.json`
themselves) out:

```sh
npm run build   # writes dist/
```

**Netlify via GitHub (CI/CD):** a `netlify.toml` at the repo root
tells Netlify everything it needs:

```toml
[build]
  command = "npm run build"
  publish = "dist"
```

Connecting the GitHub repo to a new Netlify site should pick this up
automatically — every push to the connected branch rebuilds and redeploys.
If you'd rather configure it by hand in Netlify's UI instead of relying on
the toml file, the equivalent settings are: **Base directory** left
empty, **Build command** = `npm run build`, **Publish directory** = `dist`.

Netlify's build environment also gets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
(set in `netlify.toml`) so its automatic `npm install` step doesn't waste
time downloading Playwright's browser binaries — they're only needed for
running the test suite locally, never for building or serving the site.

**Cache-busting.** File names here never change between deploys (no
content hashing), so without any cache instructions, a browser (or an
intermediate cache) holding onto a previous deploy's `live.js`/`local.js`
has no reason to ever ask for a fresh copy - `netlify.toml` sends every
file `Cache-Control: no-cache, must-revalidate`. This still allows
caching (`no-cache` despite the name doesn't mean "don't cache" - that's
`no-store`); it just forces a revalidation request on every load, which
Netlify answers with a 304 if nothing changed or the new content if it
did, so it fixes staleness without disabling caching entirely.

**Version tracking.** `build.js` also stamps each build with a short
version string and a build timestamp, written to `dist/version.js`
(`window.__BLOCK_TRIAGE_VERSION__ = { version, builtAt }`) - it prefers
Netlify's own `COMMIT_REF` env var (the exact commit being deployed),
falling back to `git rev-parse --short HEAD` for any other static host,
and "unknown" if neither is available. All three pages load this via a
plain `<script src="version.js">` tag (not `fetch()`, since that can be
blocked for local files) and, if present, use it to set a native tooltip
on the page title - hover it to see which build you're looking at. It's
deliberately not prominent; nothing is shown at all when `version.js`
doesn't exist, which is always the case running the files straight off
disk (dev, or the test suite) rather than through a deploy.

## PWA / Add to Home Screen

`manifest.json` (linked from all three pages, along with a `theme-color`
meta tag and icons) makes this installable as a PWA - on Android, "Add to
Home Screen" (Firefox and Chrome both offer this) creates an icon that
launches the app in its own window with no address bar, instead of a
regular browser tab. `display: standalone` is what triggers that; there's
no service worker, since that's for offline support specifically, which
isn't the goal here - everything still loads over the network exactly as
it does in a normal tab, just without browser chrome around it.

Points at `index.html` (the chooser) as the start_url, and its `scope`
covers the whole site, so navigating from there into `local.html` or
`live.html` stays inside the installed app rather than kicking back out to
a regular browser tab. The icons (`icons/icon-192.png`, `icons/icon-512.png`,
and a third copy marked `purpose: "maskable"` for Android's adaptive icon
shapes - all three are the same design, generated once and just needed at
different sizes/purposes) are plain PNGs checked into the repo, not
generated at build or deploy time.
