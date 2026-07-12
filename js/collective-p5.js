// Collective Score base layer rendering in p5.js
// Reuses prepareSiteGeoJSON, featuresNeedStatePlaneTransform, fitStatePlaneToWgs84,
// and transformStatePlaneWithFit, all defined globally in collective-score.html's
// inline script, which loads before this file. Also reads window.categoryFills
// and window.BASE_MARK_LIBRARY (markId + color per category; default vector marks).
//
// Modes (scoreMode):
// - View: freely pannable/zoomable working view (notations + site layers).
// - Grid: atlas scales only — whole site fixed to fit, atlas sheet overlay;
//   click a sheet cell to select it and switch to Sheet.
// - Sheet: atlas scales only — one selected A3 sheet, fixed, export-accurate,
//   with overlap guides on edges that adjoin neighbors.
// - Print: free-pan single A3 Preview (primary path below 1:1000; unchanged).
//
// The whole composition is rotated 42 degrees, applied in real-world feet
// before anything is scaled to the screen or the page, so it stays correct
// at any zoom level or print scale.
//
// Buildings, vegetation, and streets are rendered as a field of repeated
// vector marks (same geometry pipeline as lexicon notation marks), sampled
// in rotated-feet space. View/Grid may also show building/vegetation outlines
// and contours as reference; Sheet, Print Preview, and SVG export are marks
// only (contours still draw when that layer is on).

let scoreLayers = { streets: [], buildings: [], contours: [], vegetation: [] };
let scoreCentroid = null;
let scoreReady = false;

const HATCH_PITCH = 7;
const DEFAULT_MARK_ID = 'dot';

function normalizeFillEntry(entry) {
  const legacyChar = {
    '=': 'double-tick', '+': 'cross', '-': 'tick', '.': 'dot',
    ':': 'diagonal-tick', ';': 'chevron', '*': 'circle',
    's': 'tick', 'c': 'cross', 'i': 'double-tick', 'p': 'circle',
    'o': 'dot', 'a': 'chevron', 'x': 'diagonal-tick',
    'n': 'triangle', 'w': 'chevron', 'f': 'tick', 'u': 'diagonal-tick',
    'h': 'circle', 'y': 'cross', 'b': 'double-tick', 'd': 'tick',
    'r': 'diagonal-tick', 't': 'circle',
  };
  const known = (id) =>
    !!(window.BASE_MARK_LIBRARY && window.BASE_MARK_LIBRARY.some((m) => m.id === id));
  if (!entry) return { markId: DEFAULT_MARK_ID, color: '#1a1a1a' };
  if (typeof entry === 'string') {
    if (known(entry)) return { markId: entry, color: '#1a1a1a' };
    return { markId: legacyChar[entry] || DEFAULT_MARK_ID, color: '#1a1a1a' };
  }
  let markId = DEFAULT_MARK_ID;
  if (entry.markId && known(entry.markId)) markId = entry.markId;
  else if (entry.char) markId = legacyChar[entry.char] || DEFAULT_MARK_ID;
  return {
    markId: markId,
    color: entry.color || '#1a1a1a',
  };
}

function getBaseMarkDef(markId) {
  const lib = window.BASE_MARK_LIBRARY || [];
  return lib.find((m) => m.id === markId) || lib[0] || null;
}

/** True for Sheet / Print Preview — print surfaces (marks-only boundaries). */
function isPrintSurfaceMode() {
  return scoreMode === 'sheet' || scoreMode === 'print';
}

const ROTATION_DEG = 42;
const FT_PER_DEG_LAT = 364000;

// A3 portrait (mm 297 × 420) in inches.
const PAGE_WIDTH_IN = 11.69;
const PAGE_HEIGHT_IN = 16.54;
const PAGE_OVERLAP_IN = 0.5;
const PAGE_MARGIN_PX = 40;
/** Atlas tiling only at 1:1000 and coarser; finer scales use free-pan single crop. */
const ATLAS_MIN_SCALE_DENOM = 1000;

let scoreMode = 'view';
let panRX = 0;
let panRY = 0;
let viewZoom = 1;
let baseFitPxPerFt = 1;

let selectedSheetId = null;
let selectedSheetCol = 0;
let selectedSheetRow = 0;

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

function setScoreMode(mode) {
  const atlas = isAtlasScale();
  if ((mode === 'grid' || mode === 'sheet') && !atlas) mode = 'view';
  if (mode !== 'view' && mode !== 'print' && mode !== 'grid' && mode !== 'sheet') {
    mode = 'view';
  }
  scoreMode = mode;
  syncModeButtons();
  redraw();
}

function syncModeButtons() {
  const atlas = isAtlasScale();
  const gridBtn = document.getElementById('btnGridMode');
  const sheetBtn = document.getElementById('btnSheetMode');
  if (gridBtn) {
    gridBtn.style.display = atlas ? '' : 'none';
    gridBtn.disabled = !atlas;
  }
  if (sheetBtn) {
    sheetBtn.style.display = atlas ? '' : 'none';
    sheetBtn.disabled = !atlas;
  }
  if (!atlas && (scoreMode === 'grid' || scoreMode === 'sheet')) {
    scoreMode = 'view';
  }
  const modes = [
    ['view', document.getElementById('btnViewMode')],
    ['grid', gridBtn],
    ['sheet', sheetBtn],
    ['print', document.getElementById('btnPrintMode')],
  ];
  modes.forEach(([mode, btn]) => {
    if (!btn) return;
    const active = scoreMode === mode;
    btn.classList.toggle('primary', active);
    btn.classList.toggle('ghost', !active);
  });
}

function bindModeControls() {
  const viewBtn = document.getElementById('btnViewMode');
  const gridBtn = document.getElementById('btnGridMode');
  const sheetBtn = document.getElementById('btnSheetMode');
  const printBtn = document.getElementById('btnPrintMode');
  if (viewBtn) viewBtn.addEventListener('click', () => setScoreMode('view'));
  if (gridBtn) gridBtn.addEventListener('click', () => setScoreMode('grid'));
  if (sheetBtn) {
    sheetBtn.addEventListener('click', () => {
      refreshAtlasSelection();
      setScoreMode('sheet');
    });
  }
  if (printBtn) printBtn.addEventListener('click', () => setScoreMode('print'));
  const scaleEl = document.getElementById('exportScale');
  if (scaleEl) {
    scaleEl.addEventListener('change', () => {
      refreshAtlasSelection();
      syncModeButtons();
      redraw();
    });
  }
  syncModeButtons();
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

function fromRotatedFeet(rx, ry) {
  const rad = -ROTATION_DEG * Math.PI / 180;
  const dx = rx * Math.cos(rad) + ry * Math.sin(rad);
  const dy = -rx * Math.sin(rad) + ry * Math.cos(rad);
  const midLatRad = scoreCentroid.lat * Math.PI / 180;
  const ftPerDegLng = FT_PER_DEG_LAT * Math.cos(midLatRad);
  return {
    lng: scoreCentroid.lng + dx / ftPerDegLng,
    lat: scoreCentroid.lat + dy / FT_PER_DEG_LAT,
  };
}

function currentScaleDenominator() {
  const el = document.getElementById('exportScale');
  if (!el) return 500;
  const val = el.value || '1:500';
  const parts = val.split(':');
  return Number(parts[1]) || 500;
}

/** True when the current (or given) scale uses the multi-sheet atlas. */
function isAtlasScale(scaleDenom) {
  const denom = scaleDenom != null ? scaleDenom : currentScaleDenominator();
  return denom >= ATLAS_MIN_SCALE_DENOM;
}

function getViewGeometry() {
  const pxPerFt = baseFitPxPerFt * viewZoom;
  return {
    mode: 'view',
    pxPerFt,
    centerX: width / 2,
    centerY: height / 2,
    originRx: panRX,
    originRy: panRY,
  };
}

/** Free-pan single A3 page (Print Preview). Never atlas-locked. */
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
    mode: 'print',
    scaleDenom,
    pxPerFt,
    pxPerInch,
    pageW,
    pageH,
    pageX,
    pageY,
    centerX: pageX + pageW / 2,
    centerY: pageY + pageH / 2,
    originRx: panRX,
    originRy: panRY,
    atlasMode: false,
  };
}

