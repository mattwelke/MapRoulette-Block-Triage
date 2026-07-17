(function () {
  "use strict";

  const COLORS = {
    unreviewed: "#3388ff",
    flagged: "#ff9800",
    excluded: "#e53935",
    kept: "#43a047",
  };

  // Written into each kept feature's properties on export so a re-imported
  // (round-tripped) file can recognize prior decisions without relying on
  // localStorage. Namespaced and underscore-prefixed to avoid colliding with
  // anything MapRoulette itself reads out of task GeoJSON properties.
  const STATUS_PROPERTY = "_blockTriageStatus";

  const MR_API_BASE = "https://maproulette.org/api/v2";
  let mrApiKey = localStorage.getItem("block-triage:mrApiKey") || "";
  let mrChallengeId = localStorage.getItem("block-triage:mrChallengeId") || "";
  let mrLiveSync = localStorage.getItem("block-triage:mrLiveSync") === "true";

  /** @type {Map<string, {id:string, idx:number, feature:object, layer:L.Layer, area:number, compactness:number, status:string}>} */
  let entries = new Map();
  let orderedIds = []; // insertion order == original feature order
  let fileKey = null;
  let raw = null; // parsed geojson, kept so we can preserve top-level fields on export
  let selectedId = null;
  let thresholds = loadThresholds();
  let quickExcludeMode = localStorage.getItem("block-triage:quickExcludeMode") === "true";
  let undoStack = [];
  let redoStack = [];
  let newFeatureCounter = 0;
  let addedAreaCounter = 0;
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
  const oakvilleAddresses = L.tileLayer(
    "https://skfd.github.io/oakville-address-layer/tiles/raster/{z}/{x}/{y}.png",
    { maxZoom: 20, attribution: "Oakville address layer by skfd" }
  );
  // Purely visual: holds whatever the user loads via "Load reference layer...".
  // Never interactive, never part of entries/undo/export - just context to look
  // at while triaging the actual working dataset.
  const referenceLayerGroup = L.layerGroup();
  L.control
    .layers(
      { "OpenStreetMap": osm, "Aerial (Esri)": esriImagery },
      { "Oakville addresses (skfd)": oakvilleAddresses, "Reference layer": referenceLayerGroup }
    )
    .addTo(map);

  // The working areas use the canvas renderer (set via preferCanvas above, for
  // performance with thousands of features), but canvas can't do SVG pattern
  // fills. The reference layer's inner-border band needs one, so it gets its
  // own dedicated SVG renderer. Added immediately (rather than lazily) so the
  // <svg> element - and the tessellation pattern injected into it - exist
  // before any reference file is ever loaded.
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

  const fileInput = document.getElementById("file-input");
  const newBlankBtn = document.getElementById("new-blank-btn");
  const fileNameEl = document.getElementById("file-name");
  const exportBtn = document.getElementById("export-btn");
  const statsEl = document.getElementById("stats");
  const featureListEl = document.getElementById("feature-list");
  const areaThresholdInput = document.getElementById("area-threshold");
  const compactnessThresholdInput = document.getElementById("compactness-threshold");
  const quickExcludeCheckbox = document.getElementById("quick-exclude-checkbox");
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
  const mrLiveSyncCheckbox = document.getElementById("mr-live-sync-checkbox");
  const mrLivePanel = document.getElementById("mr-live-panel");
  const mrLiveBanner = document.getElementById("mr-live-banner");
  const mrLiveBannerChallenge = document.getElementById("mr-live-banner-challenge");

  mrApiKeyInput.value = mrApiKey;
  mrChallengeIdInput.value = mrChallengeId;
  mrLiveSyncCheckbox.checked = mrLiveSync;
  updateMrLiveSyncUI();

  mrLiveSyncCheckbox.addEventListener("change", () => {
    mrLiveSync = mrLiveSyncCheckbox.checked;
    localStorage.setItem("block-triage:mrLiveSync", String(mrLiveSync));
    updateMrLiveSyncUI();
  });
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
    updateMrLiveSyncUI();
  });
  mrTestBtn.addEventListener("click", mrTestConnection);

  areaThresholdInput.value = thresholds.area;
  compactnessThresholdInput.value = thresholds.compactness;
  quickExcludeCheckbox.checked = quickExcludeMode;
  appEl.classList.toggle("quick-exclude-active", quickExcludeMode);

  quickExcludeCheckbox.addEventListener("change", () => {
    quickExcludeMode = quickExcludeCheckbox.checked;
    localStorage.setItem("block-triage:quickExcludeMode", String(quickExcludeMode));
    appEl.classList.toggle("quick-exclude-active", quickExcludeMode);
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file);
  });
  newBlankBtn.addEventListener("click", startBlankSession);
  referenceFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadReferenceLayer(file);
  });
  clearReferenceBtn.addEventListener("click", clearReferenceLayer);

  exportBtn.addEventListener("click", exportFiltered);
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
    if (e.key === "x") setStatus(selectedId, "excluded");
    else if (e.key === "g") setStatus(selectedId, "kept");
    else if (e.key === "r") setStatus(selectedId, "unreviewed");
    else if (e.key === "j") selectRelative(1);
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

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        alert("Could not parse this file as JSON: " + err.message);
        return;
      }
      if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
        alert("Expected a GeoJSON FeatureCollection.");
        return;
      }
      const key = hashString(file.name + ":" + parsed.features.length + ":" + reader.result.length);
      activateDataset(parsed, key, `${file.name} (${parsed.features.length} features)`);
    };
    reader.readAsText(file);
  }

  function startBlankSession() {
    if (entries.size > 0) {
      const ok = confirm(
        "Start a new blank session? This discards the current areas from view (export first if you want to keep them)."
      );
      if (!ok) return;
    }
    const blank = { type: "FeatureCollection", name: "new-areas", features: [] };
    activateDataset(blank, "blank-session", "New, unsaved session (0 features) — draw with “Add new area…”");
  }

  function activateDataset(parsed, key, label) {
    raw = parsed;
    fileKey = key;
    fileNameEl.textContent = label;
    buildEntries(parsed);
    renderMapLayers();
    recomputeFlagsAndRender();
    exportBtn.disabled = false;
    addAreaBtn.disabled = false;
    combineAreaBtn.disabled = false;

    // Don't clobber a challenge ID the user already set/typed - only fill it
    // in when we don't have one yet.
    if (!mrChallengeId) {
      const detected = detectMrChallengeId(parsed);
      if (detected) {
        mrChallengeId = detected;
        mrChallengeIdInput.value = detected;
        localStorage.setItem("block-triage:mrChallengeId", detected);
        updateMrLiveSyncUI();
      }
    }
  }

  function updateMrLiveSyncUI() {
    mrLivePanel.hidden = !mrLiveSync;
    mrLiveBanner.hidden = !mrLiveSync;
    if (mrLiveSync) {
      mrLiveBannerChallenge.textContent = mrChallengeId || "(no challenge ID set)";
    }
  }

  function detectMrChallengeId(parsed) {
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    for (const feature of features) {
      const raw = feature.properties && feature.properties.mr_challengeId;
      if (raw !== undefined && raw !== null && raw !== "") return String(raw);
    }
    return null;
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
      headers: Object.assign({ apiKey: mrApiKey, "Content-Type": "application/json" }, (options && options.headers) || {}),
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
    const BAND_WIDTH_KM = 0.002; // ~2m inward - a quarter of the original 8m
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
    undoStack = [];
    redoStack = [];
    newFeatureCounter = 0;
    addedAreaCounter = 0;
    updateUndoRedoButtons();

    const marks = loadMarks();

    parsed.features.forEach((feature, idx) => {
      const id = hashString(JSON.stringify(feature.geometry));
      const { area, compactness } = computeMetrics(feature);
      const embeddedStatus = feature.properties && feature.properties[STATUS_PROPERTY] === "kept" ? "kept" : "unreviewed";

      entries.set(id, {
        id,
        idx,
        feature,
        layer: null,
        area,
        compactness,
        status: marks[id] || embeddedStatus,
        mrTaskId: parseMrTaskId(feature),
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

  function marksStorageKey() {
    return `block-triage:marks:${fileKey}`;
  }

  function loadMarks() {
    try {
      return JSON.parse(localStorage.getItem(marksStorageKey())) || {};
    } catch (e) {
      return {};
    }
  }

  function saveMarks() {
    const marks = {};
    entries.forEach((e, id) => {
      if (e.status !== "unreviewed") marks[id] = e.status;
    });
    localStorage.setItem(marksStorageKey(), JSON.stringify(marks));
  }

  function category(entry) {
    if (entry.status === "excluded") return "excluded";
    if (entry.status === "kept") return "kept";
    if (entry.flagged) return "flagged";
    return "unreviewed";
  }

  function styleFor(entry) {
    const cat = category(entry);
    const color = COLORS[cat];
    if (combineState && combineState.selectedIds.has(entry.id)) {
      return { color: "#9c27b0", weight: 4, dashArray: "6 3", fillColor: color, fillOpacity: 0.35 };
    }
    const isSelected = entry.id === selectedId;
    return {
      color: isSelected ? "#000" : color,
      weight: isSelected ? 3 : 1.5,
      // setStyle() merges rather than replaces, so dashArray must be explicitly
      // cleared here or a prior combine-selection dash pattern would stick.
      dashArray: null,
      fillColor: color,
      fillOpacity: cat === "excluded" ? 0.55 : cat === "kept" ? 0.25 : cat === "flagged" ? 0.4 : 0.15,
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
    // being consumed here as a selection/exclude click — a cut line very often
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
      if (quickExcludeMode) {
        setStatus(entry.id, entry.status === "excluded" ? "unreviewed" : "excluded");
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
    const div = document.createElement("div");
    div.innerHTML = `
      <div><strong>Feature #${entry.idx}</strong></div>
      <div>Area: ${entry.area.toFixed(1)} m&sup2;</div>
      <div>Compactness: ${entry.compactness.toFixed(3)}</div>
      <div>Status: <span data-status>${entry.status}</span></div>
      <div class="popup-actions">
        <button data-action="excluded">Exclude</button>
        <button data-action="kept">Keep</button>
        <button data-action="unreviewed">Reset</button>
      </div>
      <div class="popup-actions">
        <button data-split>Split&hellip;</button>
      </div>
      ${
        mrLiveSync
          ? `<div class="popup-actions"><button data-mr-action></button></div>
             <div class="mr-inline-status" data-mr-status></div>`
          : ""
      }
    `;
    div.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setStatus(entry.id, btn.dataset.action);
        div.querySelector("[data-status]").textContent = entry.status;
      });
    });
    div.querySelector("[data-split]").addEventListener("click", () => {
      if (mrLiveSync && entry.mrTaskId) {
        const ok = confirm(
          `This area is linked to MapRoulette task ${entry.mrTaskId}. Splitting it will delete that task and create two new ones on MapRoulette once you finish drawing the cut. Continue?`
        );
        if (!ok) return;
      }
      map.closePopup();
      startDrawing("split", entry.id);
    });

    if (!mrLiveSync) {
      const center = entry.layer.getBounds().getCenter();
      L.popup().setLatLng(center).setContent(div).openOn(map);
      return;
    }

    const mrBtn = div.querySelector("[data-mr-action]");
    const mrStatusInline = div.querySelector("[data-mr-status]");
    const updateMrButton = () => {
      mrBtn.textContent = entry.mrTaskId ? "Remove task from challenge" : "Add task to challenge";
    };
    updateMrButton();
    mrBtn.addEventListener("click", async () => {
      if (entry.mrTaskId) {
        const ok = confirm(
          `Remove MapRoulette task ${entry.mrTaskId} from the challenge? This deletes it immediately on MapRoulette and can't be undone from here.`
        );
        if (!ok) return;
      }
      mrBtn.disabled = true;
      mrStatusInline.textContent = entry.mrTaskId ? "Removing from MapRoulette…" : "Adding to MapRoulette…";
      try {
        if (entry.mrTaskId) {
          await mrDeleteTask(entry.mrTaskId);
          entry.mrTaskId = null;
          mrStatusInline.textContent = "Removed from MapRoulette.";
        } else {
          const created = await mrCreateTask(entry.feature);
          entry.mrTaskId = created.id;
          mrStatusInline.textContent = `Added as MapRoulette task ${created.id}.`;
        }
      } catch (err) {
        mrStatusInline.textContent = "Failed: " + err.message;
      } finally {
        mrBtn.disabled = false;
        updateMrButton();
      }
    });

    const center = entry.layer.getBounds().getCenter();
    L.popup().setLatLng(center).setContent(div).openOn(map);
  }

  function setStatus(id, status, opts) {
    const entry = entries.get(id);
    if (!entry || entry.status === status) return;
    const prevStatus = entry.status;
    entry.status = status;
    entry.layer.setStyle(styleFor(entry));
    saveMarks();
    updateStats();
    renderList();

    if (!opts || !opts.skipHistory) {
      undoStack.push({ type: "status", id, prevStatus, newStatus: status });
      redoStack = [];
      updateUndoRedoButtons();
    }
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    if (action.type === "split") undoSplit(action);
    else if (action.type === "add") undoAdd(action);
    else if (action.type === "combine") undoCombine(action);
    else {
      setStatus(action.id, action.prevStatus, { skipHistory: true });
      focusOnAction(action.id);
    }
    redoStack.push(action);
    updateUndoRedoButtons();
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    if (action.type === "split") redoSplit(action);
    else if (action.type === "add") redoAdd(action);
    else if (action.type === "combine") redoCombine(action);
    else {
      setStatus(action.id, action.newStatus, { skipHistory: true });
      focusOnAction(action.id);
    }
    undoStack.push(action);
    updateUndoRedoButtons();
  }

  function focusOnAction(id) {
    const entry = entries.get(id);
    if (!entry) return;
    selectFeature(id);
    panTo(entry);
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
    if (selectedId === id) selectedId = null;
  }

  function snapshotEntry(entry) {
    return {
      id: entry.id,
      idx: entry.idx,
      feature: entry.feature,
      area: entry.area,
      compactness: entry.compactness,
      status: entry.status,
      mrTaskId: entry.mrTaskId,
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
        status: "unreviewed",
        mrTaskId: null,
      };
    });
    newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));

    undoStack.push({ type: "split", original: originalSnapshot, newSnapshots });
    redoStack = [];
    updateUndoRedoButtons();
    saveMarks();
    updateStats();
    renderList();

    selectFeature(newSnapshots[0].id);
    panTo(entries.get(newSnapshots[0].id));

    // The local split is done; MapRoulette sync (if this area was a task and
    // live sync is on) is a separate, non-blocking follow-up - failures here
    // don't undo the local split (undo/redo never touch MapRoulette either,
    // see the README).
    if (mrLiveSync && originalSnapshot.mrTaskId) {
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
    saveMarks();
    updateStats();
    renderList();
    selectFeature(action.original.id);
    panTo(entries.get(action.original.id));
  }

  function redoSplit(action) {
    removeEntry(action.original.id);
    action.newSnapshots.forEach((snap) => restoreEntryFromSnapshot(snap));
    saveMarks();
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
      status: "unreviewed",
      mrTaskId: null,
    };
    restoreEntryFromSnapshot(snapshot);

    undoStack.push({ type: "add", snapshot });
    redoStack = [];
    updateUndoRedoButtons();
    saveMarks();
    updateStats();
    renderList();
    selectFeature(snapshot.id);
  }

  function undoAdd(action) {
    removeEntry(action.snapshot.id);
    saveMarks();
    updateStats();
    renderList();
  }

  function redoAdd(action) {
    restoreEntryFromSnapshot(action.snapshot);
    saveMarks();
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
    drawStatusText.textContent = `Click 2 or more adjacent areas to merge (${n} selected so far). They should share a boundary.`;
  }

  function toggleCombineSelection(id) {
    if (!combineState) return;
    if (combineState.selectedIds.has(id)) combineState.selectedIds.delete(id);
    else combineState.selectedIds.add(id);
    const entry = entries.get(id);
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

    // Splitting deliberately leaves a ~1m gap between the pieces it creates (see
    // doSplit), so a plain union of two just-split areas would see them as
    // non-touching and produce a MultiPolygon instead of merging them. Close
    // gaps up to that size first: buffer each area out slightly, union, then
    // buffer the result back in by the same amount ("morphological closing").
    // Areas that are genuinely far apart still won't bridge and correctly fail
    // the parts.length check below.
    const CLOSE_DISTANCE_KM = 0.001; // 1m — just past the split knife's ~0.5m radius
    let unionResult;
    try {
      const closed = targetEntries.map((e) => turf.buffer(e.feature, CLOSE_DISTANCE_KM, { units: "kilometers" }));
      const fc = turf.featureCollection(closed);
      unionResult = turf.union(fc);
      if (unionResult) {
        unionResult = turf.buffer(unionResult, -CLOSE_DISTANCE_KM, { units: "kilometers" });
      }
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
    originalSnapshots.forEach((snap) => removeEntry(snap.id));

    const newSnapshot = {
      id: hashString(JSON.stringify(combined.geometry) + ":" + newFeatureCounter++),
      idx: originalSnapshots.map((s) => s.idx).join("+"),
      feature: combined,
      area,
      compactness,
      status: "unreviewed",
      // Combine is local-only for now: the constituent areas' MapRoulette
      // tasks (if any) are left untouched remotely, and the merged result
      // starts unlinked - use its "Add task to challenge" button if you want
      // to link it to a fresh MapRoulette task.
      mrTaskId: null,
    };
    restoreEntryFromSnapshot(newSnapshot);

    undoStack.push({ type: "combine", originals: originalSnapshots, newSnapshot });
    redoStack = [];
    updateUndoRedoButtons();
    saveMarks();
    updateStats();
    renderList();

    selectFeature(newSnapshot.id);
    panTo(entries.get(newSnapshot.id));
  }

  function undoCombine(action) {
    removeEntry(action.newSnapshot.id);
    action.originals.forEach((snap) => restoreEntryFromSnapshot(snap));
    saveMarks();
    updateStats();
    renderList();
    selectFeature(action.originals[0].id);
    panTo(entries.get(action.originals[0].id));
  }

  function redoCombine(action) {
    action.originals.forEach((snap) => removeEntry(snap.id));
    restoreEntryFromSnapshot(action.newSnapshot);
    saveMarks();
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
    let unreviewed = 0, flaggedUndecided = 0, excluded = 0, kept = 0;
    entries.forEach((e) => {
      if (e.status === "excluded") excluded++;
      else if (e.status === "kept") kept++;
      else if (e.flagged) flaggedUndecided++;
      else unreviewed++;
    });
    const total = entries.size;
    statsEl.innerHTML = `
      <div>Total: ${total}</div>
      <div>Unreviewed: ${unreviewed}</div>
      <div>Flagged, undecided: ${flaggedUndecided}</div>
      <div>Excluded: ${excluded}</div>
      <div>Kept: ${kept}</div>
    `;
    document.querySelector('[data-count="all"]').textContent = total;
    document.querySelector('[data-count="flagged"]').textContent = flaggedUndecided;
    document.querySelector('[data-count="unreviewed"]').textContent = unreviewed;
    document.querySelector('[data-count="excluded"]').textContent = excluded;
    document.querySelector('[data-count="kept"]').textContent = kept;
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
        if (filter === "flagged") return e.flagged && e.status === "unreviewed";
        if (filter === "unreviewed") return e.status === "unreviewed" && !e.flagged;
        return e.status === filter;
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
      const row = document.createElement("div");
      row.className =
        "feature-row" + (id === selectedId ? " selected" : "") + (isCombineSelected ? " combine-selected" : "");
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

  function exportFiltered() {
    const features = [];
    entries.forEach((e) => {
      if (e.status === "excluded") return;
      const properties = Object.assign({}, e.feature.properties);
      if (e.status === "kept") {
        properties[STATUS_PROPERTY] = "kept";
      } else {
        delete properties[STATUS_PROPERTY];
      }
      if (e.mrTaskId) {
        properties.mr_taskId = String(e.mrTaskId);
      } else {
        delete properties.mr_taskId;
      }
      features.push(Object.assign({}, e.feature, { properties }));
    });
    const out = Object.assign({}, raw, { features });
    const blob = new Blob([JSON.stringify(out)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "filtered.geojson";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
})();
