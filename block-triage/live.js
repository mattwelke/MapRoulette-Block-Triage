(function () {
  "use strict";

  const COLORS = {
    unreviewed: "#3388ff",
    flagged: "#ff9800",
    locked: "#9e9e9e",
    "active-lock": "#6d4c41",
  };

  // Tasks already resolved on MapRoulette - read straight from the loaded
  // data, not a live status. Locked areas can still be clicked to see their
  // status, but not split, combined, or removed - there's nothing left to do
  // with an already-fixed task structurally, and doing so would just create
  // more work for someone re-reviewing it.
  const LOCKED_TASK_STATUSES = new Set(["fixed", "already fixed"]);

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
  const MR_DELETE_PACE_MS = 400; // pause between deletes when processing the queue
  let mrQuickQueueDeleteMode = localStorage.getItem("block-triage:mrQuickQueueDeleteMode") === "true";

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
  let thresholds = loadThresholds();
  let newFeatureCounter = 0;
  let addedAreaCounter = 0;
  let undoStack = [];
  let redoStack = [];
  /** @type {null | {type: "split"|"add", targetId?: string, points: [number,number][], previewLayer: L.Layer|null, vertexMarkers: L.Layer[]}} */
  let drawState = null;
  /** @type {null | {selectedIds: Set<string>}} */
  let combineState = null;

  const map = L.map("map", { preferCanvas: true }).setView([43.45, -79.68], 12);
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const esriImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "Tiles &copy; Esri" }
  );
  // Purely visual: holds whatever the user loads via "Load reference layer...".
  // Never interactive, never part of entries/undo - just context to look at
  // (e.g. a local GeoJSON of building footprints) while editing the live
  // MapRoulette challenge.
  const referenceLayerGroup = L.layerGroup();
  L.control.layers({ "OpenStreetMap": osm, "Aerial (Esri)": esriImagery }, { "Reference layer": referenceLayerGroup }).addTo(map);

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

  const statsEl = document.getElementById("stats");
  const featureListEl = document.getElementById("feature-list");
  const areaThresholdInput = document.getElementById("area-threshold");
  const compactnessThresholdInput = document.getElementById("compactness-threshold");
  const appEl = document.getElementById("app");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const addAreaBtn = document.getElementById("add-area-btn");
  const combineAreaBtn = document.getElementById("combine-area-btn");
  const drawStatusEl = document.getElementById("draw-status");
  const drawStatusText = document.getElementById("draw-status-text");
  const drawFinishBtn = document.getElementById("draw-finish-btn");
  const drawCancelBtn = document.getElementById("draw-cancel-btn");
  const referenceFileInput = document.getElementById("reference-file-input");
  const referenceFileNameEl = document.getElementById("reference-file-name");
  const clearReferenceBtn = document.getElementById("clear-reference-btn");
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
  const mrQuickQueueCheckbox = document.getElementById("mr-quick-queue-checkbox");

  mrApiKeyInput.value = mrApiKey;
  mrChallengeIdInput.value = mrChallengeId;
  updateMrBanner();
  updateMrQueueButton();
  scheduleMrLockPoll();
  mrQueueBtn.addEventListener("click", processMrDeleteQueue);

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

  areaThresholdInput.value = thresholds.area;
  compactnessThresholdInput.value = thresholds.compactness;

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
  drawFinishBtn.addEventListener("click", () => {
    if (drawState) finishDrawing();
    else if (combineState) finishCombine();
  });
  drawCancelBtn.addEventListener("click", () => {
    if (drawState) cancelDrawing();
    else if (combineState) cancelCombine();
  });

  areaThresholdInput.addEventListener("input", () => {
    thresholds.area = Number(areaThresholdInput.value) || 0;
    saveThresholds();
    recomputeFlagsAndRender();
  });
  compactnessThresholdInput.addEventListener("input", () => {
    thresholds.compactness = Number(compactnessThresholdInput.value) || 0;
    saveThresholds();
    recomputeFlagsAndRender();
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

  function loadThresholds() {
    try {
      const stored = JSON.parse(localStorage.getItem("block-triage:thresholds"));
      if (stored && typeof stored.area === "number" && typeof stored.compactness === "number") {
        return stored;
      }
    } catch (e) {}
    return { area: 150, compactness: 0.15 };
  }

  function saveThresholds() {
    localStorage.setItem("block-triage:thresholds", JSON.stringify(thresholds));
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
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Mirrors a quick-exclude-style click-to-toggle interaction, but for the
  // delete queue: a quick way to mark a whole run of already-resolved-looking
  // areas for removal while triaging, without opening a popup for each one.
  // Only ever queues - actual deletion still requires "Process delete queue".
  function toggleQuickQueueDelete(entry) {
    const blockReason = mrBlockReason(entry);
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
    const ok = confirm(
      `This will permanently delete ${ids.length} task${ids.length === 1 ? "" : "s"} from MapRoulette, one at a time. Continue?`
    );
    if (!ok) return;

    mrQueueBtn.disabled = true;
    let done = 0;
    let failed = 0;
    let skippedLocked = 0;
    for (const id of ids) {
      done++;
      mrDeleteQueue.delete(id);
      const entry = entries.get(id);
      if (!entry || !entry.mrTaskId) {
        continue; // already gone or unlinked by some other means in the meantime
      }

      // Just-in-time recheck - the queue may have sat around a while, and
      // someone could have picked up this exact task in the meantime. Only
      // the lock endpoint is refetched (not a full reload), so this is
      // cheap; best-effort if it fails, since the delete attempt itself is
      // the final word either way.
      try {
        await refreshMrLockState();
      } catch (err) {
        // ignore - fall through with whatever lock state we already had
      }
      const blockReason = mrBlockReason(entry);
      if (blockReason) {
        skippedLocked++;
        mrQueueStatusEl.textContent = `Skipped task ${entry.mrTaskId} (${done} of ${ids.length}): ${blockReason}.`;
        entry.layer.setStyle(styleFor(entry)); // drop the "queued" look, it's back to just linked
        updateStats();
        renderList();
        if (done < ids.length) await sleep(MR_DELETE_PACE_MS);
        continue;
      }

      mrQueueStatusEl.textContent = `Deleting ${done} of ${ids.length} (task ${entry.mrTaskId})…`;
      try {
        await mrDeleteTask(entry.mrTaskId);
        removeEntry(entry.id);
      } catch (err) {
        failed++;
        entry.layer.setStyle(styleFor(entry)); // drop the "queued" look, it's back to just linked
      }
      updateStats();
      renderList();
      if (done < ids.length) await sleep(MR_DELETE_PACE_MS);
    }
    const deleted = done - failed - skippedLocked;
    const parts = [`deleted ${deleted} of ${done}`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skippedLocked > 0) parts.push(`${skippedLocked} skipped (now locked)`);
    mrQueueStatusEl.textContent =
      failed === 0 && skippedLocked === 0
        ? `Done — deleted ${deleted} task${deleted === 1 ? "" : "s"}.`
        : `Done — ${parts.join(", ")}; anything not deleted is still linked locally (click "Remove task from challenge" on it again to retry).`;
    updateMrQueueButton();
  }

  function parseMrTaskId(feature) {
    const raw = feature.properties && feature.properties.mr_taskId;
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // --- MapRoulette API ---

  async function mrRequest(path, options) {
    if (!mrApiKey) throw new Error("Set your MapRoulette API key first.");
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
      throw new Error(`MapRoulette API ${res.status}: ${detail || res.statusText}`);
    }
    if (res.status === 204 || res.status === 304) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
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

  async function mrCreateTask(feature) {
    if (!mrChallengeId) throw new Error("Set a Challenge ID first.");
    const body = {
      name: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parent: Number(mrChallengeId),
      geometries: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: feature.geometry, properties: {} }],
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
      recomputeFlagsAndRender();
      addAreaBtn.disabled = false;
      combineAreaBtn.disabled = false;
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
          `Last checked ${new Date().toLocaleTimeString()} — ` +
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
    if (entry.flagged) return "flagged";
    return "unreviewed";
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
    if (mrDeleteQueue.has(entry.id)) {
      return { color: "#b71c1c", weight: 4, dashArray: "2 4", fillColor: color, fillOpacity: 0.35 };
    }
    const isSelected = entry.id === selectedId;
    return {
      color: isSelected ? "#000" : color,
      weight: isSelected ? 3 : 1.5,
      // setStyle() merges rather than replaces, so dashArray must be explicitly
      // cleared here or a prior combine-selection dash pattern would stick.
      dashArray: null,
      fillColor: color,
      fillOpacity: cat === "flagged" ? 0.4 : 0.15,
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
    const blockReason = mrBlockReason(entry);
    const div = document.createElement("div");
    div.innerHTML = `
      <div><strong>Feature #${entry.idx}</strong></div>
      <div>Area: ${entry.area.toFixed(1)} m&sup2;</div>
      <div>Compactness: ${entry.compactness.toFixed(3)}</div>
      ${
        blockReason
          ? `<div class="mr-locked-note">&#128274; ${
              entry.mrLocked
                ? `MapRoulette status: <strong>${formatMrTaskStatus(entry.mrTaskStatus)}</strong>`
                : `Currently checked out on MapRoulette`
            } — locked. Split and remove are disabled while this is the case.</div>`
          : ""
      }
      ${blockReason ? "" : `<div class="popup-actions"><button data-split>Split&hellip;</button></div>`}
      ${blockReason ? "" : `<div class="popup-actions"><button data-mr-action></button></div><div class="mr-inline-status" data-mr-status></div>`}
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
          const ok = confirm(
            `This area is linked to MapRoulette task ${entry.mrTaskId}. Splitting it will delete that task and create two new ones on MapRoulette once you finish drawing the cut. Continue?`
          );
          if (!ok) return;
        }
        map.closePopup();
        startDrawing("split", entry.id);
      });
    }

    if (blockReason) {
      const center = entry.layer.getBounds().getCenter();
      L.popup().setLatLng(center).setContent(div).openOn(map);
      return;
    }

    const mrBtn = div.querySelector("[data-mr-action]");
    const mrStatusInline = div.querySelector("[data-mr-status]");
    const updateMrButton = () => {
      if (mrDeleteQueue.has(entry.id)) {
        mrBtn.textContent = "Cancel pending removal";
      } else {
        mrBtn.textContent = entry.mrTaskId ? "Remove task from challenge" : "Add task to challenge";
      }
    };
    updateMrButton();
    mrBtn.addEventListener("click", async () => {
      // Queueing/dequeueing is fully reversible (nothing's deleted yet), so
      // no confirmation here - that happens once, for the whole batch, when
      // actually processing the queue.
      if (mrDeleteQueue.has(entry.id)) {
        mrDeleteQueue.delete(entry.id);
        entry.layer.setStyle(styleFor(entry));
        mrStatusInline.textContent = "Removed from the delete queue.";
        updateMrButton();
        updateMrQueueButton();
        renderList();
        return;
      }
      if (entry.mrTaskId) {
        mrDeleteQueue.add(entry.id);
        entry.layer.setStyle(styleFor(entry));
        mrStatusInline.textContent = 'Queued for removal — use "Process delete queue" in the sidebar to actually delete it.';
        updateMrButton();
        updateMrQueueButton();
        renderList();
        return;
      }
      mrBtn.disabled = true;
      mrStatusInline.textContent = "Adding to MapRoulette…";
      try {
        const created = await mrCreateTask(entry.feature);
        entry.mrTaskId = created.id;
        mrStatusInline.textContent = `Added as MapRoulette task ${created.id}.`;
      } catch (err) {
        mrStatusInline.textContent = "Failed: " + err.message;
      } finally {
        if (entries.has(entry.id)) {
          mrBtn.disabled = false;
          updateMrButton();
        }
      }
    });

    const center = entry.layer.getBounds().getCenter();
    L.popup().setLatLng(center).setContent(div).openOn(map);
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    if (action.type === "split") undoSplit(action);
    else if (action.type === "add") undoAdd(action);
    else if (action.type === "combine") undoCombine(action);
    redoStack.push(action);
    updateUndoRedoButtons();
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    if (action.type === "split") redoSplit(action);
    else if (action.type === "add") redoAdd(action);
    else if (action.type === "combine") redoCombine(action);
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
    };
  }

  function restoreEntryFromSnapshot(snapshot) {
    const entry = Object.assign({}, snapshot, { layer: null });
    entry.flagged = entry.area < thresholds.area || entry.compactness < thresholds.compactness;
    entries.set(entry.id, entry);
    orderedIds.push(entry.id);
    attachLayer(entry);
    return entry;
  }

  // --- Split ---

  function doSplit(targetId, points) {
    const entry = entries.get(targetId);
    if (!entry) return;
    const blockReason = mrBlockReason(entry);
    if (blockReason) {
      alert(`This area's MapRoulette task is ${blockReason} - it can't be split.`);
      return;
    }

    let diffResult;
    try {
      const cutLine = turf.lineString(points);
      const knife = turf.buffer(cutLine, 0.0005, { units: "kilometers" }); // ~1m wide knife
      diffResult = turf.difference(turf.featureCollection([entry.feature, knife]));
    } catch (err) {
      alert("Could not compute the split: " + err.message);
      return;
    }
    if (!diffResult) {
      alert("That cut line doesn't appear to cross this area.");
      return;
    }
    const parts = turf.flatten(diffResult).features.filter((f) => f.geometry && f.geometry.type === "Polygon");
    if (parts.length < 2) {
      alert(
        "That cut didn't fully divide the area into two separate pieces. Try drawing the line all the way across it, past both edges."
      );
      return;
    }

    const originalSnapshot = snapshotEntry(entry);
    removeEntry(targetId);

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
      };
    });
    newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));

    undoStack.push({ type: "split", original: originalSnapshot, newSnapshots });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();

    selectFeature(newSnapshots[0].id);
    panTo(entries.get(newSnapshots[0].id));

    // The local split is done; MapRoulette sync (if this area was a task) is
    // a separate, non-blocking follow-up - failures here don't undo the
    // local split (undo/redo never touch MapRoulette either, see the README).
    if (originalSnapshot.mrTaskId) {
      syncSplitToMapRoulette(originalSnapshot, newSnapshots);
    }
  }

  async function syncSplitToMapRoulette(originalSnapshot, newSnapshots) {
    try {
      await mrDeleteTask(originalSnapshot.mrTaskId);
    } catch (err) {
      alert(
        `Split completed locally, but removing MapRoulette task ${originalSnapshot.mrTaskId} failed: ${err.message}. It may still exist on MapRoulette; you may want to remove it manually.`
      );
      return;
    }
    for (const snap of newSnapshots) {
      const liveEntry = entries.get(snap.id);
      if (!liveEntry) continue; // this piece was removed/changed locally before the request resolved
      try {
        const created = await mrCreateTask(liveEntry.feature);
        snap.mrTaskId = created.id;
        liveEntry.mrTaskId = created.id;
      } catch (err) {
        alert(
          `The original MapRoulette task was removed, but creating a new task for one split piece failed: ${err.message}. Use that area's "Add task to challenge" button to retry.`
        );
      }
    }
  }

  function undoSplit(action) {
    action.newSnapshots.forEach((snap) => removeEntry(snap.id));
    restoreEntryFromSnapshot(action.original);
    updateStats();
    renderList();
    selectFeature(action.original.id);
    panTo(entries.get(action.original.id));
  }

  function redoSplit(action) {
    removeEntry(action.original.id);
    action.newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
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
    };
    restoreEntryFromSnapshot(snapshot);

    undoStack.push({ type: "add", snapshot });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();
    selectFeature(snapshot.id);
  }

  function undoAdd(action) {
    removeEntry(action.snapshot.id);
    updateStats();
    renderList();
  }

  function redoAdd(action) {
    restoreEntryFromSnapshot(action.snapshot);
    updateStats();
    renderList();
    selectFeature(action.snapshot.id);
  }

  // --- Combine areas ---

  function startCombine() {
    if (drawState) cancelDrawing();
    map.closePopup();
    combineState = { selectedIds: new Set() };
    appEl.classList.add("combining-active");
    drawStatusEl.hidden = false;
    updateCombineStatusText();
    combineAreaBtn.textContent = "Cancel combining…";
  }

  function updateCombineStatusText() {
    if (!combineState) return;
    const n = combineState.selectedIds.size;
    drawStatusText.textContent = `Click 2 or more areas to merge (${n} selected so far). Areas that don't touch will be bridged, not rejected.`;
  }

  function toggleCombineSelection(id) {
    if (!combineState) return;
    const entry = entries.get(id);
    const blockReason = entry && !combineState.selectedIds.has(id) ? mrBlockReason(entry) : null;
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

    // First try an adjacency-preserving union - handles the common case of
    // areas that already touch or overlap (or are separated only by a
    // split's ~1m knife gap - see doSplit) without changing their shape at
    // all. Buffer out slightly, union, then buffer back in by the same
    // amount ("morphological closing") so that gap doesn't produce a
    // MultiPolygon.
    const CLOSE_DISTANCE_KM = 0.001; // 1m — just past the split knife's ~0.5m radius
    let combined = null;
    try {
      const closed = targetEntries.map((e) => turf.buffer(e.feature, CLOSE_DISTANCE_KM, { units: "kilometers" }));
      let unionResult = turf.union(turf.featureCollection(closed));
      if (unionResult) unionResult = turf.buffer(unionResult, -CLOSE_DISTANCE_KM, { units: "kilometers" });
      const parts = unionResult ? turf.flatten(unionResult).features.filter((f) => f.geometry && f.geometry.type === "Polygon") : [];
      if (parts.length === 1) combined = parts[0];
    } catch (err) {
      alert("Could not combine these areas: " + err.message);
      return;
    }

    // Areas that are genuinely far apart won't touch even after closing -
    // bridge the gap instead of rejecting: the combined area becomes the
    // convex hull spanning all of them, so the empty space between them
    // becomes part of the new single area too.
    if (!combined) {
      try {
        combined = turf.convex(turf.featureCollection(targetEntries.map((e) => e.feature)));
      } catch (err) {
        alert("Could not combine these areas: " + err.message);
        return;
      }
    }
    if (!combined) {
      alert("Could not combine these areas.");
      return;
    }

    const { area, compactness } = computeMetrics(combined);

    const originalSnapshots = targetEntries.map(snapshotEntry);
    originalSnapshots.forEach((snap) => removeEntry(snap.id));

    const newSnapshot = {
      id: hashString(JSON.stringify(combined.geometry) + ":" + newFeatureCounter++),
      idx: originalSnapshots.map((s) => s.idx).join("+"),
      feature: combined,
      area,
      compactness,
      // The constituent areas' MapRoulette tasks (if any) are left untouched
      // remotely, and the merged result starts unlinked - use its own "Add
      // task to challenge" button if you want to link it to a fresh task.
      mrTaskId: null,
      mrTaskStatus: null,
      mrLocked: false,
      mrActiveLockedBy: null,
    };
    restoreEntryFromSnapshot(newSnapshot);

    undoStack.push({ type: "combine", originals: originalSnapshots, newSnapshot });
    redoStack = [];
    updateUndoRedoButtons();
    updateStats();
    renderList();

    selectFeature(newSnapshot.id);
    panTo(entries.get(newSnapshot.id));
  }

  function undoCombine(action) {
    removeEntry(action.newSnapshot.id);
    action.originals.forEach((snap) => restoreEntryFromSnapshot(snap));
    updateStats();
    renderList();
    selectFeature(action.originals[0].id);
    panTo(entries.get(action.originals[0].id));
  }

  function redoCombine(action) {
    action.originals.forEach((snap) => removeEntry(snap.id));
    restoreEntryFromSnapshot(action.newSnapshot);
    updateStats();
    renderList();
    selectFeature(action.newSnapshot.id);
    panTo(entries.get(action.newSnapshot.id));
  }

  // --- Drawing controller (shared by split-line and add-new-area) ---

  function startDrawing(type, targetId) {
    if (drawState) cancelDrawing();
    if (combineState) cancelCombine();
    map.closePopup();
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
    cancelDrawing();
    if (type === "split") doSplit(targetId, points);
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
    drawStatusEl.hidden = true;
    addAreaBtn.textContent = "Add new area…";
    drawState = null;
  }

  function recomputeFlagsAndRender() {
    entries.forEach((entry) => {
      entry.flagged = entry.area < thresholds.area || entry.compactness < thresholds.compactness;
      if (entry.layer) entry.layer.setStyle(styleFor(entry));
    });
    updateStats();
    renderList();
  }

  function updateStats() {
    let unreviewed = 0, flagged = 0;
    entries.forEach((e) => {
      if (e.flagged) flagged++;
      else unreviewed++;
    });
    const total = entries.size;
    statsEl.innerHTML = `
      <div>Total: ${total}</div>
      <div>Unreviewed: ${unreviewed}</div>
      <div>Flagged, undecided: ${flagged}</div>
    `;
    document.querySelector('[data-count="all"]').textContent = total;
    document.querySelector('[data-count="flagged"]').textContent = flagged;
    document.querySelector('[data-count="unreviewed"]').textContent = unreviewed;
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
        if (filter === "flagged") return e.flagged;
        if (filter === "unreviewed") return !e.flagged;
        return true;
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
      const isMrQueued = mrDeleteQueue.has(id);
      const row = document.createElement("div");
      row.className =
        "feature-row" +
        (id === selectedId ? " selected" : "") +
        (isCombineSelected ? " combine-selected" : "") +
        (isMrQueued ? " mr-delete-queued" : "");
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
})();
