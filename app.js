const LIVE_ENDPOINT_URL = "";
const MOCK_DATA_URL = "data/mockSites.json";
const FETCH_TIMEOUT_MS = 3000;
const DEFAULT_ZOOM = 9;
const ANIMATION_DURATION_MS = 2000;
const MARKER_RADIUS = 10;
const PARCEL_COUNT = 2400;
const PROVEN_FARM_COUNT = 14;

const FACTOR_ORDER = [
  "irradiance",
  "slope",
  "grid_distance",
  "land_cost",
  "maintenance",
  "locality_distance",
  "community",
  "wildlife",
];

const FACTOR_LABELS = {
  irradiance: "Solar irradiance",
  slope: "Slope / terrain",
  grid_distance: "Grid distance",
  land_cost: "Land cost & availability",
  maintenance: "Maintenance burden",
  locality_distance: "Locality distance",
  community: "Community sentiment",
  wildlife: "Wildlife / environmental",
};

let map = null;
let siteData = null;
let siteMarkers = new Map();
let isEvaluating = false;
let hasEvaluated = false;
let selectedSiteId = null;

// ── Data loading ──────────────────────────────────────────────

function isValidSitePayload(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.sites) &&
    data.sites.length > 0 &&
    data.center &&
    typeof data.center.lat === "number" &&
    typeof data.center.lng === "number"
  );
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function loadMockSites() {
  const response = await fetch(MOCK_DATA_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!isValidSitePayload(data)) throw new Error("Invalid mock payload");
  return data;
}

async function loadSites() {
  if (LIVE_ENDPOINT_URL) {
    try {
      const response = await fetchWithTimeout(LIVE_ENDPOINT_URL, FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isValidSitePayload(data)) throw new Error("Invalid live payload");
      console.log("SolarSiteIQ data source: live endpoint", LIVE_ENDPOINT_URL);
      return data;
    } catch (err) {
      console.warn("SolarSiteIQ live fetch failed, using mock fallback:", err.message);
    }
  } else {
    console.log("SolarSiteIQ data source: mock (LIVE_ENDPOINT_URL empty)");
  }

  try {
    const data = await loadMockSites();
    if (LIVE_ENDPOINT_URL) {
      console.log("SolarSiteIQ data source: mock fallback");
    }
    return data;
  } catch (err) {
    console.error("SolarSiteIQ failed to load mock data:", err);
    return null;
  }
}

// ── Map init ──────────────────────────────────────────────────

function initMap(center) {
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  }).setView([center.lat, center.lng], DEFAULT_ZOOM);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
}

function updateCountyLabel(county) {
  const el = document.getElementById("county-name");
  if (el && county) el.textContent = county;
}

// ── Score → color (smooth red → yellow → green) ───────────────

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function scoreToColor(score) {
  const s = Math.max(0, Math.min(100, score)) / 100;
  const red = { r: 193, g: 96, b: 74 };   /* clay */
  const yellow = { r: 232, g: 163, b: 61 }; /* gold */
  const green = { r: 143, g: 168, b: 136 }; /* sage */

  let r, g, b;
  if (s <= 0.5) {
    const t = s * 2;
    r = lerp(red.r, yellow.r, t);
    g = lerp(red.g, yellow.g, t);
    b = lerp(red.b, yellow.b, t);
  } else {
    const t = (s - 0.5) * 2;
    r = lerp(yellow.r, green.r, t);
    g = lerp(yellow.g, green.g, t);
    b = lerp(yellow.b, green.b, t);
  }

  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

// ── Markers ───────────────────────────────────────────────────

function createSiteMarker(site) {
  const color = scoreToColor(site.score);

  const marker = L.circleMarker([site.lat, site.lng], {
    radius: MARKER_RADIUS,
    fillColor: color,
    color: "#ffffff",
    weight: 2,
    fillOpacity: 0.92,
  });

  marker.siteId = site.id;
  marker.on("click", () => selectSite(site.id));
  return marker;
}

function animateMarkerIn(marker) {
  marker.addTo(map);
  const el = marker.getElement();
  if (!el) return;

  el.classList.add("site-marker--entering");
  requestAnimationFrame(() => {
    el.classList.remove("site-marker--entering");
    el.classList.add("site-marker--visible");
  });
}

function addSiteMarker(site) {
  const marker = createSiteMarker(site);
  animateMarkerIn(marker);
  siteMarkers.set(site.id, marker);
  return marker;
}

// ── Scoring animation ─────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function playScoringAnimation(sites) {
  const shuffled = shuffleArray(sites);
  const batches = chunkArray(shuffled, 3);
  const batchDelay = ANIMATION_DURATION_MS / batches.length;

  for (const batch of batches) {
    batch.forEach((site, i) => {
      setTimeout(() => addSiteMarker(site), i * 55);
    });
    await delay(batchDelay);
  }
}

