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

let scoreLayers = {
  streets: [],
  buildings: [],
  contours: [],
  vegetation: [],
  vegetationDensity: [],
  waterEcologies: [],
  waterColour: [],
};
let scoreCentroid = null;
let scoreReady = false;

const DEFAULT_MARK_ID = 'dot';

// Fixed physical texture on the printed page (independent of map scale).
// Single source: MARK_GRID_MM. Tip-to-tip = pitch → reach = pitch/2 = row gap.
const MM_PER_IN = 25.4;
const MARK_GRID_MM = 5.0;
const MARK_SIZE_MM = MARK_GRID_MM;
const MARK_STROKE_MM = 0.5;
const MARK_SIZE_IN = MARK_SIZE_MM / MM_PER_IN;
const MARK_GRID_IN = MARK_GRID_MM / MM_PER_IN;
const MARK_STROKE_IN = MARK_STROKE_MM / MM_PER_IN;
/** Library marks span this many field units tip-to-tip (reach = half). */
const BASE_MARK_FIELD_SPAN = 30;
/** drawSketchMark weight so stroke ≈ MARK_STROKE_IN on the page at any scale. */
const BASE_MARK_STROKE_WEIGHT = (MARK_STROKE_IN * BASE_MARK_FIELD_SPAN) / MARK_SIZE_IN;

/**
 * View/Grid on-screen pitch (px). Scaled with MARK_GRID_MM so browsing density
 * stays proportional to Sheet/Print (was 7px when print pitch was 3mm).
 */
const HATCH_PITCH = 7 * (MARK_GRID_MM / 3);

// Corner crop / registration marks (centers sit on content-rect corners).
const CROP_MARK_RADIUS_MM = 1.5;   // 3mm diameter circle
const CROP_MARK_CROSS_MM = 2.5;    // half-arm length from center (5mm total)
const CROP_MARK_RADIUS_IN = CROP_MARK_RADIUS_MM / MM_PER_IN;
const CROP_MARK_CROSS_IN = CROP_MARK_CROSS_MM / MM_PER_IN;
const CROP_MARK_STROKE_IN = 0.2 / MM_PER_IN;

const FILL_SCALE_OPTIONS = [1, 0.75, 0.5, 0.25];
const FILL_ROTATION_OPTIONS = [0, 45, 90, 135];
const GRID_PHASE_INDEX = { A: 0, B: 1 };

function clampFillScale(val) {
  const n = Number(val);
  return FILL_SCALE_OPTIONS.indexOf(n) >= 0 ? n : 1;
}

function clampFillRotation(val) {
  const n = Number(val);
  return FILL_ROTATION_OPTIONS.indexOf(n) >= 0 ? n : 0;
}

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
  // Legacy string/missing entries default to enabled; only explicit false disables.
  const enabled = !(entry && typeof entry === 'object' && entry.enabled === false);
  if (!entry) {
    return { markId: DEFAULT_MARK_ID, color: '#1a1a1a', scale: 1, rotation: 0, enabled: true };
  }
  if (typeof entry === 'string') {
    if (known(entry)) {
      return { markId: entry, color: '#1a1a1a', scale: 1, rotation: 0, enabled: true };
    }
    return {
      markId: legacyChar[entry] || DEFAULT_MARK_ID,
      color: '#1a1a1a',
      scale: 1,
      rotation: 0,
      enabled: true,
    };
  }
  let markId = DEFAULT_MARK_ID;
  if (entry.markId && known(entry.markId)) markId = entry.markId;
  else if (entry.char) markId = legacyChar[entry.char] || DEFAULT_MARK_ID;
  return {
    markId: markId,
    color: entry.color || '#1a1a1a',
    scale: clampFillScale(entry.scale),
    rotation: clampFillRotation(entry.rotation),
    enabled: enabled,
  };
}

function layerGridPhaseIndex(layerKey) {
  const g = window.layerGrid && window.layerGrid[layerKey];
  let phase = (g && g.gridPhase) || 'A';
  // Legacy Phase C (from the old 3-phase system) maps to A.
  if (phase !== 'A' && phase !== 'B') phase = 'A';
  return GRID_PHASE_INDEX[phase] != null ? GRID_PHASE_INDEX[phase] : 0;
}

/**
 * Brick / offset grid: same-row step = pitch, row gap = pitch/2,
 * odd rows (B) offset horizontally by pitch/2.
 */
function brickLatticePoint(i, j, pitch) {
  const rowGap = pitch * 0.5;
  const phase = ((j % 2) + 2) % 2;
  const xOff = phase === 1 ? pitch * 0.5 : 0;
  return { x: i * pitch + xOff, y: j * rowGap, phase: phase };
}

function brickRowPhase(j) {
  return ((j % 2) + 2) % 2;
}

function latticeKey(gx, gy) {
  return gx.toFixed(3) + ',' + gy.toFixed(3);
}

/** Iterate brick-grid points in bounds. phaseIndex null = both A and B rows. */
function forEachBrickInBounds(minX, maxX, minY, maxY, pitch, phaseIndex, callback) {
  const rowGap = pitch * 0.5;
  const pad = pitch * 2;
  const jMin = Math.floor((minY - pad) / rowGap);
  const jMax = Math.ceil((maxY + pad) / rowGap);
  for (let j = jMin; j <= jMax; j++) {
    const phase = brickRowPhase(j);
    if (phaseIndex != null && phase !== phaseIndex) continue;
    const xOff = phase === 1 ? pitch * 0.5 : 0;
    const iMin = Math.floor((minX - pad - xOff) / pitch);
    const iMax = Math.ceil((maxX + pad - xOff) / pitch);
    for (let i = iMin; i <= iMax; i++) {
      const x = i * pitch + xOff;
      const y = j * rowGap;
      if (x < minX - pad || x > maxX + pad || y < minY - pad || y > maxY + pad) continue;
      callback(x, y, j, phase);
    }
  }
}

/** Nearest brick-grid point on the given phase row (A=0 / B=1). Fail closed. */
function nearestBrickPhasePoint(x, y, pitch, phaseIndex) {
  const rowGap = pitch * 0.5;
  const target = ((phaseIndex % 2) + 2) % 2;
  const jBase = Math.floor(y / rowGap);
  let bestX = null;
  let bestY = null;
  let bestJ = jBase;
  let bestDist = Infinity;
  for (let dj = -3; dj <= 3; dj++) {
    const j = jBase + dj;
    if (brickRowPhase(j) !== target) continue;
    const xOff = target === 1 ? pitch * 0.5 : 0;
    const iApprox = Math.round((x - xOff) / pitch);
    for (let di = -2; di <= 2; di++) {
      const i = iApprox + di;
      const px = i * pitch + xOff;
      const py = j * rowGap;
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestDist) {
        bestDist = d;
        bestX = px;
        bestY = py;
        bestJ = j;
      }
    }
  }
  if (bestX == null || bestY == null || !Number.isFinite(bestX) || !Number.isFinite(bestY)) {
    let j = Math.round(y / rowGap);
    if (brickRowPhase(j) !== target) j += 1;
    const xOff = target === 1 ? pitch * 0.5 : 0;
    const i = Math.round((x - xOff) / pitch);
    return { gx: i * pitch + xOff, gy: j * rowGap, j: j };
  }
  return { gx: bestX, gy: bestY, j: bestJ };
}

