// Collective Score base layer rendering in p5.js
// Reuses prepareSiteGeoJSON, featuresNeedStatePlaneTransform, fitStatePlaneToWgs84,
// and transformStatePlaneWithFit, all defined globally in collective-score.html's
// inline script, which loads before this file. Also reads window.categoryFills,
// defined in that same script, which holds the current fill character chosen
// for each building type and vegetation type.
//
// Two modes:
// - View: freely pannable and zoomable, the everyday working view of the
//   whole composition, not tied to any page size.
// - Print: a fixed 11x17 portrait page at a chosen architectural scale
//   (1:500 to 1:5000), centred on wherever you have panned to in View mode.
//
// The whole composition is rotated 42 degrees, applied in real-world feet
// before anything is scaled to the screen or the page, so it stays correct
// at any zoom level or print scale.
//
// Buildings and vegetation are both rendered as a field of repeated
// characters filling each shape, after Frederick Hammersley's 1969
// line-printer "computer drawings", where tone and form came from character
// choice and density on a fixed grid rather than from color or a flat fill.
// Each category (building type, vegetation lifeform) can carry its own
// character, chosen in the sidebar. Streets and contours stay as fine drawn
// lines, since they are not enclosed shapes.

let scoreLayers = { streets: [], buildings: [], contours: [], vegetation: [] };
let scoreCentroid = null;
let scoreReady = false;

const HATCH_PITCH = 7;
const DEFAULT_CHAR = '.';

function normalizeFillEntry(entry) {
  if (!entry) return { char: DEFAULT_CHAR, color: '#1a1a1a' };
  if (typeof entry === 'string') return { char: entry || DEFAULT_CHAR, color: '#1a1a1a' };
  return {
    char: entry.char || DEFAULT_CHAR,
    color: entry.color || '#1a1a1a',
  };
}

const ROTATION_DEG = 42;
const FT_PER_DEG_LAT = 364000;

const PAGE_WIDTH_IN = 11;
const PAGE_HEIGHT_IN = 17;
const PAGE_MARGIN_PX = 40;

let scoreMode = 'view';
let panRX = 0;
let panRY = 0;
let viewZoom = 1;
let baseFitPxPerFt = 1;

let isDragging = false;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStartPanRX = 0;
let dragStartPanRY = 0;

function setup() {
  const wrap = document.getElementById('scoreCanvasWrap');
  if (!wrap) return;
  const c = createCanvas(wrap.clientWidth, wrap.clientHeight);
  c.parent('scoreCanvasWrap');
  textFont('monospace');
  textAlign(CENTER, CENTER);
  noLoop();
  loadScoreLayers();
  bindModeControls();
}

function windowResized() {
  const wrap = document.getElementById('scoreCanvasWrap');
  if (!wrap) return;
  resizeCanvas(wrap.clientWidth, wrap.clientHeight);
  redraw();
}

function bindModeControls() {
  const viewBtn = document.getElementById('btnViewMode');
  const printBtn = document.getElementById('btnPrintMode');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      scoreMode = 'view';
      viewBtn.classList.add('primary');
      viewBtn.classList.remove('ghost');
      if (printBtn) { printBtn.classList.add('ghost'); printBtn.classList.remove('primary'); }
      redraw();
    });
  }
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      scoreMode = 'print';
      printBtn.classList.add('primary');
      printBtn.classList.remove('ghost');
      if (viewBtn) { viewBtn.classList.add('ghost'); viewBtn.classList.remove('primary'); }
      redraw();
    });
  }
  const scaleEl = document.getElementById('exportScale');
  if (scaleEl) {
    scaleEl.addEventListener('change', () => redraw());
  }
}

async function loadScoreLayers() {
  const statusEl = document.getElementById('scoreLoadMsg');
  try {
    const [streetsRes, buildingsRes] = await Promise.all([
      fetch('geojson/searanch-roads.geojson'),
      fetch('geojson/searanch-buildings.geojson'),
    ]);
    if (!streetsRes.ok || !buildingsRes.ok) throw new Error('GeoJSON fetch failed');
    const streets = await streetsRes.json();
    const buildings = await buildingsRes.json();
    const prepared = prepareSiteGeoJSON(streets, buildings);

    let contourFeatures = [];
    try {
      const contoursRes = await fetch('geojson/contours-1m.geojson');
      if (contoursRes.ok) {
        const contours = await contoursRes.json();
        if (contours && contours.features) {
          contourFeatures = contours.features;
          if (featuresNeedStatePlaneTransform(contourFeatures)) {
            const fit = fitStatePlaneToWgs84(prepared.streets.features);
            contourFeatures = transformStatePlaneWithFit(contourFeatures, fit);
          }
        }
      }
    } catch (_) {
      // Contours are optional, absence should not block streets and buildings.
    }

    scoreLayers.streets = prepared.streets.features;
    scoreLayers.buildings = prepared.buildings.features;
    scoreLayers.contours = contourFeatures;

    const bounds = computeLngLatBounds([
      ...scoreLayers.streets,
      ...scoreLayers.buildings,
      ...scoreLayers.contours,
    ]);
    scoreCentroid = {
      lng: (bounds.minLng + bounds.maxLng) / 2,
      lat: (bounds.minLat + bounds.maxLat) / 2,
    };

    computeBaseFitScale(bounds);
    scoreReady = true;
    if (statusEl) statusEl.style.display = 'none';
    redraw();
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Unable to load site layers.';
  }
}

