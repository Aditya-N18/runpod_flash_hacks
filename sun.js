/*
 * SolarMath — sun position + tilted-surface exposure proxy.
 * Pure functions, no DOM/Cesium dependency. Requires SunCalc (loaded via CDN) to be present globally.
 *
 * Exposure model: simplified Lambertian cosine-of-incidence on a tilted plane
 * (Duffie & Beckman tilted-surface model, flat-terrain simplification). This is a
 * demo proxy for relative sun exposure, not a calibrated solar-irradiance engine.
 */

const SolarMath = (() => {
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  // PDT (US Pacific Daylight Time, UTC-7) — correct for the event date (late June).
  // Simplification: does not handle DST transitions outside summer.
  const PACIFIC_UTC_OFFSET_HOURS = 7;

  /**
   * Convert a local-Pacific hour-of-day (0-24, decimal) on "today" into a JS Date (UTC instant).
   */
  function pacificHourToDate(hourFloat) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const utcMs =
      Date.UTC(y, m, d, 0, 0, 0, 0) + (hourFloat + PACIFIC_UTC_OFFSET_HOURS) * 3600 * 1000;
    return new Date(utcMs);
  }

  /**
   * Current time of day in Pacific hours (0-24, decimal), for "Now" button.
   */
  function nowAsPacificHour() {
    const now = new Date();
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    let pacificHour = utcHour - PACIFIC_UTC_OFFSET_HOURS;
    if (pacificHour < 0) pacificHour += 24;
    if (pacificHour >= 24) pacificHour -= 24;
    return pacificHour;
  }

  /**
   * Sun altitude + azimuth (compass bearing, 0=N/90=E/180=S/270=W) for a lat/lng at a given Date.
   * SunCalc's azimuth is measured from south, clockwise toward west — convert to compass bearing.
   */
  function getSunPosition(lat, lng, date) {
    const pos = SunCalc.getPosition(date, lat, lng);
    const altitudeDeg = pos.altitude * RAD2DEG;
    const sunCalcAzimuthDeg = pos.azimuth * RAD2DEG;
    const azimuthCompassDeg = (sunCalcAzimuthDeg + 180 + 360) % 360;
    return { altitudeDeg, azimuthCompassDeg };
  }

  /**
   * Cosine-of-incidence exposure (0-100) of a tilted plane (slopeDeg, aspectDeg — compass
   * bearing the slope faces) given the sun's altitude + azimuth (compass bearing).
   * Returns 0 when the sun is below the horizon.
   */
  function computeExposure(sunAltitudeDeg, sunAzimuthCompassDeg, slopeDeg, aspectDeg) {
    if (sunAltitudeDeg <= 0) return 0;

    const alt = sunAltitudeDeg * DEG2RAD;
    const slope = slopeDeg * DEG2RAD;
    const azDiff = (sunAzimuthCompassDeg - aspectDeg) * DEG2RAD;

    const cosIncidence =
      Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(azDiff);

    return Math.round(Math.max(0, cosIncidence) * 100);
  }

  /**
   * Scan today (06:00-19:00 Pacific, 15-min steps) to find the hour of peak exposure for a site.
   * Returns { hourFloat, exposure } or null if the sun never clears the horizon in the window.
   */
  function findPeakExposureToday(lat, lng, slopeDeg, aspectDeg) {
    let best = null;
    for (let h = 6; h <= 19; h += 0.25) {
      const date = pacificHourToDate(h);
      const { altitudeDeg, azimuthCompassDeg } = getSunPosition(lat, lng, date);
      const exposure = computeExposure(altitudeDeg, azimuthCompassDeg, slopeDeg, aspectDeg);
      if (!best || exposure > best.exposure) {
        best = { hourFloat: h, exposure };
      }
    }
    return best;
  }

  function formatPacificHour(hourFloat) {
    const h24 = Math.floor(hourFloat);
    const minute = Math.round((hourFloat - h24) * 60);
    const period = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return `${h12}:${String(minute).padStart(2, "0")} ${period} PT`;
  }

  return {
    pacificHourToDate,
    nowAsPacificHour,
    getSunPosition,
    computeExposure,
    findPeakExposureToday,
    formatPacificHour,
  };
})();