function distPointToSegment2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) {
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  return ex * ex + ey * ey;
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

// Portrait page sizes (inches). Mutable via paper-size selector.
const PAPER_SIZES = {
  '11x14': { id: '11x14', label: '11×14', widthIn: 11, heightIn: 14 },
  '9x12': { id: '9x12', label: '9×12', widthIn: 9, heightIn: 12 },
};
let paperSizeId = '11x14';
let PAGE_WIDTH_IN = PAPER_SIZES['11x14'].widthIn;
let PAGE_HEIGHT_IN = PAPER_SIZES['11x14'].heightIn;
const PAGE_OVERLAP_IN = 0.5;
const PAGE_MARGIN_PX = 40;
/** Atlas tiling only at 1:1000 and coarser; finer scales use free-pan single crop. */
const ATLAS_MIN_SCALE_DENOM = 1000;

/**
 * Shared content / crop-mark rectangle in page inches.
 * Inset PAGE_OVERLAP_IN (0.5") from every page edge — same constant as atlas step
 * (PAGE_*_IN - 2×PAGE_OVERLAP_IN). Outer band is blank handling/glue margin.
 */
function getContentRectInches() {
  const m = PAGE_OVERLAP_IN;
  return {
    minX: m,
    minY: m,
    maxX: PAGE_WIDTH_IN - m,
    maxY: PAGE_HEIGHT_IN - m,
  };
}

function applyPaperSize(sizeId) {
  const spec = PAPER_SIZES[sizeId] || PAPER_SIZES['11x14'];
  paperSizeId = spec.id;
  PAGE_WIDTH_IN = spec.widthIn;
  PAGE_HEIGHT_IN = spec.heightIn;
}

function syncPaperSizeFromUI() {
  const el = document.getElementById('exportPaperSize');
  const id = el && el.value ? el.value : '11x14';
  applyPaperSize(id);
}

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
  const paperEl = document.getElementById('exportPaperSize');
  if (paperEl) {
    syncPaperSizeFromUI();
    paperEl.addEventListener('change', () => {
      syncPaperSizeFromUI();
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
    const [streetsRes, buildingsRes, densityRes] = await Promise.all([
      fetch('geojson/searanch-roads.geojson'),
      fetch('geojson/searanch-buildings.geojson'),
      fetch('geojson/vegetation_density.geojson'),
    ]);
    if (!streetsRes.ok || !buildingsRes.ok) throw new Error('GeoJSON fetch failed');
    const streets = await streetsRes.json();
    const buildings = await buildingsRes.json();
    const prepared = prepareSiteGeoJSON(streets, buildings);

    scoreLayers.streets = prepared.streets.features;
    scoreLayers.buildings = prepared.buildings.features;
    // Contours load only when the Contours toggle is on (see loadContoursLayer).

    // Vegetation Density: eager-load (~1MB, simple rings). Bin ABS_COVER into
    // 7 equal-count quantile classes at load; skip empty geometries.
    if (densityRes.ok) {
      try {
        const density = await densityRes.json();
        scoreLayers.vegetationDensity = prepareVegetationDensityFeatures(
          (density && density.features) || []
        );
        console.log(
          '[collective-score] Vegetation Density loaded:',
          scoreLayers.vegetationDensity.length,
          'binned features'
        );
      } catch (densityErr) {
        console.error('Vegetation Density layer failed to parse:', densityErr);
        scoreLayers.vegetationDensity = [];
      }
    } else {
      console.warn('Vegetation Density geojson fetch failed:', densityRes.status);
      scoreLayers.vegetationDensity = [];
    }

    const bounds = computeLngLatBounds([
      ...scoreLayers.streets,
      ...scoreLayers.buildings,
    ]);
    scoreCentroid = {
      lng: (bounds.minLng + bounds.maxLng) / 2,
      lat: (bounds.minLat + bounds.maxLat) / 2,
    };

    computeBaseFitScale(bounds);
    // Pan origin: buildings cluster center (fit scale still uses full site bounds above).
    const buildingsCenter = computeBuildingsCenterFt();
    console.log('[buildings-center] computeBuildingsCenterFt()', {
      rx: buildingsCenter.rx,
      ry: buildingsCenter.ry,
      finite: Number.isFinite(buildingsCenter.rx) && Number.isFinite(buildingsCenter.ry),
      buildingCount: (scoreLayers.buildings || []).length,
      scoreCentroid: scoreCentroid,
    });
    panRX = buildingsCenter.rx;
    panRY = buildingsCenter.ry;
    console.log('[buildings-center] pan set after load', { panRX: panRX, panRY: panRY });
    scoreReady = true;
    if (statusEl) statusEl.style.display = 'none';
    redraw();
    console.log('[buildings-center] pan after first redraw', { panRX: panRX, panRY: panRY });
    // Catch late overwrites (Firestore, other init) within the next couple frames/ticks.
    setTimeout(() => {
      console.log('[buildings-center] pan +50ms', { panRX: panRX, panRY: panRY });
    }, 50);
    setTimeout(() => {
      console.log('[buildings-center] pan +500ms', { panRX: panRX, panRY: panRY });
    }, 500);
    setTimeout(() => {
      console.log('[buildings-center] pan +2000ms', { panRX: panRX, panRY: panRY });
    }, 2000);
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Unable to load site layers.';
  }
}

/** QGIS-matching equal-count labels for Vegetation Density ABS_COVER bins. */
const VEGETATION_DENSITY_BIN_LABELS = [
  'Bare / Sparse',
  'Open Vegetation',
  'Light Cover',
  'Moderate Cover',
  'Dense Cover',
  'Woodland',
  'Closed Canopy',
];

function featureHasUsablePolygonGeometry(f) {
  if (!f || !f.geometry) return false;
  const g = f.geometry;
  const polys = g.type === 'MultiPolygon'
    ? g.coordinates
    : (g.type === 'Polygon' ? [g.coordinates] : null);
  if (!polys || !polys.length) return false;
  for (let i = 0; i < polys.length; i++) {
    const outer = polys[i] && polys[i][0];
    if (!outer || outer.length < 3) continue;
    // Need at least 3 distinct positions (closed rings may repeat the first point).
    let distinct = 0;
    let prev = null;
    for (let j = 0; j < outer.length; j++) {
      const p = outer[j];
      if (!p || p.length < 2) continue;
      if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) {
        distinct += 1;
        prev = p;
        if (distinct >= 3) return true;
      }
    }
  }
  return false;
}

/**
 * Filter empty geometries, sort by ABS_COVER, assign DensityClass via
 * index-based equal-count quantiles: bin = floor(rank * 7 / n).
 */
function prepareVegetationDensityFeatures(features) {
  const usable = [];
  (features || []).forEach((f) => {
    if (!featureHasUsablePolygonGeometry(f)) return;
    const raw = f.properties && f.properties.ABS_COVER;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    usable.push({ f: f, v: v });
  });
  usable.sort((a, b) => {
    if (a.v !== b.v) return a.v - b.v;
    return 0;
  });
  const n = usable.length;
  if (!n) return [];
  usable.forEach((item, rank) => {
    const bin = Math.min(6, Math.floor((rank * 7) / n));
    if (!item.f.properties) item.f.properties = {};
    item.f.properties.DensityClass = VEGETATION_DENSITY_BIN_LABELS[bin];
  });
  return usable.map((item) => item.f);
}

let vegetationLoaded = false;
let vegetationLoading = false;
let contoursLoaded = false;
let contoursLoading = false;

// Only called when the Contours toggle is switched on — the file may be
// absent, and drawing is already gated on state.layers.contours.
window.loadContoursLayer = async function loadContoursLayer() {
  if (contoursLoaded || contoursLoading) return;
  contoursLoading = true;
  try {
    const contoursRes = await fetch('geojson/contours-1m.geojson');
    if (contoursRes.ok) {
      const contours = await contoursRes.json();
      if (contours && contours.features) {
        let contourFeatures = contours.features;
        if (featuresNeedStatePlaneTransform(contourFeatures)) {
          const fit = fitStatePlaneToWgs84(scoreLayers.streets);
          contourFeatures = transformStatePlaneWithFit(contourFeatures, fit);
        }
        scoreLayers.contours = contourFeatures;
        contoursLoaded = true;
      }
    }
  } catch (_) {
    // Contours are optional; absence should not block the rest of the score.
  } finally {
    contoursLoading = false;
    redraw();
  }
};

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

let waterEcologiesLoaded = false;
let waterEcologiesLoading = false;

// Lazy-load like Vegetation: dense overlapping MultiPolygons (~1.7MB+), only
// fetched when the Water Ecologies toggle is switched on.
window.loadWaterEcologiesLayer = async function loadWaterEcologiesLayer() {
  if (waterEcologiesLoaded || waterEcologiesLoading) return;
  waterEcologiesLoading = true;
  const statusEl = document.getElementById('scoreLoadMsg');
  if (statusEl) {
    statusEl.textContent = 'Loading water ecologies…';
    statusEl.style.display = 'block';
  }
  try {
    const res = await fetch('geojson/Water_ecologies.geojson');
    if (res.ok) {
      const gj = await res.json();
      if (gj && gj.features) {
        // Already WGS84 lon/lat (CRS84), same as vegetation — no state-plane transform.
        scoreLayers.waterEcologies = gj.features;
        waterEcologiesLoaded = true;
      }
    }
  } catch (err) {
    console.error('Water Ecologies layer failed to load:', err);
  } finally {
    waterEcologiesLoading = false;
    if (statusEl) statusEl.style.display = 'none';
    redraw();
  }
};

let waterColourLoaded = false;
let waterColourLoading = false;

// Same class as Water Ecologies: dense regional MultiPolygons (~1.6MB). Lazy-load
// on toggle; stamp path uses viewport cull + hit-test simplification already in
// forEachCategorizedMarkStamp.
window.loadWaterColourLayer = async function loadWaterColourLayer() {
  if (waterColourLoaded || waterColourLoading) return;
  waterColourLoading = true;
  const statusEl = document.getElementById('scoreLoadMsg');
  if (statusEl) {
    statusEl.textContent = 'Loading water colour…';
    statusEl.style.display = 'block';
  }
  try {
    const res = await fetch('geojson/Water_colour.geojson');
    if (res.ok) {
      const gj = await res.json();
      if (gj && gj.features) {
        scoreLayers.waterColour = gj.features;
        waterColourLoaded = true;
      }
    }
  } catch (err) {
    console.error('Water Colour layer failed to load:', err);
  } finally {
    waterColourLoading = false;
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

/**
 * Area-weighted centroid of building polygons in rotated-feet space.
 * Each polygon's own centroid is weighted by its area, then averaged —
 * reflects building mass concentration, not AABB midpoint of outermost extent.
 * Used as View/Grid pan origin (panRX/panRY).
 */
function computeBuildingsCenterFt() {
  let sumA = 0;
  let sumX = 0;
  let sumY = 0;

  function accumulateRing(ringLngLat) {
    if (!ringLngLat || ringLngLat.length < 3) return;
    const pts = [];
    for (let i = 0; i < ringLngLat.length; i++) {
      const c = ringLngLat[i];
      if (!c || c.length < 2) continue;
      const p = toRotatedFeet(c[0], c[1]);
      pts.push(p);
    }
    if (pts.length < 3) return;
    // Close ring if needed for shoelace.
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first.rx !== last.rx || first.ry !== last.ry) pts.push({ rx: first.rx, ry: first.ry });

    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const x0 = pts[i].rx;
      const y0 = pts[i].ry;
      const x1 = pts[i + 1].rx;
      const y1 = pts[i + 1].ry;
      const cross = x0 * y1 - x1 * y0;
      twiceArea += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    if (Math.abs(twiceArea) < 1e-12) return;
    const area = Math.abs(twiceArea) * 0.5;
    const centroidX = cx / (3 * twiceArea);
    const centroidY = cy / (3 * twiceArea);
    sumA += area;
    sumX += centroidX * area;
    sumY += centroidY * area;
  }

  (scoreLayers.buildings || []).forEach((f) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    polys.forEach((poly) => {
      if (!poly || !poly[0]) return;
      accumulateRing(poly[0]); // outer ring only
    });
  });

  if (sumA < 1e-12) {
    console.warn('[buildings-center] computeBuildingsCenterFt fallback {0,0}', {
      sumA: sumA,
      buildingCount: (scoreLayers.buildings || []).length,
    });
    return { rx: 0, ry: 0 };
  }
  const result = { rx: sumX / sumA, ry: sumY / sumA };
  console.log('[buildings-center] centroid internals', {
    sumA: sumA,
    sumX: sumX,
    sumY: sumY,
    result: result,
  });
  return result;
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

/** Atlas overview: fit-to-extent baseline × viewZoom, pan via panRX/panRY (same as View). */
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
  const fitPxPerFt = Math.min(availW / widthFt, availH / heightFt);
  const pxPerFt = fitPxPerFt * viewZoom;
  return {
    mode: 'grid',
    scaleDenom,
    pxPerFt,
    centerX: width / 2,
    centerY: height / 2,
    originRx: panRX,
    originRy: panRY,
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

/** Buildings literal AABB in rotated-feet (atlas grid centering anchor). */
function computeBuildingsBoundsFt() {
  let minRx = Infinity, maxRx = -Infinity, minRy = Infinity, maxRy = -Infinity;
  (scoreLayers.buildings || []).forEach((f) => {
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
    return null;
  }
  return {
    minRx: minRx,
    maxRx: maxRx,
    minRy: minRy,
    maxRy: maxRy,
    widthFt: Math.max(maxRx - minRx, 1),
    heightFt: Math.max(maxRy - minRy, 1),
    centerRx: (minRx + maxRx) / 2,
    centerRy: (minRy + maxRy) / 2,
  };
}

/**
 * Atlas sheet grid sized to the buildings AABB only (minimal sheet count).
 * Buildings box is centered in the union so leftover whole-sheet padding is
 * even on both sides. Shared by Grid, Sheet, and SVG export.
 */
function computePrintAtlas(scaleDenom) {
  const denom = scaleDenom || currentScaleDenominator();
  const site = computeSiteBoundsFt();
  const buildings = computeBuildingsBoundsFt();
  const pageWFt = PAGE_WIDTH_IN * (denom / 12);
  const pageHFt = PAGE_HEIGHT_IN * (denom / 12);
  const stepWFt = (PAGE_WIDTH_IN - 2 * PAGE_OVERLAP_IN) * (denom / 12);
  const stepHFt = (PAGE_HEIGHT_IN - 2 * PAGE_OVERLAP_IN) * (denom / 12);

  // Cover target: buildings AABB (fallback to site if no buildings).
  const coverMinRx = buildings ? buildings.minRx : site.minRx;
  const coverMaxRx = buildings ? buildings.maxRx : site.maxRx;
  const coverMinRy = buildings ? buildings.minRy : site.minRy;
  const coverMaxRy = buildings ? buildings.maxRy : site.maxRy;
  const coverW = Math.max(coverMaxRx - coverMinRx, 1);
  const coverH = Math.max(coverMaxRy - coverMinRy, 1);
  const anchorRx = (coverMinRx + coverMaxRx) / 2;
  const anchorRy = (coverMinRy + coverMaxRy) / 2;

  // Minimal union of whole sheets that contains the cover box.
  const needW = Math.max(coverW, pageWFt);
  const needH = Math.max(coverH, pageHFt);

  let cols = 1;
  let unionW = pageWFt;
  while (unionW < needW - 1e-9) {
    cols += 1;
    unionW = (cols - 1) * stepWFt + pageWFt;
  }
  let rows = 1;
  let unionH = pageHFt;
  while (unionH < needH - 1e-9) {
    rows += 1;
    unionH = (rows - 1) * stepHFt + pageHFt;
  }

  // Center cover in the union → leftover padding split evenly both sides.
  const originMinX = anchorRx - unionW / 2;
  const originMaxY = anchorRy + unionH / 2;
  const fitsOne = cols === 1 && rows === 1;

  const sheets = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const minX = originMinX + col * stepWFt;
      const maxY = originMaxY - row * stepHFt;
      const maxX = minX + pageWFt;
      const minY = maxY - pageHFt;
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
    buildings,
    anchorRx,
    anchorRy,
    originMinX,
    originMaxY,
    unionW,
    unionH,
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
  // Teal — distinct from gray grid lines / black selection stroke.
  const labelFill = '#1a8a94';
  const labelFillSelected = '#0d5c63';

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
    const cellW = Math.max(Math.abs(se.x - nw.x), Math.abs(sw.x - ne.x), 1);
    const cellH = Math.max(Math.abs(sw.y - nw.y), Math.abs(se.y - ne.y), 1);
    // Large cell-centered labels; scale with zoom so they stay legible.
    const labelSize = Math.max(14, Math.min(64, Math.min(cellW, cellH) * 0.32));
    noStroke();
    fill(isSelected ? labelFillSelected : labelFill);
    textAlign(CENTER, CENTER);
    textSize(labelSize);
    textFont('Miniature, serif');
    text(sheet.label, cx, cy);
  });

  textFont('monospace');
  textAlign(CENTER, CENTER);
}

/** Overlap strips on sheet edges that adjoin a neighbor (Sheet mode). */
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

/** Squared distance from point P to segment AB (rotated-feet space). */
function distPointToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-18) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  return ex * ex + ey * ey;
}