// ── Results panel ─────────────────────────────────────────────

function renderRankedList(sites) {
  const listEl = document.getElementById("site-list");
  if (!listEl) return;

  const sorted = [...sites].sort((a, b) => a.rank - b.rank);
  listEl.innerHTML = "";

  sorted.forEach((site) => {
    const li = document.createElement("li");
    li.className = "site-list__item";
    li.dataset.siteId = site.id;
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");

    const rank = document.createElement("span");
    rank.className = "site-list__rank";
    rank.textContent = `#${site.rank}`;

    const name = document.createElement("span");
    name.className = "site-list__name";
    name.textContent = site.name;

    const score = document.createElement("span");
    score.className = "site-list__score";
    score.textContent = site.score;
    score.style.color = scoreToColor(site.score);

    li.append(rank, name, score);
    listEl.appendChild(li);
  });
}

function revealResultsPanel() {
  const panel = document.getElementById("results-panel");
  if (!panel) return;

  panel.hidden = false;
  setTimeout(() => map.invalidateSize(), 320);
}

// ── Site lookup & selection ───────────────────────────────────

function getSiteById(siteId) {
  return siteData?.sites?.find((s) => s.id === siteId) ?? null;
}

function updateMarkerHighlight(siteId) {
  siteMarkers.forEach((marker, id) => {
    const site = getSiteById(id);
    if (!site) return;

    if (id === siteId) {
      marker.setStyle({
        radius: MARKER_RADIUS + 3,
        weight: 4,
        color: "#2c3440",
        fillColor: scoreToColor(site.score),
        fillOpacity: 1,
      });
      marker.bringToFront();
    } else {
      marker.setStyle({
        radius: MARKER_RADIUS,
        weight: 2,
        color: "#ffffff",
        fillColor: scoreToColor(site.score),
        fillOpacity: 0.92,
      });
    }
  });
}

function updateListHighlight(siteId) {
  document.querySelectorAll(".site-list__item").forEach((li) => {
    li.classList.toggle("site-list__item--selected", li.dataset.siteId === siteId);
    if (li.dataset.siteId === siteId) {
      li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

function clearHighlights() {
  updateMarkerHighlight(null);
  document.querySelectorAll(".site-list__item--selected").forEach((li) => {
    li.classList.remove("site-list__item--selected");
  });
}

// ── Breakdown panel ───────────────────────────────────────────

function getFlagMessage(factorKey, factor) {
  if (factorKey === "community") return "Community opposition detected nearby";
  if (factorKey === "grid_distance") return "Grid connection risk — substation too far";
  if (factorKey === "wildlife") return "Protected habitat concern";
  if (factorKey === "slope") return "Steep terrain — higher build cost";
  if (factorKey === "locality_distance") return "Too close to town — noise & visual complaints";
  if (factorKey === "maintenance") return "Poor road access — maintenance burden";
  return "Factor flagged for review";
}

function renderFactorRow(factorKey, factor) {
  const isFlagged = Boolean(factor.flag);
  const row = document.createElement("div");
  row.className = `factor-row${isFlagged ? " factor-row--flagged" : ""}`;

  const header = document.createElement("div");
  header.className = "factor-row__header";

  const labelWrap = document.createElement("div");
  labelWrap.className = "factor-row__label-wrap";

  const label = document.createElement("span");
  label.className = "factor-row__label";
  label.textContent = FACTOR_LABELS[factorKey] ?? factorKey;

  labelWrap.appendChild(label);

  const scoreEl = document.createElement("span");
  scoreEl.className = "factor-row__score";
  scoreEl.textContent = factor.score;

  header.append(labelWrap, scoreEl);

  const track = document.createElement("div");
  track.className = "factor-row__bar-track";

  const fill = document.createElement("div");
  fill.className = "factor-row__bar-fill";
  fill.style.width = `${factor.score}%`;
  if (isFlagged) {
    fill.classList.add("factor-row__bar-fill--warning");
  } else {
    fill.style.backgroundColor = scoreToColor(factor.score);
  }

  track.appendChild(fill);

  const raw = document.createElement("p");
  raw.className = "factor-row__raw";
  raw.textContent = factor.raw;

  row.append(header, track, raw);

  if (isFlagged) {
    const flagLine = document.createElement("div");
    flagLine.className = "factor-row__flag-line";

    const icon = document.createElement("span");
    icon.className = "factor-row__flag-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";

    const flagLabel = document.createElement("span");
    flagLabel.className = "factor-row__flag-label";
    flagLabel.textContent = getFlagMessage(factorKey, factor);

    flagLine.append(icon, flagLabel);
    row.insertBefore(flagLine, track);
  }

  return row;
}

function renderBreakdownContent(site) {
  const container = document.getElementById("breakdown-content");
  if (!container) return;

  container.innerHTML = "";

  const title = document.createElement("h2");
  title.className = "breakdown__title";
  title.textContent = `${site.name} — #${site.rank} of ${PARCEL_COUNT.toLocaleString()}`;

  const verdict = document.createElement("p");
  verdict.className = "breakdown__verdict";
  verdict.textContent = site.verdict;

  const scoreBlock = document.createElement("div");
  scoreBlock.className = "breakdown__score-block";

  const scoreLabel = document.createElement("span");
  scoreLabel.className = "breakdown__score-label";
  scoreLabel.textContent = "Overall score";

  const scoreValue = document.createElement("span");
  scoreValue.className = "breakdown__score-value";
  scoreValue.textContent = site.score;
  scoreValue.style.color = scoreToColor(site.score);

  scoreBlock.append(scoreLabel, scoreValue);

  const similarity = document.createElement("div");
  similarity.className = "breakdown__similarity";

  const similarityPct = Math.round(site.similarity_to_proven * 100);
  const similarityText = document.createElement("p");
  similarityText.className = "breakdown__similarity-text";
  similarityText.innerHTML =
    `<strong>${similarityPct}%</strong> similar to ${PROVEN_FARM_COUNT} operating solar farms`;

  similarity.appendChild(similarityText);

  const factorsHeading = document.createElement("h3");
  factorsHeading.className = "breakdown__factors-heading";
  factorsHeading.textContent = "Factor breakdown";

  const factorsList = document.createElement("div");
  factorsList.className = "breakdown__factors";

  FACTOR_ORDER.forEach((key) => {
    const factor = site.factors[key];
    if (factor) factorsList.appendChild(renderFactorRow(key, factor));
  });

  container.append(title, verdict, scoreBlock, similarity, factorsHeading, factorsList);
}

function openBreakdownPanel(site) {
  const panel = document.getElementById("breakdown-panel");
  if (!panel) return;

  renderBreakdownContent(site);
  panel.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
  setTimeout(() => map.invalidateSize(), 320);
}

function closeBreakdownPanel() {
  const panel = document.getElementById("breakdown-panel");
  if (!panel) return;

  panel.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
  selectedSiteId = null;
  clearHighlights();
  setTimeout(() => map.invalidateSize(), 320);
}

function selectSite(siteId) {
  if (!hasEvaluated) return;

  const site = getSiteById(siteId);
  if (!site) return;

  selectedSiteId = siteId;
  updateMarkerHighlight(siteId);
  updateListHighlight(siteId);
  openBreakdownPanel(site);
}

function wireBreakdownPanel() {
  const closeBtn = document.getElementById("breakdown-close");
  if (closeBtn) closeBtn.addEventListener("click", closeBreakdownPanel);
}

function wireSiteListClicks() {
  const listEl = document.getElementById("site-list");
  if (!listEl) return;

  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".site-list__item");
    if (!item) return;
    selectSite(item.dataset.siteId);
  });

  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const item = e.target.closest(".site-list__item");
    if (!item) return;
    e.preventDefault();
    selectSite(item.dataset.siteId);
  });
}