let vegetationLoaded = false;
let vegetationLoading = false;

// Only called when the Vegetation toggle is actually switched on, rather
// than automatically after the page loads, since this file is large and
// most visits will never turn this layer on at all.
window.loadVegetationLayer = async function loadVegetationLayer() {
  if (vegetationLoaded || vegetationLoading) return;
  vegetationLoading = true;
  const statusEl = document.getElementById('scoreLoadMsg');
  if (statusEl) {
    statusEl.textContent = 'Loading vegetation…';
    statusEl.style.display = 'block';
  }
  try {
    const vegRes = await fetch('geojson/SeaRanch_VegetationTypes.geojson');
    if (vegRes.ok) {
      const veg = await vegRes.json();
      if (veg && veg.features) {
        // This file is already in plain longitude/latitude, no state-plane
        // correction needed, unlike contours.
        scoreLayers.vegetation = veg.features;
        vegetationLoaded = true;
      }
    }
  } catch (err) {
    console.error('Vegetation layer failed to load:', err);
  } finally {
    vegetationLoading = false;
    if (statusEl) statusEl.style.display = 'none';
    redraw();
  }
};

function computeLngLatBounds(features) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function walk(coords) {
    if (typeof coords[0] === 'number') {
      const lng = coords[0], lat = coords[1];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    coords.forEach(walk);
  }
  features.forEach((f) => { if (f.geometry) walk(f.geometry.coordinates); });
  return { minLng, maxLng, minLat, maxLat };
}

function computeBaseFitScale(bounds) {
  const corners = [
    [bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.minLat],
    [bounds.maxLng, bounds.maxLat], [bounds.minLng, bounds.maxLat],
  ];
  let minRx = Infinity, maxRx = -Infinity, minRy = Infinity, maxRy = -Infinity;
  corners.forEach(([lng, lat]) => {
    const { rx, ry } = toRotatedFeet(lng, lat);
    if (rx < minRx) minRx = rx;
    if (rx > maxRx) maxRx = rx;
    if (ry < minRy) minRy = ry;
    if (ry > maxRy) maxRy = ry;
  });
  const siteWidthFt = (maxRx - minRx) || 1;
  const siteHeightFt = (maxRy - minRy) || 1;
  const availW = width - PAGE_MARGIN_PX * 2;
  const availH = height - PAGE_MARGIN_PX * 2;
  baseFitPxPerFt = Math.min(availW / siteWidthFt, availH / siteHeightFt);
}

function toRotatedFeet(lng, lat) {
  const midLatRad = scoreCentroid.lat * Math.PI / 180;
  const ftPerDegLng = FT_PER_DEG_LAT * Math.cos(midLatRad);
  const dx = (lng - scoreCentroid.lng) * ftPerDegLng;
  const dy = (lat - scoreCentroid.lat) * FT_PER_DEG_LAT;

  const rad = -ROTATION_DEG * Math.PI / 180;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { rx, ry };
}

function currentScaleDenominator() {
  const el = document.getElementById('exportScale');
  if (!el) return 500;
  const val = el.value || '1:500';
  const parts = val.split(':');
  return Number(parts[1]) || 500;
}

function getViewGeometry() {
  const pxPerFt = baseFitPxPerFt * viewZoom;
  return { mode: 'view', pxPerFt, centerX: width / 2, centerY: height / 2 };
}