/** One selected atlas sheet at true print scale (Sheet mode). */
function getSheetGeometry() {
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
  const sheet = getSelectedSheet();
  return {
    mode: 'sheet',
    scaleDenom,
    pxPerFt,
    pxPerInch,
    pageW,
    pageH,
    pageX,
    pageY,
    centerX: pageX + pageW / 2,
    centerY: pageY + pageH / 2,
    originRx: sheet ? sheet.centerRx : panRX,
    originRy: sheet ? sheet.centerRy : panRY,
    atlasMode: true,
  };
}

/** Whole atlas extent fitted to the canvas (Grid mode). Fixed; no pan. */
function getGridGeometry() {
  const scaleDenom = currentScaleDenominator();
  const atlas = getCurrentAtlas();
  const site = (atlas && atlas.site) ? atlas.site : computeSiteBoundsFt();
  let minX = site.minRx;
  let maxX = site.maxRx;
  let minY = site.minRy;
  let maxY = site.maxRy;
  if (atlas && atlas.sheets.length) {
    atlas.sheets.forEach((s) => {
      const b = s.boundsFt;
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
    });
  }
  const widthFt = Math.max(maxX - minX, 1);
  const heightFt = Math.max(maxY - minY, 1);
  const pad = PAGE_MARGIN_PX;
  const availW = Math.max(width - pad * 2, 1);
  const availH = Math.max(height - pad * 2, 1);
  const pxPerFt = Math.min(availW / widthFt, availH / heightFt);
  return {
    mode: 'grid',
    scaleDenom,
    pxPerFt,
    centerX: width / 2,
    centerY: height / 2,
    originRx: (minX + maxX) / 2,
    originRy: (minY + maxY) / 2,
  };
}

function getActiveGeometry() {
  if (scoreMode === 'print') return getPrintGeometry();
  if (scoreMode === 'sheet') return getSheetGeometry();
  if (scoreMode === 'grid') return getGridGeometry();
  return getViewGeometry();
}

function project(lng, lat, geo) {
  const { rx, ry } = toRotatedFeet(lng, lat);
  return rotatedFeetToScreen(rx, ry, geo);
}

function rotatedFeetToScreen(rx, ry, geo) {
  const ox = geo.originRx != null ? geo.originRx : panRX;
  const oy = geo.originRy != null ? geo.originRy : panRY;
  return {
    x: geo.centerX + (rx - ox) * geo.pxPerFt,
    y: geo.centerY - (ry - oy) * geo.pxPerFt,
  };
}

function sheetLabel(col, row) {
  let n = col;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label + String(row + 1);
}

/** Site AABB in rotated-feet space (same frame as toRotatedFeet).
 *  Streets + buildings only — optional overlays must not resize the atlas. */
function computeSiteBoundsFt() {
  let minRx = Infinity, maxRx = -Infinity, minRy = Infinity, maxRy = -Infinity;
  const allFeatures = [
    ...scoreLayers.streets,
    ...scoreLayers.buildings,
  ];
  allFeatures.forEach((f) => {
    if (!f.geometry) return;
    (function walk(coords) {
      if (typeof coords[0] === 'number') {
        const { rx, ry } = toRotatedFeet(coords[0], coords[1]);
        if (rx < minRx) minRx = rx;
        if (rx > maxRx) maxRx = rx;
        if (ry < minRy) minRy = ry;
        if (ry > maxRy) maxRy = ry;
        return;
      }
      coords.forEach(walk);
    })(f.geometry.coordinates);
  });
  if (!isFinite(minRx)) {
    return { minRx: -1, maxRx: 1, minRy: -1, maxRy: 1, widthFt: 2, heightFt: 2 };
  }
  return {
    minRx,
    maxRx,
    minRy,
    maxRy,
    widthFt: Math.max(maxRx - minRx, 1),
    heightFt: Math.max(maxRy - minRy, 1),
  };
}

function computePrintAtlas(scaleDenom) {
  const denom = scaleDenom || currentScaleDenominator();
  const site = computeSiteBoundsFt();
  const pageWFt = PAGE_WIDTH_IN * (denom / 12);
  const pageHFt = PAGE_HEIGHT_IN * (denom / 12);
  const stepWFt = (PAGE_WIDTH_IN - PAGE_OVERLAP_IN) * (denom / 12);
  const stepHFt = (PAGE_HEIGHT_IN - PAGE_OVERLAP_IN) * (denom / 12);

  let cols = 1;
  let rows = 1;
  const fitsOne =
    site.widthFt <= pageWFt && site.heightFt <= pageHFt;

  if (!fitsOne) {
    cols = Math.max(1, Math.ceil(site.widthFt / stepWFt));
    rows = Math.max(1, Math.ceil(site.heightFt / stepHFt));
  }

  const sheets = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let minX;
      let maxY;
      let maxX;
      let minY;
      if (fitsOne) {
        const cx = (site.minRx + site.maxRx) / 2;
        const cy = (site.minRy + site.maxRy) / 2;
        minX = cx - pageWFt / 2;
        maxX = cx + pageWFt / 2;
        minY = cy - pageHFt / 2;
        maxY = cy + pageHFt / 2;
      } else {
        // A1 at northwest: cols increase east, rows increase south.
        minX = site.minRx + col * stepWFt;
        maxY = site.maxRy - row * stepHFt;
        maxX = minX + pageWFt;
        minY = maxY - pageHFt;
      }
      const centerRx = (minX + maxX) / 2;
      const centerRy = (minY + maxY) / 2;
      const label = sheetLabel(col, row);
      sheets.push({
        id: label,
        col,
        row,
        label,
        centerRx,
        centerRy,
        boundsFt: { minX, maxX, minY, maxY },
      });
    }
  }

  return {
    scaleDenom: denom,
    cols,
    rows,
    pageWFt,
    pageHFt,
    stepWFt,
    stepHFt,
    fitsOne,
    site,
    sheets,
  };
}

function getCurrentAtlas() {
  if (!isAtlasScale()) return null;
  return computePrintAtlas(currentScaleDenominator());
}

function getSelectedSheet() {
  const atlas = getCurrentAtlas();
  if (!atlas || !atlas.sheets.length) return null;
  let sheet = atlas.sheets.find((s) => s.id === selectedSheetId);
  if (sheet) return sheet;
  sheet = atlas.sheets.find((s) => s.col === selectedSheetCol && s.row === selectedSheetRow);
  if (sheet) return sheet;
  return atlas.sheets[0];
}

/** Keep selection when scale/grid changes; clamp to nearest col/row if needed. */
function refreshAtlasSelection() {
  if (!isAtlasScale()) return null;
  const atlas = getCurrentAtlas();
  if (!atlas || !atlas.sheets.length) {
    selectedSheetId = null;
    selectedSheetCol = 0;
    selectedSheetRow = 0;
    return atlas;
  }

  const exact = atlas.sheets.find((s) => s.id === selectedSheetId)
    || atlas.sheets.find((s) => s.col === selectedSheetCol && s.row === selectedSheetRow);
  if (exact) {
    selectedSheetId = exact.id;
    selectedSheetCol = exact.col;
    selectedSheetRow = exact.row;
    return atlas;
  }

  let best = atlas.sheets[0];
  let bestDist = Infinity;
  atlas.sheets.forEach((s) => {
    const d = Math.hypot(s.col - selectedSheetCol, s.row - selectedSheetRow);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  });
  selectedSheetId = best.id;
  selectedSheetCol = best.col;
  selectedSheetRow = best.row;
  return atlas;
}

function selectAtlasSheet(sheet, switchToSheet) {
  if (!sheet) return;
  selectedSheetId = sheet.id;
  selectedSheetCol = sheet.col;
  selectedSheetRow = sheet.row;
  if (switchToSheet) {
    setScoreMode('sheet');
    return;
  }
  redraw();
}