// ── Button states ─────────────────────────────────────────────

function setEvaluateButtonState(state) {
  const btn = document.getElementById("btn-evaluate");
  if (!btn) return;

  btn.classList.remove("btn-evaluate--evaluating", "btn-evaluate--done");

  if (state === "idle") {
    btn.disabled = false;
    btn.textContent = "Evaluate sites";
  } else if (state === "evaluating") {
    btn.disabled = true;
    btn.textContent = "Evaluating…";
    btn.classList.add("btn-evaluate--evaluating");
  } else if (state === "done") {
    btn.disabled = true;
    btn.textContent = `Evaluated ${PARCEL_COUNT.toLocaleString()} parcels`;
    btn.classList.add("btn-evaluate--done");
  }
}

// ── Evaluate flow ─────────────────────────────────────────────

async function handleEvaluateClick() {
  if (isEvaluating || hasEvaluated || !siteData?.sites?.length) return;

  isEvaluating = true;
  setEvaluateButtonState("evaluating");

  const sites = siteData.sites;
  await playScoringAnimation(sites);

  renderRankedList(sites);
  revealResultsPanel();
  setEvaluateButtonState("done");

  isEvaluating = false;
  hasEvaluated = true;
}

function wireEvaluateButton() {
  const btn = document.getElementById("btn-evaluate");
  if (btn) btn.addEventListener("click", handleEvaluateClick);
}

// ── Boot ──────────────────────────────────────────────────────

async function init() {
  siteData = await loadSites();

  const center = siteData?.center ?? { lat: 35.25, lng: -119.0 };
  if (siteData?.county) updateCountyLabel(siteData.county);

  initMap(center);
  wireEvaluateButton();
  wireBreakdownPanel();
  wireSiteListClicks();

  setTimeout(() => map.invalidateSize(), 100);
}

document.addEventListener("DOMContentLoaded", init);
