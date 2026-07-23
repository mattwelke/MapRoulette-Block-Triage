(function () {
  "use strict";

  // window.__BLOCK_TRIAGE_VERSION__ comes from version.js, which only exists
  // in a built (dist/) deploy - see build.js. Opening this file straight off
  // disk (dev, or the Playwright tests) has no such script, so this is
  // entirely best-effort: a plain native tooltip on the page title, not
  // meant to be prominent, just there to check if you ever need to know
  // which build you're looking at.
  (function applyVersionTooltip() {
    const info = window.__BLOCK_TRIAGE_VERSION__;
    const titleEl = document.getElementById("app-title");
    if (!info || !titleEl) return;
    const built = new Date(info.builtAt);
    const builtLabel = isNaN(built.getTime()) ? info.builtAt : built.toLocaleString();
    titleEl.title = `Block Triage ${info.version} — built ${builtLabel}`;
  })();

  const COLORS = {
    normal: "#3388ff",
    oversized: "#e64a19",
    undersized: "#fbc02d",
    locked: "#9e9e9e",
    "active-lock": "#6d4c41",
  };

  // Tasks already resolved on MapRoulette - read straight from the loaded
  // data, not a live status. Locked areas can still be clicked to see their
  // status, but not split, combined, or removed - there's nothing left to do
  // with an already-fixed task structurally, and doing so would just create
  // more work for someone re-reviewing it.
  const LOCKED_TASK_STATUSES = new Set(["fixed", "already fixed"]);

  // Marks an area as exempt from the undersized/needs-combine verdict (see
  // category()) - some areas are legitimately small because the underlying
  // density is low, not because anything's wrong with the boundary. Stored
  // as a GeoJSON feature property (underscore-prefixed, like local.js's own
  // _blockTriageStatus) so it round-trips through MapRoulette: included when
  // a task is created (mrCreateTask), read back out of the task's own
  // properties the next time a challenge is loaded (buildEntries).
  const LOW_DENSITY_PROPERTY = "_blockTriageLowDensity";

  function isLockedTaskStatus(rawStatus) {
    if (!rawStatus) return false;
    return LOCKED_TASK_STATUSES.has(String(rawStatus).replace(/_/g, " ").trim().toLowerCase());
  }

  function formatMrTaskStatus(rawStatus) {
    return rawStatus ? String(rawStatus).replace(/_/g, " ") : "unknown";
  }

  // The other reason an area can be locked: its MapRoulette task is
  // currently held open (locked via the site's own "start working" flow, or
  // another API client) - by anyone, including whoever owns the API key
  // configured here. Unlike the status-based lock above, this is only ever
  // known live, and only reflects however stale the last poll/recheck
  // happened to be (MapRoulette's API has no push mechanism for this; see
  // refreshMrLockState below).
  function mrBlockReason(entry) {
    if (entry.mrLocked) {
      return `already "${formatMrTaskStatus(entry.mrTaskStatus)}" and is locked`;
    }
    if (entry.mrActiveLockedBy != null) {
      return `currently checked out on MapRoulette and is locked`;
    }
    return null;
  }

  // Like mrBlockReason, but also blocks other structural actions (combine,
  // edit boundary, quick queue-delete) on a piece that's still part of an
  // unprocessed split group - it might yet be dropped, so it shouldn't be
  // touched by anything else in the meantime. Splitting itself is the one
  // exception - see splitBlockReason - a piece can be split again while
  // its group is still pending, which just folds its own resulting pieces
  // into that same group.
  function structuralBlockReason(entry) {
    if (entry.pendingSplitGroup != null) return "queued for a pending split";
    if (entry.pendingReplace) return "queued for a pending replace";
    if (entry.pendingCombineGroup != null) return "queued for a pending combine";
    return mrBlockReason(entry);
  }

  // Used specifically to gate splitting (queueSplit) - deliberately more
  // permissive than structuralBlockReason: a piece that's already part of
  // a pending split group is still splittable (see queueSplit's nested-
  // split branch), it just can't be combined, edited, or removed while
  // pending.
  function splitBlockReason(entry) {
    if (entry.pendingReplace) return "queued for a pending replace";
    if (entry.pendingCombineGroup != null) return "queued for a pending combine";
    return mrBlockReason(entry);
  }

  // Numeric Task.status codes as returned by GET /challenge/{id}/tasks,
  // mapped to the same underscore-separated strings MapRoulette itself
  // writes into a challenge's mr_taskStatus GeoJSON export.
  const MR_TASK_STATUS_NAMES = {
    0: "Created",
    1: "Fixed",
    2: "Not_An_Issue",
    3: "Skipped",
    4: "Deleted",
    5: "Already_Fixed",
    6: "Too_Hard",
  };

  const MR_API_BASE = "https://maproulette.org/api/v2";
  let mrApiKey = localStorage.getItem("block-triage:mrApiKey") || "";
  let mrChallengeId = localStorage.getItem("block-triage:mrChallengeId") || "";
  /** @type {Set<string>} entry ids queued for MapRoulette task deletion, not yet actually deleted */
  let mrDeleteQueue = new Set();
  // Entry ids queued for MapRoulette task creation, not yet actually created.
  // Every unlinked area (freshly drawn, or a split/combine result) lands
  // here automatically - "Add now" in the popup bypasses this queue for a
  // single area, and this queue exists so a whole batch can be created at
  // once instead of one popup at a time.
  /** @type {Set<string>} */
  let mrAddQueue = new Set();
  // Entry ids with a queued boundary edit (see "Edit boundary…") - the old
  // MapRoulette task will be deleted and a new one created with the edited
  // geometry once processed, since there's no in-place geometry update used
  // here. Only ever populated for areas that were already linked when
  // edited; editing an unlinked area is just a local geometry change.
  /** @type {Set<string>} */
  let mrEditQueue = new Set();
  // Groups queued by a split, keyed by a synthetic group id, mapped to the
  // original's snapshot and the snapshots of its still-live resulting
  // pieces (see queueSplit/dropSplitPiece). The local split already
  // happened by the time a group lands here - only the MapRoulette sync
  // (delete the original's task, create tasks for the pieces) is deferred
  // to processing. Each piece carries entry.pendingSplitGroup, which also
  // blocks other structural actions on it (combine, edit boundary, quick
  // queue-delete, splitting it again) via structuralBlockReason until its
  // group is processed or it's dropped/undone.
  /** @type {Map<string, {originalSnapshot: object, newSnapshots: object[]}>} */
  let splitQueue = new Map();
  // Groups queued by "Replace areas…", keyed by a synthetic group id, mapped
  // to the snapshots of the areas that were replaced and the snapshots of
  // the areas drawn to replace them - unlike split, the local swap (remove
  // originals, add replacements) already happened by the time a group lands
  // here; only the MapRoulette sync (delete the originals' tasks, create
  // tasks for the replacements) is deferred to processing. Each replacement
  // entry carries entry.pendingReplace = true until its group is processed.
  /** @type {Map<string, {originalSnapshots: object[], newSnapshots: object[]}>} */
  let replaceQueue = new Map();
  // Groups queued by "Combine areas…", keyed by a synthetic group id, mapped
  // to the snapshots of the constituent areas that were merged and the
  // single snapshot of the merged result - like split/replace, the local
  // merge already happened by the time a group lands here; only the
  // MapRoulette sync (delete the constituents' tasks, create a task for the
  // merged area) is deferred to processing. The merged entry carries
  // entry.pendingCombineGroup until its group is processed. If none of the
  // constituents were linked, there's nothing to delete - the merged area
  // is queued into mrAddQueue instead (same as a plain new area), and
  // processing this group is a no-op beyond clearing the pending flag.
  /** @type {Map<string, {originalSnapshots: object[], newSnapshot: object}>} */
  let combineQueue = new Map();
  // Raw MapRoulette task ids that still need deleting but have no local
  // entry left to hang a retry off of - split/replace/combine already
  // remove their originals' local entries immediately (before the remote
  // sync runs), so if deleting one of those originals' tasks still fails
  // after mrRequest's own retries are exhausted, there's nothing in
  // `entries` to re-add to mrDeleteQueue. It lands here instead: a plain
  // list of orphaned task ids to keep retrying independent of any area.
  /** @type {Set<number>} */
  let mrOrphanedDeleteQueue = new Set();
  let mrQuickQueueDeleteMode = localStorage.getItem("block-triage:mrQuickQueueDeleteMode") === "true";

  // Caps how many MapRoulette API requests may be in flight at once, across
  // every queue - every queue's own processing loop runs its items
  // concurrently (see runConcurrently below), and "Process all pending" can
  // have several queues going at once on top of that, so this is what
  // actually keeps the combined request rate bounded rather than letting
  // everything hammer the API in parallel with no ceiling.
  let mrMaxConcurrent = loadMrMaxConcurrent();
  let mrActiveRequests = 0;
  const mrSlotWaiters = [];

  function loadMrMaxConcurrent() {
    const stored = Number(localStorage.getItem("block-triage:mrMaxConcurrent"));
    return Number.isInteger(stored) && stored > 0 ? stored : 3;
  }
  function saveMrMaxConcurrent() {
    localStorage.setItem("block-triage:mrMaxConcurrent", String(mrMaxConcurrent));
  }
  // Waking a waiter and incrementing mrActiveRequests always happen together,
  // synchronously, so a burst of wakeups (e.g. raising the limit) can't
  // overshoot the cap while woken waiters are still resuming asynchronously.
  function wakeMrWaitersIfRoom() {
    while (mrActiveRequests < mrMaxConcurrent && mrSlotWaiters.length > 0) {
      mrActiveRequests++;
      mrSlotWaiters.shift()();
    }
  }
  async function acquireMrSlot() {
    if (mrActiveRequests < mrMaxConcurrent) {
      mrActiveRequests++;
      return;
    }
    await new Promise((resolve) => mrSlotWaiters.push(resolve));
  }
  function releaseMrSlot() {
    mrActiveRequests--;
    wakeMrWaitersIfRoom();
  }

  // Runs `worker` over every item in `items`, several at a time instead of
  // one at a time - up to mrMaxConcurrent lanes, each pulling the next item
  // off a shared index as soon as it finishes its current one. The actual
  // HTTP concurrency is enforced independently by acquireMrSlot inside
  // mrRequest regardless of how many lanes call into it at once, but pooling
  // here too means a queue with far more items than mrMaxConcurrent doesn't
  // kick off every item's bookkeeping (mutating shared counters, touching
  // the DOM) in one synchronous burst - work stays spread out the same way
  // the actual requests do.
  async function runConcurrently(items, worker) {
    let nextIndex = 0;
    async function lane() {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await worker(item);
      }
    }
    const laneCount = Math.max(1, Math.min(mrMaxConcurrent, items.length));
    await Promise.all(
      Array.from({ length: laneCount }, () => lane())
    );
  }

  // Background polling for "someone has this task locked" - MapRoulette's API
  // has no push mechanism, so this is the only way to notice. Jittered so
  // that if several people run this tool at once, they don't all hammer the
  // API in lockstep every 60s.
  const MR_LOCK_POLL_BASE_MS = 60000;
  const MR_LOCK_POLL_JITTER_MS = 5000; // vary +/- up to 5s
  let mrLockPollTimer = null;

  /** @type {Map<string, {id:string, idx:number, feature:object, layer:L.Layer, area:number, compactness:number}>} */
  let entries = new Map();
  let orderedIds = []; // insertion order == original feature order
  let selectedId = null;
  // Areas at least 2x this are "oversized" (a split candidate); areas at
  // most half this are "undersized" (a combine candidate) - see category().
  let targetAreaLimit = loadTargetAreaLimit();
  let newFeatureCounter = 0;
  let addedAreaCounter = 0;
  let undoStack = [];
  let redoStack = [];
  /** @type {null | {type: "split"|"add", targetId?: string, points: [number,number][], previewLayer: L.Layer|null, vertexMarkers: L.Layer[]}} */
  let drawState = null;
  /** @type {null | {selectedIds: Set<string>}} */
  let combineState = null;
  /** @type {null | {id: string, vertexMarkers: L.Marker[], previewLayer: L.Layer|null}} */
  let editState = null;
  // "selecting": selectedIds is live and nothing's changed locally yet.
  // "drawing": the selected originals are already removed (originalSnapshots
  // holds their snapshots) and newSnapshots accumulates each replacement
  // area drawn so far via "Add new area…", reused from the normal add flow.
  /** @type {null | {phase: "selecting"|"drawing", selectedIds: Set<string>|null, originalSnapshots: object[], newSnapshots: object[]}} */
  let replaceState = null;

  const map = L.map("map", { preferCanvas: true }).setView([43.45, -79.68], 12);
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const esriImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "Tiles &copy; Esri" }
  );
  const oakvilleAddresses = L.tileLayer(
    "https://skfd.github.io/oakville-address-layer/tiles/raster/{z}/{x}/{y}.png",
    { maxZoom: 20, attribution: "Oakville address layer by skfd" }
  );
  // Purely visual: holds whatever the user loads via "Load reference layer...".
  // Never interactive, never part of entries/undo - just context to look at
  // (e.g. a local GeoJSON of building footprints) while editing the live
  // MapRoulette challenge.
  const referenceLayerGroup = L.layerGroup();
  L.control
    .layers(
      { "OpenStreetMap": osm, "Aerial (Esri)": esriImagery },
      { "Oakville addresses (skfd)": oakvilleAddresses, "Reference layer": referenceLayerGroup }
    )
    .addTo(map);

  // Draggable handle used for each vertex while editing an area's boundary
  // (see "Edit boundary…") - a plain divIcon rather than Leaflet's default
  // pin image, to match this app's dot-based visual language elsewhere.
  const EDIT_VERTEX_ICON = L.divIcon({ className: "edit-vertex-icon", iconSize: [14, 14], iconAnchor: [7, 7] });

  // The working areas use the canvas renderer (set via preferCanvas above, for
  // performance with thousands of features), but canvas can't do SVG pattern
  // fills. The reference layer's inner-border band needs one, so it gets its
  // own dedicated SVG renderer.
  const referenceRenderer = L.svg().addTo(map);
  const REFERENCE_COLOR = "#00acc1";
  const REFERENCE_PATTERN_ID = "reference-tessellate-pattern";
  (function injectReferencePattern() {
    const svgEl = map.getPane("overlayPane").querySelector("svg");
    const svgNS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(svgNS, "defs");
    const pattern = document.createElementNS(svgNS, "pattern");
    pattern.setAttribute("id", REFERENCE_PATTERN_ID);
    pattern.setAttribute("width", "4");
    pattern.setAttribute("height", "4");
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("patternTransform", "rotate(45)");
    [
      [0, 0],
      [2, 2],
    ].forEach(([x, y]) => {
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", "2");
      rect.setAttribute("height", "2");
      rect.setAttribute("fill", REFERENCE_COLOR);
      pattern.appendChild(rect);
    });
    defs.appendChild(pattern);
    svgEl.appendChild(defs);
  })();
  map.on("zoomend", () => updateBandVisibility());

  // The currently-selected area gets a pulsing highlight - see local.js for
  // the full rationale (identical mechanism here).
  const selectionRenderer = L.svg().addTo(map);
  let selectionPulseLayer = null;

  function updateSelectionPulse() {
    if (selectionPulseLayer) {
      map.removeLayer(selectionPulseLayer);
      selectionPulseLayer = null;
    }
    const entry = selectedId ? entries.get(selectedId) : null;
    if (!entry) return;

    selectionPulseLayer = L.geoJSON(entry.feature, {
      interactive: false,
      renderer: selectionRenderer,
      className: "selection-pulse",
      style: { color: "#000", weight: 3, fillColor: "#000", fillOpacity: 0.35 },
    }).addTo(map);
  }

  // Highlights areas that geometrically overlap each other - usually a
  // data-quality problem (two areas covering the same ground), and easy to
  // miss just eyeballing the map. Off by default, and not kept live as you
  // edit - toggling it off and back on recomputes from scratch, which is
  // simple and avoids re-running this on every single edit.
  //
  // The renderer itself is created lazily, on first use, rather than eagerly
  // at load - an L.SVG/L.Renderer registers with the map and gets its
  // transform recalculated on every pan/zoom for as long as it's attached,
  // even with nothing drawn on it. A session that never checks this box
  // shouldn't pay any part of that cost.
  let overlapRenderer = null;
  const OVERLAP_COLOR = "#e91e63"; // not used anywhere else in this app's palette
  let overlapLayerGroup = null;

  // Bounding-box pre-filter before the expensive exact intersection check -
  // same reasoning as elsewhere in this app: with thousands of areas, an
  // all-pairs bbox comparison (cheap) is fine, but running turf.intersect
  // on every pair would not be.
  function computeOverlapFeatures() {
    const items = Array.from(entries.values());
    const bboxes = items.map((e) => turf.bbox(e.feature));
    const overlaps = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = bboxes[i];
        const b = bboxes[j];
        if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) continue; // bounding boxes don't even overlap
        let inter;
        try {
          inter = turf.intersect(turf.featureCollection([items[i].feature, items[j].feature]));
        } catch (err) {
          continue; // topology error on this pair - skip it rather than fail the whole check
        }
        if (inter && turf.area(inter) > 1) overlaps.push(inter); // >1 m² - ignore floating-point slivers
      }
    }
    return overlaps;
  }

  function showOverlaps() {
    hideOverlaps();
    if (!overlapRenderer) overlapRenderer = L.svg().addTo(map);
    const overlapFeatures = computeOverlapFeatures();
    overlapLayerGroup = L.geoJSON(turf.featureCollection(overlapFeatures), {
      interactive: false,
      renderer: overlapRenderer,
      style: { color: OVERLAP_COLOR, weight: 2, fillColor: OVERLAP_COLOR, fillOpacity: 0.6 },
    }).addTo(map);
    overlapStatusEl.textContent =
      overlapFeatures.length === 0
        ? "No overlaps found."
        : `${overlapFeatures.length} overlapping area${overlapFeatures.length === 1 ? "" : "s"} found.`;
  }

  function hideOverlaps() {
    if (overlapLayerGroup) {
      map.removeLayer(overlapLayerGroup);
      overlapLayerGroup = null;
    }
    overlapStatusEl.textContent = "";
  }

  const statsEl = document.getElementById("stats");
  const featureListEl = document.getElementById("feature-list");
  const targetAreaLimitInput = document.getElementById("target-area-limit");
  const appEl = document.getElementById("app");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const addAreaBtn = document.getElementById("add-area-btn");
  const combineAreaBtn = document.getElementById("combine-area-btn");
  const replaceAreaBtn = document.getElementById("replace-area-btn");
  const drawStatusEl = document.getElementById("draw-status");
  const drawStatusText = document.getElementById("draw-status-text");
  const drawFinishBtn = document.getElementById("draw-finish-btn");
  const drawCancelBtn = document.getElementById("draw-cancel-btn");
  const referenceFileInput = document.getElementById("reference-file-input");
  const referenceFileNameEl = document.getElementById("reference-file-name");
  const clearReferenceBtn = document.getElementById("clear-reference-btn");
  const tabletPanelEl = document.getElementById("tablet-panel");
  const tabletPanelCloseBtn = document.getElementById("tablet-panel-close");
  const tabletPanelContentEl = document.getElementById("tablet-panel-content");
  const highlightOverlapsCheckbox = document.getElementById("highlight-overlaps-checkbox");
  const overlapStatusEl = document.getElementById("overlap-status");

  highlightOverlapsCheckbox.addEventListener("change", () => {
    if (highlightOverlapsCheckbox.checked) showOverlaps();
    else hideOverlaps();
  });

  // Matches the tablet range in style.css - on these viewports, an area's
  // popup content is shown in the fixed #tablet-panel (right edge,
  // vertically centered, thumb-reachable in landscape) instead of a
  // Leaflet popup anchored to the tapped spot.
  function isTabletViewport() {
    return window.matchMedia("(min-width: 600px) and (max-width: 1366px)").matches;
  }

  function showTabletPanel(contentEl) {
    tabletPanelContentEl.innerHTML = "";
    tabletPanelContentEl.appendChild(contentEl);
    tabletPanelEl.hidden = false;
  }

  function hideTabletPanel() {
    tabletPanelEl.hidden = true;
    tabletPanelContentEl.innerHTML = "";
  }

  // Every call site that used to open a Leaflet popup should go through
  // this instead, so tablet viewports transparently get the fixed panel.
  function presentPopup(entry, div) {
    if (isTabletViewport()) {
      showTabletPanel(div);
      return;
    }
    const center = entry.layer.getBounds().getCenter();
    L.popup().setLatLng(center).setContent(div).openOn(map);
  }

  // Closes whichever presentation (Leaflet popup or tablet panel) is
  // currently showing - closePopup() is a harmless no-op if none is open.
  function closeAnyPopup() {
    map.closePopup();
    hideTabletPanel();
  }

  tabletPanelCloseBtn.addEventListener("click", closeAnyPopup);
  map.on("click", () => {
    // Feature clicks stop propagation before reaching here (see
    // attachLayer), so this only ever fires for a genuine click on empty
    // map background.
    if (isTabletViewport()) hideTabletPanel();
  });

  const mrApiKeyInput = document.getElementById("mr-api-key-input");
  const mrApiKeyClearBtn = document.getElementById("mr-api-key-clear-btn");
  const mrChallengeIdInput = document.getElementById("mr-challenge-id-input");
  const mrTestBtn = document.getElementById("mr-test-btn");
  const mrStatusEl = document.getElementById("mr-status");
  const mrLoadChallengeBtn = document.getElementById("mr-load-challenge-btn");
  const mrLoadStatusEl = document.getElementById("mr-load-status");
  const mrLockPollStatusEl = document.getElementById("mr-lock-poll-status");
  const mrLiveBannerChallenge = document.getElementById("mr-live-banner-challenge");
  const mrQueueBtn = document.getElementById("mr-queue-btn");
  const mrQueueStatusEl = document.getElementById("mr-queue-status");
  const mrAddQueueBtn = document.getElementById("mr-add-queue-btn");
  const mrAddQueueStatusEl = document.getElementById("mr-add-queue-status");
  const mrEditQueueBtn = document.getElementById("mr-edit-queue-btn");
  const mrEditQueueStatusEl = document.getElementById("mr-edit-queue-status");
  const mrSplitQueueBtn = document.getElementById("mr-split-queue-btn");
  const mrSplitQueueStatusEl = document.getElementById("mr-split-queue-status");
  const mrReplaceQueueBtn = document.getElementById("mr-replace-queue-btn");
  const mrReplaceQueueStatusEl = document.getElementById("mr-replace-queue-status");
  const mrCombineQueueBtn = document.getElementById("mr-combine-queue-btn");
  const mrCombineQueueStatusEl = document.getElementById("mr-combine-queue-status");
  const mrOrphanedDeleteQueueBtn = document.getElementById("mr-orphaned-delete-queue-btn");
  const mrOrphanedDeleteQueueStatusEl = document.getElementById("mr-orphaned-delete-queue-status");
  const mrProcessAllBtn = document.getElementById("mr-process-all-btn");
  const mrProcessAllStatusEl = document.getElementById("mr-process-all-status");
  const mrQuickQueueCheckbox = document.getElementById("mr-quick-queue-checkbox");
  const mrMaxConcurrentInput = document.getElementById("mr-max-concurrent-input");

  mrApiKeyInput.value = mrApiKey;
  mrChallengeIdInput.value = mrChallengeId;
  updateMrBanner();
  updateMrQueueButton();
  updateMrAddQueueButton();
  updateMrEditQueueButton();
  updateSplitQueueButton();
  updateReplaceQueueButton();
  updateCombineQueueButton();
  updateOrphanedDeleteQueueButton();
  scheduleMrLockPoll();
  mrQueueBtn.addEventListener("click", processMrDeleteQueue);
  mrAddQueueBtn.addEventListener("click", processMrAddQueue);
  mrEditQueueBtn.addEventListener("click", processMrEditQueue);
  mrSplitQueueBtn.addEventListener("click", processSplitQueue);
  mrReplaceQueueBtn.addEventListener("click", processReplaceQueue);
  mrCombineQueueBtn.addEventListener("click", processCombineQueue);
  mrOrphanedDeleteQueueBtn.addEventListener("click", processOrphanedDeleteQueue);
  mrProcessAllBtn.addEventListener("click", processAllQueues);

  mrApiKeyInput.addEventListener("change", () => {
    mrApiKey = mrApiKeyInput.value.trim();
    localStorage.setItem("block-triage:mrApiKey", mrApiKey);
  });
  mrApiKeyClearBtn.addEventListener("click", () => {
    mrApiKey = "";
    mrApiKeyInput.value = "";
    localStorage.removeItem("block-triage:mrApiKey");
    mrStatusEl.textContent = "";
    mrStatusEl.className = "muted";
  });
  mrChallengeIdInput.addEventListener("change", () => {
    mrChallengeId = mrChallengeIdInput.value.trim();
    localStorage.setItem("block-triage:mrChallengeId", mrChallengeId);
    updateMrBanner();
    kickMrLockPoll();
  });
  mrTestBtn.addEventListener("click", mrTestConnection);
  mrLoadChallengeBtn.addEventListener("click", loadChallengeFromMapRoulette);

  mrQuickQueueCheckbox.checked = mrQuickQueueDeleteMode;
  appEl.classList.toggle("mr-quick-queue-active", mrQuickQueueDeleteMode);
  mrQuickQueueCheckbox.addEventListener("change", () => {
    mrQuickQueueDeleteMode = mrQuickQueueCheckbox.checked;
    localStorage.setItem("block-triage:mrQuickQueueDeleteMode", String(mrQuickQueueDeleteMode));
    appEl.classList.toggle("mr-quick-queue-active", mrQuickQueueDeleteMode);
  });

  mrMaxConcurrentInput.value = mrMaxConcurrent;
  mrMaxConcurrentInput.addEventListener("change", () => {
    const n = Math.floor(Number(mrMaxConcurrentInput.value));
    mrMaxConcurrent = Number.isInteger(n) && n > 0 ? n : 3;
    mrMaxConcurrentInput.value = mrMaxConcurrent;
    saveMrMaxConcurrent();
    wakeMrWaitersIfRoom(); // a waiter blocked under the old, lower cap may now fit
  });

  targetAreaLimitInput.value = targetAreaLimit;

  referenceFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadReferenceLayer(file);
  });
  clearReferenceBtn.addEventListener("click", clearReferenceLayer);

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  addAreaBtn.addEventListener("click", () => {
    if (drawState) cancelDrawing();
    else startDrawing("add", null);
  });
  combineAreaBtn.addEventListener("click", () => {
    if (combineState) cancelCombine();
    else startCombine();
  });
  replaceAreaBtn.addEventListener("click", () => {
    if (replaceState) cancelReplace();
    else startReplace();
  });
  drawFinishBtn.addEventListener("click", () => {
    if (drawState) finishDrawing();
    else if (combineState) finishCombine();
    else if (editState) finishEditBoundary();
    else if (replaceState) {
      if (replaceState.phase === "selecting") finishReplaceSelection();
      else finishReplace();
    }
  });
  drawCancelBtn.addEventListener("click", () => {
    if (drawState) cancelDrawing();
    else if (combineState) cancelCombine();
    else if (editState) cancelEditBoundary();
    else if (replaceState) cancelReplace();
  });

  targetAreaLimitInput.addEventListener("input", () => {
    targetAreaLimit = Number(targetAreaLimitInput.value) || 5000;
    saveTargetAreaLimit();
    recomputeCategoriesAndRender();
  });

  document.querySelectorAll('input[name="filter"]').forEach((el) => {
    el.addEventListener("change", renderList);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;

    if (drawState) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishDrawing();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelDrawing();
      }
      return;
    }

    if (combineState) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishCombine();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelCombine();
      }
      return;
    }

    if (editState) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishEditBoundary();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditBoundary();
      }
      return;
    }

    if (replaceState) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (replaceState.phase === "selecting") finishReplaceSelection();
        else finishReplace();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelReplace();
      }
      return;
    }

    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if (!selectedId) return;
    if (e.key === "j") selectRelative(1);
    else if (e.key === "k") selectRelative(-1);
  });

  function loadTargetAreaLimit() {
    const stored = Number(localStorage.getItem("block-triage:targetAreaLimit"));
    return Number.isFinite(stored) && stored > 0 ? stored : 5000;
  }

  function saveTargetAreaLimit() {
    localStorage.setItem("block-triage:targetAreaLimit", String(targetAreaLimit));
  }

  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  function updateMrBanner() {
    mrLiveBannerChallenge.textContent = mrChallengeId || "(no challenge ID set)";
  }

  function updateMrQueueButton() {
    mrQueueBtn.textContent = `Process delete queue (${mrDeleteQueue.size})`;
    mrQueueBtn.disabled = mrDeleteQueue.size === 0;
    updateProcessAllButton();
  }

  // Reflects the combined size of every queue - add/delete/edit/split - so
  // "Process all pending" can be clicked once instead of hunting down each
  // queue's own button individually.
  function updateProcessAllButton() {
    const total =
      mrDeleteQueue.size +
      mrAddQueue.size +
      mrEditQueue.size +
      splitQueue.size +
      replaceQueue.size +
      combineQueue.size +
      mrOrphanedDeleteQueue.size;
    mrProcessAllBtn.textContent = `Process all pending (${total})`;
    mrProcessAllBtn.disabled = total === 0;
  }

  // Runs every queue's own processing function in turn - each starts right
  // away with no confirm dialog, processing its own items concurrently
  // internally (see runConcurrently), so this is mostly a convenience that
  // saves clicking each queue's button separately. Queue
  // *types* still run one after another rather than overlapping each other:
  // an entry could in principle be referenced by more than one queue at once
  // (e.g. queued for boundary-edit and also picked up by a bulk quick-delete
  // click), and overlapping two queues that might touch the same entry's
  // remote task risks a race that a single global request semaphore alone
  // wouldn't prevent.
  async function processAllQueues() {
    mrProcessAllBtn.disabled = true;
    mrProcessAllStatusEl.textContent = "Processing every queue below…";
    await processMrAddQueue();
    await processMrDeleteQueue();
    await processMrEditQueue();
    await processSplitQueue();
    await processReplaceQueue();
    await processCombineQueue();
    await processOrphanedDeleteQueue();
    updateProcessAllButton();
    mrProcessAllStatusEl.textContent = "Done — see each queue's own status below for details.";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Mirrors a quick-exclude-style click-to-toggle interaction, but for the
  // delete queue: a quick way to mark a whole run of already-resolved-looking
  // areas for removal while triaging, without opening a popup for each one.
  // Only ever queues - actual deletion still requires "Process delete queue".
  function toggleQuickQueueDelete(entry) {
    const blockReason = structuralBlockReason(entry);
    if (blockReason) {
      alert(`This area's MapRoulette task is ${blockReason} - it can't be queued for deletion.`);
      return;
    }
    if (!entry.mrTaskId) {
      alert("This area isn't linked to a MapRoulette task yet, so there's nothing to queue for deletion.");
      return;
    }
    if (mrDeleteQueue.has(entry.id)) mrDeleteQueue.delete(entry.id);
    else mrDeleteQueue.add(entry.id);
    entry.layer.setStyle(styleFor(entry));
    updateMrQueueButton();
    renderList();
  }

  async function processMrDeleteQueue() {
    const ids = Array.from(mrDeleteQueue);
    if (ids.length === 0) return;

    mrQueueBtn.disabled = true;
    // One recheck for the whole batch rather than one per item - the queue
    // may have sat around a while, and someone could have picked up one of
    // these tasks in the meantime; best-effort if it fails, since each
    // delete attempt itself is still the final word either way.
    try {
      await refreshMrLockState();
    } catch (err) {
      // ignore - fall through with whatever lock state we already had
    }

    let done = 0;
    let failed = 0;
    let skippedLocked = 0;
    await runConcurrently(ids, async (id) => {
      mrDeleteQueue.delete(id);
      const entry = entries.get(id);
      if (!entry || !entry.mrTaskId) {
        done++;
        return; // already gone or unlinked by some other means in the meantime
      }

      const blockReason = mrBlockReason(entry);
      if (blockReason) {
        done++;
        skippedLocked++;
        mrQueueStatusEl.textContent = `Skipped task ${entry.mrTaskId} (${done} of ${ids.length}): ${blockReason}.`;
        entry.layer.setStyle(styleFor(entry)); // drop the "queued" look, it's back to just linked
        updateStats();
        renderList();
        return;
      }

      mrQueueStatusEl.textContent = `Deleting task ${entry.mrTaskId}… (${done} of ${ids.length} done so far)`;
      try {
        await mrDeleteTask(entry.mrTaskId);
        removeEntry(entry.id);
      } catch (err) {
        failed++;
        mrDeleteQueue.add(id); // retries here are already exhausted - stays queued for the next pass instead of getting silently dropped
        entry.layer.setStyle(styleFor(entry));
      }
      done++;
      updateStats();
      renderList();
    });
    const deleted = done - failed - skippedLocked;
    const parts = [`deleted ${deleted} of ${done}`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skippedLocked > 0) parts.push(`${skippedLocked} skipped (now locked)`);
    mrQueueStatusEl.textContent =
      failed === 0 && skippedLocked === 0
        ? `Done — deleted ${deleted} task${deleted === 1 ? "" : "s"}.`
        : `Done — ${parts.join(", ")}; anything that failed is still queued to retry next time you process this queue.`;
    updateMrQueueButton();
  }

  function updateMrAddQueueButton() {
    mrAddQueueBtn.textContent = `Process add queue (${mrAddQueue.size})`;
    mrAddQueueBtn.disabled = mrAddQueue.size === 0;
    updateProcessAllButton();
  }

  // Creates every still-queued, still-unlinked area as a new MapRoulette
  // task, several at a time (see runConcurrently).
  async function processMrAddQueue() {
    const ids = Array.from(mrAddQueue);
    if (ids.length === 0) return;

    mrAddQueueBtn.disabled = true;
    let done = 0;
    let failed = 0;
    await runConcurrently(ids, async (id) => {
      mrAddQueue.delete(id);
      const entry = entries.get(id);
      if (!entry || entry.mrTaskId) {
        done++;
        return; // already linked or gone by some other means in the meantime
      }

      mrAddQueueStatusEl.textContent = `Adding… (${done} of ${ids.length} done so far)`;
      try {
        const created = await mrCreateTask(entry.feature, entry.lowDensity);
        entry.mrTaskId = created.id;
        entry.layer.setStyle(styleFor(entry));
      } catch (err) {
        failed++;
        mrAddQueue.add(id); // retries here are already exhausted - stays queued for the next pass
      }
      done++;
      renderList();
    });
    const added = done - failed;
    mrAddQueueStatusEl.textContent =
      failed === 0
        ? `Done — added ${added} task${added === 1 ? "" : "s"}.`
        : `Done — added ${added} of ${done}; ${failed} failed and ${failed === 1 ? "is" : "are"} still queued to retry next time.`;
    updateMrAddQueueButton();
  }

  function updateMrEditQueueButton() {
    mrEditQueueBtn.textContent = `Process boundary-edit queue (${mrEditQueue.size})`;
    mrEditQueueBtn.disabled = mrEditQueue.size === 0;
    updateProcessAllButton();
  }

  // Applies every queued boundary edit to MapRoulette: since there's no
  // in-place geometry update used here, this deletes the old task and
  // creates a fresh one with the edited shape - the same mechanic doSplit
  // already uses for a linked area, just batched (several at a time, see
  // runConcurrently) instead of happening immediately.
  async function processMrEditQueue() {
    const ids = Array.from(mrEditQueue);
    if (ids.length === 0) return;

    mrEditQueueBtn.disabled = true;
    // One recheck for the whole batch rather than one per item - same
    // reasoning as the delete queue.
    try {
      await refreshMrLockState();
    } catch (err) {
      // ignore - fall through with whatever lock state we already had
    }

    let done = 0;
    let failed = 0;
    let skippedLocked = 0;
    await runConcurrently(ids, async (id) => {
      mrEditQueue.delete(id);
      const entry = entries.get(id);
      if (!entry || !entry.mrTaskId) {
        done++;
        return; // gone, or somehow unlinked by some other means in the meantime
      }

      const blockReason = mrBlockReason(entry);
      if (blockReason) {
        done++;
        skippedLocked++;
        mrEditQueueStatusEl.textContent = `Skipped task ${entry.mrTaskId} (${done} of ${ids.length}): ${blockReason}.`;
        renderList();
        return;
      }

      const oldTaskId = entry.mrTaskId;
      mrEditQueueStatusEl.textContent = `Updating task ${oldTaskId}… (${done} of ${ids.length} done so far)`;
      try {
        await mrDeleteTask(oldTaskId);
      } catch (err) {
        done++;
        failed++;
        mrEditQueueStatusEl.textContent = `Failed to remove the old task ${oldTaskId} (${done} of ${ids.length}): ${err.message}. Left queued to retry.`;
        mrEditQueue.add(id); // nothing changed remotely yet - keep it queued
        renderList();
        return;
      }
      entry.mrTaskId = null; // the old task is gone remotely regardless of what happens next
      try {
        const created = await mrCreateTask(entry.feature, entry.lowDensity);
        entry.mrTaskId = created.id;
      } catch (err) {
        done++;
        failed++;
        mrAddQueue.add(id); // old task is really gone - queue the new shape for adding instead of leaving it to a manual click
        mrEditQueueStatusEl.textContent = `Old task ${oldTaskId} removed, but creating its replacement failed (${done} of ${ids.length}): ${err.message}. Queued for adding to retry.`;
        entry.layer.setStyle(styleFor(entry));
        updateMrAddQueueButton();
        renderList();
        return;
      }
      done++;
      entry.layer.setStyle(styleFor(entry));
      renderList();
    });
    const updated = done - failed - skippedLocked;
    const parts = [`updated ${updated} of ${done}`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skippedLocked > 0) parts.push(`${skippedLocked} skipped (now locked)`);
    mrEditQueueStatusEl.textContent =
      failed === 0 && skippedLocked === 0
        ? `Done — updated ${updated} task${updated === 1 ? "" : "s"}.`
        : `Done — ${parts.join(", ")}.`;
    updateMrEditQueueButton();
  }

  function parseMrTaskId(feature) {
    const raw = feature.properties && feature.properties.mr_taskId;
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // --- MapRoulette API ---

  async function mrRequestOnce(path, options) {
    const res = await fetch(MR_API_BASE + path, {
      ...options,
      headers: Object.assign(
        { apiKey: mrApiKey, "Content-Type": "application/json", From: "Block Triage - tronnalegacy@pm.me" },
        (options && options.headers) || {}
      ),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch (err) {
        // ignore - use status text below
      }
      const err = new Error(`MapRoulette API ${res.status}: ${detail || res.statusText}`);
      // 429 (rate limited) and 5xx (server trouble) are worth retrying; a 4xx
      // otherwise means the request itself is wrong (bad auth, not found,
      // conflict, ...) and retrying it will just fail the same way again.
      err.mrRetryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      throw err;
    }
    if (res.status === 204 || res.status === 304) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const MR_MAX_ATTEMPTS = 3; // the initial attempt plus up to 2 retries
  const MR_RETRY_BASE_DELAY_MS = 600;

  // Retries a request a couple of times with a short, linearly-increasing
  // delay before giving up, so a momentary blip (network hiccup, a 502, a
  // 429) doesn't immediately surface as a failure to every queue that calls
  // this - they only see an error once retrying here has already been
  // exhausted, at which point it's their job to decide whether to re-queue.
  async function mrRequest(path, options) {
    if (!mrApiKey) throw new Error("Set your MapRoulette API key first.");
    await acquireMrSlot();
    try {
      for (let attempt = 1; attempt <= MR_MAX_ATTEMPTS; attempt++) {
        try {
          return await mrRequestOnce(path, options);
        } catch (err) {
          // A thrown error with no .mrRetryable is a network-level failure
          // (offline, DNS, CORS) rather than a real response - also worth
          // retrying, so it defaults to retryable.
          const retryable = err.mrRetryable !== false;
          if (attempt === MR_MAX_ATTEMPTS || !retryable) throw err;
          await sleep(MR_RETRY_BASE_DELAY_MS * attempt);
        }
      }
    } finally {
      releaseMrSlot();
    }
  }

  async function mrTestConnection() {
    mrStatusEl.textContent = "Testing…";
    mrStatusEl.className = "muted";
    try {
      const user = await mrRequest("/user/whoami");
      const name = (user && user.osmProfile && user.osmProfile.displayName) || "unknown user";
      mrStatusEl.textContent = `Connected as ${name}.`;
      mrStatusEl.className = "mr-success";
    } catch (err) {
      mrStatusEl.textContent = "Connection failed: " + err.message;
      mrStatusEl.className = "mr-error";
    }
  }

  async function mrCreateTask(feature, lowDensity) {
    if (!mrChallengeId) throw new Error("Set a Challenge ID first.");
    const properties = lowDensity ? { [LOW_DENSITY_PROPERTY]: true } : {};
    const body = {
      name: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parent: Number(mrChallengeId),
      geometries: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: feature.geometry, properties }],
      },
    };
    return mrRequest("/task", { method: "POST", body: JSON.stringify(body) });
  }

  function mrDeleteTask(taskId) {
    return mrRequest(`/task/${taskId}`, { method: "DELETE" });
  }

  const MR_TASKS_PAGE_SIZE = 500;

  async function mrFetchAllChallengeTasks(challengeId, onProgress) {
    const tasks = [];
    let page = 0;
    for (;;) {
      const batch = await mrRequest(`/challenge/${encodeURIComponent(challengeId)}/tasks?limit=${MR_TASKS_PAGE_SIZE}&page=${page}`);
      const items = Array.isArray(batch) ? batch : [];
      tasks.push(...items);
      if (onProgress) onProgress(tasks.length);
      if (items.length < MR_TASKS_PAGE_SIZE) break;
      page++;
    }
    return tasks;
  }

  // Each Task's `geometries` is its own little FeatureCollection (usually
  // one polygon, but the API allows more) - flatten every task's feature(s)
  // into one challenge-wide FeatureCollection, stamping on the same
  // mr_taskId/mr_challengeId/mr_taskStatus properties a file exported
  // straight from MapRoulette would carry.
  function mrTasksToFeatureCollection(tasks, challengeId) {
    const features = [];
    tasks.forEach((task) => {
      const taskFeatures = task.geometries && Array.isArray(task.geometries.features) ? task.geometries.features : [];
      taskFeatures.forEach((f) => {
        if (!f.geometry) return;
        features.push({
          type: "Feature",
          geometry: f.geometry,
          properties: Object.assign({}, f.properties, {
            mr_taskId: String(task.id),
            mr_challengeId: String(challengeId),
            mr_taskStatus: MR_TASK_STATUS_NAMES[task.status] || null,
          }),
        });
      });
    });
    return { type: "FeatureCollection", name: `maproulette-challenge-${challengeId}`, features };
  }

  async function loadChallengeFromMapRoulette() {
    if (!mrApiKey) {
      mrLoadStatusEl.textContent = "Set your MapRoulette API key first.";
      mrLoadStatusEl.className = "mr-error";
      return;
    }
    if (!mrChallengeId) {
      mrLoadStatusEl.textContent = "Set a Challenge ID first.";
      mrLoadStatusEl.className = "mr-error";
      return;
    }
    if (entries.size > 0) {
      const ok = confirm(
        "Load this challenge from MapRoulette? This replaces the areas currently loaded."
      );
      if (!ok) return;
    }

    mrLoadChallengeBtn.disabled = true;
    mrLoadStatusEl.className = "muted";
    mrLoadStatusEl.textContent = "Loading tasks…";
    try {
      const tasks = await mrFetchAllChallengeTasks(mrChallengeId, (n) => {
        mrLoadStatusEl.textContent = `Loading tasks… ${n} so far…`;
      });
      const parsed = mrTasksToFeatureCollection(tasks, mrChallengeId);
      buildEntries(parsed);
      renderMapLayers();
      recomputeCategoriesAndRender();
      addAreaBtn.disabled = false;
      combineAreaBtn.disabled = false;
      replaceAreaBtn.disabled = false;
      updateMrBanner();
      kickMrLockPoll();
      mrLoadStatusEl.textContent = `Loaded ${parsed.features.length} task area${parsed.features.length === 1 ? "" : "s"} from challenge ${mrChallengeId}.`;
      mrLoadStatusEl.className = "mr-success";
    } catch (err) {
      mrLoadStatusEl.textContent = "Failed to load challenge: " + err.message;
      mrLoadStatusEl.className = "mr-error";
    } finally {
      mrLoadChallengeBtn.disabled = false;
    }
  }

  // --- MapRoulette task locks (someone actively working on a task) ---
  //
  // There's no push/webhook mechanism in MapRoulette's API for this, so the
  // only option is polling. GET /challenge/{id}/tasks (used above) doesn't
  // carry lock info at all - it only shows up on the lighter-weight
  // taskMarkers endpoint, which conveniently covers the whole challenge in
  // one call.

  function setMrLockPollStatus(text, cls) {
    if (!mrLockPollStatusEl) return;
    mrLockPollStatusEl.textContent = text;
    mrLockPollStatusEl.className = cls || "muted";
  }

  async function refreshMrLockState() {
    if (!mrApiKey || !mrChallengeId) return;
    setMrLockPollStatus("Checking for locked tasks…");
    try {
      const data = await mrRequest(`/challenge/${encodeURIComponent(mrChallengeId)}/taskMarkers`);
      const markers = [];
      if (data && Array.isArray(data.markers)) markers.push(...data.markers);
      if (data && Array.isArray(data.overlaps)) {
        data.overlaps.forEach((o) => {
          if (o && Array.isArray(o.tasks)) markers.push(...o.tasks);
        });
      }
      const lockedByTaskId = new Map();
      markers.forEach((m) => {
        if (m && m.id != null) lockedByTaskId.set(m.id, m.lockedBy != null ? m.lockedBy : null);
      });

      let changed = false;
      let activeLockCount = 0;
      entries.forEach((entry) => {
        if (entry.mrTaskId == null) return;
        const activeLockedBy = lockedByTaskId.has(entry.mrTaskId) ? lockedByTaskId.get(entry.mrTaskId) : null;
        if (activeLockedBy != null) activeLockCount++;
        if (entry.mrActiveLockedBy !== activeLockedBy) {
          entry.mrActiveLockedBy = activeLockedBy;
          if (entry.layer) entry.layer.setStyle(styleFor(entry));
          changed = true;
        }
      });
      if (changed) renderList();

      // Multiple things can independently trigger a refresh (a poll, a
      // recheck-before-delete, the challenge ID field's own change event
      // re-firing on blur, etc), so by the time this particular call
      // resolves, the challenge/data could've been cleared in the meantime.
      // Don't clobber the "paused" message with a stale result in that case
      // - the data merge above is still harmless to keep, but the status
      // line should reflect current reality.
      if (mrLockPollEligible()) {
        setMrLockPollStatus(
          `Last checked ${new Date().toLocaleTimeString()}\n` +
            (activeLockCount > 0
              ? `${activeLockCount} task${activeLockCount === 1 ? "" : "s"} currently checked out on MapRoulette.`
              : `no tasks currently checked out on MapRoulette.`)
        );
      }
    } catch (err) {
      if (mrLockPollEligible()) {
        setMrLockPollStatus(`Lock check failed: ${err.message} (will retry)`, "mr-error");
      }
      throw err;
    }
  }

  function mrLockPollEligible() {
    return !!mrChallengeId && entries.size > 0;
  }

  function scheduleMrLockPoll() {
    clearTimeout(mrLockPollTimer);
    if (!mrLockPollEligible()) {
      setMrLockPollStatus("Task lock checks paused (need a Challenge ID and some areas loaded).");
      return;
    }
    const jitter = Math.round((Math.random() * 2 - 1) * MR_LOCK_POLL_JITTER_MS);
    mrLockPollTimer = setTimeout(async () => {
      try {
        await refreshMrLockState();
      } catch (err) {
        // silent - this is a background refresh; the next scheduled poll retries
      }
      scheduleMrLockPoll();
    }, MR_LOCK_POLL_BASE_MS + jitter);
  }

  // Called whenever something changes that should make lock state fresh
  // again right away, rather than waiting out whatever's left of the current
  // poll interval: loading a challenge, or setting the challenge ID.
  function kickMrLockPoll() {
    clearTimeout(mrLockPollTimer);
    if (!mrLockPollEligible()) {
      setMrLockPollStatus("Task lock checks paused (need a Challenge ID and some areas loaded).");
      return;
    }
    refreshMrLockState().catch(() => {});
    scheduleMrLockPoll();
  }

  function loadReferenceLayer(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        alert("Could not parse this file as JSON: " + err.message);
        return;
      }
      let layer;
      try {
        layer = L.geoJSON(parsed, {
          interactive: false,
          style: { color: REFERENCE_COLOR, weight: 2, dashArray: "4 3", fillColor: REFERENCE_COLOR, fillOpacity: 0.1 },
          pointToLayer: (feature, latlng) =>
            L.circleMarker(latlng, {
              radius: 5,
              color: REFERENCE_COLOR,
              weight: 2,
              fillColor: REFERENCE_COLOR,
              fillOpacity: 0.5,
              interactive: false,
            }),
        });
      } catch (err) {
        alert("Could not render this as GeoJSON: " + err.message);
        return;
      }
      referenceLayerGroup.clearLayers();
      referenceLayerGroup.addLayer(layer);
      currentBandLayer = buildReferenceBorderBand(parsed);
      updateBandVisibility();
      if (!map.hasLayer(referenceLayerGroup)) map.addLayer(referenceLayerGroup);
      // Only steal the view if there's nothing else loaded yet to build the
      // view around - don't yank the map away from in-progress work.
      const bounds = layer.getBounds();
      if (entries.size === 0 && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20] });
      }
      const count = Array.isArray(parsed.features) ? parsed.features.length : 1;
      referenceFileNameEl.textContent = `${file.name} (${count} features)`;
      clearReferenceBtn.disabled = false;
    };
    reader.readAsText(file);
  }

  // A thin tessellated-pattern band just inside each polygon's boundary, on
  // top of its plain fill, so the filled interior reads clearly even where
  // the fill color alone doesn't contrast enough against the basemap. Only
  // meaningful when zoomed in a lot, so it's kept out of the group entirely
  // until then (see updateBandVisibility) rather than just visually tiny.
  const BAND_MIN_ZOOM = 18;
  let currentBandLayer = null;

  function updateBandVisibility() {
    if (!currentBandLayer) return;
    const shouldShow = map.getZoom() >= BAND_MIN_ZOOM;
    const isShown = referenceLayerGroup.hasLayer(currentBandLayer);
    if (shouldShow && !isShown) referenceLayerGroup.addLayer(currentBandLayer);
    else if (!shouldShow && isShown) referenceLayerGroup.removeLayer(currentBandLayer);
  }

  function buildReferenceBorderBand(parsed) {
    const BAND_WIDTH_KM = 0.002; // ~2m inward
    const features = Array.isArray(parsed.features) ? parsed.features : [parsed];
    const bandFeatures = [];
    features.forEach((feature) => {
      if (!feature.geometry || (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon")) {
        return;
      }
      try {
        const inset = turf.buffer(feature, -BAND_WIDTH_KM, { units: "kilometers" });
        if (!inset) return;
        const band = turf.difference(turf.featureCollection([feature, inset]));
        if (band) bandFeatures.push(band);
      } catch (err) {
        console.warn("Could not build reference border band for a feature", err);
      }
    });
    return L.geoJSON(turf.featureCollection(bandFeatures), {
      interactive: false,
      renderer: referenceRenderer,
      style: { stroke: false, fillColor: `url(#${REFERENCE_PATTERN_ID})`, fillOpacity: 0.9 },
    });
  }

  function clearReferenceLayer() {
    referenceLayerGroup.clearLayers();
    currentBandLayer = null;
    map.removeLayer(referenceLayerGroup);
    referenceFileNameEl.textContent = "No reference layer";
    clearReferenceBtn.disabled = true;
    referenceFileInput.value = "";
  }

  function buildEntries(parsed) {
    if (drawState) cancelDrawing();
    if (combineState) cancelCombine();
    if (replaceState) cancelReplace();
    hideOverlaps();
    highlightOverlapsCheckbox.checked = false;
    entries.forEach((e) => map.removeLayer(e.layer));
    entries = new Map();
    orderedIds = [];
    selectedId = null;
    updateSelectionPulse();
    undoStack = [];
    redoStack = [];
    newFeatureCounter = 0;
    addedAreaCounter = 0;
    updateUndoRedoButtons();
    mrDeleteQueue = new Set();
    updateMrQueueButton();
    mrQueueStatusEl.textContent = "";
    mrAddQueue = new Set();
    updateMrAddQueueButton();
    mrAddQueueStatusEl.textContent = "";
    mrEditQueue = new Set();
    updateMrEditQueueButton();
    mrEditQueueStatusEl.textContent = "";
    splitQueue = new Map();
    updateSplitQueueButton();
    mrSplitQueueStatusEl.textContent = "";
    replaceQueue = new Map();
    updateReplaceQueueButton();
    mrReplaceQueueStatusEl.textContent = "";
    combineQueue = new Map();
    updateCombineQueueButton();
    mrCombineQueueStatusEl.textContent = "";
    mrOrphanedDeleteQueue = new Set();
    updateOrphanedDeleteQueueButton();
    mrOrphanedDeleteQueueStatusEl.textContent = "";
    if (editState) cancelEditBoundary();

    parsed.features.forEach((feature, idx) => {
      const id = hashString(JSON.stringify(feature.geometry));
      const { area, compactness } = computeMetrics(feature);
      const mrTaskStatus = (feature.properties && feature.properties.mr_taskStatus) || null;

      entries.set(id, {
        id,
        idx,
        feature,
        layer: null,
        area,
        compactness,
        mrTaskId: parseMrTaskId(feature),
        mrTaskStatus,
        mrLocked: isLockedTaskStatus(mrTaskStatus),
        mrActiveLockedBy: null, // filled in by refreshMrLockState, if/when it runs
        lowDensity: !!(feature.properties && feature.properties[LOW_DENSITY_PROPERTY] === true),
      });
      orderedIds.push(id);
    });
  }

  function computeMetrics(feature) {
    let area = 0;
    let perimeter = 0;
    try {
      area = turf.area(feature);
      const line = turf.polygonToLine(feature);
      perimeter = turf.length(line, { units: "kilometers" }) * 1000;
    } catch (err) {
      console.warn("Could not compute metrics for feature", err);
    }
    const compactness = perimeter > 0 ? Math.min(1, (4 * Math.PI * area) / (perimeter * perimeter)) : 0;
    return { area, compactness };
  }

  function category(entry) {
    if (entry.mrLocked) return "locked";
    if (entry.mrActiveLockedBy != null) return "active-lock";
    // A "low density" mark exempts an area from the whole area-size rule -
    // low-density blocks can legitimately land on either side of it (a
    // sparse suburban block covering a lot of ground, or a small one with
    // little in it) without either end meaning something's actually wrong.
    if (entry.lowDensity) return "normal";
    if (entry.area >= targetAreaLimit) return "oversized";
    if (entry.area <= targetAreaLimit * 0.5) return "undersized";
    return "normal";
  }

  function styleFor(entry) {
    const cat = category(entry);
    const color = COLORS[cat];
    if (entry.mrLocked) {
      return { color: "#616161", weight: 2, dashArray: null, fillColor: color, fillOpacity: 0.45 };
    }
    if (cat === "active-lock") {
      return { color: "#4e342e", weight: 2, dashArray: null, fillColor: color, fillOpacity: 0.45 };
    }
    if (combineState && combineState.selectedIds.has(entry.id)) {
      return { color: "#9c27b0", weight: 4, dashArray: "6 3", fillColor: color, fillOpacity: 0.35 };
    }
    if (replaceState && replaceState.phase === "selecting" && replaceState.selectedIds.has(entry.id)) {
      return { color: "#00838f", weight: 4, dashArray: "6 3", fillColor: color, fillOpacity: 0.35 };
    }
    if (entry.pendingSplitGroup != null) {
      return { color: "#ef6c00", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    if (entry.pendingReplace) {
      return { color: "#00838f", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    if (entry.pendingCombineGroup != null) {
      return { color: "#9c27b0", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    if (mrDeleteQueue.has(entry.id)) {
      return { color: "#b71c1c", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    if (mrAddQueue.has(entry.id)) {
      return { color: "#2e7d32", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    if (mrEditQueue.has(entry.id)) {
      return { color: "#1565c0", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    const isSelected = entry.id === selectedId;
    return {
      color: isSelected ? "#000" : color,
      weight: isSelected ? 3 : 1.5,
      // setStyle() merges rather than replaces, so dashArray must be explicitly
      // cleared here or a prior combine-selection dash pattern would stick.
      dashArray: null,
      fillColor: color,
      fillOpacity: cat === "oversized" || cat === "undersized" ? 0.4 : 0.15,
    };
  }

  function renderMapLayers() {
    const bounds = [];
    entries.forEach((entry) => {
      attachLayer(entry);
      const b = entry.layer.getBounds();
      if (b.isValid()) bounds.push(b);
    });
    if (bounds.length) {
      let all = bounds[0];
      bounds.forEach((b) => (all = all.extend(b)));
      map.fitBounds(all, { padding: [20, 20] });
    }
  }

  function attachLayer(entry) {
    const layer = L.geoJSON(entry.feature, { style: () => styleFor(entry) });
    // While drawing (split-line or new-area), clicks/moves that land on top of
    // an existing polygon must still reach the drawing controller instead of
    // being consumed here as a selection/queue click — a cut line very often
    // needs to cross directly over other areas.
    layer.on("click", (e) => {
      if (drawState) {
        L.DomEvent.stopPropagation(e);
        onDrawMapClick(e);
        return;
      }
      if (combineState) {
        L.DomEvent.stopPropagation(e);
        toggleCombineSelection(entry.id);
        return;
      }
      if (replaceState) {
        L.DomEvent.stopPropagation(e);
        if (replaceState.phase === "selecting") toggleReplaceSelection(entry.id);
        // "drawing" phase - clicks on existing areas are inert; finish or
        // cancel the replace in progress first.
        return;
      }
      if (editState) {
        // Editing is focused on one area at a time - Finish or Cancel it
        // first rather than letting a click on some other area do anything.
        L.DomEvent.stopPropagation(e);
        return;
      }
      // Stop this from also reaching the map's own click handler (used to
      // close the tablet panel on an empty-map tap) - it's already handled
      // right here either way.
      L.DomEvent.stopPropagation(e);
      selectFeature(entry.id);
      if (mrQuickQueueDeleteMode) {
        toggleQuickQueueDelete(entry);
      } else {
        openPopup(entry);
      }
    });
    layer.on("dblclick", (e) => {
      if (drawState) {
        L.DomEvent.stopPropagation(e);
        finishDrawing();
      }
    });
    layer.on("mousemove", (e) => {
      if (drawState) onDrawMouseMove(e);
    });
    layer.addTo(map);
    entry.layer = layer;
  }

  function openPopup(entry) {
    const lockReason = mrBlockReason(entry);
    const splitGroupId = entry.pendingSplitGroup;
    const splitPending = splitGroupId != null;
    const splitGroup = splitPending ? splitQueue.get(splitGroupId) : null;
    const replacePending = entry.pendingReplace === true;
    const combinePending = entry.pendingCombineGroup != null;
    const div = document.createElement("div");
    div.innerHTML = `
      <div><strong>Feature #${entry.idx}</strong></div>
      <div>Area: ${entry.area.toFixed(1)} m&sup2;</div>
      <div>Compactness: ${entry.compactness.toFixed(3)}</div>
      ${
        lockReason
          ? `<div class="mr-locked-note">&#128274; ${
              entry.mrLocked
                ? `MapRoulette status: <strong>${formatMrTaskStatus(entry.mrTaskStatus)}</strong>`
                : `Currently checked out on MapRoulette`
            } — locked. Split and remove are disabled while this is the case.</div>`
          : ""
      }
      ${
        splitPending
          ? `<div class="mr-locked-note">Part of a pending split (${
              splitGroup ? splitGroup.newSnapshots.length : 1
            } piece${splitGroup && splitGroup.newSnapshots.length === 1 ? "" : "s"} still pending) — use Undo to reverse the whole split, or process the split queue to sync it.</div>`
          : ""
      }
      ${
        replacePending
          ? `<div class="mr-locked-note">Queued for a pending replace — use Undo to reverse it, or process the replace queue to apply it.</div>`
          : ""
      }
      ${
        combinePending
          ? `<div class="mr-locked-note">Queued for a pending combine — use Undo to reverse it, or process the combine queue to apply it.</div>`
          : ""
      }
      ${
        lockReason || replacePending || combinePending
          ? ""
          : splitPending
          ? `<div class="popup-actions"><button data-split>Split&hellip;</button><button data-drop-split-piece>Drop this piece</button></div>`
          : `<div class="popup-actions"><button data-split>Split&hellip;</button><button data-edit-boundary>Edit boundary&hellip;</button></div>`
      }
      ${
        lockReason || splitPending || replacePending || combinePending
          ? ""
          : `<label class="toggle-label" title="Exempts this area from the undersized/needs-combine check - it's expected to be small because the underlying density is genuinely low, not because anything's wrong.">
              <input type="checkbox" data-low-density ${entry.lowDensity ? "checked" : ""}>
              Low density (exempt from size check)
            </label>`
      }
      ${
        lockReason || splitPending || replacePending || combinePending
          ? ""
          : `<div class="popup-actions">
              <button data-mr-action></button>
              ${entry.mrTaskId ? "" : `<button data-mr-add-now>Add now</button>`}
            </div><div class="mr-inline-status" data-mr-status></div>`
      }
    `;
    const splitBtn = div.querySelector("[data-split]");
    if (splitBtn) {
      splitBtn.addEventListener("click", async () => {
        if (entry.mrTaskId) {
          // Last-chance recheck right before committing to the split - the
          // background poll could be up to about a minute stale, and this is
          // the moment it actually matters.
          splitBtn.disabled = true;
          try {
            await refreshMrLockState();
          } catch (err) {
            // best-effort - fall back to whatever lock state we already had
          }
          splitBtn.disabled = false;
          const freshBlockReason = mrBlockReason(entry);
          if (freshBlockReason) {
            alert(`This area's MapRoulette task is ${freshBlockReason} - it can't be split.`);
            return;
          }
        }
        closeAnyPopup();
        startDrawing("split", entry.id);
      });
    }

    const dropSplitPieceBtn = div.querySelector("[data-drop-split-piece]");
    if (dropSplitPieceBtn) {
      dropSplitPieceBtn.addEventListener("click", () => dropSplitPiece(entry));
    }

    const editBoundaryBtn = div.querySelector("[data-edit-boundary]");
    if (editBoundaryBtn) {
      editBoundaryBtn.addEventListener("click", () => {
        closeAnyPopup();
        startEditBoundary(entry.id);
      });
    }

    const lowDensityCheckbox = div.querySelector("[data-low-density]");
    if (lowDensityCheckbox) {
      lowDensityCheckbox.addEventListener("change", (e) => {
        toggleLowDensity(entry);
        // The global keydown handler ignores every shortcut (including
        // undo/redo) while an <input> has focus, to avoid interfering with
        // typing in the target-area-limit field - a checkbox isn't typed
        // into, so blur it right after toggling instead of leaving keyboard
        // shortcuts silently dead until something else steals focus.
        e.target.blur();
      });
    }

    if (lockReason || splitPending || replacePending || combinePending) {
      presentPopup(entry, div);
      return;
    }

    const mrBtn = div.querySelector("[data-mr-action]");
    const mrAddNowBtn = div.querySelector("[data-mr-add-now]");
    const mrStatusInline = div.querySelector("[data-mr-status]");
    const updateMrButton = () => {
      if (entry.mrTaskId) {
        mrBtn.textContent = mrDeleteQueue.has(entry.id) ? "Cancel pending removal" : "Remove task from challenge";
      } else {
        mrBtn.textContent = mrAddQueue.has(entry.id) ? "Cancel pending add" : "Queue for adding";
      }
    };
    updateMrButton();
    mrBtn.addEventListener("click", () => {
      // Queueing/dequeueing (for either queue) is fully reversible (nothing's
      // created/deleted yet), so no confirmation here - processing the queue
      // itself also starts immediately, with no confirmation either.
      if (entry.mrTaskId) {
        if (mrDeleteQueue.has(entry.id)) {
          mrDeleteQueue.delete(entry.id);
          mrStatusInline.textContent = "Removed from the delete queue.";
        } else {
          mrDeleteQueue.add(entry.id);
          mrStatusInline.textContent = 'Queued for removal — use "Process delete queue" in the sidebar to actually delete it.';
        }
        entry.layer.setStyle(styleFor(entry));
        updateMrButton();
        updateMrQueueButton();
        renderList();
        return;
      }
      if (mrAddQueue.has(entry.id)) {
        mrAddQueue.delete(entry.id);
        mrStatusInline.textContent = "Removed from the add queue.";
      } else {
        mrAddQueue.add(entry.id);
        mrStatusInline.textContent = 'Queued for adding — use "Process add queue" in the sidebar to actually create it.';
      }
      entry.layer.setStyle(styleFor(entry));
      updateMrButton();
      updateMrAddQueueButton();
      renderList();
    });

    if (mrAddNowBtn) {
      mrAddNowBtn.addEventListener("click", async () => {
        mrAddNowBtn.disabled = true;
        mrBtn.disabled = true;
        mrStatusInline.textContent = "Adding to MapRoulette…";
        try {
          const created = await mrCreateTask(entry.feature, entry.lowDensity);
          entry.mrTaskId = created.id;
          mrAddQueue.delete(entry.id);
          entry.layer.setStyle(styleFor(entry));
          mrStatusInline.textContent = `Added as MapRoulette task ${created.id}.`;
          updateMrButton();
          updateMrAddQueueButton();
          renderList();
          mrAddNowBtn.remove(); // no longer relevant - this area is linked now
        } catch (err) {
          mrStatusInline.textContent = "Failed: " + err.message;
        } finally {
          if (entries.has(entry.id)) {
            mrBtn.disabled = false;
            mrAddNowBtn.disabled = false;
          }
        }
      });
    }

    presentPopup(entry, div);
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    if (action.type === "split") undoSplit(action);
    else if (action.type === "add") undoAdd(action);
    else if (action.type === "combine") undoCombine(action);
    else if (action.type === "edit") undoEdit(action);
    else if (action.type === "replace") undoReplace(action);
    else if (action.type === "drop-split-piece") undoDropSplitPiece(action);
    else if (action.type === "split-in-group") undoSplitInGroup(action);
    else if (action.type === "low-density") undoLowDensity(action);
    redoStack.push(action);
    updateUndoRedoButtons();
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    if (action.type === "split") redoSplit(action);
    else if (action.type === "add") redoAdd(action);
    else if (action.type === "combine") redoCombine(action);
    else if (action.type === "edit") redoEdit(action);
    else if (action.type === "replace") redoReplace(action);
    else if (action.type === "drop-split-piece") redoDropSplitPiece(action);
    else if (action.type === "split-in-group") redoSplitInGroup(action);
    else if (action.type === "low-density") redoLowDensity(action);
    undoStack.push(action);
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function removeEntry(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.layer) map.removeLayer(entry.layer);
    entries.delete(id);
    orderedIds = orderedIds.filter((oid) => oid !== id);
    if (selectedId === id) {
      selectedId = null;
      updateSelectionPulse();
    }
  }

  function snapshotEntry(entry) {
    return {
      id: entry.id,
      idx: entry.idx,
      feature: entry.feature,
      area: entry.area,
      compactness: entry.compactness,
      mrTaskId: entry.mrTaskId,
      mrTaskStatus: entry.mrTaskStatus,
      mrLocked: entry.mrLocked,
      mrActiveLockedBy: entry.mrActiveLockedBy,
      lowDensity: entry.lowDensity,
    };
  }

  function restoreEntryFromSnapshot(snapshot) {
    const entry = Object.assign({}, snapshot, { layer: null });
    entries.set(entry.id, entry);
    orderedIds.push(entry.id);
    attachLayer(entry);
    return entry;
  }

  // --- Split ---

  // Pure geometry: computes the two (or more) pieces a cut line would
  // produce, without touching entries/undoStack/MapRoulette - a bad cut is
  // rejected here immediately, before anything local changes.
  function computeSplitPieces(entry, points) {
    let diffResult;
    try {
      const cutLine = turf.lineString(points);
      const knife = turf.buffer(cutLine, 0.0005, { units: "kilometers" }); // ~1m wide knife
      diffResult = turf.difference(turf.featureCollection([entry.feature, knife]));
    } catch (err) {
      alert("Could not compute the split: " + err.message);
      return null;
    }
    if (!diffResult) {
      alert("That cut line doesn't appear to cross this area.");
      return null;
    }
    const parts = turf.flatten(diffResult).features.filter((f) => f.geometry && f.geometry.type === "Polygon");
    if (parts.length < 2) {
      alert(
        "That cut didn't fully divide the area into two separate pieces. Try drawing the line all the way across it, past both edges."
      );
      return null;
    }

    const originalSnapshot = snapshotEntry(entry);
    const newSnapshots = parts.map((part, i) => {
      const { area, compactness } = computeMetrics(part);
      return {
        id: hashString(JSON.stringify(part.geometry) + ":" + newFeatureCounter++),
        idx: `${originalSnapshot.idx}${String.fromCharCode(97 + i)}`,
        feature: part,
        area,
        compactness,
        mrTaskId: null,
        mrTaskStatus: null,
        mrLocked: false,
        mrActiveLockedBy: null,
        // Each piece is still part of the same physical area, so it inherits
        // the low-density mark rather than starting unmarked.
        lowDensity: originalSnapshot.lowDensity,
      };
    });
    return { originalSnapshot, newSnapshots };
  }

  // Validates the cut and, if it works, applies the split locally right
  // away (same as combine/add/replace) - only the MapRoulette sync is
  // deferred to a queue. Each resulting piece is tagged pendingSplitGroup
  // so it's visible and clickable (with its own "Drop this piece" action,
  // and its own "Split…" to divide it again) while the group waits to be
  // processed, but blocked from other structural actions (see
  // structuralBlockReason) in the meantime.
  //
  // Splitting a piece that's already part of a pending group (a nested
  // split) doesn't create a second group - it splices that piece's own
  // resulting pieces into the SAME group, in its place. This keeps
  // processing/dropping generic (they already just operate on whatever's
  // in a group's newSnapshots array, however many pieces that is) and
  // keeps the mrAddQueue auto-queue decision anchored to the group's real
  // root (an intermediate piece is always unlinked by construction, so
  // checking ITS mrTaskId would always look "unlinked" even when the root
  // has a real task waiting to be resynced when the group is processed).
  function queueSplit(targetId, points) {
    const entry = entries.get(targetId);
    if (!entry) return;
    const blockReason = splitBlockReason(entry);
    if (blockReason) {
      alert(`This area's MapRoulette task is ${blockReason} - it can't be split.`);
      return;
    }
    const pieces = computeSplitPieces(entry, points);
    if (!pieces) return;
    const { originalSnapshot: replacedSnapshot, newSnapshots } = pieces;

    const existingGroupId = entry.pendingSplitGroup;
    if (existingGroupId != null) {
      const group = splitQueue.get(existingGroupId);
      const spliceIndex = group.newSnapshots.findIndex((s) => s.id === targetId);
      newSnapshots.forEach((snap) => {
        snap.pendingSplitGroup = existingGroupId;
      });
      group.newSnapshots.splice(spliceIndex, 1, ...newSnapshots);

      const wasInAddQueue = mrAddQueue.has(targetId);
      removeEntry(targetId);
      mrAddQueue.delete(targetId);
      if (wasInAddQueue) newSnapshots.forEach((snap) => mrAddQueue.add(snap.id));
      newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
      updateMrAddQueueButton();

      undoStack.push({
        type: "split-in-group",
        groupId: existingGroupId,
        replacedSnapshot,
        newSnapshots,
        spliceIndex,
        wasInAddQueue,
      });
      redoStack = [];
      updateUndoRedoButtons();
      updateStats();
      renderList();

      selectFeature(newSnapshots[0].id);
      panTo(entries.get(newSnapshots[0].id));
      return;
    }

    const groupId = hashString(JSON.stringify(replacedSnapshot.id) + ":" + newFeatureCounter++);
    newSnapshots.forEach((snap) => {
      snap.pendingSplitGroup = groupId;
    });

    removeEntry(targetId);
    // Only auto-queue the new pieces for adding if the original area had no
    // MapRoulette task of its own - if it did, processing the split queue
    // creates their replacement tasks directly instead, bypassing the add
    // queue entirely.
    if (!replacedSnapshot.mrTaskId) {
      newSnapshots.forEach((snap) => mrAddQueue.add(snap.id));
    }
    newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    updateMrAddQueueButton();

    splitQueue.set(groupId, { originalSnapshot: replacedSnapshot, newSnapshots });
    updateSplitQueueButton();

    undoStack.push({ type: "split", groupId, original: replacedSnapshot, newSnapshots });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();

    selectFeature(newSnapshots[0].id);
    panTo(entries.get(newSnapshots[0].id));
  }

  function undoSplitInGroup(action) {
    action.newSnapshots.forEach((snap) => {
      removeEntry(snap.id);
      mrAddQueue.delete(snap.id);
    });
    const group = splitQueue.get(action.groupId);
    if (group) {
      const idx = Math.min(action.spliceIndex, group.newSnapshots.length);
      group.newSnapshots.splice(idx, 0, action.replacedSnapshot);
      action.replacedSnapshot.pendingSplitGroup = action.groupId;
    } else {
      // The group was already processed or fully undone in the meantime -
      // just bring this piece back as a plain, no-longer-pending area.
      action.replacedSnapshot.pendingSplitGroup = null;
    }
    if (action.wasInAddQueue) mrAddQueue.add(action.replacedSnapshot.id);
    restoreEntryFromSnapshot(action.replacedSnapshot);
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.replacedSnapshot.id);
    panTo(entries.get(action.replacedSnapshot.id));
  }

  function redoSplitInGroup(action) {
    removeEntry(action.replacedSnapshot.id);
    mrAddQueue.delete(action.replacedSnapshot.id);
    const group = splitQueue.get(action.groupId);
    if (group) {
      action.newSnapshots.forEach((snap) => {
        snap.pendingSplitGroup = action.groupId;
      });
      const idx = group.newSnapshots.findIndex((s) => s.id === action.replacedSnapshot.id);
      if (idx !== -1) group.newSnapshots.splice(idx, 1, ...action.newSnapshots);
      else group.newSnapshots.push(...action.newSnapshots); // defensive - shouldn't normally happen
    }
    if (action.wasInAddQueue) action.newSnapshots.forEach((snap) => mrAddQueue.add(snap.id));
    action.newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.newSnapshots[0].id);
    panTo(entries.get(action.newSnapshots[0].id));
  }

  // Lets the user discard one resulting piece of a still-pending split
  // before it's ever synced to MapRoulette - e.g. one side of the cut
  // turned out to be junk. At least one piece must remain; to drop the
  // last one, undo the whole split (Ctrl+Z) instead.
  function dropSplitPiece(entry) {
    const groupId = entry.pendingSplitGroup;
    if (groupId == null) return;
    const group = splitQueue.get(groupId);
    if (!group) return;
    if (group.newSnapshots.length <= 1) {
      alert("At least one piece must remain from a split - undo the whole split (Ctrl+Z) instead if you don't want any of it.");
      return;
    }
    const dropIndex = group.newSnapshots.findIndex((s) => s.id === entry.id);
    if (dropIndex === -1) return;
    const [snapshot] = group.newSnapshots.splice(dropIndex, 1);
    removeEntry(entry.id);
    mrAddQueue.delete(entry.id);
    updateMrAddQueueButton();

    undoStack.push({ type: "drop-split-piece", groupId, snapshot, dropIndex });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();
    closeAnyPopup();
  }

  function undoDropSplitPiece(action) {
    const group = splitQueue.get(action.groupId);
    if (group) {
      const idx = Math.min(action.dropIndex, group.newSnapshots.length);
      group.newSnapshots.splice(idx, 0, action.snapshot);
      action.snapshot.pendingSplitGroup = action.groupId;
      if (!group.originalSnapshot.mrTaskId) mrAddQueue.add(action.snapshot.id);
    } else {
      // The split itself was already processed or undone in the meantime -
      // just bring the piece back as a plain, no-longer-pending area.
      action.snapshot.pendingSplitGroup = null;
    }
    restoreEntryFromSnapshot(action.snapshot);
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.snapshot.id);
    panTo(entries.get(action.snapshot.id));
  }

  function redoDropSplitPiece(action) {
    const group = splitQueue.get(action.groupId);
    if (group) {
      const idx = group.newSnapshots.findIndex((s) => s.id === action.snapshot.id);
      if (idx !== -1) group.newSnapshots.splice(idx, 1);
    }
    removeEntry(action.snapshot.id);
    mrAddQueue.delete(action.snapshot.id);
    updateMrAddQueueButton();
    updateStats();
    renderList();
  }

  function updateSplitQueueButton() {
    mrSplitQueueBtn.textContent = `Process split queue (${splitQueue.size})`;
    mrSplitQueueBtn.disabled = splitQueue.size === 0;
    updateProcessAllButton();
  }

  // Syncs every queued split to MapRoulette, one group at a time with the
  // same pacing as the other queues: deletes the original's task (if it had
  // one) and creates a fresh task for every piece still in the group
  // (dropped pieces were never part of it). Doesn't do a live lock recheck
  // first (unlike the delete/edit queues) since the original is already
  // gone locally by this point - there's no entry left to refresh against;
  // a task that became locked in the meantime just fails the delete below
  // and gets reported like any other failure.
  async function processSplitQueue() {
    const groupIds = Array.from(splitQueue.keys());
    if (groupIds.length === 0) return;

    mrSplitQueueBtn.disabled = true;
    let done = 0;
    await runConcurrently(groupIds, async (groupId) => {
      const { originalSnapshot, newSnapshots } = splitQueue.get(groupId);
      splitQueue.delete(groupId);
      newSnapshots.forEach((snap) => {
        snap.pendingSplitGroup = null;
        const e = entries.get(snap.id);
        if (e) {
          e.pendingSplitGroup = null;
          e.layer.setStyle(styleFor(e));
        }
      });
      if (originalSnapshot.mrTaskId) {
        await syncSplitToMapRoulette(originalSnapshot, newSnapshots);
      }
      done++;
      mrSplitQueueStatusEl.textContent = `Syncing splits… (${done} of ${groupIds.length} done so far)`;
      renderList();
    });
    mrSplitQueueStatusEl.textContent = `Done — synced ${done} split${done === 1 ? "" : "s"}.`;
    updateSplitQueueButton();
  }

  async function syncSplitToMapRoulette(originalSnapshot, newSnapshots) {
    try {
      await mrDeleteTask(originalSnapshot.mrTaskId);
    } catch (err) {
      // mrRequest's own retries are already exhausted by this point - nothing
      // changed remotely yet, so there's no orphaned task to track, just a
      // deletion that still needs doing. Queue the raw task id for its own
      // retry queue rather than alerting and losing track of it.
      mrOrphanedDeleteQueue.add(originalSnapshot.mrTaskId);
      updateOrphanedDeleteQueueButton();
      return;
    }
    // Each piece's create is independent of the others, so they run
    // concurrently too rather than one at a time.
    await Promise.all(
      newSnapshots.map(async (snap) => {
        const liveEntry = entries.get(snap.id);
        if (!liveEntry) return; // this piece was removed/changed locally before the request resolved
        try {
          const created = await mrCreateTask(liveEntry.feature, liveEntry.lowDensity);
          snap.mrTaskId = created.id;
          liveEntry.mrTaskId = created.id;
          liveEntry.layer.setStyle(styleFor(liveEntry));
        } catch (err) {
          // The old task is really gone regardless - queue this piece for
          // adding instead of leaving it to a manual click.
          mrAddQueue.add(liveEntry.id);
          liveEntry.layer.setStyle(styleFor(liveEntry));
          updateMrAddQueueButton();
        }
      })
    );
  }

  function undoSplit(action) {
    action.newSnapshots.forEach((snap) => {
      removeEntry(snap.id);
      mrAddQueue.delete(snap.id);
    });
    splitQueue.delete(action.groupId);
    updateSplitQueueButton();
    restoreEntryFromSnapshot(action.original);
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.original.id);
    panTo(entries.get(action.original.id));
  }

  function redoSplit(action) {
    removeEntry(action.original.id);
    action.newSnapshots.forEach((snap) => {
      snap.pendingSplitGroup = action.groupId;
    });
    if (!action.original.mrTaskId) {
      action.newSnapshots.forEach((snap) => mrAddQueue.add(snap.id));
    }
    action.newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    splitQueue.set(action.groupId, { originalSnapshot: action.original, newSnapshots: action.newSnapshots });
    updateSplitQueueButton();
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.newSnapshots[0].id);
    panTo(entries.get(action.newSnapshots[0].id));
  }

  // --- Add new area ---

  function doAddArea(points) {
    const ring = points.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

    let feature;
    try {
      feature = turf.polygon([ring]);
    } catch (err) {
      alert("Could not create an area from those points: " + err.message);
      return;
    }

    const { area, compactness } = computeMetrics(feature);
    const snapshot = {
      id: hashString(JSON.stringify(feature.geometry) + ":" + newFeatureCounter++),
      idx: `new-${++addedAreaCounter}`,
      feature,
      area,
      compactness,
      mrTaskId: null,
      mrTaskStatus: null,
      mrLocked: false,
      mrActiveLockedBy: null,
      lowDensity: false,
    };
    // A freshly-drawn area has no MapRoulette task yet - auto-queue it for
    // adding rather than requiring a manual step; "Add now" in its popup
    // still creates it right away if you don't want to wait for the batch.
    mrAddQueue.add(snapshot.id);
    restoreEntryFromSnapshot(snapshot);
    updateMrAddQueueButton();

    undoStack.push({ type: "add", snapshot });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();
    selectFeature(snapshot.id);
  }

  function undoAdd(action) {
    removeEntry(action.snapshot.id);
    mrAddQueue.delete(action.snapshot.id);
    updateMrAddQueueButton();
    updateStats();
    renderList();
  }

  function redoAdd(action) {
    mrAddQueue.add(action.snapshot.id);
    restoreEntryFromSnapshot(action.snapshot);
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.snapshot.id);
  }

  // --- Combine areas ---

  function startCombine() {
    if (drawState) cancelDrawing();
    if (editState) cancelEditBoundary();
    if (replaceState) cancelReplace();
    closeAnyPopup();
    combineState = { selectedIds: new Set() };
    appEl.classList.add("combining-active");
    drawStatusEl.hidden = false;
    updateCombineStatusText();
    combineAreaBtn.textContent = "Cancel combining…";
  }

  function updateCombineStatusText() {
    if (!combineState) return;
    const n = combineState.selectedIds.size;
    drawStatusText.textContent = `Click 2 or more adjacent areas to merge (${n} selected so far).`;
  }

  function toggleCombineSelection(id) {
    if (!combineState) return;
    const entry = entries.get(id);
    const blockReason = entry && !combineState.selectedIds.has(id) ? structuralBlockReason(entry) : null;
    if (blockReason) {
      alert(`This area's MapRoulette task is ${blockReason} - it can't be combined.`);
      return;
    }
    if (combineState.selectedIds.has(id)) combineState.selectedIds.delete(id);
    else combineState.selectedIds.add(id);
    if (entry && entry.layer) entry.layer.setStyle(styleFor(entry));
    updateCombineStatusText();
    renderList();
  }

  function finishCombine() {
    if (!combineState) return;
    const ids = Array.from(combineState.selectedIds);
    if (ids.length < 2) {
      alert("Select at least 2 areas to combine.");
      return;
    }
    const targetEntries = ids.map((id) => entries.get(id)).filter(Boolean);
    cancelCombine();
    doCombine(targetEntries);
  }

  function cancelCombine() {
    if (!combineState) return;
    const ids = Array.from(combineState.selectedIds);
    combineState = null;
    ids.forEach((id) => {
      const entry = entries.get(id);
      if (entry && entry.layer) entry.layer.setStyle(styleFor(entry));
    });
    appEl.classList.remove("combining-active");
    drawStatusEl.hidden = true;
    combineAreaBtn.textContent = "Combine areas…";
    renderList();
  }

  function doCombine(targetEntries) {
    if (targetEntries.length < 2) return;
    if (targetEntries.some((e) => mrBlockReason(e))) {
      alert(
        "One or more of these areas is locked (already resolved on MapRoulette, or currently being worked on) - it can't be combined."
      );
      return;
    }

    // Splitting deliberately leaves a ~1m gap between the pieces it creates
    // (see doSplit), so a plain union of two just-split areas would see them
    // as non-touching and produce a MultiPolygon instead of merging them.
    // Close gaps up to that size first: buffer each area out slightly,
    // union, then buffer the result back in by the same amount
    // ("morphological closing"). Areas that are genuinely far apart still
    // won't bridge and correctly fail the parts.length check below - with
    // map-feature snapping available for drawing new areas, shapes that
    // should end up joined can just share an exact boundary point to begin
    // with, so there's no need to bridge a real gap here instead of
    // rejecting it.
    const CLOSE_DISTANCE_KM = 0.001; // 1m — just past the split knife's ~0.5m radius
    let unionResult;
    try {
      const closed = targetEntries.map((e) => turf.buffer(e.feature, CLOSE_DISTANCE_KM, { units: "kilometers" }));
      unionResult = turf.union(turf.featureCollection(closed));
      if (unionResult) unionResult = turf.buffer(unionResult, -CLOSE_DISTANCE_KM, { units: "kilometers" });
    } catch (err) {
      alert("Could not combine these areas: " + err.message);
      return;
    }
    if (!unionResult) {
      alert("Could not combine these areas.");
      return;
    }
    const parts = turf.flatten(unionResult).features.filter((f) => f.geometry && f.geometry.type === "Polygon");
    if (parts.length !== 1) {
      alert(
        "These areas don't touch or overlap, so combining them would create a MultiPolygon, which isn't supported here. Pick areas that share a boundary."
      );
      return;
    }
    const combined = parts[0];
    const { area, compactness } = computeMetrics(combined);

    const originalSnapshots = targetEntries.map(snapshotEntry);
    originalSnapshots.forEach((snap) => {
      removeEntry(snap.id);
      mrAddQueue.delete(snap.id);
    });

    const groupId = hashString(JSON.stringify(originalSnapshots.map((s) => s.id)) + ":" + newFeatureCounter++);
    const newSnapshot = {
      id: hashString(JSON.stringify(combined.geometry) + ":" + newFeatureCounter++),
      idx: originalSnapshots.map((s) => s.idx).join("+"),
      feature: combined,
      area,
      compactness,
      mrTaskId: null,
      mrTaskStatus: null,
      mrLocked: false,
      mrActiveLockedBy: null,
      pendingCombineGroup: groupId,
      // If any constituent was marked low-density, the merged area still is -
      // merging two areas doesn't make either of them less sparse.
      lowDensity: originalSnapshots.some((s) => s.lowDensity),
    };
    // Only auto-queue the merged area for adding if none of the constituents
    // had a MapRoulette task of their own - if any did, processing the
    // combine queue deletes them and creates the merged area's task
    // directly instead, bypassing the add queue entirely (same reasoning
    // as split/replace).
    const anyLinked = originalSnapshots.some((s) => s.mrTaskId);
    if (!anyLinked) {
      mrAddQueue.add(newSnapshot.id);
      updateMrAddQueueButton();
    }
    restoreEntryFromSnapshot(newSnapshot);
    combineQueue.set(groupId, { originalSnapshots, newSnapshot });
    updateCombineQueueButton();

    undoStack.push({ type: "combine", groupId, originals: originalSnapshots, newSnapshot });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();

    selectFeature(newSnapshot.id);
    panTo(entries.get(newSnapshot.id));
  }

  function undoCombine(action) {
    removeEntry(action.newSnapshot.id);
    mrAddQueue.delete(action.newSnapshot.id);
    combineQueue.delete(action.groupId);
    updateCombineQueueButton();
    action.originals.forEach((snap) => {
      restoreEntryFromSnapshot(snap);
      if (!snap.mrTaskId) mrAddQueue.add(snap.id);
    });
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.originals[0].id);
    panTo(entries.get(action.originals[0].id));
  }

  function redoCombine(action) {
    action.originals.forEach((snap) => {
      removeEntry(snap.id);
      mrAddQueue.delete(snap.id);
    });
    action.newSnapshot.pendingCombineGroup = action.groupId;
    if (!action.originals.some((s) => s.mrTaskId)) {
      mrAddQueue.add(action.newSnapshot.id);
    }
    restoreEntryFromSnapshot(action.newSnapshot);
    combineQueue.set(action.groupId, { originalSnapshots: action.originals, newSnapshot: action.newSnapshot });
    updateCombineQueueButton();
    updateMrAddQueueButton();
    updateStats();
    renderList();
    selectFeature(action.newSnapshot.id);
    panTo(entries.get(action.newSnapshot.id));
  }

  function updateCombineQueueButton() {
    mrCombineQueueBtn.textContent = `Process combine queue (${combineQueue.size})`;
    mrCombineQueueBtn.disabled = combineQueue.size === 0;
    updateProcessAllButton();
  }

  // Deletes every task-linked constituent in a combine-group, then creates a
  // fresh task for the merged area - the same "delete old(s), create new"
  // mechanic split/replace use, just N-to-1. A no-op remotely if none of the
  // constituents were linked (mrAddQueue handles creating the merged area's
  // task in that case instead - see doCombine/processCombineQueue).
  async function syncCombineToMapRoulette(originalSnapshots, newSnapshot) {
    // Each constituent's delete is independent of the others, so they run
    // concurrently rather than one at a time.
    await Promise.all(
      originalSnapshots.map(async (snap) => {
        if (!snap.mrTaskId) return;
        try {
          await mrDeleteTask(snap.mrTaskId);
        } catch (err) {
          // mrRequest's own retries are already exhausted - nothing changed
          // remotely for this one, just a deletion that still needs doing, so
          // it's tracked on its own rather than alerted-and-forgotten.
          mrOrphanedDeleteQueue.add(snap.mrTaskId);
          updateOrphanedDeleteQueueButton();
        }
      })
    );
    const liveEntry = entries.get(newSnapshot.id);
    if (!liveEntry || liveEntry.mrTaskId) return; // gone, or already linked some other way, before this ran
    try {
      const created = await mrCreateTask(liveEntry.feature, liveEntry.lowDensity);
      newSnapshot.mrTaskId = created.id;
      liveEntry.mrTaskId = created.id;
      liveEntry.layer.setStyle(styleFor(liveEntry));
    } catch (err) {
      // The constituents are already gone regardless - queue the merged
      // area for adding instead of leaving it to a manual click.
      mrAddQueue.add(liveEntry.id);
      liveEntry.layer.setStyle(styleFor(liveEntry));
      updateMrAddQueueButton();
    }
  }

  // Syncs every queued combine to MapRoulette, several groups at a time (see
  // runConcurrently). Doesn't do a live lock recheck first (unlike the
  // delete/edit queues) since the constituents are already gone locally by
  // this point - there's no entry left to refresh against; a task that
  // became locked in the meantime just fails the delete below and gets
  // reported like any other failure.
  async function processCombineQueue() {
    const groupIds = Array.from(combineQueue.keys());
    if (groupIds.length === 0) return;

    mrCombineQueueBtn.disabled = true;
    let done = 0;
    await runConcurrently(groupIds, async (groupId) => {
      const { originalSnapshots, newSnapshot } = combineQueue.get(groupId);
      combineQueue.delete(groupId);
      newSnapshot.pendingCombineGroup = null;
      const e = entries.get(newSnapshot.id);
      if (e) {
        e.pendingCombineGroup = null;
        e.layer.setStyle(styleFor(e));
      }
      if (originalSnapshots.some((s) => s.mrTaskId)) {
        await syncCombineToMapRoulette(originalSnapshots, newSnapshot);
      }
      done++;
      mrCombineQueueStatusEl.textContent = `Syncing combines… (${done} of ${groupIds.length} done so far)`;
      renderList();
    });
    mrCombineQueueStatusEl.textContent = `Done — synced ${done} combine${done === 1 ? "" : "s"}.`;
    updateCombineQueueButton();
  }

  function updateOrphanedDeleteQueueButton() {
    mrOrphanedDeleteQueueBtn.textContent = `Process orphaned deletes (${mrOrphanedDeleteQueue.size})`;
    mrOrphanedDeleteQueueBtn.disabled = mrOrphanedDeleteQueue.size === 0;
    updateProcessAllButton();
  }

  // Retries deleting every task id that a split/replace/combine sync
  // couldn't remove even after mrRequest's own retries were exhausted -
  // these have no local area to attach the retry to anymore (the local side
  // already moved on), so they sit here as bare task ids until this
  // succeeds or the user gives up on one (there's no undo for this queue,
  // since these tasks are already known-orphaned duplicates, not areas).
  async function processOrphanedDeleteQueue() {
    const ids = Array.from(mrOrphanedDeleteQueue);
    if (ids.length === 0) return;

    mrOrphanedDeleteQueueBtn.disabled = true;
    let done = 0;
    let failed = 0;
    await runConcurrently(ids, async (taskId) => {
      mrOrphanedDeleteQueue.delete(taskId);
      mrOrphanedDeleteQueueStatusEl.textContent = `Deleting task ${taskId}… (${done} of ${ids.length} done so far)`;
      try {
        await mrDeleteTask(taskId);
      } catch (err) {
        failed++;
        mrOrphanedDeleteQueue.add(taskId);
      }
      done++;
    });
    const deleted = done - failed;
    mrOrphanedDeleteQueueStatusEl.textContent =
      failed === 0
        ? `Done — deleted ${deleted} orphaned task${deleted === 1 ? "" : "s"}.`
        : `Done — deleted ${deleted} of ${done}; ${failed} still failed and ${
            failed === 1 ? "stays" : "stay"
          } queued to retry next time.`;
    updateOrphanedDeleteQueueButton();
  }

  // --- Replace ---
  //
  // Two phases: "selecting" (pick 1+ existing areas to replace - nothing
  // changes locally yet) then "drawing" (the selected originals are already
  // gone, and "Add new area…" is reused, once or more, to draw whatever
  // replaces them). Unlike split, the local swap happens immediately once
  // selection finishes - only the MapRoulette sync (delete the originals'
  // tasks, create tasks for the replacements) is queued, since there's no
  // sensible way to show "these areas are about to disappear" without
  // actually removing them so the user can draw into the freed-up space.

  function startReplace() {
    if (drawState) cancelDrawing();
    if (combineState) cancelCombine();
    if (editState) cancelEditBoundary();
    closeAnyPopup();
    replaceState = { phase: "selecting", selectedIds: new Set(), originalSnapshots: [], newSnapshots: [] };
    appEl.classList.add("replacing-active");
    drawStatusEl.hidden = false;
    updateReplaceStatusText();
    replaceAreaBtn.textContent = "Cancel replacing…";
  }

  function updateReplaceStatusText() {
    if (!replaceState) return;
    if (replaceState.phase === "selecting") {
      const n = replaceState.selectedIds.size;
      drawStatusText.textContent = `Click 1 or more areas to replace (${n} selected so far).`;
    } else {
      const n = replaceState.newSnapshots.length;
      drawStatusText.textContent = `Draw one or more replacement areas with "Add new area…" (${n} drawn so far), then Finish when done.`;
    }
  }

  function toggleReplaceSelection(id) {
    if (!replaceState || replaceState.phase !== "selecting") return;
    const entry = entries.get(id);
    const blockReason = entry && !replaceState.selectedIds.has(id) ? structuralBlockReason(entry) : null;
    if (blockReason) {
      alert(`This area's MapRoulette task is ${blockReason} - it can't be replaced.`);
      return;
    }
    if (replaceState.selectedIds.has(id)) replaceState.selectedIds.delete(id);
    else replaceState.selectedIds.add(id);
    if (entry && entry.layer) entry.layer.setStyle(styleFor(entry));
    updateReplaceStatusText();
    renderList();
  }

  async function finishReplaceSelection() {
    if (!replaceState || replaceState.phase !== "selecting") return;
    const ids = Array.from(replaceState.selectedIds);
    if (ids.length < 1) {
      alert("Select at least 1 area to replace.");
      return;
    }
    // Last-chance recheck, same reasoning as split/combine - the background
    // poll could be stale, and this is the moment it actually matters since
    // the selected areas are about to disappear locally.
    try {
      await refreshMrLockState();
    } catch (err) {
      // ignore - fall through with whatever lock state we already had
    }
    const selectedEntries = ids.map((id) => entries.get(id)).filter(Boolean);
    const stillBlocked = selectedEntries.find((e) => mrBlockReason(e));
    if (stillBlocked) {
      alert(
        `This area's MapRoulette task is ${mrBlockReason(stillBlocked)} - it can't be replaced. Deselect it (click it again) and try again.`
      );
      return;
    }

    const originalSnapshots = selectedEntries.map((e) => snapshotEntry(e));
    selectedEntries.forEach((e) => removeEntry(e.id));
    replaceState.phase = "drawing";
    replaceState.originalSnapshots = originalSnapshots;
    replaceState.selectedIds = null;
    updateStats();
    renderList();
    updateReplaceStatusText();
  }

  // Reuses the normal "Add new area…" draw flow (see finishDrawing), routed
  // here instead of doAddArea while a replace's drawing phase is active -
  // the new area becomes a real, visible entry right away, but flagged
  // pendingReplace and left out of undoStack/mrAddQueue until "Finish
  // replacing" bundles it (and any siblings) with the originals it replaces.
  function addReplacementArea(points) {
    const ring = points.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

    let feature;
    try {
      feature = turf.polygon([ring]);
    } catch (err) {
      alert("Could not create an area from those points: " + err.message);
      return;
    }

    const { area, compactness } = computeMetrics(feature);
    const snapshot = {
      id: hashString(JSON.stringify(feature.geometry) + ":" + newFeatureCounter++),
      idx: `replace-${replaceState.newSnapshots.length + 1}`,
      feature,
      area,
      compactness,
      mrTaskId: null,
      mrTaskStatus: null,
      mrLocked: false,
      mrActiveLockedBy: null,
      pendingReplace: true,
    };
    replaceState.newSnapshots.push(snapshot);
    restoreEntryFromSnapshot(snapshot);
    updateStats();
    renderList();
    updateReplaceStatusText();
  }

  function finishReplace() {
    if (!replaceState || replaceState.phase !== "drawing") return;
    if (replaceState.newSnapshots.length === 0) {
      alert('Draw at least one replacement area (via "Add new area…") before finishing, or Cancel to back out entirely.');
      return;
    }
    const { originalSnapshots, newSnapshots } = replaceState;
    const groupId = hashString(JSON.stringify(originalSnapshots.map((s) => s.id)) + ":" + newFeatureCounter++);
    replaceQueue.set(groupId, { originalSnapshots, newSnapshots });
    exitReplaceUI();
    replaceState = null;

    undoStack.push({ type: "replace", groupId, originals: originalSnapshots, newSnapshots });
    redoStack = [];
    updateUndoRedoButtons();
    updateReplaceQueueButton();
    updateStats();
    renderList();
  }

  function cancelReplace() {
    if (!replaceState) return;
    if (replaceState.phase === "selecting") {
      // Nothing removed yet - just clear the selection styling.
      const ids = Array.from(replaceState.selectedIds);
      replaceState = null;
      ids.forEach((id) => {
        const entry = entries.get(id);
        if (entry && entry.layer) entry.layer.setStyle(styleFor(entry));
      });
      exitReplaceUI();
      renderList();
      return;
    }
    // "drawing" phase - undo the whole thing: drop any replacements drawn so
    // far (nothing was queued yet) and restore the originals.
    const { originalSnapshots, newSnapshots } = replaceState;
    newSnapshots.forEach((snap) => removeEntry(snap.id));
    originalSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    replaceState = null;
    exitReplaceUI();
    updateStats();
    renderList();
  }

  function exitReplaceUI() {
    appEl.classList.remove("replacing-active");
    drawStatusEl.hidden = true;
    replaceAreaBtn.textContent = "Replace areas…";
  }

  function updateReplaceQueueButton() {
    mrReplaceQueueBtn.textContent = `Process replace queue (${replaceQueue.size})`;
    mrReplaceQueueBtn.disabled = replaceQueue.size === 0;
    updateProcessAllButton();
  }

  // Deletes every task-linked original in a replace-group, then creates a
  // fresh task for every replacement drawn for it - the same "delete old(s),
  // create new(s)" mechanic split uses, just N-to-M instead of 1-to-2.
  // Doesn't do a live lock recheck first (unlike the other queues) since the
  // originals are already gone locally by the time a group reaches this
  // point - there's no entry left to refresh against; a task that became
  // locked in the meantime just fails the delete below and gets reported
  // like any other failure, same as the pre-queue split used to work.
  async function syncReplaceToMapRoulette(originalSnapshots, newSnapshots) {
    // Each original's delete is independent of the others, so they run
    // concurrently rather than one at a time.
    await Promise.all(
      originalSnapshots.map(async (snap) => {
        if (!snap.mrTaskId) return;
        try {
          await mrDeleteTask(snap.mrTaskId);
        } catch (err) {
          // mrRequest's own retries are already exhausted - nothing changed
          // remotely for this one, just a deletion that still needs doing, so
          // it's tracked on its own rather than alerted-and-forgotten.
          mrOrphanedDeleteQueue.add(snap.mrTaskId);
          updateOrphanedDeleteQueueButton();
        }
      })
    );
    // Same for each replacement's create.
    await Promise.all(
      newSnapshots.map(async (snap) => {
        const liveEntry = entries.get(snap.id);
        if (!liveEntry) return; // removed/changed locally before the request resolved
        try {
          const created = await mrCreateTask(liveEntry.feature, liveEntry.lowDensity);
          snap.mrTaskId = created.id;
          liveEntry.mrTaskId = created.id;
          liveEntry.layer.setStyle(styleFor(liveEntry));
        } catch (err) {
          // The original(s) are already gone regardless - queue this
          // replacement for adding instead of leaving it to a manual click.
          mrAddQueue.add(liveEntry.id);
          liveEntry.layer.setStyle(styleFor(liveEntry));
          updateMrAddQueueButton();
        }
      })
    );
  }

  async function processReplaceQueue() {
    const groupIds = Array.from(replaceQueue.keys());
    if (groupIds.length === 0) return;

    mrReplaceQueueBtn.disabled = true;
    let done = 0;
    await runConcurrently(groupIds, async (groupId) => {
      const { originalSnapshots, newSnapshots } = replaceQueue.get(groupId);
      replaceQueue.delete(groupId);
      newSnapshots.forEach((snap) => {
        snap.pendingReplace = false;
        const e = entries.get(snap.id);
        if (e) {
          e.pendingReplace = false;
          e.layer.setStyle(styleFor(e));
        }
      });
      await syncReplaceToMapRoulette(originalSnapshots, newSnapshots);
      done++;
      mrReplaceQueueStatusEl.textContent = `Replacing groups… (${done} of ${groupIds.length} done so far)`;
      renderList();
    });
    mrReplaceQueueStatusEl.textContent = `Done — processed ${done} replace group${done === 1 ? "" : "s"}.`;
    updateReplaceQueueButton();
  }

  function undoReplace(action) {
    action.newSnapshots.forEach((snap) => removeEntry(snap.id));
    replaceQueue.delete(action.groupId);
    action.originals.forEach((snap) => restoreEntryFromSnapshot(snap));
    updateReplaceQueueButton();
    updateStats();
    renderList();
    selectFeature(action.originals[0].id);
    panTo(entries.get(action.originals[0].id));
  }

  function redoReplace(action) {
    action.originals.forEach((snap) => removeEntry(snap.id));
    action.newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    replaceQueue.set(action.groupId, { originalSnapshots: action.originals, newSnapshots: action.newSnapshots });
    updateReplaceQueueButton();
    updateStats();
    renderList();
    selectFeature(action.newSnapshots[0].id);
    panTo(entries.get(action.newSnapshots[0].id));
  }

  // --- Edit boundary (drag existing vertices, opt-in per area) ---
  //
  // Deliberately a separate, explicit mode (entered only via an area's own
  // "Edit boundary…" popup button) rather than always-draggable vertices,
  // so a stray click/drag on the map never silently reshapes something.

  function startEditBoundary(entryId) {
    const entry = entries.get(entryId);
    if (!entry) return;
    if (mrBlockReason(entry)) return; // shouldn't be reachable - the popup omits this button for locked areas
    if (drawState) cancelDrawing();
    if (combineState) cancelCombine();
    if (editState) cancelEditBoundary();
    closeAnyPopup();

    const ring = entry.feature.geometry.coordinates[0].slice(0, -1); // drop the closing duplicate point
    map.removeLayer(entry.layer);
    editState = { id: entryId, vertexMarkers: [], previewLayer: null };
    ring.forEach(([lng, lat]) => {
      const marker = L.marker([lat, lng], { draggable: true, icon: EDIT_VERTEX_ICON });
      marker.on("drag", onEditVertexDrag);
      marker.on("dragend", onEditVertexDrag);
      marker.addTo(map);
      editState.vertexMarkers.push(marker);
    });
    redrawEditPreview();
    appEl.classList.add("editing-active");
    drawStatusEl.hidden = false;
    updateEditStatusText();
  }

  function onEditVertexDrag() {
    if (!editState) return;
    redrawEditPreview();
  }

  function redrawEditPreview() {
    if (!editState) return;
    if (editState.previewLayer) {
      map.removeLayer(editState.previewLayer);
      editState.previewLayer = null;
    }
    const latlngs = editState.vertexMarkers.map((m) => m.getLatLng());
    if (latlngs.length >= 3) {
      editState.previewLayer = L.polygon(latlngs, {
        color: "#1565c0",
        weight: 2,
        dashArray: "4 4",
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(map);
    }
  }

  function updateEditStatusText() {
    if (!editState) return;
    drawStatusText.textContent = "Drag a point to move it, then Finish (Enter) when done.";
  }

  function finishEditBoundary() {
    if (!editState) return;
    const entry = entries.get(editState.id);
    if (!entry) {
      cancelEditBoundary();
      return;
    }
    const points = editState.vertexMarkers.map((m) => {
      const ll = m.getLatLng();
      return [ll.lng, ll.lat];
    });
    const ring = points.slice();
    ring.push(ring[0]);
    let feature;
    try {
      feature = turf.polygon([ring]);
    } catch (err) {
      alert("Could not update this boundary: " + err.message);
      return;
    }

    const entryId = entry.id;
    const beforeFeature = entry.feature;
    const wasEditQueuedBefore = mrEditQueue.has(entryId);
    exitEditUI();
    applyEditedGeometry(entry, feature);
    if (entry.mrTaskId) {
      mrEditQueue.add(entryId);
      updateMrEditQueueButton();
    }

    undoStack.push({ type: "edit", id: entryId, beforeFeature, afterFeature: feature, wasEditQueuedBefore });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();
    selectFeature(entryId);
    panTo(entry);
  }

  function cancelEditBoundary() {
    if (!editState) return;
    const entry = entries.get(editState.id);
    exitEditUI();
    if (entry && entry.layer) entry.layer.addTo(map); // restore the untouched original layer
  }

  function exitEditUI() {
    if (!editState) return;
    editState.vertexMarkers.forEach((m) => map.removeLayer(m));
    if (editState.previewLayer) map.removeLayer(editState.previewLayer);
    appEl.classList.remove("editing-active");
    drawStatusEl.hidden = true;
    editState = null;
  }

  // Applies a (possibly brand new) feature geometry to an existing entry in
  // place - same id, same MapRoulette linkage, just a reshaped boundary.
  // The entry's old layer must already be off the map by the time this runs.
  function applyEditedGeometry(entry, feature) {
    const { area, compactness } = computeMetrics(feature);
    entry.feature = feature;
    entry.area = area;
    entry.compactness = compactness;
    attachLayer(entry);
    if (selectedId === entry.id) updateSelectionPulse();
  }

  function undoEdit(action) {
    const entry = entries.get(action.id);
    if (!entry) return;
    map.removeLayer(entry.layer);
    applyEditedGeometry(entry, action.beforeFeature);
    if (!action.wasEditQueuedBefore) {
      mrEditQueue.delete(action.id);
      updateMrEditQueueButton();
    }
    updateStats();
    renderList();
    selectFeature(action.id);
    panTo(entry);
  }

  function redoEdit(action) {
    const entry = entries.get(action.id);
    if (!entry) return;
    map.removeLayer(entry.layer);
    applyEditedGeometry(entry, action.afterFeature);
    if (entry.mrTaskId) {
      mrEditQueue.add(action.id);
      updateMrEditQueueButton();
    }
    updateStats();
    renderList();
    selectFeature(action.id);
    panTo(entry);
  }

  // Flips the low-density exemption on an already-loaded entry. Purely a
  // property change (the geometry doesn't move), but if the entry is
  // task-linked, MapRoulette's copy of it still needs to be recreated to
  // pick up the new property (there's no in-place update used anywhere in
  // this app) - reuses the boundary-edit queue/mechanism for that, since
  // "delete the old task, create a fresh one reflecting the entry's current
  // state" is exactly what it already does, regardless of what changed.
  function toggleLowDensity(entry) {
    const before = entry.lowDensity;
    entry.lowDensity = !before;
    entry.layer.setStyle(styleFor(entry));
    const wasEditQueuedBefore = mrEditQueue.has(entry.id);
    if (entry.mrTaskId) {
      mrEditQueue.add(entry.id);
      updateMrEditQueueButton();
    }
    undoStack.push({ type: "low-density", id: entry.id, before, after: entry.lowDensity, wasEditQueuedBefore });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();
  }

  function undoLowDensity(action) {
    const entry = entries.get(action.id);
    if (!entry) return;
    entry.lowDensity = action.before;
    entry.layer.setStyle(styleFor(entry));
    if (!action.wasEditQueuedBefore) {
      mrEditQueue.delete(action.id);
      updateMrEditQueueButton();
    }
    updateStats();
    renderList();
    selectFeature(action.id);
    panTo(entry);
  }

  function redoLowDensity(action) {
    const entry = entries.get(action.id);
    if (!entry) return;
    entry.lowDensity = action.after;
    entry.layer.setStyle(styleFor(entry));
    if (entry.mrTaskId) {
      mrEditQueue.add(action.id);
      updateMrEditQueueButton();
    }
    updateStats();
    renderList();
    selectFeature(action.id);
    panTo(entry);
  }

  // --- Drawing controller (shared by split-line and add-new-area) ---

  function startDrawing(type, targetId) {
    if (drawState) cancelDrawing();
    if (combineState) cancelCombine();
    if (editState) cancelEditBoundary();
    closeAnyPopup();
    drawState = { type, targetId, points: [], previewLayer: null, vertexMarkers: [] };
    map.doubleClickZoom.disable();
    appEl.classList.add("drawing-active");
    drawStatusEl.hidden = false;
    updateDrawStatusText();
    map.on("click", onDrawMapClick);
    map.on("mousemove", onDrawMouseMove);
    map.on("dblclick", finishDrawing);
    if (type === "add") addAreaBtn.textContent = "Cancel adding…";
  }

  function updateDrawStatusText() {
    if (!drawState) return;
    const need = drawState.type === "split" ? 2 : 3;
    const verb = drawState.type === "split" ? "Draw a line across the area to split it" : "Draw the new area's outline";
    drawStatusText.textContent = `${verb} — click to add points (${drawState.points.length} so far, need at least ${need}).`;
  }

  function onDrawMapClick(e) {
    if (!drawState) return;
    drawState.points.push([e.latlng.lng, e.latlng.lat]);
    redrawDrawPreview();
    updateDrawStatusText();
  }

  function onDrawMouseMove(e) {
    if (!drawState || drawState.points.length === 0) return;
    redrawDrawPreview(e.latlng);
  }

  function redrawDrawPreview(cursorLatLng) {
    if (drawState.previewLayer) {
      map.removeLayer(drawState.previewLayer);
      drawState.previewLayer = null;
    }
    const latlngs = drawState.points.map(([lng, lat]) => [lat, lng]);
    if (cursorLatLng) latlngs.push([cursorLatLng.lat, cursorLatLng.lng]);
    // interactive: false so these purely-visual overlays never swallow the
    // clicks/moves that the drawing controller needs to receive itself.
    if (drawState.type === "add" && latlngs.length >= 3) {
      drawState.previewLayer = L.polygon(latlngs, {
        color: "#333",
        weight: 2,
        dashArray: "4 4",
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(map);
    } else if (latlngs.length >= 2) {
      drawState.previewLayer = L.polyline(latlngs, {
        color: "#333",
        weight: 2,
        dashArray: "4 4",
        interactive: false,
      }).addTo(map);
    }
    drawState.vertexMarkers.forEach((m) => map.removeLayer(m));
    drawState.vertexMarkers = drawState.points.map(([lng, lat]) =>
      L.circleMarker([lat, lng], {
        radius: 4,
        color: "#333",
        weight: 1,
        fillColor: "#fff",
        fillOpacity: 1,
        interactive: false,
      }).addTo(map)
    );
  }

  function finishDrawing() {
    if (!drawState) return;
    const minPoints = drawState.type === "split" ? 2 : 3;
    if (drawState.points.length < minPoints) {
      alert(`Add at least ${minPoints} points before finishing.`);
      return;
    }
    const { type, targetId, points } = drawState;
    const inReplaceDrawing = replaceState && replaceState.phase === "drawing";
    cancelDrawing();
    if (type === "split") queueSplit(targetId, points);
    else if (inReplaceDrawing) addReplacementArea(points);
    else doAddArea(points);
  }

  function cancelDrawing() {
    if (!drawState) return;
    if (drawState.previewLayer) map.removeLayer(drawState.previewLayer);
    drawState.vertexMarkers.forEach((m) => map.removeLayer(m));
    map.off("click", onDrawMapClick);
    map.off("mousemove", onDrawMouseMove);
    map.off("dblclick", finishDrawing);
    map.doubleClickZoom.enable();
    appEl.classList.remove("drawing-active");
    addAreaBtn.textContent = "Add new area…";
    drawState = null;
    if (replaceState) {
      // Still mid-replace (drawing phase) - restore its own status text
      // instead of hiding the bar, since one polygon finishing/canceling
      // doesn't end the whole replace operation.
      drawStatusEl.hidden = false;
      updateReplaceStatusText();
    } else {
      drawStatusEl.hidden = true;
    }
  }

  function recomputeCategoriesAndRender() {
    entries.forEach((entry) => {
      if (entry.layer) entry.layer.setStyle(styleFor(entry));
    });
    updateStats();
    renderList();
  }

  function updateStats() {
    let normal = 0, oversized = 0, undersized = 0;
    entries.forEach((e) => {
      // Mirrors category()'s own low-density exemption - without this check
      // here too, a low-density area would render as normal (blue) on the
      // map but still get counted as oversized/undersized in these totals.
      if (e.lowDensity) normal++;
      else if (e.area >= targetAreaLimit) oversized++;
      else if (e.area <= targetAreaLimit * 0.5) undersized++;
      else normal++;
    });
    const total = entries.size;
    statsEl.innerHTML = `
      <div>Total: ${total}</div>
      <div>Normal: ${normal}</div>
      <div>Oversized (needs split): ${oversized}</div>
      <div>Undersized (needs combine): ${undersized}</div>
    `;
    document.querySelector('[data-count="all"]').textContent = total;
    document.querySelector('[data-count="oversized"]').textContent = oversized;
    document.querySelector('[data-count="undersized"]').textContent = undersized;
    document.querySelector('[data-count="normal"]').textContent = normal;
  }

  function currentFilter() {
    const checked = document.querySelector('input[name="filter"]:checked');
    return checked ? checked.value : "all";
  }

  function filteredSortedIds() {
    const filter = currentFilter();
    return orderedIds
      .filter((id) => {
        const e = entries.get(id);
        if (filter === "all") return true;
        return category(e) === filter;
      })
      .sort((a, b) => entries.get(a).area - entries.get(b).area);
  }

  function renderList() {
    const ids = filteredSortedIds();
    featureListEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    ids.forEach((id) => {
      const e = entries.get(id);
      const isCombineSelected = combineState && combineState.selectedIds.has(id);
      const isReplaceSelected = replaceState && replaceState.phase === "selecting" && replaceState.selectedIds.has(id);
      const isMrDeleteQueued = mrDeleteQueue.has(id);
      const isMrAddQueued = mrAddQueue.has(id);
      const isMrEditQueued = mrEditQueue.has(id);
      const isSplitQueued = e.pendingSplitGroup != null;
      const isReplaceQueued = e.pendingReplace === true;
      const isMrCombineQueued = e.pendingCombineGroup != null;
      const row = document.createElement("div");
      row.className =
        "feature-row" +
        (id === selectedId ? " selected" : "") +
        (isCombineSelected ? " combine-selected" : "") +
        (isReplaceSelected ? " replace-selected" : "") +
        (isMrDeleteQueued ? " mr-delete-queued" : "") +
        (isMrAddQueued ? " mr-add-queued" : "") +
        (isMrEditQueued ? " mr-edit-queued" : "") +
        (isSplitQueued ? " mr-split-queued" : "") +
        (isReplaceQueued ? " mr-replace-queued" : "") +
        (isMrCombineQueued ? " mr-combine-queued" : "");
      row.dataset.id = id;
      row.innerHTML = `
        <span class="status-dot ${category(e)}"></span>
        <span class="meta">
          <span class="id">#${e.idx}</span>
          <span>${e.area.toFixed(0)} m&sup2;</span>
          <span>${e.compactness.toFixed(2)}</span>
        </span>
      `;
      row.addEventListener("click", () => {
        if (combineState) {
          toggleCombineSelection(id);
          return;
        }
        if (replaceState) {
          if (replaceState.phase === "selecting") toggleReplaceSelection(id);
          return; // drawing phase - finish or cancel the replace in progress first
        }
        if (editState) return; // finish or cancel the boundary edit in progress first
        selectFeature(id);
        panTo(e);
        openPopup(e);
      });
      frag.appendChild(row);
    });
    featureListEl.appendChild(frag);
  }

  function panTo(entry) {
    const b = entry.layer.getBounds();
    if (b.isValid()) map.fitBounds(b, { maxZoom: 19, padding: [40, 40] });
  }

  function selectFeature(id) {
    const prev = selectedId;
    selectedId = id;
    if (prev && entries.has(prev)) entries.get(prev).layer.setStyle(styleFor(entries.get(prev)));
    if (entries.has(id)) entries.get(id).layer.setStyle(styleFor(entries.get(id)));
    if (prev !== id) updateSelectionPulse();
    renderList();
  }

  function selectRelative(delta) {
    const ids = filteredSortedIds();
    if (!ids.length) return;
    const currentIndex = selectedId ? ids.indexOf(selectedId) : -1;
    let next = currentIndex + delta;
    if (next < 0) next = 0;
    if (next >= ids.length) next = ids.length - 1;
    const id = ids[next];
    const e = entries.get(id);
    selectFeature(id);
    panTo(e);
    openPopup(e);
  }

  // Test-only hook (see tests/mr-edit-boundary.js) - there's no
  // export/download path in this page to inspect resulting geometry otherwise.
  window.__blockTriageGetEntries = () => entries;

  // Test-only hook (see tests/mr-max-concurrent.js) - the semaphore itself
  // has no visible effect in the UI unless multiple requests actually
  // overlap, which none of today's queues do on their own.
  window.__blockTriageMrSlotTest = { acquireMrSlot, releaseMrSlot, getActive: () => mrActiveRequests };
})();