function drawAtlasOverlay(geo) {
  if (!isAtlasScale()) return;
  const atlas = getCurrentAtlas();
  if (!atlas || !atlas.sheets.length) return;
  const selected = getSelectedSheet();
  // Grid mode is fitted to the whole atlas — size labels for legibility.
  const labelSize = scoreMode === 'grid' ? 16 : 11;
  const selectedSize = scoreMode === 'grid' ? 18 : 13;

  atlas.sheets.forEach((sheet) => {
    const b = sheet.boundsFt;
    const sw = rotatedFeetToScreen(b.minX, b.minY, geo);
    const se = rotatedFeetToScreen(b.maxX, b.minY, geo);
    const ne = rotatedFeetToScreen(b.maxX, b.maxY, geo);
    const nw = rotatedFeetToScreen(b.minX, b.maxY, geo);
    const isSelected = selected && sheet.id === selected.id;

    noFill();
    stroke(isSelected ? '#1a1a1a' : '#888888');
    strokeWeight(isSelected ? 1.5 : 0.75);
    beginShape();
    vertex(nw.x, nw.y);
    vertex(ne.x, ne.y);
    vertex(se.x, se.y);
    vertex(sw.x, sw.y);
    endShape(CLOSE);

    const cx = (nw.x + se.x) / 2;
    const cy = (nw.y + se.y) / 2;
    noStroke();
    fill(isSelected ? '#1a1a1a' : '#666666');
    textAlign(CENTER, CENTER);
    textSize(isSelected ? selectedSize : labelSize);
    textFont('Miniature, serif');
    text(sheet.label, cx, cy);
  });

  textFont('monospace');
  textAlign(CENTER, CENTER);
}

/** 0.5" overlap strips on sheet edges that adjoin a neighbor (Sheet mode). */
function drawPrintOverlapGuides(geo) {
  if (!geo || !geo.atlasMode) return;
  const atlas = getCurrentAtlas();
  const sheet = getSelectedSheet();
  if (!atlas || !sheet) return;

  const overlapPx = PAGE_OVERLAP_IN * (geo.pxPerInch || (geo.pageW / PAGE_WIDTH_IN));
  if (!(overlapPx > 0)) return;

  const hasWest = sheet.col > 0;
  const hasEast = sheet.col < atlas.cols - 1;
  const hasNorth = sheet.row > 0;
  const hasSouth = sheet.row < atlas.rows - 1;
  if (!hasWest && !hasEast && !hasNorth && !hasSouth) return;

  push();
  noStroke();
  fill(26, 26, 26, 28);

  if (hasWest) {
    rect(geo.pageX, geo.pageY, overlapPx, geo.pageH);
  }
  if (hasEast) {
    rect(geo.pageX + geo.pageW - overlapPx, geo.pageY, overlapPx, geo.pageH);
  }
  if (hasNorth) {
    rect(geo.pageX, geo.pageY, geo.pageW, overlapPx);
  }
  if (hasSouth) {
    rect(geo.pageX, geo.pageY + geo.pageH - overlapPx, geo.pageW, overlapPx);
  }

  stroke(26, 26, 26, 90);
  strokeWeight(0.75);
  drawingContext.setLineDash([4, 3]);
  if (hasWest) {
    line(geo.pageX + overlapPx, geo.pageY, geo.pageX + overlapPx, geo.pageY + geo.pageH);
  }
  if (hasEast) {
    line(geo.pageX + geo.pageW - overlapPx, geo.pageY, geo.pageX + geo.pageW - overlapPx, geo.pageY + geo.pageH);
  }
  if (hasNorth) {
    line(geo.pageX, geo.pageY + overlapPx, geo.pageX + geo.pageW, geo.pageY + overlapPx);
  }
  if (hasSouth) {
    line(geo.pageX, geo.pageY + geo.pageH - overlapPx, geo.pageX + geo.pageW, geo.pageY + geo.pageH - overlapPx);
  }
  drawingContext.setLineDash([]);
  pop();
}

function hitTestSheetAt(mx, my) {
  if (!scoreReady || scoreMode !== 'grid' || !isAtlasScale()) return null;
  const atlas = getCurrentAtlas();
  if (!atlas) return null;
  const geo = getGridGeometry();
  // Prefer later sheets only if overlapping; walk reverse so SE sheets win ties.
  for (let i = atlas.sheets.length - 1; i >= 0; i--) {
    const sheet = atlas.sheets[i];
    const b = sheet.boundsFt;
    const sw = rotatedFeetToScreen(b.minX, b.minY, geo);
    const ne = rotatedFeetToScreen(b.maxX, b.maxY, geo);
    const minX = Math.min(sw.x, ne.x);
    const maxX = Math.max(sw.x, ne.x);
    const minY = Math.min(sw.y, ne.y);
    const maxY = Math.max(sw.y, ne.y);
    if (mx >= minX && mx <= maxX && my >= minY && my <= maxY) {
      return sheet;
    }
  }
  return null;
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


function nearestOffsetGridPoint(x, y, pitch, offset) {
  const gx = Math.round((x - offset) / pitch) * pitch + offset;
  const gy = Math.round((y - offset) / pitch) * pitch + offset;
  return { gx, gy };
}

/** Pitch in feet so page density ≈ former HATCH_PITCH screen spacing. */
function texturePitchFt(geo) {
  return HATCH_PITCH / Math.max(geo.pxPerFt, 1e-9);
}

/** Field px → feet scale so marks read ~same size as old character stamps. */
function baseLayerFtPerFieldPx(geo) {
  const desiredFt = (HATCH_PITCH * 0.85) / Math.max(geo.pxPerFt, 1e-9);
  return desiredFt / 30;
}

function stampInClip(geo, lng, lat) {
  if (geo.clipMinX == null) return true;
  const p = project(lng, lat, geo);
  const pad = HATCH_PITCH * 2;
  return p.x >= geo.clipMinX - pad && p.x <= geo.clipMaxX + pad &&
    p.y >= geo.clipMinY - pad && p.y <= geo.clipMaxY + pad;
}

function ringToRotatedFeet(ring) {
  return ring.map(([lng, lat]) => {
    const { rx, ry } = toRotatedFeet(lng, lat);
    return { x: rx, y: ry };
  });
}

/**
 * Shared base-layer stamp positions in rotated-feet space.
 * callback(markDef, color, lng, lat) — same path for screen draw and SVG export.
 */
function forEachStreetMarkStamp(geo, features, callback) {
  if (!state.layers.streets) return;
  const pitch = texturePitchFt(geo);
  const offset = pitch / 2;
  const stepFt = pitch * 0.5;
  const drawnPoints = new Set();
  const roadFills = (window.categoryFills && window.categoryFills.streets) || {};
  const list = features || scoreLayers.streets;

  list.forEach((f) => {
    if (!f.geometry) return;
    const category = (f.properties && f.properties.Class) || 'Local';
    const { markId, color } = normalizeFillEntry(roadFills[category]);
    const markDef = getBaseMarkDef(markId);
    if (!markDef) return;
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringToRotatedFeet(line);
      for (let i = 0; i < pts.length - 1; i++) {
        const x1 = pts[i].x, y1 = pts[i].y, x2 = pts[i + 1].x, y2 = pts[i + 1].y;
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(segLen / stepFt));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = x1 + (x2 - x1) * t;
          const y = y1 + (y2 - y1) * t;
          const { gx, gy } = nearestOffsetGridPoint(x, y, pitch, offset);
          const key = gx.toFixed(3) + ',' + gy.toFixed(3);
          if (drawnPoints.has(key)) continue;
          drawnPoints.add(key);
          const { lng, lat } = fromRotatedFeet(gx, gy);
          if (!stampInClip(geo, lng, lat)) continue;
          callback(markDef, color, lng, lat);
        }
      }
    });
  });
}

