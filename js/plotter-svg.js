/**
 * Shared plotter-safe SVG helpers: monoline caption glyphs, crop marks,
 * and field-local sketch.marks → SVG (no map/geo anchor required).
 */
(function (global) {
  'use strict';

  const MM_PER_IN = 25.4;
  const FIELD_W = 600;
  const FIELD_H = 800;

  const CROP_MARK_RADIUS_MM = 1.5;
  const CROP_MARK_CROSS_MM = 2.5;
  const CROP_MARK_RADIUS_IN = CROP_MARK_RADIUS_MM / MM_PER_IN;
  const CROP_MARK_CROSS_IN = CROP_MARK_CROSS_MM / MM_PER_IN;
  const CROP_MARK_STROKE_IN = 0.2 / MM_PER_IN;

  /** Built-in monoline caption glyphs (unit em height 1). */
  const CAPTION_GLYPHS = {
    ' ': { w: 0.45, strokes: [] },
    ':': { w: 0.35, strokes: [[[0.15, 0.25]], [[0.15, 0.7]]] },
    '·': { w: 0.4, strokes: [[[0.18, 0.5]]] },
    '•': { w: 0.4, strokes: [[[0.18, 0.5]]] },
    '-': { w: 0.5, strokes: [[[0.08, 0.5], [0.42, 0.5]]] },
    '–': { w: 0.5, strokes: [[[0.08, 0.5], [0.42, 0.5]]] },
    '—': { w: 0.6, strokes: [[[0.05, 0.5], [0.55, 0.5]]] },
    "'": { w: 0.28, strokes: [[[0.12, 0.12], [0.12, 0.35], [0.06, 0.42]]] },
    '\u2019': { w: 0.28, strokes: [[[0.12, 0.12], [0.12, 0.35], [0.06, 0.42]]] },
    ',': { w: 0.28, strokes: [[[0.14, 0.72], [0.14, 0.88], [0.06, 0.98]]] },
    '/': { w: 0.45, strokes: [[[0.35, 0.12], [0.1, 0.88]]] },
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

  function svgNum(n) {
    return (Math.round(n * 10000) / 10000).toString();
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

  function svgEscapeAttr(t) {
    return String(t)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function polylineToPathD(pts) {
    if (!pts.length) return '';
    let d = 'M ' + svgNum(pts[0].x) + ' ' + svgNum(pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      d += ' L ' + svgNum(pts[i].x) + ' ' + svgNum(pts[i].y);
    }
    return d;
  }

  function getCaptionGlyph(ch) {
    if (CAPTION_GLYPHS[ch]) return CAPTION_GLYPHS[ch];
    const up = ch.toUpperCase();
    if (CAPTION_GLYPHS[up]) return CAPTION_GLYPHS[up];
    return CAPTION_GLYPHS[' '] || { w: 0.4, strokes: [] };
  }

  /** Emit caption string as stroked paths; (startX,startY) is left / vertical center. */
  function captionStringPathsAt(str, startX, startY, heightIn, color) {
    let x = startX;
    const out = [];
    const strokeW = Math.max(heightIn * 0.08, 0.006);
    const ink = color || '#1a1a1a';
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
            fill: 'none',
            stroke: ink,
            'stroke-width': svgNum(strokeW),
          }));
          return;
        }
        const d = polylineToPathD(pts);
        if (d) {
          out.push(svgEl('path', {
            d: d,
            fill: 'none',
            stroke: ink,
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

  /**
   * Build an SVG fragment for caption text fitted into a box (for on-screen cards).
   * align: 'left' | 'center' | 'right'
   */
  function captionSvgMarkup(str, opts) {
    const o = opts || {};
    const text = String(str == null ? '' : str);
    const height = o.height != null ? o.height : 12;
    const color = o.color || '#1a1a1a';
    const align = o.align || 'left';
    const maxWidth = o.maxWidth != null ? o.maxWidth : Infinity;
    let h = height;
    let width = captionStringWidthIn(text, h);
    if (width > maxWidth && width > 0) {
      h = height * (maxWidth / width);
      width = captionStringWidthIn(text, h);
    }
    let startX = 0;
    if (align === 'center') startX = (maxWidth < Infinity ? (maxWidth - width) * 0.5 : 0);
    else if (align === 'right') startX = (maxWidth < Infinity ? maxWidth - width : 0);
    const startY = h * 0.5;
    const vbW = maxWidth < Infinity ? maxWidth : Math.max(width, 1);
    const parts = captionStringPathsAt(text, startX, startY, h, color);
    return {
      markup: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ' +
        'viewBox="0 0 ' + svgNum(vbW) + ' ' + svgNum(h) + '" preserveAspectRatio="xMidYMid meet" ' +
        'aria-hidden="true">' + parts.join('') + '</svg>',
      width: width,
      height: h,
    };
  }

  function createCaptionSvgElement(str, opts) {
    const built = captionSvgMarkup(str, opts);
    const wrap = document.createElement('div');
    wrap.innerHTML = built.markup;
    const el = wrap.firstChild;
    return el;
  }

  function contentRectInches(pageW, pageH, margin) {
    const m = margin != null ? margin : 0.5;
    return { minX: m, minY: m, maxX: pageW - m, maxY: pageH - m };
  }

  function cropMarkCenters(pageW, pageH, margin) {
    const r = contentRectInches(pageW, pageH, margin);
    return [
      { x: r.minX, y: r.minY },
      { x: r.maxX, y: r.minY },
      { x: r.maxX, y: r.maxY },
      { x: r.minX, y: r.maxY },
    ];
  }

  function cropMarksSvgParts(pageW, pageH, margin) {
    const parts = [];
    const rad = CROP_MARK_RADIUS_IN;
    const arm = CROP_MARK_CROSS_IN;
    const sw = CROP_MARK_STROKE_IN;
    cropMarkCenters(pageW, pageH, margin).forEach((c) => {
      parts.push(svgEl('circle', {
        cx: svgNum(c.x), cy: svgNum(c.y), r: svgNum(rad),
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
    return parts;
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
    return { x: FIELD_W / 2, y: FIELD_H / 2 };
  }

  function rotateFieldPt(p, c, rot) {
    if (!rot) return { x: p.x, y: p.y };
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  }

  function semiArcAngles(orient) {
    const o = orient || 0;
    if (o === 1) return { start: Math.PI / 2, end: -Math.PI / 2, ccw: true };
    if (o === 2) return { start: 0, end: Math.PI, ccw: false };
    if (o === 3) return { start: -Math.PI / 2, end: Math.PI / 2, ccw: false };
    return { start: Math.PI, end: 0, ccw: true };
  }

  function sketchBoxFromPts(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((p) => {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function sketchLocalBounds(m) {
    const g = m.geom || {};
    if (m.type === 'line') return sketchBoxFromPts([{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }]);
    if (m.type === 'circle' || m.type === 'dot') {
      return { x: g.cx - g.r, y: g.cy - g.r, w: g.r * 2, h: g.r * 2 };
    }
    if (m.type === 'semicircle') {
      const r = g.r;
      if (g.orient === 1) return { x: g.cx - r, y: g.cy - r, w: r, h: r * 2 };
      if (g.orient === 2) return { x: g.cx - r, y: g.cy, w: r * 2, h: r };
      if (g.orient === 3) return { x: g.cx, y: g.cy - r, w: r, h: r * 2 };
      return { x: g.cx - r, y: g.cy - r, w: r * 2, h: r };
    }
    return sketchBoxFromPts(g.pts || [{ x: 0, y: 0 }]);
  }

  function sketchBounds(m) {
    const b = sketchLocalBounds(m);
    const rot = m.rot || 0;
    if (!rot) return b;
    const c = markLocalCenter(m);
    const pts = [
      { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
    ].map((p) => rotateFieldPt(p, c, rot));
    return sketchBoxFromPts(pts);
  }

  function unionMarkBounds(marks) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (marks || []).forEach((m) => {
      const b = sketchBounds(m);
      const pad = (m.weight || 0) / 2 + 2;
      x0 = Math.min(x0, b.x - pad);
      y0 = Math.min(y0, b.y - pad);
      x1 = Math.max(x1, b.x + b.w + pad);
      y1 = Math.max(y1, b.y + b.h + pad);
    });
    if (!isFinite(x0)) return { x: 0, y: 0, w: FIELD_W, h: FIELD_H };
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /** Map field coords into targetRect, fitting union bounds with padding. */
  function makeFieldToRectMapper(bounds, targetRect, padFrac) {
    const pad = padFrac != null ? padFrac : 0.08;
    const tw = targetRect.maxX - targetRect.minX;
    const th = targetRect.maxY - targetRect.minY;
    const side = Math.max(bounds.w, bounds.h, 1);
    const usable = Math.min(tw, th) * (1 - pad * 2);
    const scale = usable / side;
    const drawW = bounds.w * scale;
    const drawH = bounds.h * scale;
    const ox = targetRect.minX + (tw - drawW) / 2;
    const oy = targetRect.minY + (th - drawH) / 2;
    return function toTarget(fx, fy) {
      return {
        x: ox + (fx - bounds.x) * scale,
        y: oy + (fy - bounds.y) * scale,
      };
    };
  }

  function emitLine(out, a, b, color, weight) {
    out.push(svgEl('line', {
      x1: svgNum(a.x), y1: svgNum(a.y),
      x2: svgNum(b.x), y2: svgNum(b.y),
      stroke: color, 'stroke-width': svgNum(weight),
      fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }

  function emitPolyline(out, pts, color, weight, close) {
    if (!pts || pts.length < 2) return;
    const closed = pts.slice();
    if (close && closed.length > 1) {
      const first = closed[0];
      const last = closed[closed.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-9) closed.push(first);
    }
    const d = polylineToPathD(closed);
    if (!d) return;
    out.push(svgEl('path', {
      d: d,
      fill: 'none',
      stroke: color,
      'stroke-width': svgNum(weight),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
  }

  function emitCircle(out, c, r, color, weight, filled) {
    out.push(svgEl('circle', {
      cx: svgNum(c.x), cy: svgNum(c.y), r: svgNum(Math.max(r, 0.001)),
      fill: filled ? color : 'none',
      stroke: color,
      'stroke-width': svgNum(weight),
    }));
  }

  /**
   * Emit one sketch mark into target space via toTarget(fx,fy).
   * options: { omitHatch, strokeScale, minStroke }
   */
  function emitSketchMarkLocal(m, toTarget, options) {
    if (!m || !m.geom) return [];
    const opts = options || {};
    const g = m.geom;
    const pivot = opts.pivot || markLocalCenter(m);
    const rot = m.rot || 0;
    const color = m.color || '#1a1a1a';
    const strokeScale = opts.strokeScale != null ? opts.strokeScale : 1;
    const minStroke = opts.minStroke != null ? opts.minStroke : 0.006;
    const weight = Math.max((m.weight || 1) * strokeScale, minStroke);
    const fillStroke = Math.max(weight * 0.25, minStroke);
    const out = [];

    const map = (fx, fy) => {
      const r = rotateFieldPt({ x: fx, y: fy }, pivot, rot);
      return toTarget(r.x, r.y);
    };

    if (m.type === 'dot') {
      const c = map(g.cx, g.cy);
      const edge = map(g.cx + g.r, g.cy);
      const r = Math.hypot(edge.x - c.x, edge.y - c.y);
      const filled = m.fill === 'solid' || m.stroke === false;
      emitCircle(out, c, r, color, weight, filled);
      return out;
    }

    if (m.type === 'line') {
      if (m.stroke === false) return out;
      emitLine(out, map(g.x1, g.y1), map(g.x2, g.y2), color, weight);
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
        samples.push(map(g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)));
      }
      emitPolyline(out, samples, color, weight, false);
      return out;
    }

    const closedTypes = m.type === 'circle' || m.type === 'triangle'
      || m.type === 'rectangle' || m.type === 'diamond';

    if (closedTypes && !opts.omitHatch && global.SketchFill && global.SketchFill.fillGeometryForMark) {
      const fillGeom = global.SketchFill.fillGeometryForMark(m);
      if (fillGeom) {
        (fillGeom.lines || []).forEach((seg) => {
          emitLine(out, map(seg.x1, seg.y1), map(seg.x2, seg.y2), color, fillStroke);
        });
        (fillGeom.dots || []).forEach((d) => {
          const c = map(d.cx, d.cy);
          const edge = map(d.cx + d.r, d.cy);
          const rIn = Math.max(Math.hypot(edge.x - c.x, edge.y - c.y), minStroke * 0.5);
          emitCircle(out, c, rIn, color, fillStroke, false);
        });
      }
    }

    let fieldPts = null;
    if (m.type === 'circle') {
      const samples = [];
      const n = (global.SketchFill && global.SketchFill.CIRCLE_RING_VERTS) || 48;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        samples.push({ x: g.cx + g.r * Math.cos(t), y: g.cy + g.r * Math.sin(t) });
      }
      fieldPts = samples;
    } else if (Array.isArray(g.pts) && g.pts.length) {
      fieldPts = g.pts;
    }
    if (!fieldPts || !fieldPts.length) return out;

    if (m.stroke !== false || m.fill === 'solid') {
      emitPolyline(out, fieldPts.map((p) => map(p.x, p.y)), color, weight, true);
    }
    return out;
  }

  /**
   * Build SVG fragment string for a composed sketch fitted into targetRect.
   * options: {
   *   targetRect: {minX,minY,maxX,maxY},
   *   omitHatch: boolean (on-screen simplification),
   *   strokeScale: number (field weight → target units),
   *   minStroke: number,
   *   padFrac: number
   * }
   */
  function emitSketchMarksInRect(marks, options) {
    const opts = options || {};
    const list = Array.isArray(marks) ? marks : [];
    if (!list.length) return [];
    if (global.SketchFill && global.SketchFill.migrateMarkFills) {
      global.SketchFill.migrateMarkFills(list);
    }
    const bounds = unionMarkBounds(list);
    const target = opts.targetRect || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const toTarget = makeFieldToRectMapper(bounds, target, opts.padFrac);
    const tw = target.maxX - target.minX;
    const strokeScale = opts.strokeScale != null
      ? opts.strokeScale
      : (Math.min(tw, target.maxY - target.minY) / Math.max(bounds.w, bounds.h, 1));
    const emitOpts = {
      omitHatch: !!opts.omitHatch,
      strokeScale: strokeScale,
      minStroke: opts.minStroke != null ? opts.minStroke : Math.max(tw * 0.0015, 0.004),
    };
    const out = [];
    list.forEach((m) => {
      emitSketchMarkLocal(m, toTarget, emitOpts).forEach((el) => out.push(el));
    });
    return out;
  }

  /**
   * Create a standalone <svg> DOM element for on-screen tile/preview use.
   * Uses a stable unit viewBox so CSS sizing can scale without rebuilding paths.
   */
  function createSketchSvgElement(marks, options) {
    const opts = options || {};
    const vb = opts.viewSize != null ? opts.viewSize : 100;
    const omitHatch = opts.omitHatch !== false; // default simplify on-screen when dense
    const forceHatch = opts.forceHatch === true;
    const list = Array.isArray(marks) ? marks : [];

    let useOmit = forceHatch ? false : omitHatch;
    // Auto: omit hatch when many fill segments likely (closed filled shapes).
    if (!forceHatch && opts.autoSimplifyHatch !== false) {
      let hatchy = 0;
      list.forEach((m) => {
        if (m && m.fill && m.fill !== 'none' && m.fill !== 'solid') hatchy += 1;
      });
      if (hatchy === 0) useOmit = false;
    }

    const parts = emitSketchMarksInRect(list, {
      targetRect: { minX: 0, minY: 0, maxX: vb, maxY: vb },
      omitHatch: useOmit,
      padFrac: opts.padFrac != null ? opts.padFrac : 0.08,
      minStroke: opts.minStroke != null ? opts.minStroke : vb * 0.008,
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', '0 0 ' + vb + ' ' + vb);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-hidden', 'true');
    if (!parts.length) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(vb / 2));
      c.setAttribute('cy', String(vb / 2));
      c.setAttribute('r', String(vb * 0.06));
      c.setAttribute('fill', '#2a6049');
      c.setAttribute('stroke', 'none');
      svg.appendChild(c);
      return svg;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + parts.join('') + '</svg>';
    const tmp = wrap.firstChild;
    while (tmp.firstChild) svg.appendChild(tmp.firstChild);
    return svg;
  }

  function slugify(text) {
    return String(text || 'untitled')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'untitled';
  }

  function downloadSvgString(svg, filename) {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * Build a 6×6in lexicon card SVG string.
   * card: { author, lexicon, initials, metaTags[], typology, element, marks[] }
   * Description is intentionally not included.
   */
  function buildLexiconCardSvgString(card) {
    const pageW = 6;
    const pageH = 6;
    const margin = 0.5;
    const content = contentRectInches(pageW, pageH, margin);
    const cw = content.maxX - content.minX; // 5
    const ch = content.maxY - content.minY; // 5
    const ink = '#1a1a1a';
    const dim = '#555555';

    const initials = card.initials || '';
    const metaTags = Array.isArray(card.metaTags) ? card.metaTags : [];
    const title = card.lexicon || 'Untitled';
    const typology = card.typology || '—';
    const element = card.element || '—';
    const marks = card.marks || [];

    const parts = [];

    // Top chrome
    const initialsH = 0.22;
    parts.push.apply(parts, captionStringPathsAt(
      initials,
      content.minX + 0.06,
      content.minY + 0.08 + initialsH * 0.5,
      initialsH,
      ink
    ));

    const tagH = 0.14;
    const tagGap = 0.02;
    metaTags.slice(0, 6).forEach((tag, i) => {
      const line = String(tag || '');
      const w = captionStringWidthIn(line, tagH);
      const y = content.minY + 0.08 + tagH * 0.5 + i * (tagH + tagGap);
      const x = content.maxX - 0.06 - w;
      parts.push.apply(parts, captionStringPathsAt(line, x, y, tagH, dim));
    });

    // Mark zone (~3.2in square, centered in middle band)
    const markSize = 3.2;
    const markTop = content.minY + 0.55;
    const markLeft = content.minX + (cw - markSize) / 2;
    const markRect = {
      minX: markLeft,
      minY: markTop,
      maxX: markLeft + markSize,
      maxY: markTop + markSize,
    };
    parts.push.apply(parts, emitSketchMarksInRect(marks, {
      targetRect: markRect,
      omitHatch: false,
      padFrac: 0.08,
      minStroke: 0.01,
    }));

    // Title / typology / element below mark
    const titleH = 0.3;
    const subH = 0.15;
    const textMaxW = cw - 0.2;
    let titleDrawH = titleH;
    let titleW = captionStringWidthIn(title, titleDrawH);
    if (titleW > textMaxW) {
      titleDrawH = titleH * (textMaxW / titleW);
      titleW = captionStringWidthIn(title, titleDrawH);
    }
    const titleY = markRect.maxY + 0.22 + titleDrawH * 0.5;
    parts.push.apply(parts, captionStringPathsAt(
      title,
      content.minX + (cw - titleW) * 0.5,
      titleY,
      titleDrawH,
      ink
    ));

    function centeredLine(text, y, h, color) {
      let drawH = h;
      let w = captionStringWidthIn(text, drawH);
      if (w > textMaxW) {
        drawH = h * (textMaxW / w);
        w = captionStringWidthIn(text, drawH);
      }
      parts.push.apply(parts, captionStringPathsAt(
        text,
        content.minX + (cw - w) * 0.5,
        y,
        drawH,
        color
      ));
      return drawH;
    }

    centeredLine(typology, titleY + titleDrawH * 0.5 + 0.12 + subH * 0.5, subH, dim);
    centeredLine(element, titleY + titleDrawH * 0.5 + 0.12 + subH + 0.06 + subH * 0.5, subH, dim);

    // Optional bottom-margin caption (outside content, Score-style)
    const capH = 0.12;
    const cap = 'LEXICON · ' + title;
    let capDrawH = capH;
    let capW = captionStringWidthIn(cap, capDrawH);
    const capMax = pageW - 0.16;
    if (capW > capMax) {
      capDrawH = capH * (capMax / capW);
      capW = captionStringWidthIn(cap, capDrawH);
    }
    const capY = pageH - margin * 0.5;
    parts.push.apply(parts, captionStringPathsAt(
      cap,
      (pageW - capW) * 0.5,
      capY,
      capDrawH,
      ink
    ));

    const cropParts = cropMarksSvgParts(pageW, pageH, margin);

    const authorSlug = slugify(card.author);
    const lexiconSlug = slugify(card.lexicon);
    const filename = 'lexicon-card-' + authorSlug + '-' + lexiconSlug + '.svg';

    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
      'width="' + pageW + 'in" height="' + pageH + 'in" ' +
      'viewBox="0 0 ' + pageW + ' ' + pageH + '">\n' +
      '<g id="card" inkscape:groupmode="layer" inkscape:label="card">\n' +
      parts.join('\n') + '\n' +
      '</g>\n' +
      '<g id="crop-marks" inkscape:groupmode="layer" inkscape:label="crop marks">\n' +
      cropParts.join('\n') + '\n' +
      '</g>\n' +
      '</svg>\n';

    return { svg: svg, filename: filename };
  }

  global.PlotterSvg = {
    MM_PER_IN: MM_PER_IN,
    FIELD_W: FIELD_W,
    FIELD_H: FIELD_H,
    CROP_MARK_RADIUS_IN: CROP_MARK_RADIUS_IN,
    CROP_MARK_CROSS_IN: CROP_MARK_CROSS_IN,
    CROP_MARK_STROKE_IN: CROP_MARK_STROKE_IN,
    CAPTION_GLYPHS: CAPTION_GLYPHS,
    svgNum: svgNum,
    svgEl: svgEl,
    svgEscapeAttr: svgEscapeAttr,
    getCaptionGlyph: getCaptionGlyph,
    captionStringPathsAt: captionStringPathsAt,
    captionStringWidthIn: captionStringWidthIn,
    captionSvgMarkup: captionSvgMarkup,
    createCaptionSvgElement: createCaptionSvgElement,
    contentRectInches: contentRectInches,
    cropMarkCenters: cropMarkCenters,
    cropMarksSvgParts: cropMarksSvgParts,
    markLocalCenter: markLocalCenter,
    rotateFieldPt: rotateFieldPt,
    unionMarkBounds: unionMarkBounds,
    emitSketchMarkLocal: emitSketchMarkLocal,
    emitSketchMarksInRect: emitSketchMarksInRect,
    createSketchSvgElement: createSketchSvgElement,
    buildLexiconCardSvgString: buildLexiconCardSvgString,
    slugify: slugify,
    downloadSvgString: downloadSvgString,
  };
})(typeof window !== 'undefined' ? window : globalThis);