function getPrintGeometry() {
  const scaleDenom = currentScaleDenominator();
  const availW = width - PAGE_MARGIN_PX * 2;
  const availH = height - PAGE_MARGIN_PX * 2;
  const pxPerInch = Math.min(availW / PAGE_WIDTH_IN, availH / PAGE_HEIGHT_IN);
  const pageW = PAGE_WIDTH_IN * pxPerInch;
  const pageH = PAGE_HEIGHT_IN * pxPerInch;
  const pageX = (width - pageW) / 2;
  const pageY = (height - pageH) / 2;
  const ftPerPagePixel = (scaleDenom / 12) / pxPerInch;
  const pxPerFt = 1 / ftPerPagePixel;
  return {
    mode: 'print', scaleDenom, pxPerFt, pageW, pageH, pageX, pageY,
    centerX: pageX + pageW / 2, centerY: pageY + pageH / 2,
  };
}

function project(lng, lat, geo) {
  const { rx, ry } = toRotatedFeet(lng, lat);
  const x = geo.centerX + (rx - panRX) * geo.pxPerFt;
  const y = geo.centerY - (ry - panRY) * geo.pxPerFt;
  return { x, y };
}

function ringToScreen(ring, geo) {
  return ring.map(([lng, lat]) => project(lng, lat, geo));
}

function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const intersects = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function drawPageFrame(geo) {
  push();
  noStroke();
  fill('#e8e8e8');
  rect(0, 0, width, height);
  fill('#ffffff');
  stroke('#1a1a1a');
  strokeWeight(1);
  rect(geo.pageX, geo.pageY, geo.pageW, geo.pageH);
  pop();
}


function nearestOffsetGridPoint(x, y, offset) {
  const gx = Math.round((x - offset) / HATCH_PITCH) * HATCH_PITCH + offset;
  const gy = Math.round((y - offset) / HATCH_PITCH) * HATCH_PITCH + offset;
  return { gx, gy };
}

function drawStreets(geo) {
  if (!state.layers.streets) return;
  noStroke();
  textSize(HATCH_PITCH * 0.9);

  const offset = HATCH_PITCH / 2;
  const stepPx = HATCH_PITCH * 0.5;
  const drawnPoints = new Set();

  const roadFills = (window.categoryFills && window.categoryFills.streets) || {};

  scoreLayers.streets.forEach((f) => {
    if (!f.geometry) return;
    const category = (f.properties && f.properties.Class) || 'Local';
    const { char: ch, color } = normalizeFillEntry(roadFills[category]);
    fill(color);
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringToScreen(line, geo);
      for (let i = 0; i < pts.length - 1; i++) {
        const x1 = pts[i].x, y1 = pts[i].y, x2 = pts[i + 1].x, y2 = pts[i + 1].y;
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(segLen / stepPx));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = x1 + (x2 - x1) * t;
          const y = y1 + (y2 - y1) * t;
          if (x < -HATCH_PITCH || x > width + HATCH_PITCH || y < -HATCH_PITCH || y > height + HATCH_PITCH) continue;
          const { gx, gy } = nearestOffsetGridPoint(x, y, offset);
          const key = gx + ',' + gy;
          if (!drawnPoints.has(key)) {
            drawnPoints.add(key);
            text(ch, gx, gy);
          }
        }
      }
    });
  });
}

function drawContours(geo) {
  if (!state.layers.contours) return;
  const contourColor = (window.layerColors && window.layerColors.contours) || '#dddddd';
  stroke(contourColor);
  strokeWeight(0.4);
  noFill();
  scoreLayers.contours.forEach((f) => {
    if (!f.geometry) return;
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringToScreen(line, geo);
      beginShape();
      pts.forEach((p) => vertex(p.x, p.y));
      endShape();
    });
  });
}

// Shared by drawBuildings and drawVegetation, since both are now categorized
// character fills, just reading a different property and a different
// character map.
function drawCategorizedFill(geo, features, categoryField, fillGroupKey) {
  const fills = (window.categoryFills && window.categoryFills[fillGroupKey]) || {};

  features.forEach((f) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];

    const category = (f.properties && f.properties[categoryField]) || 'Other';
    const { char: ch, color } = normalizeFillEntry(fills[category]);

    polys.forEach((poly) => {
      const outerRing = ringToScreen(poly[0], geo);

      noFill();
      if (window.state && state.mapView && state.mapView.showOutlines) {
        const outlineColor = (window.layerColors && window.layerColors.outlines) || '#999999';
        stroke(outlineColor);
        strokeWeight(0.5);
      } else {
        noStroke();
      }
      beginShape();
      outerRing.forEach((p) => vertex(p.x, p.y));
      endShape(CLOSE);

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      outerRing.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });

      if (maxX < 0 || minX > width || maxY < 0 || minY > height) return;

      noStroke();
      fill(color);
      textSize(HATCH_PITCH * 0.9);

      if (maxX - minX < HATCH_PITCH && maxY - minY < HATCH_PITCH) {
        text(ch, (minX + maxX) / 2, (minY + maxY) / 2);
        return;
      }

      const gridStartX = Math.floor(minX / HATCH_PITCH) * HATCH_PITCH;
      const gridStartY = Math.floor(minY / HATCH_PITCH) * HATCH_PITCH;
      for (let gy = gridStartY; gy <= maxY; gy += HATCH_PITCH) {
        for (let gx = gridStartX; gx <= maxX; gx += HATCH_PITCH) {
          if (pointInPolygon(gx, gy, outerRing)) {
            text(ch, gx, gy);
          }
        }
      }
    });
  });
}