function forEachCategorizedMarkStamp(geo, features, categoryField, fillGroupKey, callback, outlineCallback) {
  const fills = (window.categoryFills && window.categoryFills[fillGroupKey]) || {};
  const pitch = texturePitchFt(geo);
  const list = features || [];

  list.forEach((f) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];

    const category = (f.properties && f.properties[categoryField]) || 'Other';
    const { markId, color } = normalizeFillEntry(fills[category]);
    const markDef = getBaseMarkDef(markId);
    if (!markDef) return;

    polys.forEach((poly) => {
      const outerFt = ringToRotatedFeet(poly[0]);
      if (outlineCallback) outlineCallback(ringToScreen(poly[0], geo));

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      outerFt.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });

      if (maxX - minX < pitch && maxY - minY < pitch) {
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const { lng, lat } = fromRotatedFeet(cx, cy);
        if (stampInClip(geo, lng, lat)) callback(markDef, color, lng, lat);
        return;
      }

      const gridStartX = Math.floor(minX / pitch) * pitch;
      const gridStartY = Math.floor(minY / pitch) * pitch;
      for (let gy = gridStartY; gy <= maxY; gy += pitch) {
        for (let gx = gridStartX; gx <= maxX; gx += pitch) {
          if (!pointInPolygon(gx, gy, outerFt)) continue;
          const { lng, lat } = fromRotatedFeet(gx, gy);
          if (!stampInClip(geo, lng, lat)) continue;
          callback(markDef, color, lng, lat);
        }
      }
    });
  });
}

/**
 * Iterate every base-layer stamp (streets + buildings + vegetation).
 * Shared by drawBaseLayerMarks and appendBaseLayerMarksSvg — one placement path.
 */
function forEachBaseLayerStamp(geo, callback, options) {
  const opts = options || {};
  const streets = opts.streets != null ? opts.streets : scoreLayers.streets;
  const buildings = opts.buildings != null ? opts.buildings : scoreLayers.buildings;
  const vegetation = opts.vegetation != null ? opts.vegetation : scoreLayers.vegetation;
  const drawOutlines = !!opts.drawOutlines;

  function outlineDrawer(outerRing) {
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
  }

  // Match prior paint order: vegetation, streets, buildings.
  if (state.layers.vegetation) {
    forEachCategorizedMarkStamp(
      geo, vegetation, 'LIFEFORM', 'vegetation', callback,
      drawOutlines ? outlineDrawer : null
    );
  }

  if (state.layers.streets) {
    forEachStreetMarkStamp(geo, streets, callback);
  }

  if (state.layers.buildings) {
    forEachCategorizedMarkStamp(
      geo, buildings, 'PropType', 'buildings', callback,
      drawOutlines ? outlineDrawer : null
    );
  }
}

function drawBaseLayerMarkAt(markDef, color, lng, lat, geo) {
  if (!markDef || !Array.isArray(markDef.marks)) return;
  const ftPerPx = baseLayerFtPerFieldPx(geo);
  markDef.marks.forEach((m) => {
    const colored = Object.assign({}, m, { color: color || m.color || '#1a1a1a' });
    drawSketchMark(colored, lng, lat, ftPerPx, geo);
  });
}

function drawBaseLayerMarks(geo) {
  const drawOutlines = !isPrintSurfaceMode();
  forEachBaseLayerStamp(geo, (markDef, color, lng, lat) => {
    drawBaseLayerMarkAt(markDef, color, lng, lat, geo);
  }, { drawOutlines: drawOutlines });
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

  // Always resolve from the live dropdown — never trust geo.scaleDenom, which
  // can lag if a caller passes a stale geometry object.
  const denom = currentScaleDenominator();

  const freePanPrintStatus = () => {
    const site = computeSiteBoundsFt();
    const pageWidthFt = geo.pageW / geo.pxPerFt;
    const pageHeightFt = geo.pageH / geo.pxPerFt;
    if (site.widthFt <= pageWidthFt && site.heightFt <= pageHeightFt) {
      statusEl.textContent = 'Full site fits on the page at 1:' + denom + '.';
    } else {
      statusEl.textContent = 'Showing a ' + Math.round(pageWidthFt) + ' by ' +
        Math.round(pageHeightFt) + ' ft crop of a ' + Math.round(site.widthFt) +
        ' by ' + Math.round(site.heightFt) + ' ft site at 1:' + denom +
        '. Pan in View mode to choose a different area, then switch back to Print.';
    }
  };

  if (!isAtlasScale(denom)) {
    if (scoreMode !== 'print') {
      statusEl.textContent =
        'Scale 1:' + denom + ' — free pan. Pan in View mode to choose the Print Preview crop.';
      return;
    }
    freePanPrintStatus();
    return;
  }

  // Atlas scales: Grid / Sheet messaging; Print Preview stays free-pan.
  if (scoreMode === 'print') {
    freePanPrintStatus();
    return;
  }

  const atlas = getCurrentAtlas();
  const sheet = getSelectedSheet();
  if (!atlas || !sheet) {
    statusEl.textContent = '';
    return;
  }

  if (scoreMode === 'grid') {
    statusEl.textContent =
      'Atlas grid ' + atlas.cols + '×' + atlas.rows +
      ' at 1:' + denom + '. Click a sheet to open Sheet view.';
    return;
  }

  if (scoreMode === 'sheet') {
    statusEl.textContent =
      'Sheet ' + sheet.label + ' of ' + atlas.cols + '×' + atlas.rows +
      ' at 1:' + denom;
    return;
  }

  // View at atlas scales — point toward Grid for sheet picking.
  statusEl.textContent =
    'Scale 1:' + denom + ' — atlas available. Open Grid to pick a sheet (' +
    atlas.cols + '×' + atlas.rows + ').';
}

