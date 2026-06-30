// ============================================================
//  SolarSiteIQ — single 3D app
//  Cesium World Terrain + energizing pipeline + 8-factor sheet
// ============================================================

const CESIUM_ION_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0NzE2ZWE4Ni1kYjE0LTRjY2YtYjBkZi0zMmM3MjljNjE2YjMiLCJpZCI6NDUwOTY1LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODI4NTA2NzR9.LdCJhGvlXWXn2XqDlqRn-eeqUE_pZCwDEkYHJ1_Tbmo";

const PARCEL_COUNT = 2400;
const PROVEN_FARM_COUNT = 14;

const FACTOR_ORDER = [
  "irradiance", "slope", "grid_distance", "land_cost",
  "maintenance", "locality_distance", "community", "wildlife",
];
const FACTOR_LABELS = {
  irradiance: "Solar irradiance",
  slope: "Slope / terrain",
  grid_distance: "Grid distance",
  land_cost: "Land cost",
  maintenance: "Maintenance access",
  locality_distance: "Locality distance",
  community: "Community sentiment",
  wildlife: "Wildlife / habitat",
};
const FLAG_MESSAGES = {
  community: "Community opposition detected nearby",
  grid_distance: "Grid connection risk — substation too far",
  wildlife: "Borders protected habitat",
  slope: "Steep terrain — higher build cost",
  locality_distance: "Too close to town — noise & visual complaints",
  maintenance: "Poor road access — maintenance burden",
};

// Reference operating solar farms (real Kern County solar country).
const PROVEN_FARMS = [
  { lat: 35.0, lng: -119.22, name: "Operating solar farm" },
  { lat: 35.43, lng: -119.05, name: "Operating solar farm" },
];

const PIPELINE_STAGES = [
  { title: "Ingest",   src: "Bright Data",   sub: "Scraping parcels, grid, zoning & local sentiment" },
  { title: "Score",    src: "RunPod Flash",  sub: "Scoring 2,400 parcels in parallel" },
  { title: "Classify", src: "Flash · LLM",   sub: "Reading community sentiment signals" },
  { title: "Rank",     src: "",              sub: "Ranking by 8-factor fit" },
  { title: "Map",      src: "",              sub: "Plotting ranked sites on terrain" },
];

let viewer = null;
let siteData = null;
let selectedSiteId = null;
let highlightedId = null;
let hasEvaluated = false;
let isRunning = false;

// ── Color ramp (clay → gold → sage), shared everywhere ──────
function lerp(a, b, t) { return a + (b - a) * t; }
function scoreToRGB(score) {
  const s = Math.max(0, Math.min(100, score)) / 100;
  const lo = { r: 222, g: 115, b: 85 };   // clay
  const mid = { r: 242, g: 169, b: 59 };  // gold
  const hi = { r: 143, g: 181, b: 138 };  // sage
  let c;
  if (s <= 0.5) { const t = s * 2; c = { r: lerp(lo.r, mid.r, t), g: lerp(lo.g, mid.g, t), b: lerp(lo.b, mid.b, t) }; }
  else { const t = (s - 0.5) * 2; c = { r: lerp(mid.r, hi.r, t), g: lerp(mid.g, hi.g, t), b: lerp(mid.b, hi.b, t) }; }
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
}
function scoreToColor(score) { const c = scoreToRGB(score); return `rgb(${c.r}, ${c.g}, ${c.b})`; }
function cesiumColor(score, alpha = 1) {
  return Cesium.Color.fromCssColorString(scoreToColor(score)).withAlpha(alpha);
}

// ── DOM helpers ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("is-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-show"), 2600);
}

// ── Token gate ──────────────────────────────────────────────
function tokenMissing() { return !CESIUM_ION_TOKEN || CESIUM_ION_TOKEN.includes("PASTE_YOUR"); }
function bootError(html) {
  const boot = $("boot");
  boot.classList.add("boot--error");
  $("boot-text").innerHTML = html;
}

// ── Operating solar farm: property boundary + icon (no tarp) ──
const SOLAR_ICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'>" +
  "<rect x='4' y='5' width='36' height='34' rx='9' fill='#16264e' stroke='#8FA6E0' stroke-width='2'/>" +
  "<g fill='#7f9be0'>" +
  "<rect x='11' y='14' width='8' height='6.5' rx='1'/><rect x='21' y='14' width='8' height='6.5' rx='1'/>" +
  "<rect x='11' y='22.5' width='8' height='6.5' rx='1'/><rect x='21' y='22.5' width='8' height='6.5' rx='1'/>" +
  "</g><circle cx='33' cy='12' r='4' fill='#FFC65A'/></svg>";