function drawBuildings(geo) {
  if (!state.layers.buildings) return;
  drawCategorizedFill(geo, scoreLayers.buildings, 'PropType', 'buildings');
}

function drawVegetation(geo) {
  if (!state.layers.vegetation) return;
  drawCategorizedFill(geo, scoreLayers.vegetation, 'LIFEFORM', 'vegetation');
}

// --- Observation lexicon marks (native p5, same feet → rotate → project pipeline) ---
//
// Site layers arrive as WGS84 lng/lat (after prepareSiteGeoJSON state-plane fit).
// Anchors use toRotatedFeet (42°) then project so marks sit on the rotated site.
// Local sketch offsets are applied upright in screen space (scale only); per-mark
// rot still applies in field space. Real-world size: sketch.scaleFt feet across
// MARK_SCALE_BAR_PX field pixels (default scaleFt = 10).

const MARK_FIELD_W = 600;
const MARK_FIELD_H = 800;
const MARK_SCALE_BAR_PX = 100;
const MARK_HATCH_LINE_STEP = 8;
const FALLBACK_DOT_RADIUS_FT = 3;

function getNotationsToDraw() {
  if (typeof state === 'undefined' || !state || !Array.isArray(state.notations)) return [];
  if (Array.isArray(state.filteredNotations)) return state.filteredNotations;
  return state.notations;
}

function markFtPerFieldPx(sketch) {
  const scaleFt = sketch && sketch.scaleFt != null ? Number(sketch.scaleFt) : 10;
  return (scaleFt > 0 ? scaleFt : 10) / MARK_SCALE_BAR_PX;
}

function fieldPointToScreen(fx, fy, lng, lat, ftPerPx, geo) {
  // Anchor: full rotated site pipeline (same as streets/buildings).
  const anchor = project(lng, lat, geo);
  // Local geometry: upright field axes at that screen point (no 42° on shape offsets).
  const dxFt = (fx - MARK_FIELD_W / 2) * ftPerPx;
  const dyFt = (fy - MARK_FIELD_H / 2) * ftPerPx;
  return {
    x: anchor.x + dxFt * geo.pxPerFt,
    y: anchor.y + dyFt * geo.pxPerFt,
  };
}

function markLocalCenter(m) {
  const g = m.geom || {};
  if (m.type === 'line') {
    return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
  }
  if (m.type === 'circle' || m.type === 'dot' || m.type === 'semicircle') {
    return { x: g.cx, y: g.cy };
  }
  if (Array.isArray(g.pts) && g.pts.length) {
    let sx = 0, sy = 0;
    g.pts.forEach((p) => { sx += p.x; sy += p.y; });
    return { x: sx / g.pts.length, y: sy / g.pts.length };
  }
  return { x: MARK_FIELD_W / 2, y: MARK_FIELD_H / 2 };
}