/**
 * Douglas–Peucker simplification for PIP hit-testing only.
 * Keeps endpoints; closes the ring if the source was closed.
 */
function simplifyRingDp(points, tolerance) {
  if (!points || points.length <= 4) return points;
  const sqTol = tolerance * tolerance;
  const closed = points.length > 1 &&
    points[0].x === points[points.length - 1].x &&
    points[0].y === points[points.length - 1].y;
  const pts = closed ? points.slice(0, -1) : points;
  if (pts.length <= 3) return points;

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  function dp(i0, i1) {
    let maxD = 0;
    let maxI = -1;
    const a = pts[i0];
    const b = pts[i1];
    for (let i = i0 + 1; i < i1; i++) {
      const d = distPointToSegSq(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > sqTol && maxI >= 0) {
      keep[maxI] = 1;
      dp(i0, maxI);
      dp(maxI, i1);
    }
  }
  dp(0, pts.length - 1);

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  if (out.length < 3) return points;
  if (closed) out.push(out[0]);
  return out;
}

/** Cache: GeoJSON outer-ring array → rotated-feet full ring + pitch-keyed hit-test ring. */
const stampOuterRingCache = new WeakMap();

/**
 * Full ring for bounds/outlines; simplified ring for PIP when dense.
 * Cached across redraws; hit-test ring rebuilds when pitch changes materially.
 */
function getStampOuterRingsFt(outerLngLat, pitch) {
  let entry = stampOuterRingCache.get(outerLngLat);
  if (!entry) {
    const full = ringToRotatedFeet(outerLngLat);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    full.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    entry = { full: full, minX: minX, maxX: maxX, minY: minY, maxY: maxY, hit: null, hitPitchKey: null };
    stampOuterRingCache.set(outerLngLat, entry);
  }
  const pitchKey = Math.round(pitch * 100) / 100;
  if (entry.hitPitchKey !== pitchKey) {
    // Tolerance ~¼ pitch: preserves lattice membership at stamp resolution.
    const tol = Math.max(pitch * 0.25, 1);
    entry.hit = entry.full.length > 400 ? simplifyRingDp(entry.full, tol) : entry.full;
    entry.hitPitchKey = pitchKey;
  }
  return entry;
}

function intersectBoundsFt(a, b) {
  if (!a) return b;
  if (!b) return a;
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  if (minX > maxX || minY > maxY) return null;
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}

/**
 * Visible lattice search window in rotated feet.
 * Sheet/Print: content clip rect. View/Grid: canvas viewport.
 * Pads by mark size + pitch so edge stamps are not clipped early.
 */
function stampSearchBoundsFt(geo, pitch) {
  if (!geo || !(geo.pxPerFt > 0)) return null;
  const padPx = stampClipPadPx(geo);
  const padFt = padPx / geo.pxPerFt + (pitch || 0) * 2;
  const ox = geo.originRx != null ? geo.originRx : panRX;
  const oy = geo.originRy != null ? geo.originRy : panRY;

  let x0;
  let x1;
  let y0;
  let y1;
  if (geo.clipMinX != null) {
    x0 = geo.clipMinX;
    x1 = geo.clipMaxX;
    y0 = geo.clipMinY;
    y1 = geo.clipMaxY;
  } else {
    x0 = 0;
    x1 = width;
    y0 = 0;
    y1 = height;
  }

  function screenToFt(sx, sy) {
    return {
      x: ox + (sx - geo.centerX) / geo.pxPerFt,
      y: oy - (sy - geo.centerY) / geo.pxPerFt,
    };
  }

  const corners = [
    screenToFt(x0, y0),
    screenToFt(x1, y0),
    screenToFt(x1, y1),
    screenToFt(x0, y1),
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  corners.forEach((c) => {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  });
  return {
    minX: minX - padFt,
    maxX: maxX + padFt,
    minY: minY - padFt,
    maxY: maxY + padFt,
  };
}

/** Cheap visibility test in screen space (View/Grid) or page clip (Sheet/Print). */
function stampInVisible(geo, gx, gy, lng, lat) {
  if (geo.clipMinX != null) return stampInClip(geo, lng, lat);
  if (!(geo.pxPerFt > 0)) return true;
  const ox = geo.originRx != null ? geo.originRx : panRX;
  const oy = geo.originRy != null ? geo.originRy : panRY;
  const sx = geo.centerX + (gx - ox) * geo.pxPerFt;
  const sy = geo.centerY - (gy - oy) * geo.pxPerFt;
  const pad = stampClipPadPx(geo);
  return sx >= -pad && sx <= width + pad && sy >= -pad && sy <= height + pad;
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


/**
 * Stamp grid pitch in rotated feet (horizontal same-row spacing).
 * Sheet / Print Preview / SVG export: fixed MARK_GRID_MM on the page at scaleDenom.
 * View / Grid: ~HATCH_PITCH screen px via geo.pxPerFt (zoom-aware browsing density).
 * Row gap is always pitch/2 (brick offset grid).
 */
function texturePitchFt(geo) {
  if (isPrintSurfaceMode()) {
    const denom = (geo && geo.scaleDenom) || currentScaleDenominator();
    return MARK_GRID_IN * (denom / 12);
  }
  return HATCH_PITCH / Math.max(geo && geo.pxPerFt, 1e-9);
}

/**
 * Field px → feet for base-layer mark size.
 * Tip-to-tip = pitch (reach = pitch/2) at 100% classification scale.
 * Sheet / Print / export: MARK_SIZE_MM on the page at scaleDenom.
 * View / Grid: HATCH_PITCH screen px (matches zoom-aware pitch).
 */
function baseLayerFtPerFieldPx(geo) {
  if (isPrintSurfaceMode()) {
    const denom = (geo && geo.scaleDenom) || currentScaleDenominator();
    const inchesPerFt = 12 / denom;
    return MARK_SIZE_IN / (BASE_MARK_FIELD_SPAN * inchesPerFt);
  }
  const desiredFt = HATCH_PITCH / Math.max(geo && geo.pxPerFt, 1e-9);
  return desiredFt / BASE_MARK_FIELD_SPAN;
}

/** Clip padding covers full mark tip-to-tip size, √2 for 45°/135° rotation. */
function stampClipPadPx(geo) {
  const basePx = (geo.pxPerInch != null)
    ? (MARK_SIZE_IN * geo.pxPerInch)
    : HATCH_PITCH;
  return basePx * Math.SQRT2;
}

function stampInClip(geo, lng, lat) {
  if (geo.clipMinX == null) return true;
  const p = project(lng, lat, geo);
  const padPx = stampClipPadPx(geo);
  return p.x >= geo.clipMinX - padPx && p.x <= geo.clipMaxX + padPx &&
    p.y >= geo.clipMinY - padPx && p.y <= geo.clipMaxY + padPx;
}

function ringToRotatedFeet(ring) {
  return ring.map(([lng, lat]) => {
    const { rx, ry } = toRotatedFeet(lng, lat);
    return { x: rx, y: ry };
  });
}

/**
 * Shared base-layer stamp positions on the brick offset grid.
 * Strict single-phase: each layer stamps only its assigned A/B rows.
 * callback(markDef, color, lng, lat, category, scale, rotation)
 */
function forEachStreetMarkStamp(geo, features, callback) {
  if (!state.layers.streets) return;
  const pitch = texturePitchFt(geo);
  const phaseIndex = layerGridPhaseIndex('streets');
  const corridor = pitch * 0.5;
  const drawnPoints = new Set();
  const roadFills = (window.categoryFills && window.categoryFills.streets) || {};
  const list = features || scoreLayers.streets;

  list.forEach((f) => {
    if (!f.geometry) return;
    const category = (f.properties && f.properties.Class) || 'Local';
    const { markId, color, scale, rotation, enabled } = normalizeFillEntry(roadFills[category]);
    if (!enabled) return;
    const markDef = getBaseMarkDef(markId);
    if (!markDef) return;
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringToRotatedFeet(line);
      if (pts.length < 2) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      pts.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
      const pad = corridor;
      forEachBrickInBounds(minX - pad, maxX + pad, minY - pad, maxY + pad, pitch, phaseIndex, (gx, gy) => {
        const key = latticeKey(gx, gy);
        if (drawnPoints.has(key)) return;
        let near = false;
        for (let s = 0; s < pts.length - 1; s++) {
          if (distPointToSegment2(gx, gy, pts[s].x, pts[s].y, pts[s + 1].x, pts[s + 1].y) <= corridor * corridor) {
            near = true;
            break;
          }
        }
        if (!near) return;
        drawnPoints.add(key);
        const { lng, lat } = fromRotatedFeet(gx, gy);
        if (!stampInClip(geo, lng, lat)) return;
        callback(markDef, color, lng, lat, category, scale, rotation);
      });
    });
  });
}

function forEachCategorizedMarkStamp(geo, features, categoryField, fillGroupKey, callback, outlineCallback) {
  const fills = (window.categoryFills && window.categoryFills[fillGroupKey]) || {};
  const pitch = texturePitchFt(geo);
  const phaseIndex = layerGridPhaseIndex(fillGroupKey);
  const list = features || [];
  // First polygon (feature order) to contain a lattice point wins — prevents
  // double-stamps where land-cover polygons overlap (same or different class).
  const drawnPoints = new Set();
  // Cull lattice iteration to the visible/sheet window. Critical for regional
  // polygons (e.g. Water Ecologies) whose AABBs dwarf the Sea Ranch site.
  const searchBounds = stampSearchBoundsFt(geo, pitch);

  list.forEach((f) => {
    if (!f.geometry) return;
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];

    const category = (f.properties && f.properties[categoryField]) || 'Other';
    const { markId, color, scale, rotation, enabled } = normalizeFillEntry(fills[category]);
    if (!enabled) return;
    const markDef = getBaseMarkDef(markId);
    if (!markDef) return;

    polys.forEach((poly) => {
      const outerLngLat = poly[0];
      const rings = getStampOuterRingsFt(outerLngLat, pitch);
      const hitFt = rings.hit;
      if (outlineCallback) outlineCallback(ringToScreen(outerLngLat, geo));

      const polyBounds = {
        minX: rings.minX,
        maxX: rings.maxX,
        minY: rings.minY,
        maxY: rings.maxY,
      };
      const query = intersectBoundsFt(polyBounds, searchBounds);
      if (!query) return;

      if (query.maxX - query.minX < pitch && query.maxY - query.minY < pitch) {
        const cx = (query.minX + query.maxX) / 2;
        const cy = (query.minY + query.maxY) / 2;
        const { gx, gy } = nearestBrickPhasePoint(cx, cy, pitch, phaseIndex);
        const key = latticeKey(gx, gy);
        if (drawnPoints.has(key)) return;
        const { lng, lat } = fromRotatedFeet(gx, gy);
        if (!stampInVisible(geo, gx, gy, lng, lat)) return;
        if (!pointInPolygon(gx, gy, hitFt)) return;
        drawnPoints.add(key);
        callback(markDef, color, lng, lat, category, scale, rotation);
        return;
      }

      forEachBrickInBounds(query.minX, query.maxX, query.minY, query.maxY, pitch, phaseIndex, (gx, gy) => {
        const key = latticeKey(gx, gy);
        if (drawnPoints.has(key)) return;
        // Cheap visibility before expensive PIP (especially dense Water Ecologies rings).
        const { lng, lat } = fromRotatedFeet(gx, gy);
        if (!stampInVisible(geo, gx, gy, lng, lat)) return;
        if (!pointInPolygon(gx, gy, hitFt)) return;
        drawnPoints.add(key);
        callback(markDef, color, lng, lat, category, scale, rotation);
      });
    });
  });
}