function solarIcon() { return "data:image/svg+xml," + encodeURIComponent(SOLAR_ICON_SVG); }

function addSolarFarm(farm) {
  const dLat = 0.011, dLng = 0.016;
  const w = farm.lng - dLng / 2, e = farm.lng + dLng / 2, s = farm.lat - dLat / 2, n = farm.lat + dLat / 2;

  // subtle parcel fill
  viewer.entities.add({
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
      material: Cesium.Color.fromCssColorString("#3C5599").withAlpha(0.16),
      classificationType: Cesium.ClassificationType.TERRAIN,
    },
  });
  // crisp property boundary, draped on terrain
  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]),
      width: 2.5, clampToGround: true,
      material: Cesium.Color.fromCssColorString("#8FA6E0"),
    },
  });
  // icon + label
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(farm.lng, farm.lat),
    billboard: {
      image: solarIcon(), width: 34, height: 34,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(3000, 1.15, 130000, 0.45),
    },
    label: {
      text: farm.name,
      font: "600 11px 'JetBrains Mono', monospace",
      fillColor: Cesium.Color.fromCssColorString("#B4C5EE"),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#0b1228").withAlpha(0.72),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -38),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(6000, 1.0, 130000, 0.0),
    },
  });
}

// ── Candidate site markers ──────────────────────────────────
function getSite(id) { return siteData?.sites?.find((s) => s.id === id) ?? null; }

