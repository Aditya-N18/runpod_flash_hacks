// ── Cesium ion token ──────────────────────────────────────────
// Free token: https://ion.cesium.com/signup -> Access Tokens tab -> copy default token.
const CESIUM_ION_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0NzE2ZWE4Ni1kYjE0LTRjY2YtYjBkZi0zMmM3MjljNjE2YjMiLCJpZCI6NDUwOTY1LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODI4NTA2NzR9.LdCJhGvlXWXn2XqDlqRn-eeqUE_pZCwDEkYHJ1_Tbmo";

const PARCEL_COUNT = 2400;
const PROVEN_FARM_COUNT = 14;
const HIGHLIGHT_STROKE = "#2c3440";

let viewer = null;
let siteData = null;
let selectedSiteId = null;
let highlightedEntityId = null;

// ── Score → color (same gradient as the 2D app, ported for Cesium) ──

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function scoreToColor(score) {
  const s = Math.max(0, Math.min(100, score)) / 100;
  const red = { r: 193, g: 96, b: 74 };
  const yellow = { r: 232, g: 163, b: 61 };
  const green = { r: 143, g: 168, b: 136 };

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

function scoreToCesiumColor(score) {
  return Cesium.Color.fromCssColorString(scoreToColor(score));
}

// ── Token guard ───────────────────────────────────────────────

function tokenIsMissing() {
  return !CESIUM_ION_TOKEN || CESIUM_ION_TOKEN.includes("PASTE_YOUR");
}

function showTokenBanner() {
  const container = document.getElementById("cesiumContainer");
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;">
      <div style="max-width:480px;font-family:Inter,sans-serif;">
        <h2 style="font-size:1.25rem;margin-bottom:12px;">Cesium ion token needed</h2>
        <p style="font-size:0.9375rem;line-height:1.6;color:#555;">
          Sun View needs a free Cesium ion token for terrain + imagery.
          Get one at <a href="https://ion.cesium.com/signup" target="_blank" rel="noopener">ion.cesium.com/signup</a>
          (Access Tokens tab → copy the default token), then paste it into
          <code>CESIUM_ION_TOKEN</code> at the top of <code>sun-view.js</code>.
        </p>
      </div>
    </div>`;
}

// ── Time helpers ──────────────────────────────────────────────

function setClockToPacificHour(hourFloat) {
  const jsDate = SolarMath.pacificHourToDate(hourFloat);
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(jsDate);
}

function updateTimeDisplay(hourFloat) {
  document.getElementById("sv-time-display").textContent = SolarMath.formatPacificHour(hourFloat);
}

function updateSunReadout(hourFloat) {
  const jsDate = SolarMath.pacificHourToDate(hourFloat);
  const { altitudeDeg, azimuthCompassDeg } = SolarMath.getSunPosition(
    siteData.center.lat,
    siteData.center.lng,
    jsDate
  );
  document.getElementById("sv-sun-altitude").textContent = `Altitude: ${altitudeDeg.toFixed(1)}°`;
  document.getElementById("sv-sun-azimuth").textContent = `Azimuth: ${azimuthCompassDeg.toFixed(0)}°`;
}

function currentSliderHour() {
  return parseFloat(document.getElementById("sv-time-slider").value);
}

// ── Site entities ─────────────────────────────────────────────

function getSiteById(siteId) {
  return siteData?.sites?.find((s) => s.id === siteId) ?? null;
}

function addSiteEntity(site) {
  viewer.entities.add({
    id: site.id,
    position: Cesium.Cartesian3.fromDegrees(site.lng, site.lat),
    point: {
      pixelSize: 14,
      color: scoreToCesiumColor(site.score),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function setEntityHighlight(siteId, isHighlighted) {
  const entity = viewer.entities.getById(siteId);
  if (!entity) return;
  const site = getSiteById(siteId);
  if (isHighlighted) {
    entity.point.pixelSize = 22;
    entity.point.outlineWidth = 4;
    entity.point.outlineColor = Cesium.Color.fromCssColorString(HIGHLIGHT_STROKE);
  } else {
    entity.point.pixelSize = 14;
    entity.point.outlineWidth = 2;
    entity.point.outlineColor = Cesium.Color.WHITE;
    entity.point.color = scoreToCesiumColor(site.score);
  }
}

function wireClickHandler() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id && picked.id.id) {
      selectSite(picked.id.id);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// ── Selection + panel ─────────────────────────────────────────

function selectSite(siteId) {
  const site = getSiteById(siteId);
  if (!site) return;

  if (highlightedEntityId) setEntityHighlight(highlightedEntityId, false);
  setEntityHighlight(siteId, true);
  highlightedEntityId = siteId;
  selectedSiteId = siteId;

  renderPanelForSite(siteId);
  openPanel();

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(site.lng, site.lat, 3000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
    duration: 1.2,
  });
}

function renderPanelForSite(siteId) {
  const site = getSiteById(siteId);
  if (!site) return;

  const hourFloat = currentSliderHour();
  const jsDate = SolarMath.pacificHourToDate(hourFloat);
  const { altitudeDeg, azimuthCompassDeg } = SolarMath.getSunPosition(site.lat, site.lng, jsDate);
  const exposure = SolarMath.computeExposure(altitudeDeg, azimuthCompassDeg, site.slope_deg, site.aspect_deg);
  const peak = SolarMath.findPeakExposureToday(site.lat, site.lng, site.slope_deg, site.aspect_deg);
  const similarityPct = Math.round(site.similarity_to_proven * 100);

  const container = document.getElementById("sv-panel-content");
  container.innerHTML = `
    <h2 class="breakdown__title">${site.name} — #${site.rank} of ${PARCEL_COUNT.toLocaleString()}</h2>
    <p class="breakdown__verdict">${site.verdict}</p>
    <div class="breakdown__score-block">
      <span class="breakdown__score-label">Overall score</span>
      <span class="breakdown__score-value" style="color:${scoreToColor(site.score)}">${site.score}</span>
    </div>
    <div class="breakdown__similarity">
      <p class="breakdown__similarity-text"><strong>${similarityPct}%</strong> similar to ${PROVEN_FARM_COUNT} operating solar farms</p>
    </div>
    <div class="sv-exposure-block">
      <div class="sv-exposure-label">Sun exposure right now</div>
      <div class="sv-exposure-value" style="color:${scoreToColor(exposure)}">${altitudeDeg > 0 ? exposure : "—"}</div>
      <div class="sv-exposure-meta">
        ${altitudeDeg > 0
          ? `Sun altitude ${altitudeDeg.toFixed(1)}°, azimuth ${azimuthCompassDeg.toFixed(0)}° &middot; slope ${site.slope_deg}° facing ${site.aspect_deg}°`
          : "Sun is below the horizon at this time."}
      </div>
      ${peak ? `<div class="sv-exposure-peak">Peak exposure today: ${SolarMath.formatPacificHour(peak.hourFloat)} (${peak.exposure})</div>` : ""}
    </div>
  `;
}

function openPanel() {
  const panel = document.getElementById("sv-panel");
  panel.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
}

function closePanel() {
  const panel = document.getElementById("sv-panel");
  panel.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
  if (highlightedEntityId) {
    setEntityHighlight(highlightedEntityId, false);
    highlightedEntityId = null;
  }
  selectedSiteId = null;
  document.getElementById("sv-panel-content").innerHTML =
    '<p class="sv-empty-hint">Click a site marker on the globe to see its live sun exposure.</p>';
}

// ── Time controls wiring ──────────────────────────────────────

function applyHour(hourFloat) {
  setClockToPacificHour(hourFloat);
  updateTimeDisplay(hourFloat);
  updateSunReadout(hourFloat);
  if (selectedSiteId) renderPanelForSite(selectedSiteId);
}

function wireTimeControls() {
  const slider = document.getElementById("sv-time-slider");
  const nowBtn = document.getElementById("sv-now-btn");

  slider.addEventListener("input", () => applyHour(parseFloat(slider.value)));

  nowBtn.addEventListener("click", () => {
    const hour = SolarMath.nowAsPacificHour();
    slider.value = hour;
    applyHour(hour);
  });

  document.getElementById("sv-panel-close").addEventListener("click", closePanel);
}

// ── Boot ──────────────────────────────────────────────────────

async function init() {
  if (tokenIsMissing()) {
    showTokenBanner();
    return;
  }

  Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

  const res = await fetch("data/mockSites.json");
  siteData = await res.json();

  viewer = new Cesium.Viewer("cesiumContainer", {
    terrain: Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true }),
    shadows: true,
    terrainShadows: Cesium.ShadowMode.ENABLED,
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });

  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.clock.shouldAnimate = false;

  const center = siteData.center;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, 25000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 2,
  });

  siteData.sites.forEach(addSiteEntity);
  wireClickHandler();
  wireTimeControls();

  const nowHour = SolarMath.nowAsPacificHour();
  document.getElementById("sv-time-slider").value = nowHour;
  applyHour(nowHour);
}

document.addEventListener("DOMContentLoaded", init);
