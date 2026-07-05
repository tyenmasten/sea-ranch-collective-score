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
  fill('#ff0000');
  textSize(HATCH_PITCH * 0.9);

  const offset = HATCH_PITCH / 2;
  const stepPx = HATCH_PITCH * 0.5;
  const drawnPoints = new Set();

  const roadFills = (window.categoryFills && window.categoryFills.streets) || {};

  scoreLayers.streets.forEach((f) => {
    if (!f.geometry) return;
    const category = (f.properties && f.properties.Class) || 'Local';
    const ch = roadFills[category] || DEFAULT_CHAR;
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
  stroke('#dddddd');
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
    const ch = fills[category] || DEFAULT_CHAR;

    polys.forEach((poly) => {
      const outerRing = ringToScreen(poly[0], geo);

      noFill();
      if (window.state && state.mapView && state.mapView.showOutlines) {
        stroke('#999999');
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
      if (maxX - minX < HATCH_PITCH && maxY - minY < HATCH_PITCH) return;

      noStroke();
      fill('#1a1a1a');
      textSize(HATCH_PITCH * 0.9);
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

  if (scoreMode === 'print') {
    drawingContext.restore();
  }

  updateFitStatus(geo);
}

// --- pan and zoom interaction ---

function isPointerInCanvas(x, y) {
  return x >= 0 && x <= width && y >= 0 && y <= height;
}

function mousePressed() {
  if (!isPointerInCanvas(mouseX, mouseY)) return;
  isDragging = true;
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
  panRX = dragStartPanRX - dxPx / geo.pxPerFt;
  panRY = dragStartPanRY + dyPx / geo.pxPerFt;
  redraw();
}

function mouseReleased() {
  isDragging = false;
}

function mouseWheel(event) {
  if (!isPointerInCanvas(mouseX, mouseY)) return true;
  if (scoreMode !== 'view') return false;
  const factor = event.delta > 0 ? 0.9 : 1.1;
  viewZoom = Math.min(40, Math.max(0.1, viewZoom * factor));
  redraw();
  return false;
}