function draw() {
  clear();
  background(255);
  if (!scoreReady) return;

  if (isAtlasScale()) refreshAtlasSelection();
  const geo = getActiveGeometry();
  const pageModes = scoreMode === 'print' || scoreMode === 'sheet';

  if (pageModes) {
    drawPageFrame(geo);
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(geo.pageX, geo.pageY, geo.pageW, geo.pageH);
    drawingContext.clip();
  }

  drawContours(geo);
  drawBaseLayerMarks(geo);
  drawNotations(geo);

  if (pageModes) {
    if (scoreMode === 'sheet') {
      drawPrintOverlapGuides(geo);
      drawSheetCaption(geo);
    }
    drawingContext.restore();
  } else if (scoreMode === 'grid' && isAtlasScale()) {
    drawAtlasOverlay(geo);
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
  const geo = getActiveGeometry();
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
  // Grid and Sheet are fixed; only View and free-pan Print Preview can pan.
  if (scoreMode === 'grid' || scoreMode === 'sheet') return;
  const geo = getActiveGeometry();
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

  // Marker hits take priority over atlas sheet selection.
  const hit = hitTestNotationAt(mouseX, mouseY);
  if (hit && typeof selectNotation === 'function') {
    selectNotation(hit.id);
    return;
  }

  if (scoreMode === 'grid' && isAtlasScale()) {
    const sheet = hitTestSheetAt(mouseX, mouseY);
    if (sheet) selectAtlasSheet(sheet, true);
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

// ---------------------------------------------------------------------------
// SVG plotter export (selected atlas sheet → physical A3 page inches)
// ---------------------------------------------------------------------------

const EXPORT_STROKE_IN = 0.012;
const EXPORT_MARK_STROKE_SCALE = 1;

/**
 * Convert Sheet-mode screen pixels to page inches using the same page frame
 * getSheetGeometry() uses (origin = sheet centerRx/centerRy, scaleDenom/12).
 */
function screenToPageInches(geo, sx, sy) {
  return {
    x: (sx - geo.pageX) / geo.pxPerInch,
    y: (sy - geo.pageY) / geo.pxPerInch,
  };
}

function projectLngLatToPageInches(lng, lat, geo) {
  const s = project(lng, lat, geo);
  return screenToPageInches(geo, s.x, s.y);
}

/** Same pipeline as site features: ringToScreen(geo) → screenToPageInches. */
function ringLngLatToPageInches(ring, geo) {
  return ringToScreen(ring, geo).map((p) => screenToPageInches(geo, p.x, p.y));
}

function featureBoundsFt(feature) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let any = false;
  function walk(coords) {
    if (typeof coords[0] === 'number') {
      const { rx, ry } = toRotatedFeet(coords[0], coords[1]);
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
      any = true;
      return;
    }
    coords.forEach(walk);
  }
  if (feature && feature.geometry && feature.geometry.coordinates) {
    walk(feature.geometry.coordinates);
  }
  if (!any) return null;
  return { minX, maxX, minY, maxY };
}

function boundsIntersectFt(a, b, bufferFt) {
  if (!a || !b) return false;
  const buf = bufferFt || 0;
  return !(
    a.maxX < b.minX - buf ||
    a.minX > b.maxX + buf ||
    a.maxY < b.minY - buf ||
    a.minY > b.maxY + buf
  );
}

/** Keep features whose rotated-feet AABB intersects the sheet (plus buffer). */
function filterFeaturesToSheet(features, sheet, bufferFt) {
  if (!sheet || !sheet.boundsFt) return features || [];
  const sheetB = sheet.boundsFt;
  return (features || []).filter((f) => {
    const fb = featureBoundsFt(f);
    return boundsIntersectFt(fb, sheetB, bufferFt);
  });
}

function notationIntersectsSheet(notation, sheet, bufferFt) {
  if (!notation || notation.lat == null || notation.lng == null || !sheet || !sheet.boundsFt) {
    return false;
  }
  const { rx, ry } = toRotatedFeet(notation.lng, notation.lat);
  const b = sheet.boundsFt;
  const buf = bufferFt || 0;
  return rx >= b.minX - buf && rx <= b.maxX + buf &&
    ry >= b.minY - buf && ry <= b.maxY + buf;
}

function logExportCoordCheck(geo, sheet) {
  const screenCenter = rotatedFeetToScreen(sheet.centerRx, sheet.centerRy, geo);
  const pageCenter = screenToPageInches(geo, screenCenter.x, screenCenter.y);
  const expected = { x: PAGE_WIDTH_IN / 2, y: PAGE_HEIGHT_IN / 2 };
  let sample = null;
  if (scoreLayers.buildings.length && scoreLayers.buildings[0].geometry) {
    const f = scoreLayers.buildings[0];
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    const c0 = polys[0] && polys[0][0] && polys[0][0][0];
    if (c0) {
      const lng = c0[0];
      const lat = c0[1];
      const { rx, ry } = toRotatedFeet(lng, lat);
      const screenPt = project(lng, lat, geo);
      const pagePt = screenToPageInches(geo, screenPt.x, screenPt.y);
      sample = {
        lng, lat, rx, ry,
        originRx: sheet.centerRx,
        originRy: sheet.centerRy,
        deltaFt: { x: rx - sheet.centerRx, y: ry - sheet.centerRy },
        screenPx: screenPt,
        pageIn: pagePt,
        inchesPerFt: 12 / geo.scaleDenom,
      };
    }
  }
  console.log('[export svg] coord check', {
    sheet: sheet.label,
    scaleDenom: geo.scaleDenom,
    sheetOriginFt: { centerRx: sheet.centerRx, centerRy: sheet.centerRy },
    screenSheetCenterPx: screenCenter,
    pageSheetCenterIn: pageCenter,
    expectedPageCenterIn: expected,
    pageFrame: { pageX: geo.pageX, pageY: geo.pageY, pxPerInch: geo.pxPerInch, pxPerFt: geo.pxPerFt },
    buildingCornerSample: sample,
  });
}

function svgNum(n) {
  return (Math.round(n * 10000) / 10000).toString();
}

function svgPathFromPts(pts, close) {
  if (!pts || !pts.length) return '';
  let d = 'M ' + svgNum(pts[0].x) + ' ' + svgNum(pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    d += ' L ' + svgNum(pts[i].x) + ' ' + svgNum(pts[i].y);
  }
  if (close) d += ' Z';
  return d;
}

function svgEl(tag, attrs, body) {
  let s = '<' + tag;
  Object.keys(attrs).forEach((k) => {
    if (attrs[k] == null || attrs[k] === '') return;
    s += ' ' + k + '="' + attrs[k] + '"';
  });
  if (body == null) return s + '/>';
  return s + '>' + body + '</' + tag + '>';
}

function svgEscapeText(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fieldPointToPageInches(fx, fy, lng, lat, ftPerPx, geo) {
  const anchor = projectLngLatToPageInches(lng, lat, geo);
  const dxFt = (fx - MARK_FIELD_W / 2) * ftPerPx;
  const dyFt = (fy - MARK_FIELD_H / 2) * ftPerPx;
  const inchesPerFt = 12 / geo.scaleDenom;
  return {
    x: anchor.x + dxFt * inchesPerFt,
    y: anchor.y + dyFt * inchesPerFt,
  };
}

function mapFieldPtsToPageInches(pts, lng, lat, ftPerPx, geo, pivot, rot) {
  return pts.map((p) => {
    const r = rotateFieldPt(p, pivot, rot);
    return fieldPointToPageInches(r.x, r.y, lng, lat, ftPerPx, geo);
  });
}

/** Port of hatchFillScreen → SVG primitives in page inches (clip via clipPath). */
function svgMarkHatchParts(pagePts, fillStyle, stepIn, clipId) {
  if (!pagePts.length || fillStyle === 'none' || fillStyle === 'solid') return '';
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pagePts.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  const parts = [];
  const clipAttr = clipId ? ' clip-path="url(#' + clipId + ')"' : '';
  parts.push('<g fill="none" stroke="#1a1a1a" stroke-width="' + svgNum(Math.max(stepIn * 0.2, 0.006)) + '"' + clipAttr + '>');
  if (fillStyle === 'h' || fillStyle === 'cross') {
    for (let y = minY; y <= maxY; y += stepIn) {
      parts.push(svgEl('line', { x1: svgNum(minX), y1: svgNum(y), x2: svgNum(maxX), y2: svgNum(y) }));
    }
  }
  if (fillStyle === 'd' || fillStyle === 'cross') {
    const span = Math.max(maxX - minX, maxY - minY) * 2;
    for (let d = -span; d <= span; d += stepIn) {
      parts.push(svgEl('line', {
        x1: svgNum(minX + d), y1: svgNum(minY),
        x2: svgNum(minX + d + span), y2: svgNum(maxY),
      }));
    }
  }
  if (fillStyle === 'dots') {
    const dotR = Math.max(stepIn * 0.15, 0.004);
    const dotStep = stepIn * (10 / 8);
    parts.push('</g><g fill="#1a1a1a" stroke="none"' + clipAttr + '>');
    for (let y = minY; y <= maxY; y += dotStep) {
      for (let x = minX; x <= maxX; x += dotStep) {
        parts.push(svgEl('circle', { cx: svgNum(x), cy: svgNum(y), r: svgNum(dotR) }));
      }
    }
  }
  parts.push('</g>');
  return parts.join('');
}

function appendGeoLineStrings(features, geo, outPaths) {
  features.forEach((f) => {
    if (!f.geometry) return;
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringLngLatToPageInches(line, geo);
      if (pts.length < 2) return;
      const d = svgPathFromPts(pts, false);
      if (d) outPaths.push(svgEl('path', { d: d }));
    });
  });
}

function appendGeoPolygonOutlines(features, geo, outOutlines) {
  features.forEach((f) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    polys.forEach((poly) => {
      const ring = ringLngLatToPageInches(poly[0], geo);
      if (ring.length < 3) return;
      const d = svgPathFromPts(ring, true);
      if (d) outOutlines.push(svgEl('path', { d: d }));
    });
  });
}

