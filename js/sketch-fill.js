/**
 * Shared sketch fill geometry (Line / Dot / None).
 *
 * Returns real clipped vector geometry in the same coordinate space as the
 * input ring (typically mark field space). Builder, Score, Overview, Location
 * Input, and SVG export should all consume this — not canvas clip tricks.
 *
 * Density spacing matches MARK_GRID_MM (5mm) via the same field-unit mapping
 * used by base-layer marks: BASE_MARK_FIELD_SPAN (30) = MARK_SIZE_MM (5mm),
 * so 1mm → 6 field units. tight/medium/loose = 2.5 / 5 / 10 mm → 15 / 30 / 60.
 *
 * Load before sketch-composer.js (and later before collective-p5 consumers).
 */
(function (global) {
  'use strict';

  var FILL_TYPES = ['line', 'dot', 'none'];
  var FILL_ANGLES = [0, 45, 90, 135];
  var FILL_DENSITIES = ['tight', 'medium', 'loose'];

  /** Field units per mm — aligned with BASE_MARK_FIELD_SPAN / MARK_SIZE_MM. */
  var FIELD_UNITS_PER_MM = 30 / 5;

  var DENSITY_MM = {
    tight: 2.5,
    medium: 5,
    loose: 10,
  };

  function clampFillType(v) {
    return FILL_TYPES.indexOf(v) >= 0 ? v : 'none';
  }

  function clampFillAngle(v) {
    var n = Number(v);
    return FILL_ANGLES.indexOf(n) >= 0 ? n : 0;
  }

  function clampFillDensity(v) {
    return FILL_DENSITIES.indexOf(v) >= 0 ? v : 'medium';
  }

  function densitySpacingField(density) {
    var mm = DENSITY_MM[clampFillDensity(density)] || DENSITY_MM.medium;
    return mm * FIELD_UNITS_PER_MM;
  }

  /**
   * Map legacy fill strings from saved Firestore sketches.
   * Returns { fill, fillAngle, fillDensity }.
   */
  function migrateLegacyFill(fill) {
    if (fill == null || fill === '') {
      return { fill: 'none', fillAngle: 0, fillDensity: 'medium' };
    }
    if (fill === 'line' || fill === 'dot' || fill === 'none') {
      return {
        fill: fill,
        fillAngle: 0,
        fillDensity: 'medium',
      };
    }
    if (fill === 'h') {
      return { fill: 'line', fillAngle: 0, fillDensity: 'medium' };
    }
    if (fill === 'd') {
      return { fill: 'line', fillAngle: 45, fillDensity: 'medium' };
    }
    if (fill === 'cross') {
      // Lossy: keeps horizontal family only.
      return { fill: 'line', fillAngle: 0, fillDensity: 'medium' };
    }
    if (fill === 'dots') {
      return { fill: 'dot', fillAngle: 0, fillDensity: 'medium' };
    }
    // solid and any unrecognized value
    return { fill: 'none', fillAngle: 0, fillDensity: 'medium' };
  }

  function migrateMarkFills(marks) {
    if (!Array.isArray(marks)) return marks;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!m || typeof m !== 'object') continue;
      if (m.fill === 'line' || m.fill === 'dot' || m.fill === 'none') {
        // Preserve stored angle/density when already on the new schema.
        m.fill = clampFillType(m.fill);
        m.fillAngle = clampFillAngle(m.fillAngle);
        m.fillDensity = clampFillDensity(m.fillDensity);
        continue;
      }
      var mig = migrateLegacyFill(m.fill);
      m.fill = mig.fill;
      m.fillAngle = mig.fillAngle;
      m.fillDensity = mig.fillDensity;
    }
    return marks;
  }

  function isLegacyFillValue(fill) {
    if (fill == null || fill === '') return false;
    return fill !== 'line' && fill !== 'dot' && fill !== 'none';
  }

  /** True if a mark still stores a pre–Line/Dot/None fill string. */
  function markNeedsFillMigration(m) {
    return !!(m && isLegacyFillValue(m.fill));
  }

  /**
   * True if the sketch blob (tool defaults and/or marks) still has legacy fills.
   * Entries already on line|dot|none are left alone (no Firestore rewrite).
   */
  function sketchNeedsFillMigration(sketch) {
    if (!sketch || typeof sketch !== 'object') return false;
    if (isLegacyFillValue(sketch.fill)) return true;
    var marks = sketch.marks;
    if (!Array.isArray(marks)) return false;
    for (var i = 0; i < marks.length; i++) {
      if (markNeedsFillMigration(marks[i])) return true;
    }
    return false;
  }

  /**
   * Mutates sketch in place to the new fill schema.
   * @returns {{ sketch: object, changed: boolean }}
   */
  function migrateSketchFills(sketch) {
    if (!sketch || typeof sketch !== 'object') {
      return { sketch: sketch, changed: false };
    }
    var changed = sketchNeedsFillMigration(sketch);
    if (Array.isArray(sketch.marks)) migrateMarkFills(sketch.marks);
    if (isLegacyFillValue(sketch.fill)) {
      var toolMig = migrateLegacyFill(sketch.fill);
      sketch.fill = toolMig.fill;
      sketch.fillAngle = toolMig.fillAngle;
      sketch.fillDensity = toolMig.fillDensity;
    } else if (sketch.fill === 'line' || sketch.fill === 'dot' || sketch.fill === 'none') {
      sketch.fill = clampFillType(sketch.fill);
      sketch.fillAngle = clampFillAngle(sketch.fillAngle);
      sketch.fillDensity = clampFillDensity(sketch.fillDensity);
    }
    return { sketch: sketch, changed: changed };
  }

  function ringBBox(ring) {
    var minX = Infinity;
    var maxX = -Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  function pointInRing(px, py, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i].x;
      var yi = ring[i].y;
      var xj = ring[j].x;
      var yj = ring[j].y;
      var intersect =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-30) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function segIntersectionT(x1, y1, x2, y2, x3, y3, x4, y4) {
    var dxa = x2 - x1;
    var dya = y2 - y1;
    var dxb = x4 - x3;
    var dyb = y4 - y3;
    var den = dxa * dyb - dya * dxb;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((x3 - x1) * dyb - (y3 - y1) * dxb) / den;
    var u = ((x3 - x1) * dya - (y3 - y1) * dxa) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return Math.max(0, Math.min(1, t));
  }

  /**
   * Clip an infinite-ish segment to a simple polygon; returns inside pieces.
   * Works for concave rings via along-line even-odd pairing of crossings.
   */
  function clipLineToRing(x1, y1, x2, y2, ring) {
    var ts = [];
    function pushT(t) {
      if (t == null || t < -1e-9 || t > 1 + 1e-9) return;
      t = Math.max(0, Math.min(1, t));
      for (var i = 0; i < ts.length; i++) {
        if (Math.abs(ts[i] - t) < 1e-8) return;
      }
      ts.push(t);
    }
    if (pointInRing(x1, y1, ring)) pushT(0);
    if (pointInRing(x2, y2, ring)) pushT(1);
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var t = segIntersectionT(
        x1, y1, x2, y2,
        ring[j].x, ring[j].y, ring[i].x, ring[i].y
      );
      pushT(t);
    }
    ts.sort(function (a, b) { return a - b; });
    var out = [];
    for (var k = 0; k < ts.length - 1; k++) {
      var ta = ts[k];
      var tb = ts[k + 1];
      if (tb - ta < 1e-9) continue;
      var tm = (ta + tb) / 2;
      var mx = x1 + (x2 - x1) * tm;
      var my = y1 + (y2 - y1) * tm;
      if (!pointInRing(mx, my, ring)) continue;
      out.push({
        x1: x1 + (x2 - x1) * ta,
        y1: y1 + (y2 - y1) * ta,
        x2: x1 + (x2 - x1) * tb,
        y2: y1 + (y2 - y1) * tb,
      });
    }
    return out;
  }

  function normalizeRing(ring) {
    if (!ring || ring.length < 3) return null;
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (!p) continue;
      out.push({ x: Number(p.x), y: Number(p.y) });
    }
    if (out.length < 3) return null;
    var first = out[0];
    var last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-9) {
      out.push({ x: first.x, y: first.y });
    }
    return out;
  }

  function generateLineFill(ring, angleDeg, spacing) {
    var lines = [];
    var rad = (clampFillAngle(angleDeg) * Math.PI) / 180;
    // Line direction (along hatch strokes) and perpendicular (spacing axis).
    var ux = Math.cos(rad);
    var uy = Math.sin(rad);
    var px = -Math.sin(rad);
    var py = Math.cos(rad);
    var bb = ringBBox(ring);
    var corners = [
      { x: bb.minX, y: bb.minY },
      { x: bb.maxX, y: bb.minY },
      { x: bb.maxX, y: bb.maxY },
      { x: bb.minX, y: bb.maxY },
    ];
    var minPerp = Infinity;
    var maxPerp = -Infinity;
    var minPar = Infinity;
    var maxPar = -Infinity;
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      var pr = c.x * px + c.y * py;
      var pa = c.x * ux + c.y * uy;
      if (pr < minPerp) minPerp = pr;
      if (pr > maxPerp) maxPerp = pr;
      if (pa < minPar) minPar = pa;
      if (pa > maxPar) maxPar = pa;
    }
    var pad = spacing * 2;
    minPerp -= pad;
    maxPerp += pad;
    minPar -= pad;
    maxPar += pad;
    var span = maxPar - minPar;
    // Snap start so lattice is stable across redraws.
    var start = Math.floor(minPerp / spacing) * spacing;
    for (var s = start; s <= maxPerp + 1e-9; s += spacing) {
      var cx = px * s;
      var cy = py * s;
      var x1 = cx + ux * minPar;
      var y1 = cy + uy * minPar;
      var x2 = cx + ux * (minPar + span);
      var y2 = cy + uy * (minPar + span);
      var clipped = clipLineToRing(x1, y1, x2, y2, ring);
      for (var k = 0; k < clipped.length; k++) lines.push(clipped[k]);
    }
    return lines;
  }

  function generateDotFill(ring, spacing) {
    var dots = [];
    var bb = ringBBox(ring);
    var r = Math.max(spacing * 0.12, 1.2);
    var x0 = Math.floor(bb.minX / spacing) * spacing;
    var y0 = Math.floor(bb.minY / spacing) * spacing;
    for (var y = y0; y <= bb.maxY + 1e-9; y += spacing) {
      for (var x = x0; x <= bb.maxX + 1e-9; x += spacing) {
        if (pointInRing(x, y, ring)) {
          dots.push({ cx: x, cy: y, r: r });
        }
      }
    }
    return dots;
  }

  /**
   * @param {Array<{x:number,y:number}>} ring Closed or open ring in field space.
   * @param {{fill?:string, fillAngle?:number, fillDensity?:string}} opts
   * @returns {{ lines: Array<{x1,y1,x2,y2}>, dots: Array<{cx,cy,r}> }}
   */
  function generateFillGeometry(ring, opts) {
    var o = opts || {};
    var fill = clampFillType(o.fill);
    var empty = { lines: [], dots: [] };
    if (fill === 'none') return empty;
    var norm = normalizeRing(ring);
    if (!norm) return empty;
    var spacing = densitySpacingField(o.fillDensity);
    if (o.spacingField != null && Number(o.spacingField) > 0) {
      spacing = Number(o.spacingField);
    }
    if (!(spacing > 0)) return empty;
    if (fill === 'line') {
      return {
        lines: generateLineFill(norm, o.fillAngle, spacing),
        dots: [],
      };
    }
    if (fill === 'dot') {
      return {
        lines: [],
        dots: generateDotFill(norm, spacing),
      };
    }
    return empty;
  }

  /** Shared closed ring for fill (circle = 48 verts). Local / unrotated field space. */
  var CIRCLE_RING_VERTS = 48;

  function closedMarkRing(m) {
    if (!m || !m.geom) return null;
    var g = m.geom;
    if (m.type === 'circle') {
      var pts = [];
      var n = CIRCLE_RING_VERTS;
      for (var i = 0; i <= n; i++) {
        var t = (i / n) * Math.PI * 2;
        pts.push({ x: g.cx + g.r * Math.cos(t), y: g.cy + g.r * Math.sin(t) });
      }
      return pts;
    }
    if (Array.isArray(g.pts) && g.pts.length >= 3) {
      var out = [];
      for (var j = 0; j < g.pts.length; j++) {
        var p = g.pts[j];
        out.push({ x: p.x, y: p.y });
      }
      return out;
    }
    return null;
  }

  /**
   * Migrate legacy fill on the mark if needed, then generate clipped fill geometry
   * in local (unrotated) field space. Surfaces that rotate marks must apply the
   * same rotation they use for strokes (canvas rotate, or rotateFieldPt).
   */
  function fillGeometryForMark(m) {
    var empty = { lines: [], dots: [] };
    if (!m) return empty;
    if (m.fill === 'line' || m.fill === 'dot' || m.fill === 'none') {
      m.fill = clampFillType(m.fill);
      m.fillAngle = clampFillAngle(m.fillAngle);
      m.fillDensity = clampFillDensity(m.fillDensity);
    } else {
      var mig = migrateLegacyFill(m.fill);
      m.fill = mig.fill;
      m.fillAngle = mig.fillAngle;
      m.fillDensity = mig.fillDensity;
    }
    if (m.fill === 'none') return empty;
    var ring = closedMarkRing(m);
    if (!ring) return empty;
    return generateFillGeometry(ring, {
      fill: m.fill,
      fillAngle: m.fillAngle,
      fillDensity: m.fillDensity,
    });
  }

  global.SketchFill = {
    FILL_TYPES: FILL_TYPES,
    FILL_ANGLES: FILL_ANGLES,
    FILL_DENSITIES: FILL_DENSITIES,
    FIELD_UNITS_PER_MM: FIELD_UNITS_PER_MM,
    DENSITY_MM: DENSITY_MM,
    CIRCLE_RING_VERTS: CIRCLE_RING_VERTS,
    clampFillType: clampFillType,
    clampFillAngle: clampFillAngle,
    clampFillDensity: clampFillDensity,
    densitySpacingField: densitySpacingField,
    migrateLegacyFill: migrateLegacyFill,
    migrateMarkFills: migrateMarkFills,
    isLegacyFillValue: isLegacyFillValue,
    markNeedsFillMigration: markNeedsFillMigration,
    sketchNeedsFillMigration: sketchNeedsFillMigration,
    migrateSketchFills: migrateSketchFills,
    generateFillGeometry: generateFillGeometry,
    closedMarkRing: closedMarkRing,
    fillGeometryForMark: fillGeometryForMark,
    pointInRing: pointInRing,
    normalizeRing: normalizeRing,
  };
})(typeof window !== 'undefined' ? window : globalThis);