function addSiteMarker(site) {
  if (viewer.entities.getById(site.id)) return; // already placed (e.g. via search)
  viewer.entities.add({
    id: site.id,
    position: Cesium.Cartesian3.fromDegrees(site.lng, site.lat),
    point: {
      pixelSize: 0, // animate up
      color: cesiumColor(site.score),
      outlineColor: Cesium.Color.WHITE.withAlpha(0.9), outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  // pop-in
  const entity = viewer.entities.getById(site.id);
  const target = site.rank === 1 ? 18 : 13;
  const start = performance.now();
  (function grow(now) {
    const t = Math.min(1, (now - start) / 320);
    const eased = 1 - Math.pow(1 - t, 3);
    entity.point.pixelSize = eased * target;
    if (t < 1) requestAnimationFrame(grow);
  })(start);
}

function setHighlight(id, on) {
  const e = viewer.entities.getById(id);
  if (!e) return;
  const site = getSite(id);
  const base = site.rank === 1 ? 18 : 13;
  if (on) {
    e.point.pixelSize = base + 11;
    e.point.color = Cesium.Color.fromCssColorString("#F4FBFA");
    e.point.outlineColor = Cesium.Color.fromCssColorString("#25E0D0"); // distinct teal — pops over heatmap
    e.point.outlineWidth = 5;
  } else {
    e.point.pixelSize = base;
    e.point.color = cesiumColor(site.score);
    e.point.outlineColor = Cesium.Color.WHITE.withAlpha(0.9);
    e.point.outlineWidth = 2;
  }
}

// ── Pipeline ────────────────────────────────────────────────
function renderPipelineStages() {
  const ol = $("pipe-stages");
  ol.innerHTML = "";
  PIPELINE_STAGES.forEach((st, i) => {
    const li = document.createElement("li");
    li.className = "stage";
    li.dataset.idx = i;
    li.innerHTML = `
      <div class="stage__node">${i + 1}</div>
      <div class="stage__body">
        <div class="stage__title">${st.title}${st.src ? `<span class="stage__src">${st.src}</span>` : ""}</div>
        <div class="stage__sub">${st.sub}</div>
      </div>`;
    ol.appendChild(li);
  });
}

async function runPipeline() {
  if (isRunning || hasEvaluated) return;
  isRunning = true;

  const runBtn = $("run-btn");
  runBtn.disabled = true;
  runBtn.classList.add("is-running");
  runBtn.querySelector(".run__label").textContent = "Evaluating…";
  runBtn.querySelector(".run__sub").textContent = "running pipeline";

  const stages = [...document.querySelectorAll(".stage")];
  const sites = [...siteData.sites].sort((a, b) => a.rank - b.rank);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    stage.classList.add("is-active");
    $("pipe-count").textContent = `${i + 1}/${stages.length}`;

    // On the final "Map" stage, drop markers onto the globe.
    if (i === stages.length - 1) {
      sites.forEach((site, k) => setTimeout(() => addSiteMarker(site), k * 70));
      await delay(Math.max(820, sites.length * 70 + 200));
    } else {
      await delay(720);
    }
    stage.classList.remove("is-active");
    stage.classList.add("is-done");
  }

  renderRanked(sites);
  $("ranked").hidden = false;
  $("ranked").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("pipe-count").textContent = "complete";
  runBtn.classList.remove("is-running");
  runBtn.classList.add("is-done");
  runBtn.querySelector(".run__label").textContent = "✓ 12 sites ranked";
  runBtn.querySelector(".run__sub").textContent = `${PARCEL_COUNT.toLocaleString()} parcels evaluated`;

  hasEvaluated = true;
  isRunning = false;
  toast(`Evaluated ${PARCEL_COUNT.toLocaleString()} parcels across 8 factors`);
}

// ── Ranked list ─────────────────────────────────────────────
function renderRanked(sites) {
  const ol = $("ranked-list");
  ol.innerHTML = "";
  sites.forEach((site) => {
    const hasFlag = Object.values(site.factors).some((f) => f.flag);
    const li = document.createElement("li");
    li.className = "rsite";
    li.dataset.id = site.id;
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.innerHTML = `
      <span class="rsite__rank">#${site.rank}</span>
      <span class="rsite__name">${site.name}${hasFlag ? ' <span class="rsite__flag">⚑</span>' : ""}</span>
      <span class="rsite__score" style="color:${scoreToColor(site.score)}">${site.score}</span>`;
    ol.appendChild(li);
  });
}

// ── 8-factor sheet ──────────────────────────────────────────
function renderSheet(site) {
  const similarityPct = Math.round(site.similarity_to_proven * 100);
  const factorsHtml = FACTOR_ORDER.map((key) => {
    const f = site.factors[key];
    if (!f) return "";
    const flagged = Boolean(f.flag);
    const fillColor = flagged ? "var(--clay)" : scoreToColor(f.score);
    return `
      <div class="fac${flagged ? " fac--flagged" : ""}">
        <div class="fac__top">
          <span class="fac__label">${FACTOR_LABELS[key]}</span>
          <span class="fac__val" style="color:${flagged ? "var(--clay)" : scoreToColor(f.score)}">${f.score}</span>
        </div>
        <div class="fac__track"><div class="fac__fill" data-w="${f.score}" style="background:${fillColor}"></div></div>
        <div class="fac__raw">${f.raw}</div>
        ${flagged ? `<div class="fac__flag"><span class="fac__flag-dot">!</span>${FLAG_MESSAGES[key] || "Flagged for review"}</div>` : ""}
      </div>`;
  }).join("");

  $("sheet-content").innerHTML = `
    <p class="bd__eyebrow">CANDIDATE PARCEL</p>
    <h2 class="bd__name">${site.name}</h2>
    <p class="bd__rank">RANK #${site.rank} OF ${PARCEL_COUNT.toLocaleString()}</p>
    <p class="bd__verdict">${site.verdict}</p>
    <div class="bd__scorewrap">
      <div>
        <div class="bd__score-k">Overall score</div>
        <div class="bd__score" style="color:${scoreToColor(site.score)}">${site.score}</div>
      </div>
      <div class="bd__sim">
        <div class="bd__sim-pct">${similarityPct}%</div>
        <div class="bd__sim-txt">similar to ${PROVEN_FARM_COUNT} operating solar farms</div>
      </div>
    </div>
    <p class="bd__factors-head">8-FACTOR BREAKDOWN</p>
    <div class="bd__factors">${factorsHtml}</div>`;

  // animate bars after paint
  requestAnimationFrame(() => {
    $("sheet-content").querySelectorAll(".fac__fill").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  });
}

function openSheet() { $("sheet").classList.add("is-open"); $("sheet").setAttribute("aria-hidden", "false"); }
function closeSheet() {
  $("sheet").classList.remove("is-open");
  $("sheet").setAttribute("aria-hidden", "true");
  if (highlightedId) { setHighlight(highlightedId, false); highlightedId = null; }
  document.querySelectorAll(".rsite.is-selected").forEach((el) => el.classList.remove("is-selected"));
  selectedSiteId = null;
}

function selectSite(id, fly = true) {
  const site = getSite(id);
  if (!site) return;
  if (!viewer.entities.getById(id)) addSiteMarker(site); // search before "Evaluate"
  if (highlightedId) setHighlight(highlightedId, false);
  setHighlight(id, true);
  highlightedId = id;
  selectedSiteId = id;

  document.querySelectorAll(".rsite").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.id === id);
    if (el.dataset.id === id) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  renderSheet(site);
  openSheet();

  if (fly) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(site.lng, site.lat, 4200),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-42), roll: 0 },
      duration: 1.1,
    });
  }
}