/** Built-in monoline caption glyphs (unit em height 1). A–Z, 0–9, colon, middle dot, space. */
const CAPTION_GLYPHS = {
  ' ': { w: 0.45, strokes: [] },
  ':': { w: 0.35, strokes: [[[0.15, 0.25]], [[0.15, 0.7]]] },
  '·': { w: 0.4, strokes: [[[0.18, 0.5]]] },
  '•': { w: 0.4, strokes: [[[0.18, 0.5]]] },
  '-': { w: 0.5, strokes: [[[0.08, 0.5], [0.42, 0.5]]] },
  '0': { w: 0.7, strokes: [[[0.15, 0.15], [0.5, 0.15], [0.55, 0.3], [0.55, 0.7], [0.5, 0.85], [0.15, 0.85], [0.1, 0.7], [0.1, 0.3], [0.15, 0.15]]] },
  '1': { w: 0.5, strokes: [[[0.15, 0.3], [0.3, 0.15], [0.3, 0.85]]] },
  '2': { w: 0.7, strokes: [[[0.1, 0.3], [0.15, 0.15], [0.5, 0.15], [0.55, 0.3], [0.1, 0.85], [0.55, 0.85]]] },
  '3': { w: 0.7, strokes: [[[0.1, 0.2], [0.45, 0.15], [0.55, 0.3], [0.35, 0.5], [0.55, 0.7], [0.45, 0.85], [0.1, 0.8]]] },
  '4': { w: 0.7, strokes: [[[0.45, 0.85], [0.45, 0.15], [0.1, 0.6], [0.55, 0.6]]] },
  '5': { w: 0.7, strokes: [[[0.55, 0.15], [0.15, 0.15], [0.1, 0.45], [0.45, 0.45], [0.55, 0.6], [0.5, 0.85], [0.15, 0.85], [0.1, 0.7]]] },
  '6': { w: 0.7, strokes: [[[0.5, 0.2], [0.2, 0.15], [0.1, 0.4], [0.1, 0.7], [0.2, 0.85], [0.5, 0.85], [0.55, 0.65], [0.5, 0.5], [0.15, 0.5]]] },
  '7': { w: 0.7, strokes: [[[0.1, 0.15], [0.55, 0.15], [0.25, 0.85]]] },
  '8': { w: 0.7, strokes: [[[0.2, 0.5], [0.15, 0.3], [0.25, 0.15], [0.45, 0.15], [0.55, 0.3], [0.5, 0.5], [0.2, 0.5], [0.1, 0.7], [0.2, 0.85], [0.5, 0.85], [0.55, 0.7], [0.5, 0.5]]] },
  '9': { w: 0.7, strokes: [[[0.15, 0.8], [0.45, 0.85], [0.55, 0.6], [0.55, 0.3], [0.45, 0.15], [0.15, 0.15], [0.1, 0.35], [0.15, 0.5], [0.5, 0.5]]] },
  'A': { w: 0.75, strokes: [[[0.1, 0.85], [0.35, 0.15], [0.6, 0.85]], [[0.2, 0.55], [0.5, 0.55]]] },
  'B': { w: 0.7, strokes: [[[0.1, 0.15], [0.1, 0.85], [0.4, 0.85], [0.55, 0.7], [0.4, 0.5], [0.1, 0.5]], [[0.1, 0.5], [0.4, 0.5], [0.55, 0.35], [0.4, 0.15], [0.1, 0.15]]] },
  'C': { w: 0.7, strokes: [[[0.55, 0.25], [0.4, 0.15], [0.2, 0.15], [0.1, 0.3], [0.1, 0.7], [0.2, 0.85], [0.4, 0.85], [0.55, 0.75]]] },
  'D': { w: 0.75, strokes: [[[0.1, 0.15], [0.1, 0.85], [0.4, 0.85], [0.6, 0.65], [0.6, 0.35], [0.4, 0.15], [0.1, 0.15]]] },
  'E': { w: 0.65, strokes: [[[0.55, 0.15], [0.1, 0.15], [0.1, 0.85], [0.55, 0.85]], [[0.1, 0.5], [0.45, 0.5]]] },
  'F': { w: 0.65, strokes: [[[0.55, 0.15], [0.1, 0.15], [0.1, 0.85]], [[0.1, 0.5], [0.45, 0.5]]] },
  'G': { w: 0.75, strokes: [[[0.55, 0.25], [0.4, 0.15], [0.2, 0.15], [0.1, 0.3], [0.1, 0.7], [0.2, 0.85], [0.45, 0.85], [0.6, 0.7], [0.6, 0.5], [0.35, 0.5]]] },
  'H': { w: 0.75, strokes: [[[0.1, 0.15], [0.1, 0.85]], [[0.6, 0.15], [0.6, 0.85]], [[0.1, 0.5], [0.6, 0.5]]] },
  'I': { w: 0.4, strokes: [[[0.2, 0.15], [0.2, 0.85]]] },
  'J': { w: 0.6, strokes: [[[0.45, 0.15], [0.45, 0.7], [0.35, 0.85], [0.15, 0.85], [0.1, 0.7]]] },
  'K': { w: 0.7, strokes: [[[0.1, 0.15], [0.1, 0.85]], [[0.55, 0.15], [0.1, 0.5], [0.55, 0.85]]] },
  'L': { w: 0.6, strokes: [[[0.1, 0.15], [0.1, 0.85], [0.5, 0.85]]] },
  'M': { w: 0.85, strokes: [[[0.1, 0.85], [0.1, 0.15], [0.4, 0.55], [0.7, 0.15], [0.7, 0.85]]] },
  'N': { w: 0.75, strokes: [[[0.1, 0.85], [0.1, 0.15], [0.6, 0.85], [0.6, 0.15]]] },
  'O': { w: 0.75, strokes: [[[0.2, 0.15], [0.5, 0.15], [0.6, 0.35], [0.6, 0.65], [0.5, 0.85], [0.2, 0.85], [0.1, 0.65], [0.1, 0.35], [0.2, 0.15]]] },
  'P': { w: 0.65, strokes: [[[0.1, 0.85], [0.1, 0.15], [0.4, 0.15], [0.55, 0.3], [0.4, 0.5], [0.1, 0.5]]] },
  'Q': { w: 0.75, strokes: [[[0.2, 0.15], [0.5, 0.15], [0.6, 0.35], [0.6, 0.65], [0.5, 0.85], [0.2, 0.85], [0.1, 0.65], [0.1, 0.35], [0.2, 0.15]], [[0.4, 0.6], [0.65, 0.9]]] },
  'R': { w: 0.7, strokes: [[[0.1, 0.85], [0.1, 0.15], [0.4, 0.15], [0.55, 0.3], [0.4, 0.5], [0.1, 0.5]], [[0.3, 0.5], [0.55, 0.85]]] },
  'S': { w: 0.65, strokes: [[[0.55, 0.25], [0.4, 0.15], [0.2, 0.15], [0.1, 0.3], [0.2, 0.45], [0.45, 0.55], [0.55, 0.7], [0.4, 0.85], [0.15, 0.85], [0.1, 0.7]]] },
  'T': { w: 0.7, strokes: [[[0.1, 0.15], [0.6, 0.15]], [[0.35, 0.15], [0.35, 0.85]]] },
  'U': { w: 0.75, strokes: [[[0.1, 0.15], [0.1, 0.65], [0.2, 0.85], [0.5, 0.85], [0.6, 0.65], [0.6, 0.15]]] },
  'V': { w: 0.75, strokes: [[[0.1, 0.15], [0.35, 0.85], [0.6, 0.15]]] },
  'W': { w: 0.9, strokes: [[[0.1, 0.15], [0.25, 0.85], [0.45, 0.4], [0.65, 0.85], [0.8, 0.15]]] },
  'X': { w: 0.7, strokes: [[[0.1, 0.15], [0.6, 0.85]], [[0.6, 0.15], [0.1, 0.85]]] },
  'Y': { w: 0.7, strokes: [[[0.1, 0.15], [0.35, 0.5], [0.6, 0.15]], [[0.35, 0.5], [0.35, 0.85]]] },
  'Z': { w: 0.7, strokes: [[[0.1, 0.15], [0.6, 0.15], [0.1, 0.85], [0.6, 0.85]]] },
};

function getCaptionGlyph(ch) {
  if (CAPTION_GLYPHS[ch]) return CAPTION_GLYPHS[ch];
  const up = ch.toUpperCase();
  if (CAPTION_GLYPHS[up]) return CAPTION_GLYPHS[up];
  return CAPTION_GLYPHS[' '] || { w: 0.4, strokes: [] };
}

function polylineToPathD(pts) {
  if (!pts.length) return '';
  let d = 'M ' + svgNum(pts[0].x) + ' ' + svgNum(pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    d += ' L ' + svgNum(pts[i].x) + ' ' + svgNum(pts[i].y);
  }
  return d;
}

