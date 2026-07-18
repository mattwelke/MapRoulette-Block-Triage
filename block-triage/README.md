# Block Triage

A small local web app for reviewing a GeoJSON file of area polygons (e.g.
the "blocks" you generate before setting up a MapRoulette challenge) and
marking the ones that have no real work to do — cul-de-sac islands, thin
slivers between divided-highway carriageways, etc. — before you upload
the challenge or feed the areas into your address-import workflow.

It runs entirely in your browser. No build step, no server, no account.

## Which interface?

Opening `index.html` (double-click it, or `open index.html` / drag it into
a browser window) asks which interface you want:

- **Full tool** (`app.html`) — the map-based review workflow described
  below. Best on a laptop/desktop screen.
- **Quick mobile triage** (`mobile.html`) — a phone-friendly one-task-at-a-
  time view for quickly clearing out small junk tasks from a MapRoulette
  challenge: smallest-area tasks first, a big **Delete** and **Next**
  button, and a quick **Undo**. See
  [Quick mobile triage](#quick-mobile-triage) below. It's a separate,
  minimal page — good for bookmarking directly on a phone's home screen if
  you don't want to see the chooser every time.

## Usage (full tool)

1. Open `app.html` (or get there via `index.html`'s chooser).
2. Load some areas to review, one of three ways:
   - Click **Open GeoJSON…** and pick your file (a `FeatureCollection` of
     `Polygon` features — see `sample-data/blocks.geojson` for an example,
     which is real output for Oakville, Ontario).
   - Turn on **Live sync with MapRoulette** (sidebar) and click **Load
     challenge from MapRoulette** — pulls every task straight from the API
     using just a Challenge ID and API key, no file required. See
     [MapRoulette integration](#maproulette-integration) below.
   - To build a GeoJSON from scratch instead of reviewing an existing one,
     click **New (blank)** — this starts an empty session with no source
     file, so **Add new area…** works right away with nothing pre-loaded.
     There's nothing to reload from if you refresh the browser mid-session
     with any of these, so export before you do.
3. The map loads every polygon. Anything smaller than the **small area**
   threshold or below the **skinny (compactness)** threshold is
   automatically flagged orange as a likely candidate to exclude — tune
   both thresholds in the sidebar and the map/list update live.
4. The currently-selected area pulses gently on the map (a soft dark
   highlight fading in and out) so it stays easy to pick out of a dense
   cluster — especially useful right before splitting or deleting
   something you don't want to get wrong.
5. Click a polygon (on the map or in the sidebar list) to select it, then:
   - **Exclude** — mark it to be dropped from the exported file (red)
   - **Keep** — explicitly keep it even if flagged (green)
   - **Reset** — back to unreviewed
   - Keyboard shortcuts once a feature is selected: `x` exclude, `g` keep,
     `r` reset, `j`/`k` next/previous in the current filtered list.
   - `Ctrl+Z` (or the **Undo** button) undoes the last status change —
     whether it came from a popup button, a keyboard shortcut, or an
     accidental quick-exclude click. `Ctrl+Shift+Z` (or **Redo**) reapplies
     it. History is per-file and clears when you load a new file.
6. The sidebar list is sorted smallest-area-first by default, and can be
   filtered to just "Flagged, undecided" so you can plow through the
   likely junk first.
7. Check **Quick exclude mode** (top bar) to skip the popup entirely:
   while it's on, clicking an area on the map immediately marks it
   excluded, and clicking it again undoes that (back to unreviewed).
   This is meant for flying through a cluster of obvious junk quickly;
   sidebar-list clicks still open the review popup regardless of this
   mode, since that's the more deliberate review path. Turn it back off
   to return to the click-then-confirm popup workflow.
8. Click **Export filtered GeoJSON** to download a copy of the original
   file with every *excluded* feature removed. Everything else (kept and
   still-unreviewed features) is preserved as-is.
9. Open a feature's popup and click **Split…** to divide it into two —
   useful when one polygon covers both a legitimate block and something
   like a hydro corridor or a large patch of forest. Click points across
   the area to draw a cut line, then `Enter`, double-click, or the
   **Finish** button to complete it (`Esc` or **Cancel** to back out).
   The cut needs to fully cross the area (past both edges) to produce two
   separate pieces; both come out **unreviewed** so you decide on each
   independently. This is undoable like any other action.
10. Click **Add new area…** (top bar) to draw a brand new polygon from
    scratch — for spots your block-generating code missed entirely. Same
    click-to-add-point / `Enter` or double-click to finish / `Esc` to
    cancel interaction as splitting, just needs 3+ points instead of 2. The
    new area starts **unreviewed** and is included in exports and undo/redo
    like anything else.
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
- **Load challenge from MapRoulette** — pulls every task in the given
  Challenge ID directly from the API (paging through 500 at a time under
  the hood), no GeoJSON file needed at all. Each task's geometry becomes
  an area here, stamped with the same `mr_taskId` / `mr_challengeId` /
  `mr_taskStatus` properties a file exported from MapRoulette would carry
  — so everything downstream (locking already-`Fixed`/`Already Fixed`
  tasks, add/remove, split sync, the delete queue) behaves identically to
  a challenge you'd uploaded as a file. If you already have areas loaded,
  it confirms first, since it replaces what's currently on screen.

**Per-area actions** (only appear while live sync is on) (in the popup, alongside Exclude/Keep/Reset/Split):
a button that reads **Add task to challenge** for an area with no linked
task (freshly drawn, or one you've removed), or **Remove task from
challenge** for one that has one (loaded from a file that had
`mr_taskId`, or created through this UI).

Clicking **Remove task from challenge** doesn't delete anything right
away — it queues the removal (the button flips to **Cancel pending
removal**, and the area gets a red dashed outline so you can see what's
queued on the map and in the list) and nothing is deleted until you
process the queue. This is because MapRoulette's delete endpoint can be
slow, and deleting a batch of areas one popup at a time, waiting on each
request, isn't a great way to work — queue up everything you've decided
on, then let it run in the background. **Process delete queue N** (in
the MapRoulette panel) confirms once for the whole batch, then deletes
them one at a time with a short pause between each so as not to hammer
the API. Whatever succeeds disappears entirely from the map, the list,
the stats, and the in-memory GeoJSON, the same as before — there's
nothing left to review locally once a task is gone from MapRoulette.
Anything that fails stays exactly as it was (unqueued, still linked,
nothing deleted), reported at the end so you know what to retry.

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

**Locked (already-resolved) tasks.** If a loaded feature's `mr_taskStatus`
is `Fixed` or `Already_Fixed`, it's shown grey on the map and treated as
locked — there's nothing structurally left to do with a task someone's
already resolved. Locked areas:
- **Can't** be split, combined, or queued for removal — each of those
  actions shows an explanatory alert instead of doing anything.
- **Can** still be clicked to open the popup (so you can see its status
  at a glance), and Exclude/Keep/Reset still work on them, since those are
  purely local bookkeeping, not actions that touch MapRoulette.
- This applies regardless of whether live sync is on — it's read straight
  from the file's data, not a live lookup, so it's consistent whether
  you're just browsing a file or actively syncing.

**Locked (checked out right now) tasks.** While live sync is on, this tool
also watches for a task currently being checked out on MapRoulette (i.e.
someone's locked it by starting work on it there, or via another API
client) — shown as a distinct brown, separate from the grey of an
already-resolved task, since it's a temporary condition rather than a
permanent one. The same restrictions apply (no split/combine/queue, but
you can still open the popup and use Exclude/Keep/Reset). A few things
worth understanding about how this works:
- Any active lock counts, including one held by the same MapRoulette
  account as the API key configured here — e.g. if you have the task open
  in the MapRoulette site yourself. This is deliberately simple: it just
  checks whether `lockedBy` is set at all, with no "is it me" carve-out.
- MapRoulette's API has no push/webhook mechanism for lock changes, so
  this can only ever be as fresh as the last check — there's no way to
  react the instant a task gets locked. This tool polls in the background
  every ~60 seconds (jittered by a few seconds either way, so multiple
  people running this tool against the same challenge don't all hit the
  API in lockstep) while live sync is on and something's loaded.
- Right before anything that would actually delete a task — processing
  the delete queue, or committing to a split on a task-linked area — it
  does one more on-demand check of just that moment's lock state first,
  since a background poll landing up to a minute earlier isn't good
  enough right at the point something irreversible is about to happen.
  If a queued area turns out to be freshly locked when its turn in the
  queue comes up, it's skipped (not deleted) and called out in the final
  summary rather than silently dropped.
- This is purely a live-sync concept (there's nowhere to store "someone
  has this open right now" in a static GeoJSON file), so it has no effect
  with live sync off, and turning live sync off immediately clears any
  such styling rather than leaving it stale on screen.
- A **"Task lock checks: ..."** line in the MapRoulette panel shows when
  polling last ran and what it found (or that it's paused, and why) -
  since with nobody actively working on anything, the feature can
  otherwise be invisible. It updates every time a check runs, including
  the on-demand rechecks right before a delete.

**Quick queue-delete mode** (checkbox in the MapRoulette panel, only
relevant with live sync on) mirrors **Quick exclude mode** but for the
delete queue: while it's on, clicking an area on the map queues it for
removal (or unqueues it if it's already queued) instead of opening the
popup — handy for quickly working through a run of areas you already
know you want gone. It only applies to map clicks (sidebar-list clicks
still open the popup, same carve-out as quick exclude mode), only queues
areas that are actually linked to a MapRoulette task, and refuses locked
areas with the same explanatory alert as everywhere else. Nothing is
actually deleted until you run **Process delete queue**.

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
- Every request carries a `From: Block Triage - tronnalegacy@pm.me`
  header, so it's identifiable on MapRoulette's end as coming from this
  tool rather than the official site/app.

## Quick mobile triage

`mobile.html` is a separate, minimal page for a specific fast workflow:
clearing small junk tasks out of a MapRoulette challenge one at a time,
from a phone. It has nothing to do with GeoJSON files or the map-review
workflow above — it talks to the MapRoulette API directly.

1. Enter your **API key** and **Challenge ID** and tap **Load smallest
   tasks**. (These are stored the same way as the full tool's, so if
   you're on the same device/browser as an existing session, they're
   already filled in and it loads automatically — the whole point of this
   view is being fast.) Tasks that are already `Fixed`/`Already_Fixed` are
   left out entirely; there's nothing to do with those here.
2. It shows the single smallest-area remaining task, with a small map so
   you can see what you're about to act on, and two big buttons:
   - **Delete** — deletes the task immediately. No confirmation dialog —
     this view is built for speed — but the button starts disabled for
     about a second every time a new task is shown, specifically so a
     fast double-tap or a tap that lands before you've actually looked at
     the new one can't delete the wrong task.
   - **Next** — moves on without deleting anything.
3. After a delete, an **Undo** banner appears for a few seconds. Since a
   deleted MapRoulette task can't be restored as the same task, Undo works
   by recreating a brand new task with the exact same geometry the
   deleted one had (kept in memory just for this purpose) — so a mis-tap
   is a tap away from fixed, not a trip back to the desktop tool. Only the
   single most recent delete is undoable; a second delete replaces it.
4. Reloading the page re-fetches the challenge from scratch (smallest
   first again) — there's no session to resume, by design. It's meant for
   quick bursts of triage, not as a persistent queue.

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

## Testing

The app itself has no dependencies to install — but the test suite
(`tests/`) is written with [Playwright](https://playwright.dev) and drives
the app's HTML files directly as `file://` URLs (mostly `app.html`, plus
`mobile.html` and `index.html` for their own features), the same way
you'd use the app by hand. Install once, then run:

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
Playwright's request interception (`page.route(...)`) against synthetic
fixtures in `tests/fixtures/` (a small hand-built challenge export with a
predictable mix of locked/unlocked tasks) to simulate MapRoulette's
responses, so they're deterministic and don't need real credentials.