// ── ZIP locator ─────────────────────────────────────────────
async function locateZip(e) {
  e.preventDefault();
  const zip = $("zip-input").value.trim();
  const status = $("zip-status");
  status.classList.remove("locator__status--err");

  if (!/^\d{5}$/.test(zip)) {
    status.textContent = "Enter a 5-digit ZIP";
    status.classList.add("locator__status--err");
    return;
  }
  status.textContent = "Locating…";
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const place = data.places[0];
    const lat = parseFloat(place.latitude);
    const lng = parseFloat(place.longitude);
    const label = `${place["place name"]}, ${place["state abbreviation"]}`;
    status.textContent = label;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, 9000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      duration: 1.6,
    });
    toast(`Jumped to ${label} (${zip})`);
  } catch (err) {
    status.textContent = "ZIP not found";
    status.classList.add("locator__status--err");
  }
}

// ── Instrument readout (live camera center) ─────────────────
function updateReadout() {
  const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2));
  const pos = ray && viewer.scene.globe.pick(ray, viewer.scene);
  if (!pos) return;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  $("ro-lat").textContent = Cesium.Math.toDegrees(carto.latitude).toFixed(4);
  $("ro-lng").textContent = Cesium.Math.toDegrees(carto.longitude).toFixed(4);
}

// ── Score field (per-pixel / per-hex interpolation, IDW) ────
let _bounds = null;
function getBounds(pad = 0.12) {
  if (_bounds) return _bounds;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const site of siteData.sites) {
    w = Math.min(w, site.lng); e = Math.max(e, site.lng);
    s = Math.min(s, site.lat); n = Math.max(n, site.lat);
  }
  _bounds = { west: w - pad, east: e + pad, south: s - pad, north: n + pad };
  return _bounds;
}

// Smoothed inverse-distance weighting — each pixel/hex gets a score blended
// from all 12 sites by proximity. The eps term keeps peaks from spiking to ∞.
function interpScore(lat, lng) {
  let num = 0, den = 0;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const site of siteData.sites) {
    const dLat = lat - site.lat;
    const dLng = (lng - site.lng) * cosLat;
    const d2 = dLat * dLat + dLng * dLng;
    const w = 1 / (d2 + 6e-4);
    num += w * site.score; den += w;
  }
  return num / den;
}

// ── Heatmap (per-pixel score surface, draped as imagery) ────
let heatLayer = null, heatBuilt = false;
async function buildHeatmap() {
  const b = getBounds();
  const W = 200, H = 200;
  const cvs = document.createElement("canvas");
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext("2d");
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let py = 0; py < H; py++) {
    const lat = b.north - (py / (H - 1)) * (b.north - b.south);
    for (let px = 0; px < W; px++) {
      const lng = b.west + (px / (W - 1)) * (b.east - b.west);
      const c = scoreToRGB(interpScore(lat, lng));
      const i = (py * W + px) * 4;
      d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const provider = await Cesium.SingleTileImageryProvider.fromUrl(cvs.toDataURL(), {
    rectangle: Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
  });
  heatLayer = viewer.imageryLayers.addImageryProvider(provider);
  heatLayer.alpha = 0.62;
  heatBuilt = true;
}

async function toggleHeat() {
  const chip = $("t-heat");
  if (!heatBuilt) {
    await buildHeatmap();
    chip.setAttribute("aria-pressed", "true");
    toast("Heatmap on — per-pixel score surface");
    return;
  }
  const on = !heatLayer.show;
  heatLayer.show = on;
  chip.setAttribute("aria-pressed", on ? "true" : "false");
}

// ── Hex grid (binned score) ─────────────────────────────────
let hexEntities = [], hexBuilt = false, hexShown = false;
function buildHex() {
  const b = getBounds();
  const sizeLat = 0.05, shrink = 0.9;
  const midLat = (b.south + b.north) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const rowH = 1.5 * sizeLat;
  const colW = Math.sqrt(3) * sizeLat;
  const spanX = (b.east - b.west) * cosLat;
  let row = 0;
  for (let y = b.south; y <= b.north + sizeLat; y += rowH, row++) {
    const xoff = (row % 2) ? colW / 2 : 0;
    for (let x = xoff; x <= spanX + colW; x += colW) {
      const cLat = y;
      const cLng = b.west + x / cosLat;
      const score = interpScore(cLat, cLng);
      const pts = [];
      for (let k = 0; k < 6; k++) {
        const ang = (Math.PI / 180) * (60 * k + 30);
        const vx = x + Math.cos(ang) * sizeLat * shrink;
        const vy = cLat + Math.sin(ang) * sizeLat * shrink;
        pts.push(b.west + vx / cosLat, vy);
      }
      const ent = viewer.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(pts),
          material: cesiumColor(score, 0.5),
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      });
      ent.show = false;
      hexEntities.push(ent);
    }
  }
  hexBuilt = true;
}

