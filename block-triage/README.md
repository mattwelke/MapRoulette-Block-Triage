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
   which is real output for Oakville, Ontario).
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

Your marks are saved to the browser's `localStorage` as you go (keyed to
the loaded file's name/size/feature count), so a refresh won't lose your
progress. Marks for one file don't affect another.

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
