(function () {
  "use strict";

  const COLORS = {
    unreviewed: "#3388ff",
    flagged: "#ff9800",
    excluded: "#e53935",
    kept: "#43a047",
  };

  /** @type {Map<string, {id:string, idx:number, feature:object, layer:L.Layer, area:number, compactness:number, status:string}>} */
  let entries = new Map();
  let orderedIds = []; // insertion order == original feature order
  let fileKey = null;
  let raw = null; // parsed geojson, kept so we can preserve top-level fields on export
  let selectedId = null;
  let thresholds = loadThresholds();

  const map = L.map("map", { preferCanvas: true }).setView([43.45, -79.68], 12);
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const esriImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "Tiles &copy; Esri" }
  );
  L.control.layers({ "OpenStreetMap": osm, "Aerial (Esri)": esriImagery }).addTo(map);

  const fileInput = document.getElementById("file-input");
  const fileNameEl = document.getElementById("file-name");
  const exportBtn = document.getElementById("export-btn");
  const statsEl = document.getElementById("stats");
  const featureListEl = document.getElementById("feature-list");
  const areaThresholdInput = document.getElementById("area-threshold");
  const compactnessThresholdInput = document.getElementById("compactness-threshold");

  areaThresholdInput.value = thresholds.area;
  compactnessThresholdInput.value = thresholds.compactness;

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file);
  });

  exportBtn.addEventListener("click", exportFiltered);

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
    if (!selectedId) return;
    if (e.target.tagName === "INPUT") return;
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
      raw = parsed;
      fileKey = hashString(file.name + ":" + parsed.features.length + ":" + reader.result.length);
      fileNameEl.textContent = `${file.name} (${parsed.features.length} features)`;
      buildEntries(parsed);
      renderMapLayers();
      recomputeFlagsAndRender();
      exportBtn.disabled = false;
    };
    reader.readAsText(file);
  }

  function buildEntries(parsed) {
    entries.forEach((e) => map.removeLayer(e.layer));
    entries = new Map();
    orderedIds = [];
    selectedId = null;

    const marks = loadMarks();

    parsed.features.forEach((feature, idx) => {
      const id = hashString(JSON.stringify(feature.geometry));
      let area = 0;
      let perimeter = 0;
      try {
        area = turf.area(feature);
        const line = turf.polygonToLine(feature);
        perimeter = turf.length(line, { units: "kilometers" }) * 1000;
      } catch (err) {
        console.warn("Could not compute metrics for feature", idx, err);
      }
      const compactness = perimeter > 0 ? Math.min(1, (4 * Math.PI * area) / (perimeter * perimeter)) : 0;

      entries.set(id, {
        id,
        idx,
        feature,
        layer: null,
        area,
        compactness,
        status: marks[id] || "unreviewed",
      });
      orderedIds.push(id);
    });
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
    const isSelected = entry.id === selectedId;
    return {
      color: isSelected ? "#000" : color,
      weight: isSelected ? 3 : 1.5,
      fillColor: color,
      fillOpacity: cat === "excluded" ? 0.55 : cat === "kept" ? 0.25 : cat === "flagged" ? 0.4 : 0.15,
    };
  }

  function renderMapLayers() {
    const bounds = [];
    entries.forEach((entry) => {
      const layer = L.geoJSON(entry.feature, { style: () => styleFor(entry) });
      layer.on("click", () => {
        selectFeature(entry.id);
        openPopup(entry);
      });
      layer.addTo(map);
      entry.layer = layer;
      const b = layer.getBounds();
      if (b.isValid()) bounds.push(b);
    });
    if (bounds.length) {
      let all = bounds[0];
      bounds.forEach((b) => (all = all.extend(b)));
      map.fitBounds(all, { padding: [20, 20] });
    }
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
    `;
    div.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setStatus(entry.id, btn.dataset.action);
        div.querySelector("[data-status]").textContent = entry.status;
      });
    });
    entry.layer.bindPopup(div).openPopup();
  }

  function setStatus(id, status) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.status = status;
    entry.layer.setStyle(styleFor(entry));
    saveMarks();
    updateStats();
    renderList();
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
      const row = document.createElement("div");
      row.className = "feature-row" + (id === selectedId ? " selected" : "");
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
      if (e.status !== "excluded") features.push(e.feature);
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