/**
 * Iterate every base-layer stamp (water, vegetation, streets, buildings).
 * Shared by drawBaseLayerMarks and appendBaseLayerMarksSvg — one placement path.
 */
function forEachBaseLayerStamp(geo, callback, options) {
  const opts = options || {};
  const streets = opts.streets != null ? opts.streets : scoreLayers.streets;
  const buildings = opts.buildings != null ? opts.buildings : scoreLayers.buildings;
  const vegetation = opts.vegetation != null ? opts.vegetation : scoreLayers.vegetation;
  const vegetationDensity = opts.vegetationDensity != null
    ? opts.vegetationDensity
    : scoreLayers.vegetationDensity;
  const waterEcologies = opts.waterEcologies != null ? opts.waterEcologies : scoreLayers.waterEcologies;
  const waterColour = opts.waterColour != null ? opts.waterColour : scoreLayers.waterColour;
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

  // Paint order: water ecology → water colour → density → vegetation → streets → buildings.
  // Ecology (phase A) and colour (phase B) share geometry; opposite phases interleave.
  // forEachCategorizedMarkStamp dedupes lattice points within each layer
  // (first feature wins) — required where polygons overlap.
  if (state.layers.waterEcologies) {
    forEachCategorizedMarkStamp(
      geo, waterEcologies, 'Layer', 'waterEcologies', callback,
      drawOutlines ? outlineDrawer : null
    );
  }

  if (state.layers.waterColour) {
    forEachCategorizedMarkStamp(
      geo, waterColour, 'Layer', 'waterColour', callback,
      drawOutlines ? outlineDrawer : null
    );
  }

  if (state.layers.vegetationDensity) {
    forEachCategorizedMarkStamp(
      geo, vegetationDensity, 'DensityClass', 'vegetationDensity', callback,
      drawOutlines ? outlineDrawer : null
    );
  }

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

function drawBaseLayerMarkAt(markDef, color, lng, lat, geo, scale, rotationDeg) {
  if (!markDef || !Array.isArray(markDef.marks)) return;
  const s = clampFillScale(scale);
  const rotExtra = (clampFillRotation(rotationDeg) * Math.PI) / 180;
  // Geometry scales with s; stroke weight compensated so screen stroke stays fixed.
  const ftPerPx = baseLayerFtPerFieldPx(geo) * s;
  const strokeWeight = BASE_MARK_STROKE_WEIGHT / Math.max(s, 1e-6);
  const groupPivot = markDef.pivotMode === 'group' ? markDefGroupPivot(markDef) : null;
  markDef.marks.forEach((m) => {
    const colored = Object.assign({}, m, {
      color: color || m.color || '#1a1a1a',
      weight: strokeWeight,
      rot: (m.rot || 0) + rotExtra,
    });
    drawSketchMark(colored, lng, lat, ftPerPx, geo, groupPivot);
  });
}

function drawBaseLayerMarks(geo) {
  const drawOutlines = !isPrintSurfaceMode();
  forEachBaseLayerStamp(geo, (markDef, color, lng, lat, category, scale, rotation) => {
    drawBaseLayerMarkAt(markDef, color, lng, lat, geo, scale, rotation);
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

/**
 * Site exterior mask — STATIC hole in rotated feet (same frame as toRotatedFeet).
 * Tweak these four numbers directly to nudge each edge; no GeoJSON / layer bounds.
 *   left   = minRx (decrease to open west / increase to crop west)
 *   right  = maxRx
 *   bottom = minRy
 *   top    = maxRy
 * Initial guess ≈ previous streets+buildings AABB (flush crop that rendered correctly).
 */
const SITE_MASK_HOLE_LEFT = -6405;
const SITE_MASK_HOLE_RIGHT = 5932;
const SITE_MASK_HOLE_BOTTOM = -32243;
const SITE_MASK_HOLE_TOP = 29650;
const SITE_MASK_OUTER_MULT = 5;

function getSiteMaskBandsFt() {
  const hole = {
    minRx: SITE_MASK_HOLE_LEFT,
    maxRx: SITE_MASK_HOLE_RIGHT,
    minRy: SITE_MASK_HOLE_BOTTOM,
    maxRy: SITE_MASK_HOLE_TOP,
  };
  const widthFt = Math.max(hole.maxRx - hole.minRx, 1);
  const heightFt = Math.max(hole.maxRy - hole.minRy, 1);
  const span = Math.max(widthFt, heightFt) * SITE_MASK_OUTER_MULT;
  const cx = (hole.minRx + hole.maxRx) / 2;
  const cy = (hole.minRy + hole.maxRy) / 2;
  const outer = {
    minRx: cx - span,
    maxRx: cx + span,
    minRy: cy - span,
    maxRy: cy + span,
  };
  return { hole: hole, outer: outer };
}

function drawWorldRectFt(minRx, minRy, maxRx, maxRy, geo) {
  if (!(maxRx > minRx) || !(maxRy > minRy)) return;
  const sw = rotatedFeetToScreen(minRx, minRy, geo);
  const se = rotatedFeetToScreen(maxRx, minRy, geo);
  const ne = rotatedFeetToScreen(maxRx, maxRy, geo);
  const nw = rotatedFeetToScreen(minRx, maxRy, geo);
  beginShape();
  vertex(sw.x, sw.y);
  vertex(se.x, se.y);
  vertex(ne.x, ne.y);
  vertex(nw.x, nw.y);
  endShape(CLOSE);
}

function drawSiteExteriorMask(geo) {
  if (!scoreReady) return;
  const bands = getSiteMaskBandsFt();
  if (!bands) return;
  const hole = bands.hole;
  const outer = bands.outer;
  noStroke();
  fill(255);
  // Four bands around the site hole (same rotated-feet frame as streets/buildings).
  drawWorldRectFt(outer.minRx, hole.maxRy, outer.maxRx, outer.maxRy, geo);
  drawWorldRectFt(outer.minRx, outer.minRy, outer.maxRx, hole.minRy, geo);
  drawWorldRectFt(outer.minRx, hole.minRy, hole.minRx, hole.maxRy, geo);
  drawWorldRectFt(hole.maxRx, hole.minRy, outer.maxRx, hole.maxRy, geo);
}

function appendSiteExteriorMaskSvg(geo, plotParts) {
  const bands = getSiteMaskBandsFt();
  if (!bands || !(geo && geo.pxPerInch > 0)) return;
  const hole = bands.hole;
  const outer = bands.outer;
  const rects = [
    [outer.minRx, hole.maxRy, outer.maxRx, outer.maxRy],
    [outer.minRx, outer.minRy, outer.maxRx, hole.minRy],
    [outer.minRx, hole.minRy, hole.minRx, hole.maxRy],
    [hole.maxRx, hole.minRy, outer.maxRx, hole.maxRy],
  ];
  const parts = [];
  rects.forEach((r) => {
    const minRx = r[0];
    const minRy = r[1];
    const maxRx = r[2];
    const maxRy = r[3];
    if (!(maxRx > minRx) || !(maxRy > minRy)) return;
    const corners = [
      [minRx, minRy],
      [maxRx, minRy],
      [maxRx, maxRy],
      [minRx, maxRy],
    ].map(([rx, ry]) => {
      const s = rotatedFeetToScreen(rx, ry, geo);
      return {
        x: (s.x - geo.pageX) / geo.pxPerInch,
        y: (s.y - geo.pageY) / geo.pxPerInch,
      };
    });
    const d = svgPathFromPts(corners, true);
    if (d) parts.push(svgEl('path', { d: d, fill: '#ffffff', stroke: 'none' }));
  });
  if (!parts.length) return;
  plotParts.push(svgLayerOpen('site-mask', 'site exterior mask'));
  plotParts.push(parts.join(''));
  plotParts.push(svgLayerClose());
}

// --- Observation lexicon marks (native p5, same feet → rotate → project pipeline) ---
//
// Site layers arrive as WGS84 lng/lat (after prepareSiteGeoJSON state-plane fit).
// Anchors use toRotatedFeet (42°) then project so marks sit on the rotated site.
// Local sketch offsets are applied upright in screen space (scale only); per-mark
// rot still applies in field space.
// Collective Score display/export: lattice-snapped anchors + fixed NOTATION_GRID_CELLS
// footprint (ignores stored scaleFt for drawing). Builder/Location Input/Firestore keep
// literal lat/lng and scaleFt.

const MARK_FIELD_W = 600;
const MARK_FIELD_H = 800;
const MARK_SCALE_BAR_PX = 100;
const FALLBACK_DOT_RADIUS_FT = 3;
/**
 * Collective Score display/export only: every notation spans this many lattice
 * pitches across the sketch field width (≈2×2 cell footprint). Stored scaleFt
 * is never overwritten — Builder / Firestore / Location Input stay literal.
 */
const NOTATION_GRID_CELLS = 2;
/** Max spiral nudge from preferred cell, in lattice pitches (scale-linked feet). */
const NOTATION_NUDGE_MAX_PITCHES = 8;
/** Overflow fan-out radius as a fraction of pitch when the capped search fails. */
const NOTATION_OVERFLOW_OFFSET_FRAC = 0.25;

function getNotationsToDraw() {
  if (typeof state === 'undefined' || !state || !Array.isArray(state.notations)) return [];
  // Master layer gate — stacks with author/status filters (filteredNotations).
  if (state.layers && state.layers.notations === false) return [];
  if (Array.isArray(state.filteredNotations)) return state.filteredNotations;
  return state.notations;
}

function markFtPerFieldPx(sketch) {
  const scaleFt = sketch && sketch.scaleFt != null ? Number(sketch.scaleFt) : 10;
  return (scaleFt > 0 ? scaleFt : 10) / MARK_SCALE_BAR_PX;
}

/**
 * Print/export lattice pitch in rotated feet — always MARK_GRID_MM at the selected
 * scaleDenom, even in View browse mode, so notation placement matches SVG export.
 */
function notationPrintPitchFt(geo) {
  const denom = (geo && geo.scaleDenom) || currentScaleDenominator();
  return MARK_GRID_IN * (denom / 12);
}

/** Nearest brick lattice point on either A or B row (whichever is closer). */
function nearestBrickPointAnyPhase(x, y, pitch) {
  const a = nearestBrickPhasePoint(x, y, pitch, 0);
  const b = nearestBrickPhasePoint(x, y, pitch, 1);
  const da = (a.gx - x) * (a.gx - x) + (a.gy - y) * (a.gy - y);
  const db = (b.gx - x) * (b.gx - x) + (b.gy - y) * (b.gy - y);
  return da <= db ? a : b;
}

function notationCentreClear(gx, gy, centres, minDist2) {
  for (let i = 0; i < centres.length; i++) {
    const c = centres[i];
    const dx = gx - c.gx;
    const dy = gy - c.gy;
    if (dx * dx + dy * dy < minDist2) return false;
  }
  return true;
}

/**
 * Nearest brick cell to (prefGx, prefGy) whose centre is at least
 * NOTATION_GRID_CELLS pitches from every already-placed centre, within
 * NOTATION_NUDGE_MAX_PITCHES of preferred. Returns null if none (overflow).
 */
function findFreeNotationLatticeCell(prefGx, prefGy, pitch, centres) {
  const minDist = NOTATION_GRID_CELLS * pitch;
  const minDist2 = minDist * minDist;
  const maxDist = NOTATION_NUDGE_MAX_PITCHES * pitch;
  const maxDist2 = maxDist * maxDist;

  if (notationCentreClear(prefGx, prefGy, centres, minDist2)) {
    return { gx: prefGx, gy: prefGy };
  }

  const maxRing = Math.ceil(NOTATION_NUDGE_MAX_PITCHES * 2) + 2;
  for (let ring = 1; ring <= maxRing; ring++) {
    const pad = ring * pitch * 0.5;
    if (pad > maxDist + pitch) break;
    let best = null;
    let bestD = Infinity;
    forEachBrickInBounds(
      prefGx - pad, prefGx + pad, prefGy - pad, prefGy + pad,
      pitch, null,
      (gx, gy) => {
        const dPref = (gx - prefGx) * (gx - prefGx) + (gy - prefGy) * (gy - prefGy);
        if (dPref > maxDist2 + 1e-9) return;
        if (!notationCentreClear(gx, gy, centres, minDist2)) return;
        if (dPref < bestD) {
          bestD = dPref;
          best = { gx: gx, gy: gy };
        }
      }
    );
    if (best) return best;
  }
  return null;
}

/** Deterministic micro-offset from preferred cell for capped-search overflow. */
function notationOverflowAnchor(prefGx, prefGy, pitch, overflowIndex) {
  // Golden-angle fan so stacked overflows stay separated for the plotter.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const angle = overflowIndex * golden;
  const r = NOTATION_OVERFLOW_OFFSET_FRAC * pitch;
  return {
    gx: prefGx + r * Math.cos(angle),
    gy: prefGy + r * Math.sin(angle),
  };
}

function notationPlacementSortKey(a, b) {
  const ida = String(a && a.id != null ? a.id : '');
  const idb = String(b && b.id != null ? b.id : '');
  if (ida !== idb) return ida < idb ? -1 : 1;
  const sa = String(a && a.savedAt != null ? a.savedAt : '');
  const sb = String(b && b.savedAt != null ? b.savedAt : '');
  if (sa !== sb) return sa < sb ? -1 : 1;
  return 0;
}

/**
 * Shared Collective Score placement for student notations (screen + SVG).
 * Snaps anchors to the print brick lattice, sizes every mark to a fixed
 * NOTATION_GRID_CELLS footprint (ignores stored scaleFt for drawing only),
 * nudges with 2-pitch centre clearance and an 8-pitch search cap, and falls
 * back to a preferred-cell micro-offset when the neighbourhood is full.
 * Does not mutate notations or Firestore.
 *
 * @returns {Object.<string, {lng,lat,gx,gy,ftPerPx,cells,pitch,overflow}>} keyed by notation.id
 */
function resolveNotationLatticePlacement(notations, geo) {
  const pitch = notationPrintPitchFt(geo);
  const list = Array.isArray(notations) ? notations.slice() : [];
  list.sort(notationPlacementSortKey);

  const centres = [];
  const overflowCountByPref = Object.create(null);
  const byId = Object.create(null);
  const cells = NOTATION_GRID_CELLS;
  const ftPerPx = (cells * pitch) / MARK_FIELD_W;

  list.forEach((notation) => {
    if (!notation || notation.lat == null || notation.lng == null) return;
    if (notation.id == null || notation.id === '') return;
    const id = String(notation.id);

    const { rx, ry } = toRotatedFeet(notation.lng, notation.lat);
    const pref = nearestBrickPointAnyPhase(rx, ry, pitch);
    const found = findFreeNotationLatticeCell(pref.gx, pref.gy, pitch, centres);

    let gx;
    let gy;
    let overflow = false;
    if (found) {
      gx = found.gx;
      gy = found.gy;
      centres.push({ gx: gx, gy: gy });
    } else {
      const prefKey = latticeKey(pref.gx, pref.gy);
      const idx = overflowCountByPref[prefKey] || 0;
      overflowCountByPref[prefKey] = idx + 1;
      const off = notationOverflowAnchor(pref.gx, pref.gy, pitch, idx);
      gx = off.gx;
      gy = off.gy;
      overflow = true;
    }

    const ll = fromRotatedFeet(gx, gy);

    byId[id] = {
      lng: ll.lng,
      lat: ll.lat,
      gx: gx,
      gy: gy,
      preferredGx: pref.gx,
      preferredGy: pref.gy,
      ftPerPx: ftPerPx,
      cells: cells,
      pitch: pitch,
      overflow: overflow,
    };
  });

  return byId;
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

/** Shared pivot for pivotMode:'group' marks (average of segment centres ≈ BMC). */
function markDefGroupPivot(markDef) {
  if (!markDef || !Array.isArray(markDef.marks) || !markDef.marks.length) {
    return { x: MARK_FIELD_W / 2, y: MARK_FIELD_H / 2 };
  }
  let sx = 0;
  let sy = 0;
  let n = 0;
  markDef.marks.forEach((m) => {
    const c = markLocalCenter(m);
    sx += c.x;
    sy += c.y;
    n += 1;
  });
  return { x: sx / n, y: sy / n };
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

function drawFillGeometryScreen(geom, color, toScreen, weightPx) {
  if (!geom) return;
  const ctx = drawingContext;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max((weightPx || 1) * 0.25, 0.75);
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  (geom.lines || []).forEach((seg) => {
    const a = toScreen(seg.x1, seg.y1);
    const b = toScreen(seg.x2, seg.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  });
  (geom.dots || []).forEach((d) => {
    const c = toScreen(d.cx, d.cy);
    const edge = toScreen(d.cx + d.r, d.cy);
    const rPx = Math.max(Math.hypot(edge.x - c.x, edge.y - c.y), 0.5);
    ctx.beginPath();
    ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function fillGeometryForSketchMark(m) {
  if (!m || !window.SketchFill || !window.SketchFill.fillGeometryForMark) return null;
  if (m.fill === 'none') return null;
  // closed shapes only; lines/dots/semicircles have no area fill
  if (m.type !== 'circle' && m.type !== 'triangle' && m.type !== 'rectangle' && m.type !== 'diamond') {
    return null;
  }
  return window.SketchFill.fillGeometryForMark(m);
}

function strokeScreenPolyline(screenPts, close) {
  if (!screenPts.length) return;
  beginShape();
  screenPts.forEach((p) => vertex(p.x, p.y));
  if (close) endShape(CLOSE);
  else endShape();
}

function drawSketchMark(m, lng, lat, ftPerPx, geo, pivotOverride) {
  if (!m || !m.geom) return;
  const g = m.geom;
  const pivot = pivotOverride || markLocalCenter(m);
  const rot = m.rot || 0;
  const color = m.color || '#1a1a1a';
  const weightPx = Math.max((m.weight || 1) * ftPerPx * geo.pxPerFt, 0.5);

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
    const fillGeom = fillGeometryForSketchMark(m);
    if (fillGeom && (fillGeom.lines.length || fillGeom.dots.length)) {
      drawFillGeometryScreen(fillGeom, color, toScreen, weightPx);
    }
    if (m.stroke !== false) {
      const samples = [];
      const n = (window.SketchFill && window.SketchFill.CIRCLE_RING_VERTS) || 48;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        samples.push({
          x: g.cx + g.r * Math.cos(t),
          y: g.cy + g.r * Math.sin(t),
        });
      }
      const screenPts = mapFieldPts(samples, lng, lat, ftPerPx, geo, pivot, rot);
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
  const fillGeom = fillGeometryForSketchMark(m);
  if (fillGeom && (fillGeom.lines.length || fillGeom.dots.length)) {
    drawFillGeometryScreen(fillGeom, color, toScreen, weightPx);
  }
  if (m.stroke !== false) {
    const screenPts = mapFieldPts(g.pts, lng, lat, ftPerPx, geo, pivot, rot);
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
  const placement = resolveNotationLatticePlacement(notations, geo);
  notations.forEach((notation) => {
    if (notation.lat == null || notation.lng == null) return;
    const place = notation.id != null ? placement[String(notation.id)] : null;
    const lng = place ? place.lng : notation.lng;
    const lat = place ? place.lat : notation.lat;
    const anchored = place ? Object.assign({}, notation, { lng: lng, lat: lat }) : notation;

    if (notation.lexiconLinkStatus === 'missing') {
      drawFallbackNotationDot(anchored, geo);
      return;
    }

    const marks = notation.sketch && Array.isArray(notation.sketch.marks)
      ? notation.sketch.marks
      : null;
    if (!marks || !marks.length) {
      drawFallbackNotationDot(anchored, geo);
      return;
    }
    const ftPerPx = place ? place.ftPerPx : markFtPerFieldPx(notation.sketch);
    if (window.SketchFill && window.SketchFill.migrateMarkFills) {
      window.SketchFill.migrateMarkFills(marks);
    }
    marks.forEach((m) => drawSketchMark(m, lng, lat, ftPerPx, geo));
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

  function drawPreviewFill(geom, color, mapPt, weight) {
    if (!geom) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max((weight || 1) * 0.25, 0.75);
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    (geom.lines || []).forEach((seg) => {
      const a = mapPt(seg.x1, seg.y1);
      const b = mapPt(seg.x2, seg.y2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    (geom.dots || []).forEach((d) => {
      const c = mapPt(d.cx, d.cy);
      const edge = mapPt(d.cx + d.r, d.cy);
      const r = Math.max(Math.hypot(edge.x - c.x, edge.y - c.y), 0.5);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
    });
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
      const fillGeom = fillGeometryForSketchMark(m);
      if (fillGeom && (fillGeom.lines.length || fillGeom.dots.length)) {
        drawPreviewFill(fillGeom, color, mapPt, weight);
      }
      if (m.stroke !== false) {
        const n = (window.SketchFill && window.SketchFill.CIRCLE_RING_VERTS) || 48;
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2;
          const p = mapPt(g.cx + g.r * Math.cos(t), g.cy + g.r * Math.sin(t));
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      return;
    }

    if (!Array.isArray(g.pts) || !g.pts.length) return;
    const fillGeom = fillGeometryForSketchMark(m);
    if (fillGeom && (fillGeom.lines.length || fillGeom.dots.length)) {
      drawPreviewFill(fillGeom, color, mapPt, weight);
    }
    if (m.stroke !== false) {
      const pts = g.pts.map((p) => mapPt(p.x, p.y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
    }
  }

  if (window.SketchFill && window.SketchFill.migrateMarkFills) {
    window.SketchFill.migrateMarkFills(marks);
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
  if (!window.__buildingsCenterDrawLogged) {
    window.__buildingsCenterDrawLogged = true;
    console.log('[buildings-center] first draw geometry origin', {
      scoreMode: scoreMode,
      originRx: geo.originRx,
      originRy: geo.originRy,
      panRX: panRX,
      panRY: panRY,
      pxPerFt: geo.pxPerFt,
      // Approximate on-screen shift vs site AABB midpoint (ft → px).
      approxShiftPxFromZero: {
        x: -panRX * geo.pxPerFt,
        y: panRY * geo.pxPerFt,
      },
    });
  }
  const pageModes = scoreMode === 'print' || scoreMode === 'sheet';

  if (pageModes) {
    // Cull + clip to the shared content rect (PAGE_OVERLAP_IN inset), not the full page.
    const mPx = PAGE_OVERLAP_IN * geo.pxPerInch;
    geo.clipMinX = geo.pageX + mPx;
    geo.clipMaxX = geo.pageX + geo.pageW - mPx;
    geo.clipMinY = geo.pageY + mPx;
    geo.clipMaxY = geo.pageY + geo.pageH - mPx;
    drawPageFrame(geo);
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(
      geo.clipMinX,
      geo.clipMinY,
      geo.clipMaxX - geo.clipMinX,
      geo.clipMaxY - geo.clipMinY
    );
    drawingContext.clip();
  }

  drawContours(geo);
  drawBaseLayerMarks(geo);
  // Cover exterior mess (water beyond corridor, empty ocean) after base layers;
  // notations stay on top and anything inside the site AABB remains visible.
  drawSiteExteriorMask(geo);
  drawNotations(geo);

  if (pageModes) {
    drawingContext.restore();
    // Crop marks, caption, and overlap guides live in/on the margin — outside content clip.
    if (scoreMode === 'sheet') {
      drawPrintOverlapGuides(geo);
      drawCropMarks(geo);
      drawSheetCaption(geo);
    }
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

function notationHitRadiusPx(notation, geo, ftPerPxOverride) {
  if (notation.lexiconLinkStatus === 'missing' ||
      !(notation.sketch && Array.isArray(notation.sketch.marks) && notation.sketch.marks.length)) {
    return Math.max(NOTATION_HIT_MIN_PX, FALLBACK_DOT_RADIUS_FT * geo.pxPerFt * 2.5);
  }
  const ftPerPx = ftPerPxOverride != null ? ftPerPxOverride : markFtPerFieldPx(notation.sketch);
  // Field center is the projected anchor; use a fraction of field half-width in screen px.
  const halfFieldPx = (MARK_FIELD_W / 2) * ftPerPx * geo.pxPerFt * 0.45;
  return Math.max(NOTATION_HIT_MIN_PX, Math.min(NOTATION_HIT_MAX_PX, halfFieldPx));
}

/** Hit-test filtered (visible) notations only. Prefers the closest mark within radius. */
function hitTestNotationAt(mx, my) {
  if (!scoreReady) return null;
  const geo = getActiveGeometry();
  const list = getNotationsToDraw();
  const placement = resolveNotationLatticePlacement(list, geo);
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const notation = list[i];
    if (notation.lat == null || notation.lng == null) continue;
    const place = notation.id != null ? placement[String(notation.id)] : null;
    const lng = place ? place.lng : notation.lng;
    const lat = place ? place.lat : notation.lat;
    const p = project(lng, lat, geo);
    const r = notationHitRadiusPx(notation, geo, place ? place.ftPerPx : null);
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
  // Sheet is fixed; View, Grid, and free-pan Print Preview can pan.
  if (scoreMode === 'sheet') return;
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
  if (scoreMode !== 'view' && scoreMode !== 'grid') return false;
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

/** Inkscape-friendly layer group open tag. */
function svgLayerOpen(id, label) {
  const safeId = String(id).replace(/[^A-Za-z0-9._:-]+/g, '-');
  return '<g id="' + safeId + '" inkscape:groupmode="layer" inkscape:label="' +
    svgEscapeText(label || id) + '">';
}

function svgLayerClose() {
  return '</g>';
}

/** Stable subgroup id from parent layer + classification name. */
function svgCategorySubId(parentId, category) {
  return parentId + '--' + String(category).replace(/[^A-Za-z0-9]+/g, '-');
}

// --- Geometric clipping against the page rectangle (plotter-safe; no clip-path) ---

function pointInPageRect(p, rect) {
  const r = rect || getContentRectInches();
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

function outCode(x, y, rect) {
  let code = 0;
  if (x < rect.minX) code |= 1;
  else if (x > rect.maxX) code |= 2;
  if (y < rect.minY) code |= 4;
  else if (y > rect.maxY) code |= 8;
  return code;
}

/** Cohen–Sutherland. Returns clipped segment {x1,y1,x2,y2} or null. */
function clipSegmentToRect(x1, y1, x2, y2, rect) {
  const r = rect || getContentRectInches();
  let code1 = outCode(x1, y1, r);
  let code2 = outCode(x2, y2, r);
  for (;;) {
    if (!(code1 | code2)) return { x1: x1, y1: y1, x2: x2, y2: y2 };
    if (code1 & code2) return null;
    const codeOut = code1 || code2;
    let x = 0;
    let y = 0;
    if (codeOut & 8) {
      x = x1 + (x2 - x1) * (r.maxY - y1) / (y2 - y1);
      y = r.maxY;
    } else if (codeOut & 4) {
      x = x1 + (x2 - x1) * (r.minY - y1) / (y2 - y1);
      y = r.minY;
    } else if (codeOut & 2) {
      y = y1 + (y2 - y1) * (r.maxX - x1) / (x2 - x1);
      x = r.maxX;
    } else {
      y = y1 + (y2 - y1) * (r.minX - x1) / (x2 - x1);
      x = r.minX;
    }
    if (codeOut === code1) {
      x1 = x; y1 = y; code1 = outCode(x1, y1, r);
    } else {
      x2 = x; y2 = y; code2 = outCode(x2, y2, r);
    }
  }
}

/** Clip a polyline into zero or more open polylines inside rect. */
function clipPolylineToRect(pts, rect) {
  const r = rect || getContentRectInches();
  if (!pts || pts.length < 2) return [];
  const out = [];
  let current = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegmentToRect(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r);
    if (!seg) {
      if (current && current.length >= 2) out.push(current);
      current = null;
      continue;
    }
    const a = { x: seg.x1, y: seg.y1 };
    const b = { x: seg.x2, y: seg.y2 };
    if (!current) {
      current = [a, b];
    } else {
      const last = current[current.length - 1];
      if (Math.hypot(last.x - a.x, last.y - a.y) > 1e-9) {
        out.push(current);
        current = [a, b];
      } else {
        current.push(b);
      }
    }
  }
  if (current && current.length >= 2) out.push(current);
  return out;
}

function circleFullyInRect(cx, cy, radius, rect) {
  const r = rect || getContentRectInches();
  return cx - radius >= r.minX && cx + radius <= r.maxX &&
    cy - radius >= r.minY && cy + radius <= r.maxY;
}

function circleOutsideRect(cx, cy, radius, rect) {
  const r = rect || getContentRectInches();
  return cx + radius < r.minX || cx - radius > r.maxX ||
    cy + radius < r.minY || cy - radius > r.maxY;
}

/** Sample a circle as a closed polyline in page inches. */
function sampleCirclePagePts(cx, cy, radius, steps) {
  const n = steps || 48;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) });
  }
  return pts;
}

function emitClippedLineSvg(x1, y1, x2, y2, color, weightIn, rect) {
  const seg = clipSegmentToRect(x1, y1, x2, y2, rect);
  if (!seg) return [];
  return [svgEl('line', {
    x1: svgNum(seg.x1), y1: svgNum(seg.y1),
    x2: svgNum(seg.x2), y2: svgNum(seg.y2),
    stroke: color || '#1a1a1a', 'stroke-width': svgNum(weightIn),
    'stroke-linecap': 'round',
  })];
}

function emitClippedPolylineSvg(pts, color, weightIn, rect) {
  const parts = [];
  clipPolylineToRect(pts, rect).forEach((poly) => {
    const d = svgPathFromPts(poly, false);
    if (d) {
      parts.push(svgEl('path', {
        d: d, fill: 'none', stroke: color || '#1a1a1a',
        'stroke-width': svgNum(weightIn),
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    }
  });
  return parts;
}

/**
 * Emit a circle clipped to the page: intact <circle> if fully inside, else
 * discretized and segment-clipped (no SVG clip-path).
 */
function emitClippedCircleSvg(cx, cy, radius, color, weightIn, filled, rect) {
  const r = rect || getContentRectInches();
  if (circleOutsideRect(cx, cy, radius, r)) return [];
  if (circleFullyInRect(cx, cy, radius, r)) {
    // Always stroke (never fill-only): plotters ignore fill and need stroke geometry.
    // Former "filled" dots become a stroked circle outline at the same radius.
    return [svgEl('circle', {
      cx: svgNum(cx), cy: svgNum(cy), r: svgNum(radius),
      fill: 'none', stroke: color || '#1a1a1a', 'stroke-width': svgNum(weightIn),
    })];
  }
  // Partial: stroke as clipped polyline (no SVG clip-path).
  return emitClippedPolylineSvg(sampleCirclePagePts(cx, cy, radius, 64), color, weightIn, r);
}

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

function appendGeoLineStrings(features, geo, outPaths) {
  features.forEach((f) => {
    if (!f.geometry) return;
    const lines = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    lines.forEach((line) => {
      const pts = ringLngLatToPageInches(line, geo);
      if (pts.length < 2) return;
      clipPolylineToRect(pts, getContentRectInches()).forEach((poly) => {
        const d = svgPathFromPts(poly, false);
        if (d) outPaths.push(svgEl('path', { d: d }));
      });
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
        // Stroked outline (not fill-only) so plotters can trace the mid-dot.
        out.push(svgEl('circle', {
          cx: svgNum(pts[0].x), cy: svgNum(pts[0].y), r: svgNum(r),
          fill: 'none',
          stroke: color || '#1a1a1a',
          'stroke-width': svgNum(strokeW),
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

function captionStringWidthIn(str, heightIn) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const glyph = getCaptionGlyph(str.charAt(i));
    w += (glyph.w || 0.5) * heightIn * 1.08;
  }
  return w;
}

function sheetCaptionText(sheet, scaleDenom) {
  return 'SHEET ' + sheet.label + ' · 1:' + scaleDenom;
}

/**
 * Sheet/SVG caption layout in page inches: stacked below the bottom crop line,
 * horizontally centered on the full page width, vertically in the bottom margin.
 */
function sheetCaptionLayoutInches(sheet, scaleDenom) {
  const caption = sheetCaptionText(sheet, scaleDenom);
  const heightIn = 0.18;
  const gapIn = 0.05; // clear air between crop arm tip and label top
  const m = PAGE_OVERLAP_IN;
  const cropY = PAGE_HEIGHT_IN - m;
  const arm = CROP_MARK_CROSS_IN;
  const widthIn = captionStringWidthIn(caption, heightIn);
  // Vertical center: below crop arm height, keep glyph inside [pageH - m, pageH].
  let startY = cropY + arm + gapIn + heightIn * 0.5;
  const minY = (PAGE_HEIGHT_IN - m) + heightIn * 0.5 + 0.01;
  const maxY = PAGE_HEIGHT_IN - heightIn * 0.5 - 0.02;
  if (startY < minY) startY = minY;
  if (startY > maxY) startY = maxY;
  // Horizontally center on the full page.
  let startX = PAGE_WIDTH_IN * 0.5 - widthIn * 0.5;
  const pad = 0.04;
  if (startX < pad) startX = pad;
  if (startX + widthIn > PAGE_WIDTH_IN - pad) startX = PAGE_WIDTH_IN - pad - widthIn;
  return {
    caption: caption,
    heightIn: heightIn,
    startX: startX,
    startY: startY,
    cropY: cropY,
    widthIn: widthIn,
  };
}

function drawSheetCaption(geo) {
  const sheet = getSelectedSheet();
  if (!sheet || !geo.pxPerInch) return;
  const layout = sheetCaptionLayoutInches(sheet, geo.scaleDenom);
  const px = geo.pxPerInch;
  const heightPx = layout.heightIn * px;
  let x = geo.pageX + layout.startX * px;
  const startY = geo.pageY + layout.startY * px;
  stroke('#1a1a1a');
  strokeWeight(Math.max(heightPx * 0.08, 0.8));
  strokeCap(ROUND);
  strokeJoin(ROUND);
  noFill();
  for (let i = 0; i < layout.caption.length; i++) {
    const glyph = getCaptionGlyph(layout.caption.charAt(i));
    const w = (glyph.w || 0.5) * heightPx;
    (glyph.strokes || []).forEach((seg) => {
      if (!seg.length) return;
      const pts = seg.map((p) => ({
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
 * Page-edge clipping is geometric (Cohen–Sutherland / polyline clip) — not clip-path.
 * clipState = { seq: number } only for optional hatch shape masks (notation fills).
 *
 * Fills: local-generate via SketchFill → rotateFieldPt → page inches (same as Pass 2
 * screen path). Dot fills export as stroked pen circles (fill="none"), not filled discs.
 */
function emitSketchMarkSvg(m, lng, lat, ftPerPx, geo, defs, clipState, options) {
  if (!m || !m.geom) return [];
  const opts = options || {};
  const inchesPerFt = 12 / geo.scaleDenom;
  const g = m.geom;
  const pivot = opts.pivot || markLocalCenter(m);
  const rot = m.rot || 0;
  const color = m.color || '#1a1a1a';
  const weightIn = opts.fixedStrokeIn != null
    ? opts.fixedStrokeIn
    : Math.max((m.weight || 1) * ftPerPx * inchesPerFt * EXPORT_MARK_STROKE_SCALE, 0.006);
  const pageRect = opts.pageRect || getContentRectInches();
  const out = [];
  const fillStrokeIn = Math.max(weightIn * 0.25, 0.006);

  const toPage = (fx, fy) => {
    const r = rotateFieldPt({ x: fx, y: fy }, pivot, rot);
    return fieldPointToPageInches(r.x, r.y, lng, lat, ftPerPx, geo);
  };

  if (m.type === 'dot') {
    const c = toPage(g.cx, g.cy);
    const edge = toPage(g.cx + g.r, g.cy);
    const rPx = Math.hypot(edge.x - c.x, edge.y - c.y);
    const filled = m.fill === 'solid' || m.stroke === false;
    return emitClippedCircleSvg(c.x, c.y, rPx, color, weightIn, filled, pageRect);
  }

  if (m.type === 'line') {
    if (m.stroke === false) return out;
    const a = toPage(g.x1, g.y1);
    const b = toPage(g.x2, g.y2);
    return emitClippedLineSvg(a.x, a.y, b.x, b.y, color, weightIn, pageRect);
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
    return emitClippedPolylineSvg(samples, color, weightIn, pageRect);
  }

  const closedTypes = m.type === 'circle' || m.type === 'triangle'
    || m.type === 'rectangle' || m.type === 'diamond';

  if (closedTypes && window.SketchFill && window.SketchFill.fillGeometryForMark) {
    const fillGeom = window.SketchFill.fillGeometryForMark(m);
    if (fillGeom) {
      (fillGeom.lines || []).forEach((seg) => {
        const a = toPage(seg.x1, seg.y1);
        const b = toPage(seg.x2, seg.y2);
        emitClippedLineSvg(a.x, a.y, b.x, b.y, color, fillStrokeIn, pageRect)
          .forEach((el) => out.push(el));
      });
      // Dot fill: stroked pen circles (plotter-safe), not filled discs.
      (fillGeom.dots || []).forEach((d) => {
        const c = toPage(d.cx, d.cy);
        const edge = toPage(d.cx + d.r, d.cy);
        const rIn = Math.max(Math.hypot(edge.x - c.x, edge.y - c.y), 0.003);
        emitClippedCircleSvg(c.x, c.y, rIn, color, fillStrokeIn, false, pageRect)
          .forEach((el) => out.push(el));
      });
    }
  }

  let pagePts = null;
  if (m.type === 'circle') {
    const samples = [];
    const n = (window.SketchFill && window.SketchFill.CIRCLE_RING_VERTS) || 48;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      samples.push({ x: g.cx + g.r * Math.cos(t), y: g.cy + g.r * Math.sin(t) });
    }
    pagePts = mapFieldPtsToPageInches(samples, lng, lat, ftPerPx, geo, pivot, rot);
  } else if (Array.isArray(g.pts) && g.pts.length) {
    pagePts = mapFieldPtsToPageInches(g.pts, lng, lat, ftPerPx, geo, pivot, rot);
  }
  if (!pagePts || !pagePts.length) return out;

  // Outline after fill migration (solid → none); keep solid guard if SketchFill absent.
  if (m.stroke !== false || m.fill === 'solid') {
    const closed = pagePts.slice();
    if (closed.length > 1) {
      const first = closed[0];
      const last = closed[closed.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-9) closed.push(first);
    }
    emitClippedPolylineSvg(closed, color, weightIn, pageRect).forEach((el) => out.push(el));
  }
  return out;
}

function pushMarkFrags(parts, markDef, color, lng, lat, ftPerPxBase, geo, defs, clipState, emitOpts, scale, rotationDeg) {
  if (!markDef || !Array.isArray(markDef.marks)) return;
  const s = clampFillScale(scale);
  const rotExtra = (clampFillRotation(rotationDeg) * Math.PI) / 180;
  const ftPerPx = ftPerPxBase * s;
  const groupPivot = markDef.pivotMode === 'group' ? markDefGroupPivot(markDef) : null;
  markDef.marks.forEach((m) => {
    const colored = Object.assign({}, m, {
      color: color || m.color || '#1a1a1a',
      weight: BASE_MARK_STROKE_WEIGHT,
      rot: (m.rot || 0) + rotExtra,
    });
    const frags = emitSketchMarkSvg(
      colored, lng, lat, ftPerPx, geo, defs, clipState,
      Object.assign(
        { fixedStrokeIn: MARK_STROKE_IN },
        emitOpts || {},
        groupPivot ? { pivot: groupPivot } : {}
      )
    );
    for (let i = 0; i < frags.length; i++) parts.push(frags[i]);
  });
}

/** Append one category layer with Inkscape sublayers per classification. */
function appendOneBaseLayerSvg(geo, defs, plotParts, layerId, label, fillGroupKey, stampIterator, clipState) {
  const ftPerPx = baseLayerFtPerFieldPx(geo);
  const clips = clipState || { seq: 0 };
  const byCat = {};
  stampIterator((markDef, color, lng, lat, category, scale, rotation) => {
    const cat = category || 'Other';
    if (!byCat[cat]) byCat[cat] = [];
    pushMarkFrags(byCat[cat], markDef, color, lng, lat, ftPerPx, geo, defs, clips, {}, scale, rotation);
  });

  const fills = (window.categoryFills && window.categoryFills[fillGroupKey]) || {};
  const catEnabled = (cat) => normalizeFillEntry(fills[cat]).enabled !== false;

  const present = Object.keys(byCat);
  const defaults = (window.DEFAULT_CATEGORY_MARKS && window.DEFAULT_CATEGORY_MARKS[fillGroupKey]) || {};
  const preferred = Object.keys(defaults);
  // Enabled cats with stamps + known disabled cats (empty groups) so Inkscape structure stays intact.
  const ordered = [];
  preferred.forEach((c) => {
    if (byCat[c] || !catEnabled(c)) ordered.push(c);
  });
  present.filter((c) => preferred.indexOf(c) < 0).sort().forEach((c) => ordered.push(c));
  if (!ordered.length) return;

  plotParts.push(svgLayerOpen(layerId, label));
  ordered.forEach((cat) => {
    plotParts.push(svgLayerOpen(svgCategorySubId(layerId, cat), cat));
    if (byCat[cat] && byCat[cat].length) plotParts.push(byCat[cat].join(''));
    plotParts.push(svgLayerClose());
  });
  plotParts.push(svgLayerClose());
}

function appendBaseLayerMarksSvg(geo, defs, plotParts, layerOpts, clipState) {
  const opts = layerOpts || {};
  const streets = opts.streets != null ? opts.streets : scoreLayers.streets;
  const buildings = opts.buildings != null ? opts.buildings : scoreLayers.buildings;
  const vegetation = opts.vegetation != null ? opts.vegetation : scoreLayers.vegetation;
  const vegetationDensity = opts.vegetationDensity != null
    ? opts.vegetationDensity
    : scoreLayers.vegetationDensity;
  const waterEcologies = opts.waterEcologies != null ? opts.waterEcologies : scoreLayers.waterEcologies;
  const waterColour = opts.waterColour != null ? opts.waterColour : scoreLayers.waterColour;

  if (state.layers.waterEcologies) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'waterEcologies', 'water ecologies', 'waterEcologies', (cb) => {
      forEachCategorizedMarkStamp(geo, waterEcologies, 'Layer', 'waterEcologies', cb, null);
    }, clipState);
  }
  if (state.layers.waterColour) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'waterColour', 'water colour', 'waterColour', (cb) => {
      forEachCategorizedMarkStamp(geo, waterColour, 'Layer', 'waterColour', cb, null);
    }, clipState);
  }
  if (state.layers.vegetationDensity) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'vegetationDensity', 'vegetation density', 'vegetationDensity', (cb) => {
      forEachCategorizedMarkStamp(geo, vegetationDensity, 'DensityClass', 'vegetationDensity', cb, null);
    }, clipState);
  }
  if (state.layers.vegetation) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'vegetation', 'vegetation', 'vegetation', (cb) => {
      forEachCategorizedMarkStamp(geo, vegetation, 'LIFEFORM', 'vegetation', cb, null);
    }, clipState);
  }
  if (state.layers.streets) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'streets', 'streets', 'streets', (cb) => {
      forEachStreetMarkStamp(geo, streets, cb);
    }, clipState);
  }
  if (state.layers.buildings) {
    appendOneBaseLayerSvg(geo, defs, plotParts, 'buildings', 'buildings', 'buildings', (cb) => {
      forEachCategorizedMarkStamp(geo, buildings, 'PropType', 'buildings', cb, null);
    }, clipState);
  }
}

function appendNotationMarksSvg(geo, defs, plotParts, sheet, bufferFt, clipState) {
  // Resolve against the full visible set (same as screen) so nudge order/occupancy
  // matches drawNotations; then cull to this sheet using snapped anchors.
  const allNotations = getNotationsToDraw();
  const placement = resolveNotationLatticePlacement(allNotations, geo);
  const notations = allNotations.filter((n) => {
    if (n.lat == null || n.lng == null) return false;
    const place = n.id != null ? placement[String(n.id)] : null;
    const forSheet = place
      ? Object.assign({}, n, { lng: place.lng, lat: place.lat })
      : n;
    return notationIntersectsSheet(forSheet, sheet, bufferFt);
  });
  const inchesPerFt = 12 / geo.scaleDenom;
  const clips = clipState || { seq: 0 };
  const parts = [];
  notations.forEach((notation) => {
    if (notation.lat == null || notation.lng == null) return;
    const place = notation.id != null ? placement[String(notation.id)] : null;
    const lng = place ? place.lng : notation.lng;
    const lat = place ? place.lat : notation.lat;
    const ftPerPx = place ? place.ftPerPx : markFtPerFieldPx(notation.sketch);

    if (notation.lexiconLinkStatus === 'missing') {
      const p = projectLngLatToPageInches(lng, lat, geo);
      const r = Math.max(FALLBACK_DOT_RADIUS_FT * inchesPerFt, 0.02);
      emitClippedCircleSvg(p.x, p.y, r, '#1a1a1a', EXPORT_STROKE_IN * 1.5, false, getContentRectInches())
        .forEach((el) => parts.push(el));
      const arm = r * 0.55;
      emitClippedLineSvg(p.x - arm, p.y - arm, p.x + arm, p.y + arm, '#1a1a1a', EXPORT_STROKE_IN, getContentRectInches())
        .forEach((el) => parts.push(el));
      emitClippedLineSvg(p.x + arm, p.y - arm, p.x - arm, p.y + arm, '#1a1a1a', EXPORT_STROKE_IN, getContentRectInches())
        .forEach((el) => parts.push(el));
      return;
    }

    const marks = notation.sketch && Array.isArray(notation.sketch.marks)
      ? notation.sketch.marks
      : null;
    if (!marks || !marks.length) {
      const p = projectLngLatToPageInches(lng, lat, geo);
      const r = Math.max(FALLBACK_DOT_RADIUS_FT * inchesPerFt, 0.02);
      emitClippedCircleSvg(p.x, p.y, r, '#1a1a1a', EXPORT_STROKE_IN, false, getContentRectInches())
        .forEach((el) => parts.push(el));
      return;
    }

    if (window.SketchFill && window.SketchFill.migrateMarkFills) {
      window.SketchFill.migrateMarkFills(marks);
    }
    marks.forEach((m) => {
      const frags = emitSketchMarkSvg(m, lng, lat, ftPerPx, geo, defs, clips, {});
      for (let i = 0; i < frags.length; i++) parts.push(frags[i]);
    });
  });
  if (parts.length) {
    plotParts.push(svgLayerOpen('marks', 'notation marks'));
    plotParts.push(parts.join(''));
    plotParts.push(svgLayerClose());
  }
}

function cropMarkCentersInches() {
  const r = getContentRectInches();
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}

function appendCropMarksSvg(plotParts) {
  const parts = [];
  const r = CROP_MARK_RADIUS_IN;
  const arm = CROP_MARK_CROSS_IN;
  const sw = CROP_MARK_STROKE_IN;
  cropMarkCentersInches().forEach((c) => {
    parts.push(svgEl('circle', {
      cx: svgNum(c.x), cy: svgNum(c.y), r: svgNum(r),
      fill: 'none', stroke: '#1a1a1a', 'stroke-width': svgNum(sw),
    }));
    parts.push(svgEl('line', {
      x1: svgNum(c.x - arm), y1: svgNum(c.y),
      x2: svgNum(c.x + arm), y2: svgNum(c.y),
      stroke: '#1a1a1a', 'stroke-width': svgNum(sw), 'stroke-linecap': 'round',
    }));
    parts.push(svgEl('line', {
      x1: svgNum(c.x), y1: svgNum(c.y - arm),
      x2: svgNum(c.x), y2: svgNum(c.y + arm),
      stroke: '#1a1a1a', 'stroke-width': svgNum(sw), 'stroke-linecap': 'round',
    }));
  });
  plotParts.push(svgLayerOpen('crop-marks', 'crop marks'));
  plotParts.push(parts.join(''));
  plotParts.push(svgLayerClose());
}

/** Screen-space crop marks in Sheet mode (same page inset as export). */
function drawCropMarks(geo) {
  if (!geo || !geo.pxPerInch) return;
  const px = geo.pxPerInch;
  const r = CROP_MARK_RADIUS_IN * px;
  const arm = CROP_MARK_CROSS_IN * px;
  stroke('#1a1a1a');
  strokeWeight(Math.max(CROP_MARK_STROKE_IN * px, 0.8));
  noFill();
  cropMarkCentersInches().forEach((c) => {
    const sx = geo.pageX + c.x * px;
    const sy = geo.pageY + c.y * px;
    circle(sx, sy, r * 2);
    line(sx - arm, sy, sx + arm, sy);
    line(sx, sy - arm, sx, sy + arm);
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
  syncPaperSizeFromUI();
  const geo = getSheetGeometry();
  // Cull stamps to the shared content rect (PAGE_OVERLAP_IN inset), matching Sheet on-screen clip.
  const mPx = PAGE_OVERLAP_IN * geo.pxPerInch;
  geo.clipMinX = geo.pageX + mPx;
  geo.clipMaxX = geo.pageX + geo.pageW - mPx;
  geo.clipMinY = geo.pageY + mPx;
  geo.clipMaxY = geo.pageY + geo.pageH - mPx;
  logExportCoordCheck(geo, sheet);

  // Only write features that intersect this sheet (overlap strip as buffer).
  const sheetBufferFt = PAGE_OVERLAP_IN * (geo.scaleDenom / 12);
  const streetsF = filterFeaturesToSheet(scoreLayers.streets, sheet, sheetBufferFt);
  const buildingsF = filterFeaturesToSheet(scoreLayers.buildings, sheet, sheetBufferFt);
  const vegetationF = filterFeaturesToSheet(scoreLayers.vegetation, sheet, sheetBufferFt);
  const vegetationDensityF = filterFeaturesToSheet(scoreLayers.vegetationDensity, sheet, sheetBufferFt);
  const waterEcologiesF = filterFeaturesToSheet(scoreLayers.waterEcologies, sheet, sheetBufferFt);
  const waterColourF = filterFeaturesToSheet(scoreLayers.waterColour, sheet, sheetBufferFt);
  const contoursF = filterFeaturesToSheet(scoreLayers.contours, sheet, sheetBufferFt);

  const defs = [];
  const plotParts = [];
  const exportClipState = { seq: 0 };

  if (includeGeom) {
    if (typeof state !== 'undefined' && state.layers && state.layers.contours && contoursF.length) {
      const contourPaths = [];
      appendGeoLineStrings(contoursF, geo, contourPaths);
      if (contourPaths.length) {
        plotParts.push(
          '<g id="contours" inkscape:groupmode="layer" inkscape:label="contours" ' +
          'fill="none" stroke="#1a1a1a" stroke-width="' + svgNum(EXPORT_STROKE_IN * 0.6) + '">'
        );
        plotParts.push(contourPaths.join(''));
        plotParts.push(svgLayerClose());
      }
    }

    appendBaseLayerMarksSvg(geo, defs, plotParts, {
      streets: streetsF,
      buildings: buildingsF,
      vegetation: vegetationF,
      vegetationDensity: vegetationDensityF,
      waterEcologies: waterEcologiesF,
      waterColour: waterColourF,
      drawOutlines: false,
    }, exportClipState);
    // Same world-space crop as on-screen View/Sheet.
    appendSiteExteriorMaskSvg(geo, plotParts);
  }

  if (includeMarks) {
    appendNotationMarksSvg(geo, defs, plotParts, sheet, sheetBufferFt, exportClipState);
  }

  appendCropMarksSvg(plotParts);

  const layout = sheetCaptionLayoutInches(sheet, geo.scaleDenom);
  const labels = captionStringPathsAt(
    layout.caption, layout.startX, layout.startY, layout.heightIn, '#1a1a1a'
  );

  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
    'width="' + PAGE_WIDTH_IN + 'in" height="' + PAGE_HEIGHT_IN + 'in" ' +
    'viewBox="0 0 ' + PAGE_WIDTH_IN + ' ' + PAGE_HEIGHT_IN + '">\n' +
    (defs.length ? '<defs>\n' + defs.join('\n') + '\n</defs>\n' : '') +
    plotParts.join('\n') + '\n' +
    svgLayerOpen('labels', 'caption') + '\n' +
    labels.join('\n') + '\n' +
    svgLayerClose() + '\n' +
    '</svg>\n';

  // Diagnose path coordinate ranges and confirm no <text> / no clip-path on plot.
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
  const clipPathCount = (svg.match(/clip-path=/g) || []).length;
  console.log('[export svg] filter counts', {
    sheet: sheet.label,
    bufferFt: sheetBufferFt,
    streets: streetsF.length + '/' + scoreLayers.streets.length,
    buildings: buildingsF.length + '/' + scoreLayers.buildings.length,
    vegetation: vegetationF.length + '/' + scoreLayers.vegetation.length,
    vegetationDensity: vegetationDensityF.length + '/' + scoreLayers.vegetationDensity.length,
    waterEcologies: waterEcologiesF.length + '/' + scoreLayers.waterEcologies.length,
    waterColour: waterColourF.length + '/' + scoreLayers.waterColour.length,
    contours: contoursF.length + '/' + scoreLayers.contours.length,
    textElements: textCount,
    clipPathAttrs: clipPathCount,
    markSizeMm: MARK_SIZE_MM,
    markGridMm: MARK_GRID_MM,
  });
  if (pathVals.length) {
    let minV = pathVals[0];
    let maxV = pathVals[0];
    for (let i = 1; i < pathVals.length; i++) {
      const v = pathVals[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    console.log('[export svg] path coord range', {
      min: minV,
      max: maxV,
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