function toggleHex() {
  if (!hexBuilt) buildHex();
  hexShown = !hexShown;
  hexEntities.forEach((e) => { e.show = hexShown; });
  $("t-hex").setAttribute("aria-pressed", hexShown ? "true" : "false");
  if (hexShown) toast("Hex grid on — binned score");
}

// ── Search by name ──────────────────────────────────────────
function nameSearch() {
  const q = $("name-search").value.trim().toLowerCase();
  const box = $("finder-results");
  if (!q) { box.hidden = true; box.innerHTML = ""; return; }

  const matches = siteData.sites
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 6);

  box.innerHTML = "";
  if (!matches.length) {
    box.innerHTML = '<li class="fres__empty">No sites match</li>';
    box.hidden = false;
    return;
  }
  matches.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "fres" + (i === 0 ? " is-active" : "");
    li.dataset.id = s.id;
    li.innerHTML = `<span class="fres__name">${s.name}</span><span class="fres__score" style="color:${scoreToColor(s.score)}">${s.score}</span>`;
    box.appendChild(li);
  });
  box.hidden = false;
}

function chooseSearch(id) {
  $("name-search").value = "";
  $("finder-results").hidden = true;
  selectSite(id);
}

// ── Wiring ──────────────────────────────────────────────────
function wireEvents() {
  $("run-btn").addEventListener("click", runPipeline);
  $("sheet-close").addEventListener("click", closeSheet);
  $("locator").addEventListener("submit", locateZip);

  // layer toggles
  $("t-heat").addEventListener("click", toggleHeat);
  $("t-hex").addEventListener("click", toggleHex);

  // name search
  const ns = $("name-search");
  ns.addEventListener("input", nameSearch);
  ns.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("finder-results").querySelector(".fres");
      if (first && first.dataset.id) chooseSearch(first.dataset.id);
    } else if (e.key === "Escape") {
      $("finder-results").hidden = true;
    }
  });
  $("finder-results").addEventListener("click", (e) => {
    const row = e.target.closest(".fres");
    if (row && row.dataset.id) chooseSearch(row.dataset.id);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".finder")) $("finder-results").hidden = true;
  });

  const list = $("ranked-list");
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".rsite");
    if (row) selectSite(row.dataset.id);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".rsite");
    if (row) { e.preventDefault(); selectSite(row.dataset.id); }
  });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((m) => {
    const picked = viewer.scene.pick(m.position);
    if (Cesium.defined(picked) && picked.id && picked.id.id && getSite(picked.id.id)) {
      selectSite(picked.id.id);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  viewer.camera.moveEnd.addEventListener(updateReadout);
}

// ── Boot ────────────────────────────────────────────────────
async function init() {
  renderPipelineStages();

  if (tokenMissing()) {
    bootError('Cesium ion token needed. Get a free one at <a class="boot__link" href="https://ion.cesium.com/signup" target="_blank" rel="noopener">ion.cesium.com/signup</a> and paste it into <code>CESIUM_ION_TOKEN</code> in solar.js.');
    return;
  }

  try {
    Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    siteData = await (await fetch("data/mockSites.json")).json();

    viewer = new Cesium.Viewer("cesiumContainer", {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      shadows: true,
      timeline: false, animation: false, baseLayerPicker: false, geocoder: false,
      homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
    });

    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.skyAtmosphere.show = true;
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    viewer.clock.shouldAnimate = false;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#0a0a0f");
    if (viewer.cesiumWidget && viewer.cesiumWidget.creditContainer) {
      viewer.cesiumWidget.creditContainer.style.display = "none";
    }

    PROVEN_FARMS.forEach(addSolarFarm);

    const c = siteData.center;
    await viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 60000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-48), roll: 0 },
      duration: 0,
    });

    wireEvents();
    updateReadout();

    $("boot").classList.add("is-hidden");

    // gentle intro flight
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 42000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-52), roll: 0 },
      duration: 2.4,
    });
  } catch (err) {
    console.error(err);
    bootError(`Failed to load globe: ${err.message}. Check the Cesium ion token and your connection.`);
  }
}

document.addEventListener("DOMContentLoaded", init);