/** Emit caption string as stroked paths; (startX,startY) is left / vertical center. */
function captionStringPathsAt(str, startX, startY, heightIn, color) {
  let x = startX;
  const out = [];
  const strokeW = Math.max(heightIn * 0.08, 0.006);
  for (let i = 0; i < str.length; i++) {
    const glyph = getCaptionGlyph(str.charAt(i));
    const w = (glyph.w || 0.5) * heightIn;
    (glyph.strokes || []).forEach((stroke) => {
      if (!stroke.length) return;
      const pts = stroke.map((p) => ({
        x: x + p[0] * heightIn,
        y: startY + (p[1] - 0.5) * heightIn,
      }));
      if (pts.length === 1) {
        const r = Math.max(heightIn * 0.04, 0.004);
        out.push(svgEl('circle', {
          cx: svgNum(pts[0].x), cy: svgNum(pts[0].y), r: svgNum(r),
          fill: color || '#1a1a1a', stroke: 'none',
        }));
        return;
      }
      const d = polylineToPathD(pts);
      if (d) {
        out.push(svgEl('path', {
          d: d,
          fill: 'none',
          stroke: color || '#1a1a1a',
          'stroke-width': svgNum(strokeW),
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }));
      }
    });
    x += w * 1.08;
  }
  return out;
}

function sheetCaptionText(sheet, scaleDenom) {
  return 'SHEET ' + sheet.label + ' · 1:' + scaleDenom;
}

function drawSheetCaption(geo) {
  const sheet = getSelectedSheet();
  if (!sheet || !geo.pxPerInch) return;
  const caption = sheetCaptionText(sheet, geo.scaleDenom);
  const heightPx = 0.22 * geo.pxPerInch;
  let x = geo.pageX + 0.35 * geo.pxPerInch;
  const startY = geo.pageY + 0.45 * geo.pxPerInch;
  stroke('#1a1a1a');
  strokeWeight(Math.max(heightPx * 0.08, 0.8));
  strokeCap(ROUND);
  strokeJoin(ROUND);
  noFill();
  for (let i = 0; i < caption.length; i++) {
    const glyph = getCaptionGlyph(caption.charAt(i));
    const w = (glyph.w || 0.5) * heightPx;
    (glyph.strokes || []).forEach((stroke) => {
      if (!stroke.length) return;
      const pts = stroke.map((p) => ({
        x: x + p[0] * heightPx,
        y: startY + (p[1] - 0.5) * heightPx,
      }));
      if (pts.length === 1) {
        noStroke();
        fill('#1a1a1a');
        circle(pts[0].x, pts[0].y, Math.max(heightPx * 0.08, 1.2));
        noFill();
        stroke('#1a1a1a');
        strokeWeight(Math.max(heightPx * 0.08, 0.8));
        return;
      }
      beginShape();
      pts.forEach((p) => vertex(p.x, p.y));
      endShape();
    });
    x += w * 1.08;
  }
}

/**
 * Emit one sketch mark as SVG fragments (shared by notations + base-layer texture).
 * clipState = { seq: number } mutated when hatch clipPaths are added to defs.
 */
function emitSketchMarkSvg(m, lng, lat, ftPerPx, geo, defs, clipState) {
  if (!m || !m.geom) return [];
  const inchesPerFt = 12 / geo.scaleDenom;
  const g = m.geom;
  const pivot = markLocalCenter(m);
  const rot = m.rot || 0;
  const color = m.color || '#1a1a1a';
  const weightIn = Math.max((m.weight || 1) * ftPerPx * inchesPerFt * EXPORT_MARK_STROKE_SCALE, 0.006);
  const hatchStep = MARK_HATCH_LINE_STEP * ftPerPx * inchesPerFt;
  const out = [];

  const toPage = (fx, fy) => {
    const r = rotateFieldPt({ x: fx, y: fy }, pivot, rot);
    return fieldPointToPageInches(r.x, r.y, lng, lat, ftPerPx, geo);
  };

  if (m.type === 'dot') {
    const c = toPage(g.cx, g.cy);
    const edge = toPage(g.cx + g.r, g.cy);
    const rPx = Math.hypot(edge.x - c.x, edge.y - c.y);
    if (m.fill === 'solid' || m.stroke === false) {
      out.push(svgEl('circle', {
        cx: svgNum(c.x), cy: svgNum(c.y), r: svgNum(rPx),
        fill: color, stroke: 'none',
      }));
    } else {
      out.push(svgEl('circle', {
        cx: svgNum(c.x), cy: svgNum(c.y), r: svgNum(rPx),
        fill: 'none', stroke: color, 'stroke-width': svgNum(weightIn),
      }));
    }
    return out;
  }

  if (m.type === 'line') {
    if (m.stroke === false) return out;
    const a = toPage(g.x1, g.y1);
    const b = toPage(g.x2, g.y2);
    out.push(svgEl('line', {
      x1: svgNum(a.x), y1: svgNum(a.y),
      x2: svgNum(b.x), y2: svgNum(b.y),
      stroke: color, 'stroke-width': svgNum(weightIn),
      'stroke-linecap': 'round',
    }));
    return out;
  }

  if (m.type === 'semicircle') {
    if (m.stroke === false) return out;
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
      samples.push(toPage(g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)));
    }
    const d = svgPathFromPts(samples, false);
    if (d) {
      out.push(svgEl('path', {
        d: d, fill: 'none', stroke: color, 'stroke-width': svgNum(weightIn),
        'stroke-linecap': 'round',
      }));
    }
    return out;
  }

  let pagePts = null;
  if (m.type === 'circle') {
    const samples = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      samples.push({ x: g.cx + g.r * Math.cos(t), y: g.cy + g.r * Math.sin(t) });
    }
    pagePts = mapFieldPtsToPageInches(samples, lng, lat, ftPerPx, geo, pivot, rot);
  } else if (Array.isArray(g.pts) && g.pts.length) {
    pagePts = mapFieldPtsToPageInches(g.pts, lng, lat, ftPerPx, geo, pivot, rot);
  }
  if (!pagePts || !pagePts.length) return out;

  const outlineD = svgPathFromPts(pagePts, true);
  if (m.fill && m.fill !== 'none' && m.fill !== 'solid') {
    clipState.seq += 1;
    const clipId = 'mark-clip-' + clipState.seq;
    defs.push(
      '<clipPath id="' + clipId + '">' +
      svgEl('path', { d: outlineD }) +
      '</clipPath>'
    );
    out.push(svgMarkHatchParts(pagePts, m.fill, hatchStep, clipId));
  }
  if (outlineD && (m.stroke !== false || m.fill === 'solid')) {
    out.push(svgEl('path', {
      d: outlineD, fill: 'none', stroke: color, 'stroke-width': svgNum(weightIn),
    }));
  }
  return out;
}

/** Base-layer texture: same forEachBaseLayerStamp + emitSketchMarkSvg as Sheet preview. */
function appendBaseLayerMarksSvg(geo, defs, plotParts, layerOpts, clipState) {
  const ftPerPx = baseLayerFtPerFieldPx(geo);
  const clips = clipState || { seq: 0 };
  const parts = [];
  forEachBaseLayerStamp(geo, (markDef, color, lng, lat) => {
    if (!markDef || !Array.isArray(markDef.marks)) return;
    markDef.marks.forEach((m) => {
      const colored = Object.assign({}, m, { color: color || m.color || '#1a1a1a' });
      const frags = emitSketchMarkSvg(colored, lng, lat, ftPerPx, geo, defs, clips);
      for (let i = 0; i < frags.length; i++) parts.push(frags[i]);
    });
  }, Object.assign({ drawOutlines: false }, layerOpts || {}));
  if (parts.length) {
    plotParts.push('<g id="base-texture">');
    plotParts.push(parts.join(''));
    plotParts.push('</g>');
  }
}