function rotateFieldPt(p, c, rot) {
  if (!rot) return { x: p.x, y: p.y };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function mapFieldPts(pts, lng, lat, ftPerPx, geo, pivot, rot) {
  return pts.map((p) => {
    const r = rotateFieldPt(p, pivot, rot);
    return fieldPointToScreen(r.x, r.y, lng, lat, ftPerPx, geo);
  });
}

function semiArcAngles(orient) {
  const o = orient || 0;
  if (o === 1) return { start: Math.PI / 2, end: -Math.PI / 2, ccw: true };
  if (o === 2) return { start: 0, end: Math.PI, ccw: false };
  if (o === 3) return { start: -Math.PI / 2, end: Math.PI / 2, ccw: false };
  return { start: Math.PI, end: 0, ccw: true };
}

function setMarkDash(lineStyle, weightPx) {
  const ctx = drawingContext;
  if (lineStyle === 'dashed') {
    ctx.setLineDash([Math.max(weightPx * 3, 8), Math.max(weightPx * 2, 5)]);
  } else if (lineStyle === 'dotted') {
    ctx.setLineDash([Math.max(weightPx * 0.2, 1), Math.max(weightPx * 2, 4)]);
  } else {
    ctx.setLineDash([]);
  }
}

function hatchFillScreen(screenPts, color, fillStyle, stepPx) {
  if (!screenPts.length) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  screenPts.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  const ctx = drawingContext;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(stepPx * 0.2, 0.75);
  ctx.setLineDash([]);
  if (fillStyle === 'h' || fillStyle === 'cross') {
    for (let y = minY; y <= maxY; y += stepPx) {
      ctx.beginPath();
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
      ctx.stroke();
    }
  }
  if (fillStyle === 'd' || fillStyle === 'cross') {
    const span = Math.max(maxX - minX, maxY - minY) * 2;
    for (let d = -span; d <= span; d += stepPx) {
      ctx.beginPath();
      ctx.moveTo(minX + d, minY);
      ctx.lineTo(minX + d + span, maxY);
      ctx.stroke();
    }
  }
  if (fillStyle === 'dots') {
    const dotR = Math.max(stepPx * 0.15, 0.6);
    const dotStep = stepPx * (10 / 8);
    for (let y = minY; y <= maxY; y += dotStep) {
      for (let x = minX; x <= maxX; x += dotStep) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function strokeScreenPolyline(screenPts, close) {
  if (!screenPts.length) return;
  beginShape();
  screenPts.forEach((p) => vertex(p.x, p.y));
  if (close) endShape(CLOSE);
  else endShape();
}

function drawSketchMark(m, lng, lat, ftPerPx, geo) {
  if (!m || !m.geom) return;
  const g = m.geom;
  const pivot = markLocalCenter(m);
  const rot = m.rot || 0;
  const color = m.color || '#1a1a1a';
  const weightPx = Math.max((m.weight || 1) * ftPerPx * geo.pxPerFt, 0.5);
  const hatchStep = MARK_HATCH_LINE_STEP * ftPerPx * geo.pxPerFt;

  const toScreen = (fx, fy) => {
    const r = rotateFieldPt({ x: fx, y: fy }, pivot, rot);
    return fieldPointToScreen(r.x, r.y, lng, lat, ftPerPx, geo);
  };

  if (m.type === 'dot') {
    const c = toScreen(g.cx, g.cy);
    const edge = toScreen(g.cx + g.r, g.cy);
    const rPx = Math.hypot(edge.x - c.x, edge.y - c.y);
    noStroke();
    fill(color);
    circle(c.x, c.y, rPx * 2);
    return;
  }

  if (m.type === 'line') {
    if (m.stroke === false) return;
    const a = toScreen(g.x1, g.y1);
    const b = toScreen(g.x2, g.y2);
    stroke(color);
    strokeWeight(weightPx);
    strokeCap(ROUND);
    setMarkDash(m.lineStyle, weightPx);
    line(a.x, a.y, b.x, b.y);
    drawingContext.setLineDash([]);
    return;
  }

  if (m.type === 'semicircle') {
    if (m.stroke === false) return;
    const samples = [];
    const a = semiArcAngles(g.orient);
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let ang;
      if (a.ccw) {
        let delta = a.end - a.start;
        if (delta > 0) delta -= Math.PI * 2;
        ang = a.start + delta * t;
      } else {
        let delta = a.end - a.start;
        if (delta < 0) delta += Math.PI * 2;
        ang = a.start + delta * t;
      }
      samples.push(toScreen(g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)));
    }
    noFill();
    stroke(color);
    strokeWeight(weightPx);
    strokeCap(ROUND);
    setMarkDash(m.lineStyle, weightPx);
    beginShape();
    samples.forEach((p) => vertex(p.x, p.y));
    endShape();
    drawingContext.setLineDash([]);
    return;
  }

  if (m.type === 'circle') {
    const samples = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      samples.push({
        x: g.cx + g.r * Math.cos(t),
        y: g.cy + g.r * Math.sin(t),
      });
    }
    const screenPts = mapFieldPts(samples, lng, lat, ftPerPx, geo, pivot, rot);
    if (m.fill === 'solid') {
      noStroke();
      fill(color);
      strokeScreenPolyline(screenPts, true);
    } else if (m.fill && m.fill !== 'none') {
      hatchFillScreen(screenPts, color, m.fill, hatchStep);
    }
    if (m.stroke !== false) {
      noFill();
      stroke(color);
      strokeWeight(weightPx);
      drawingContext.setLineDash([]);
      strokeScreenPolyline(screenPts, true);
    }
    return;
  }

  // triangle, rectangle, diamond (closed polygons via geom.pts)
  if (!Array.isArray(g.pts) || !g.pts.length) return;
  const screenPts = mapFieldPts(g.pts, lng, lat, ftPerPx, geo, pivot, rot);
  if (m.fill === 'solid') {
    noStroke();
    fill(color);
    strokeScreenPolyline(screenPts, true);
  } else if (m.fill && m.fill !== 'none') {
    hatchFillScreen(screenPts, color, m.fill, hatchStep);
  }
  if (m.stroke !== false) {
    noFill();
    stroke(color);
    strokeWeight(weightPx);
    drawingContext.setLineDash([]);
    strokeScreenPolyline(screenPts, true);
  }
}

const FALLBACK_DOT_COLOR = '#2a6049';
const MISSING_LEXICON_COLOR = '#c45c26';

function drawFallbackNotationDot(notation, geo) {
  if (notation.lat == null || notation.lng == null) return;
  const p = project(notation.lng, notation.lat, geo);
  const rPx = Math.max(FALLBACK_DOT_RADIUS_FT * geo.pxPerFt, 2);
  const missing = notation.lexiconLinkStatus === 'missing';

  if (missing) {
    noFill();
    stroke(MISSING_LEXICON_COLOR);
    strokeWeight(Math.max(rPx * 0.35, 1.5));
    circle(p.x, p.y, rPx * 2);
    const arm = rPx * 0.55;
    line(p.x - arm, p.y - arm, p.x + arm, p.y + arm);
    line(p.x + arm, p.y - arm, p.x - arm, p.y + arm);
    return;
  }

  noStroke();
  fill(FALLBACK_DOT_COLOR);
  circle(p.x, p.y, rPx * 2);
}

function drawNotations(geo) {
  const notations = getNotationsToDraw();
  notations.forEach((notation) => {
    if (notation.lat == null || notation.lng == null) return;

    if (notation.lexiconLinkStatus === 'missing') {
      drawFallbackNotationDot(notation, geo);
      return;
    }

    const marks = notation.sketch && Array.isArray(notation.sketch.marks)
      ? notation.sketch.marks
      : null;
    if (!marks || !marks.length) {
      drawFallbackNotationDot(notation, geo);
      return;
    }
    const ftPerPx = markFtPerFieldPx(notation.sketch);
    marks.forEach((m) => drawSketchMark(m, notation.lng, notation.lat, ftPerPx, geo));
  });
}

/** Sidebar preview: same mark geometry as the score, drawn in field space into the preview box. */
window.renderSelectedNotationPreview = function renderSelectedNotationPreview(container, notation) {
  if (!container) return;
  container.innerHTML = '';

  const cssW = 72;
  const cssH = 54;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  if (notation.lexiconLinkStatus === 'missing') {
    const cx = cssW / 2;
    const cy = cssH / 2;
    const r = 10;
    ctx.strokeStyle = MISSING_LEXICON_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - 5);
    ctx.lineTo(cx + 5, cy + 5);
    ctx.moveTo(cx + 5, cy - 5);
    ctx.lineTo(cx - 5, cy + 5);
    ctx.stroke();
    return;
  }

  const marks = notation.sketch && Array.isArray(notation.sketch.marks)
    ? notation.sketch.marks
    : null;

  if (!marks || !marks.length) {
    ctx.fillStyle = FALLBACK_DOT_COLOR;
    ctx.beginPath();
    ctx.arc(cssW / 2, cssH / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const pad = 6;
  const scale = Math.min((cssW - pad * 2) / MARK_FIELD_W, (cssH - pad * 2) / MARK_FIELD_H);
  const ox = (cssW - MARK_FIELD_W * scale) / 2;
  const oy = (cssH - MARK_FIELD_H * scale) / 2;

  function toPreview(fx, fy) {
    return { x: ox + fx * scale, y: oy + fy * scale };
  }

  function rotatePt(p, c, rot) {
    if (!rot) return { x: p.x, y: p.y };
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  }

  function previewHatch(pts, color, fillStyle, step) {
    if (!pts.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    if (fillStyle === 'h' || fillStyle === 'cross') {
      for (let y = minY; y <= maxY; y += step) {
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();
      }
    }
    if (fillStyle === 'd' || fillStyle === 'cross') {
      const span = Math.max(maxX - minX, maxY - minY) * 2;
      for (let d = -span; d <= span; d += step) {
        ctx.beginPath();
        ctx.moveTo(minX + d, minY);
        ctx.lineTo(minX + d + span, maxY);
        ctx.stroke();
      }
    }
    if (fillStyle === 'dots') {
      for (let y = minY; y <= maxY; y += step) {
        for (let x = minX; x <= maxX; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  function drawPreviewMark(m) {
    if (!m || !m.geom) return;
    const g = m.geom;
    const pivot = markLocalCenter(m);
    const rot = m.rot || 0;
    const color = m.color || '#1a1a1a';
    const weight = Math.max((m.weight || 1) * scale, 0.75);

    const mapPt = (fx, fy) => {
      const r = rotatePt({ x: fx, y: fy }, pivot, rot);
      return toPreview(r.x, r.y);
    };

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = weight;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    if (m.type === 'dot') {
      const c = mapPt(g.cx, g.cy);
      const edge = mapPt(g.cx + g.r, g.cy);
      const r = Math.hypot(edge.x - c.x, edge.y - c.y);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (m.type === 'line') {
      if (m.stroke === false) return;
      const a = mapPt(g.x1, g.y1);
      const b = mapPt(g.x2, g.y2);
      if (m.lineStyle === 'dashed') ctx.setLineDash([Math.max(weight * 3, 4), Math.max(weight * 2, 3)]);
      else if (m.lineStyle === 'dotted') ctx.setLineDash([Math.max(weight * 0.2, 1), Math.max(weight * 2, 3)]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    if (m.type === 'semicircle') {
      if (m.stroke === false) return;
      const a = semiArcAngles(g.orient);
      if (m.lineStyle === 'dashed') ctx.setLineDash([Math.max(weight * 3, 4), Math.max(weight * 2, 3)]);
      else if (m.lineStyle === 'dotted') ctx.setLineDash([Math.max(weight * 0.2, 1), Math.max(weight * 2, 3)]);
      ctx.beginPath();
      const steps = 32;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        let ang;
        if (a.ccw) {
          let delta = a.end - a.start;
          if (delta > 0) delta -= Math.PI * 2;
          ang = a.start + delta * t;
        } else {
          let delta = a.end - a.start;
          if (delta < 0) delta += Math.PI * 2;
          ang = a.start + delta * t;
        }
        const p = mapPt(g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang));
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    if (m.type === 'circle') {
      const samples = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        samples.push(mapPt(g.cx + g.r * Math.cos(t), g.cy + g.r * Math.sin(t)));
      }
      if (m.fill === 'solid') {
        ctx.beginPath();
        ctx.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].x, samples[i].y);
        ctx.closePath();
        ctx.fill();
      } else if (m.fill && m.fill !== 'none') {
        previewHatch(samples, color, m.fill, Math.max(MARK_HATCH_LINE_STEP * scale, 3));
      }
      if (m.stroke !== false) {
        ctx.beginPath();
        ctx.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].x, samples[i].y);
        ctx.closePath();
        ctx.stroke();
      }
      return;
    }

    if (!Array.isArray(g.pts) || !g.pts.length) return;
    const pts = g.pts.map((p) => mapPt(p.x, p.y));
    if (m.fill === 'solid') {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    } else if (m.fill && m.fill !== 'none') {
      previewHatch(pts, color, m.fill, Math.max(MARK_HATCH_LINE_STEP * scale, 3));
    }
    if (m.stroke !== false) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
    }
  }

  marks.forEach(drawPreviewMark);
};

function updateFitStatus(geo) {
  const statusEl = document.getElementById('scaleFitStatus');
  if (!statusEl) return;

  if (scoreMode !== 'print') {
    statusEl.textContent = '';
    return;
  }

  let minRx = Infinity, maxRx = -Infinity, minRy = Infinity, maxRy = -Infinity;
  const allFeatures = [...scoreLayers.streets, ...scoreLayers.buildings, ...scoreLayers.contours];
  allFeatures.forEach((f) => {
    if (!f.geometry) return;
    const coordsList = [];
    (function walk(coords) {
      if (typeof coords[0] === 'number') { coordsList.push(coords); return; }
      coords.forEach(walk);
    })(f.geometry.coordinates);
    coordsList.forEach(([lng, lat]) => {
      const { rx, ry } = toRotatedFeet(lng, lat);
      if (rx < minRx) minRx = rx;
      if (rx > maxRx) maxRx = rx;
      if (ry < minRy) minRy = ry;
      if (ry > maxRy) maxRy = ry;
    });
  });

  const siteWidthFt = maxRx - minRx;
  const siteHeightFt = maxRy - minRy;
  const pageWidthFt = geo.pageW / geo.pxPerFt;
  const pageHeightFt = geo.pageH / geo.pxPerFt;

  if (siteWidthFt <= pageWidthFt && siteHeightFt <= pageHeightFt) {
    statusEl.textContent = 'Full site fits on the page at 1:' + geo.scaleDenom + '.';
  } else {
    statusEl.textContent = 'Showing a ' + Math.round(pageWidthFt) + ' by ' +
      Math.round(pageHeightFt) + ' ft crop of a ' + Math.round(siteWidthFt) +
      ' by ' + Math.round(siteHeightFt) + ' ft site at 1:' + geo.scaleDenom +
      '. Pan in View mode to choose a different area, then switch back to Print.';
  }
}

function draw() {
  clear();
  background(255);
  if (!scoreReady) return;

  const geo = scoreMode === 'print' ? getPrintGeometry() : getViewGeometry();

  if (scoreMode === 'print') {
    drawPageFrame(geo);
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(geo.pageX, geo.pageY, geo.pageW, geo.pageH);
    drawingContext.clip();
  }

  drawContours(geo);
  drawVegetation(geo);
  drawStreets(geo);
  drawBuildings(geo);
  drawNotations(geo);

  if (scoreMode === 'print') {
    drawingContext.restore();
  }

  updateFitStatus(geo);
}

// --- pan and zoom interaction ---

const CLICK_MOVE_THRESH_PX = 5;
const NOTATION_HIT_MIN_PX = 14;
const NOTATION_HIT_MAX_PX = 72;

let pointerDidPan = false;

function isPointerInCanvas(x, y) {
  return x >= 0 && x <= width && y >= 0 && y <= height;
}

function notationHitRadiusPx(notation, geo) {
  if (notation.lexiconLinkStatus === 'missing' ||
      !(notation.sketch && Array.isArray(notation.sketch.marks) && notation.sketch.marks.length)) {
    return Math.max(NOTATION_HIT_MIN_PX, FALLBACK_DOT_RADIUS_FT * geo.pxPerFt * 2.5);
  }
  const ftPerPx = markFtPerFieldPx(notation.sketch);
  // Field center is the projected anchor; use a fraction of field half-width in screen px.
  const halfFieldPx = (MARK_FIELD_W / 2) * ftPerPx * geo.pxPerFt * 0.45;
  return Math.max(NOTATION_HIT_MIN_PX, Math.min(NOTATION_HIT_MAX_PX, halfFieldPx));
}

/** Hit-test filtered (visible) notations only. Prefers the closest mark within radius. */
function hitTestNotationAt(mx, my) {
  if (!scoreReady) return null;
  const geo = scoreMode === 'print' ? getPrintGeometry() : getViewGeometry();
  const list = getNotationsToDraw();
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const notation = list[i];
    if (notation.lat == null || notation.lng == null) continue;
    const p = project(notation.lng, notation.lat, geo);
    const r = notationHitRadiusPx(notation, geo);
    const d = Math.hypot(mx - p.x, my - p.y);
    if (d <= r && d < bestDist) {
      bestDist = d;
      best = notation;
    }
  }
  return best;
}

function mousePressed() {
  if (!isPointerInCanvas(mouseX, mouseY)) return;
  isDragging = true;
  pointerDidPan = false;
  dragStartMouseX = mouseX;
  dragStartMouseY = mouseY;
  dragStartPanRX = panRX;
  dragStartPanRY = panRY;
}

function mouseDragged() {
  if (!isDragging || !scoreReady) return;
  const geo = scoreMode === 'print' ? getPrintGeometry() : getViewGeometry();
  const dxPx = mouseX - dragStartMouseX;
  const dyPx = mouseY - dragStartMouseY;
  if (Math.hypot(dxPx, dyPx) > CLICK_MOVE_THRESH_PX) pointerDidPan = true;
  panRX = dragStartPanRX - dxPx / geo.pxPerFt;
  panRY = dragStartPanRY + dyPx / geo.pxPerFt;
  redraw();
}

function mouseReleased() {
  if (!isDragging) return;
  isDragging = false;
  if (pointerDidPan || !scoreReady) return;
  if (!isPointerInCanvas(mouseX, mouseY)) return;

  const hit = hitTestNotationAt(mouseX, mouseY);
  if (hit && typeof selectNotation === 'function') {
    selectNotation(hit.id);
  }
}

function mouseWheel(event) {
  if (!isPointerInCanvas(mouseX, mouseY)) return true;
  if (scoreMode !== 'view') return false;
  const factor = event.delta > 0 ? 0.9 : 1.1;
  viewZoom = Math.min(40, Math.max(0.1, viewZoom * factor));
  redraw();
  return false;
}