function appendNotationMarksSvg(geo, defs, plotParts, sheet, bufferFt, clipState) {
  const notations = getNotationsToDraw().filter((n) =>
    notationIntersectsSheet(n, sheet, bufferFt)
  );
  const inchesPerFt = 12 / geo.scaleDenom;
  const clips = clipState || { seq: 0 };
  notations.forEach((notation) => {
    if (notation.lat == null || notation.lng == null) return;

    if (notation.lexiconLinkStatus === 'missing') {
      const p = projectLngLatToPageInches(notation.lng, notation.lat, geo);
      const r = Math.max(FALLBACK_DOT_RADIUS_FT * inchesPerFt, 0.02);
      plotParts.push(svgEl('circle', {
        cx: svgNum(p.x), cy: svgNum(p.y), r: svgNum(r),
        fill: 'none', stroke: '#1a1a1a', 'stroke-width': svgNum(EXPORT_STROKE_IN * 1.5),
      }));
      const arm = r * 0.55;
      plotParts.push(svgEl('line', {
        x1: svgNum(p.x - arm), y1: svgNum(p.y - arm),
        x2: svgNum(p.x + arm), y2: svgNum(p.y + arm),
      }));
      plotParts.push(svgEl('line', {
        x1: svgNum(p.x + arm), y1: svgNum(p.y - arm),
        x2: svgNum(p.x - arm), y2: svgNum(p.y + arm),
      }));
      return;
    }

    const marks = notation.sketch && Array.isArray(notation.sketch.marks)
      ? notation.sketch.marks
      : null;
    if (!marks || !marks.length) {
      const p = projectLngLatToPageInches(notation.lng, notation.lat, geo);
      const r = Math.max(FALLBACK_DOT_RADIUS_FT * inchesPerFt, 0.02);
      plotParts.push(svgEl('circle', {
        cx: svgNum(p.x), cy: svgNum(p.y), r: svgNum(r),
        fill: 'none', stroke: '#1a1a1a', 'stroke-width': svgNum(EXPORT_STROKE_IN),
      }));
      return;
    }

    const ftPerPx = markFtPerFieldPx(notation.sketch);
    marks.forEach((m) => {
      const frags = emitSketchMarkSvg(m, notation.lng, notation.lat, ftPerPx, geo, defs, clips);
      for (let i = 0; i < frags.length; i++) plotParts.push(frags[i]);
    });
  });
}

function buildSelectedSheetSvgString(options) {
  const opts = options || {};
  const layerMode = opts.layerMode || 'all';
  const includeGeom = layerMode === 'all' || layerMode === 'geometry';
  const includeMarks = layerMode === 'all' || layerMode === 'marks';

  if (scoreMode !== 'sheet') {
    return { error: 'Switch to Sheet mode and select a sheet to export.' };
  }
  if (!isAtlasScale()) {
    return { error: 'SVG export requires an atlas scale (1:1000 or coarser). Switch to Sheet mode at 1:1000 or coarser.' };
  }
  refreshAtlasSelection();
  const sheet = getSelectedSheet();
  if (!sheet) {
    return { error: 'Switch to Sheet mode and select a sheet to export.' };
  }

  // Same geometry Sheet mode uses on screen (origin = sheet center, scaleDenom/12).
  const geo = getSheetGeometry();
  // Cull stamps to the page rect (same area Sheet mode clips to).
  geo.clipMinX = geo.pageX;
  geo.clipMaxX = geo.pageX + geo.pageW;
  geo.clipMinY = geo.pageY;
  geo.clipMaxY = geo.pageY + geo.pageH;
  logExportCoordCheck(geo, sheet);

  // Only write features that intersect this sheet (overlap strip as buffer).
  const sheetBufferFt = PAGE_OVERLAP_IN * (geo.scaleDenom / 12);
  const streetsF = filterFeaturesToSheet(scoreLayers.streets, sheet, sheetBufferFt);
  const buildingsF = filterFeaturesToSheet(scoreLayers.buildings, sheet, sheetBufferFt);
  const vegetationF = filterFeaturesToSheet(scoreLayers.vegetation, sheet, sheetBufferFt);
  const contoursF = filterFeaturesToSheet(scoreLayers.contours, sheet, sheetBufferFt);

  const defs = [
    '<clipPath id="sheet-clip"><rect x="0" y="0" width="' +
    svgNum(PAGE_WIDTH_IN) + '" height="' + svgNum(PAGE_HEIGHT_IN) + '"/></clipPath>',
  ];
  const plotParts = [];
  const exportClipState = { seq: 0 };

  if (includeGeom) {
    // Contours still export when the Contours layer is on (exception vs other boundaries).
    if (typeof state !== 'undefined' && state.layers && state.layers.contours && contoursF.length) {
      const contourPaths = [];
      appendGeoLineStrings(contoursF, geo, contourPaths);
      if (contourPaths.length) {
        plotParts.push('<g id="contours" fill="none" stroke="#1a1a1a" stroke-width="' + svgNum(EXPORT_STROKE_IN * 0.6) + '">');
        plotParts.push(contourPaths.join(''));
        plotParts.push('</g>');
      }
    }

    // No street centerlines / building / vegetation outlines in export — marks only.
    appendBaseLayerMarksSvg(geo, defs, plotParts, {
      streets: streetsF,
      buildings: buildingsF,
      vegetation: vegetationF,
      drawOutlines: false,
    }, exportClipState);
  }

  if (includeMarks) {
    const markParts = [];
    appendNotationMarksSvg(geo, defs, markParts, sheet, sheetBufferFt, exportClipState);
    if (markParts.length) {
      plotParts.push('<g id="marks">');
      plotParts.push(markParts.join(''));
      plotParts.push('</g>');
    }
  }

  const caption = sheetCaptionText(sheet, geo.scaleDenom);
  const labels = captionStringPathsAt(caption, 0.35, 0.45, 0.22, '#1a1a1a');

  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'width="' + PAGE_WIDTH_IN + 'in" height="' + PAGE_HEIGHT_IN + 'in" ' +
    'viewBox="0 0 ' + PAGE_WIDTH_IN + ' ' + PAGE_HEIGHT_IN + '">\n' +
    '<defs>\n' + defs.join('\n') + '\n</defs>\n' +
    '<g id="plot" clip-path="url(#sheet-clip)" fill="none" stroke="#1a1a1a" stroke-width="' +
    svgNum(EXPORT_STROKE_IN) + '">\n' +
    plotParts.join('\n') + '\n' +
    '</g>\n' +
    '<g id="labels">\n' + labels.join('\n') + '\n</g>\n' +
    '</svg>\n';

  // Diagnose path coordinate ranges and confirm no <text> remains.
  const pathVals = [];
  const pathRe = /\b(?:x|y|x1|y1|x2|y2|cx|cy)="([-+0-9.]+)"/g;
  const dRe = /[ML]\s*([-+0-9.]+)\s+([-+0-9.]+)/g;
  let m;
  while ((m = pathRe.exec(svg))) pathVals.push(Number(m[1]));
  while ((m = dRe.exec(svg))) {
    pathVals.push(Number(m[1]));
    pathVals.push(Number(m[2]));
  }
  const textCount = (svg.match(/<text[\s>]/g) || []).length;
  console.log('[export svg] filter counts', {
    sheet: sheet.label,
    bufferFt: sheetBufferFt,
    streets: streetsF.length + '/' + scoreLayers.streets.length,
    buildings: buildingsF.length + '/' + scoreLayers.buildings.length,
    vegetation: vegetationF.length + '/' + scoreLayers.vegetation.length,
    contours: contoursF.length + '/' + scoreLayers.contours.length,
    textElements: textCount,
  });
  if (pathVals.length) {
    console.log('[export svg] path coord range', {
      min: Math.min.apply(null, pathVals),
      max: Math.max.apply(null, pathVals),
      n: pathVals.length,
      svgBytes: svg.length,
    });
  }

  return {
    svg,
    filename: 'collective-score-' + sheet.label + '-1-' + geo.scaleDenom + '.svg',
    sheet,
    scaleDenom: geo.scaleDenom,
  };
}

function downloadSvgString(svg, filename) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'collective-score-sheet.svg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

window.exportSelectedSheetSvg = function exportSelectedSheetSvg(options) {
  const result = buildSelectedSheetSvgString(options);
  if (result.error) {
    console.warn('[exportSelectedSheetSvg]', result.error);
    alert(result.error);
    return null;
  }
  downloadSvgString(result.svg, result.filename);
  console.log('[exportSelectedSheetSvg] exported', result.filename, {
    sheet: result.sheet && result.sheet.label,
    scaleDenom: result.scaleDenom,
  });
  return result;
};
