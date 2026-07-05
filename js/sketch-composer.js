const FIELD_W = 600;
const FIELD_H = 800;
    const GRID = 100;
    const UNIT = GRID / 2;
    const HANDLE = 8;
    const ROT_HANDLE = 10;
    const HATCH_LINE_STEP = 8;
    const HATCH_DOT_STEP = 10;
    const PALETTE = [
      '#E83A2F', '#F26B1D', '#F5C800', '#2E9E4F', '#1A5BA6', '#7B3FA0',
      '#E8547A', '#00A0C1', '#3D8C2F', '#E8A020', '#1A3A8A', '#C13A2A'
    ];
    const COLORS = ['#000000', '#FFFFFF', ...PALETTE];
    const SHAPES = ['select', 'line', 'semicircle', 'circle', 'triangle', 'rightTriangle', 'rectangle', 'diamond', 'dot'];
    const ICONS = {
      select: '<path d="M6 3 L6 19 L10 15 L13 21 L15 20 L12 14 L17 14 Z"/>',
      line: '<line x1="4" y1="14" x2="20" y2="14"/>',
      semicircle: '<path d="M4 18 A8 8 0 0 1 20 18"/>',
      circle: '<circle cx="12" cy="12" r="8"/>',
      triangle: '<polygon points="12,4 20,20 4,20"/>',
      rightTriangle: '<polyline points="4,20 20,20 4,6 4,20"/>',
      rectangle: '<rect x="4" y="6" width="16" height="12"/>',
      diamond: '<polygon points="12,4 20,12 12,20 4,12"/>',
      dot: '<circle cx="12" cy="12" r="3"/>'
    };
    const FILLS = ['solid', 'h', 'd', 'cross', 'dots', 'none'];
    const CLOSED = new Set(['circle', 'triangle', 'rectangle', 'diamond']);
    const STROKED = new Set(['line', 'semicircle', 'circle', 'triangle', 'rectangle', 'diamond']);
    const SCALE_PRESETS = [1, 5, 10, 50, 100, 500];
    const S = {
      marks: [],
      selected: null,
      tool: 'select',
      color: '#000000',
      weight: 5,
      fill: 'solid',
      lineStyle: 'solid',
      stroke: true,
      scaleFt: 10,
      pointer: null,
      undo: [],
      multi: []
    };

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    // --- geometry ---

    const snap = v => Math.round(v / GRID) * GRID;
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

    function boxFromPts(pts) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach(p => {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      });
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    function inBox(x, y, b, pad = 0) {
      return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
    }

    function bounds(m) {
      const b = localBounds(m);
      const rot = m.rot || 0;
      if (!rot) return b;
      return rotatedBounds(b, center(m), rot);
    }

    function clampToField(m) {
      const b = bounds(m);
      let dx = 0, dy = 0;
      if (b.x < 0) dx = -b.x;
      else if (b.x + b.w > FIELD_W) dx = FIELD_W - (b.x + b.w);
      if (b.y < 0) dy = -b.y;
      else if (b.y + b.h > FIELD_H) dy = FIELD_H - (b.y + b.h);
      if (dx || dy) translateGeom(m.geom, m.type, dx, dy);
    }

    function localBounds(m) {
      const g = m.geom;
      if (m.type === 'line') return boxFromPts([{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }]);
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
      return boxFromPts(g.pts);
    }

    function center(m) {
      const b = localBounds(m);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }

    function rotatePt(p, c, rot) {
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const dx = p.x - c.x, dy = p.y - c.y;
      return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
    }

    function unrotatePt(p, c, rot) {
      return rotatePt(p, c, -rot);
    }

    function rotatedBounds(b, c, rot) {
      const pts = [
        { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }
      ].map(p => rotatePt(p, c, rot));
      return boxFromPts(pts);
    }

    function rotateHandlePos(m) {
      const c = center(m);
      const lb = localBounds(m);
      const dist = Math.max(lb.w, lb.h) * 0.5 + 22;
      const a = (m.rot || 0) - Math.PI / 2;
      return { x: c.x + Math.cos(a) * dist, y: c.y + Math.sin(a) * dist };
    }

    function cloneGeom(g) {
      return JSON.parse(JSON.stringify(g));
    }

    function translateGeom(g, type, dx, dy) {
      if (type === 'line') { g.x1 += dx; g.y1 += dy; g.x2 += dx; g.y2 += dy; }
      else if (type === 'circle' || type === 'dot' || type === 'semicircle') { g.cx += dx; g.cy += dy; }
      else g.pts.forEach(p => { p.x += dx; p.y += dy; });
    }

    function scalePt(p, ax, ay, sx, sy) {
      return { x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy };
    }

    function resizeGeom(orig, type, b0, handle, p) {
      const g = cloneGeom(orig);
      const opp = { tl: 'br', tr: 'bl', br: 'tl', bl: 'tr' };
      const corners = {
        tl: { x: b0.x, y: b0.y },
        tr: { x: b0.x + b0.w, y: b0.y },
        br: { x: b0.x + b0.w, y: b0.y + b0.h },
        bl: { x: b0.x, y: b0.y + b0.h }
      };
      const anchor = corners[opp[handle]];
      const start = corners[handle];
      const sx = Math.abs(start.x - anchor.x) < 1 ? 1 : (p.x - anchor.x) / (start.x - anchor.x);
      const sy = Math.abs(start.y - anchor.y) < 1 ? 1 : (p.y - anchor.y) / (start.y - anchor.y);
      const clamp = v => Math.abs(v) < 0.05 ? 0.05 * Math.sign(v || 1) : v;

      if (type === 'dot') {
        const np = scalePt({ x: g.cx, y: g.cy }, anchor.x, anchor.y, sx, sy);
        g.cx = np.x; g.cy = np.y;
        g.r = Math.max(orig.r * Math.max(Math.abs(sx), Math.abs(sy)), 3);
      } else if (type === 'circle' || type === 'semicircle') {
        const np = scalePt({ x: g.cx, y: g.cy }, anchor.x, anchor.y, sx, sy);
        g.cx = np.x; g.cy = np.y;
        g.r = Math.max(orig.r * Math.max(Math.abs(sx), Math.abs(sy)), 4);
      } else if (type === 'line') {
        g.x1 = scalePt({ x: orig.x1, y: orig.y1 }, anchor.x, anchor.y, clamp(sx), clamp(sy)).x;
        g.y1 = scalePt({ x: orig.x1, y: orig.y1 }, anchor.x, anchor.y, clamp(sx), clamp(sy)).y;
        g.x2 = scalePt({ x: orig.x2, y: orig.y2 }, anchor.x, anchor.y, clamp(sx), clamp(sy)).x;
        g.y2 = scalePt({ x: orig.x2, y: orig.y2 }, anchor.x, anchor.y, clamp(sx), clamp(sy)).y;
      } else {
        g.pts = orig.pts.map(pt => scalePt(pt, anchor.x, anchor.y, clamp(sx), clamp(sy)));
      }
      return g;
    }

    function snapMark(m) {
      const b = localBounds(m);
      const dx = snap(b.x) - b.x;
      const dy = snap(b.y) - b.y;
      translateGeom(m.geom, m.type, dx, dy);
    }

    function makeTriangleGeom(cx, cy, variant = 'equilateral') {
      const s = UNIT;
      if (variant === 'isosceles') {
        const hw = s * 0.38;
        const hh = hw * 4;
        return {
          variant: 'isosceles',
          pts: [
            { x: cx, y: cy - hh / 2 },
            { x: cx + hw, y: cy + hh / 2 },
            { x: cx - hw, y: cy + hh / 2 },
            { x: cx, y: cy - hh / 2 }
          ]
        };
      }
      if (variant === 'right') {
        const w = s * 0.85;
        const h = s * 0.85;
        return {
          variant: 'right',
          pts: [
            { x: cx - w / 2, y: cy + h / 2 },
            { x: cx + w / 2, y: cy + h / 2 },
            { x: cx - w / 2, y: cy - h / 2 },
            { x: cx - w / 2, y: cy + h / 2 }
          ]
        };
      }
      const pts = [];
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / 3;
        pts.push({ x: cx + s * Math.cos(a), y: cy + s * Math.sin(a) });
      }
      pts.push({ ...pts[0] });
      return { variant: 'equilateral', pts };
    }

    function makeGeom(type, x, y) {
      x = snap(x); y = snap(y);
      const s = UNIT;
      if (type === 'line') return { x1: x - s, y1: y, x2: x + s, y2: y };
      if (type === 'circle') return { cx: x, cy: y, r: s };
      if (type === 'dot') return { cx: x, cy: y, r: 10 };
      if (type === 'semicircle') return { cx: x, cy: y, r: s, orient: 0 };
      if (type === 'rectangle') {
        const hw = s, hh = s * 0.72;
        return { pts: rectPts(x, y, hw, hh) };
      }
      if (type === 'diamond') {
        return { pts: [
          { x, y: y - s * 0.72 }, { x: x + s, y }, { x, y: y + s * 0.72 }, { x: x - s, y }, { x, y: y - s * 0.72 }
        ]};
      }
      if (type === 'triangle') return makeTriangleGeom(x, y, 'equilateral');
      if (type === 'rightTriangle') return makeTriangleGeom(x, y, 'right');
      return makeTriangleGeom(x, y, 'equilateral');
    }

    function rectPts(cx, cy, hw, hh) {
      return [
        { x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh },
        { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh },
        { x: cx - hw, y: cy - hh }
      ];
    }

    // --- hit test (bounding box only) ---

    function pickMark(x, y) {
      for (let i = S.marks.length - 1; i >= 0; i--) {
        if (inBox(x, y, bounds(S.marks[i]))) return S.marks[i];
      }
      return null;
    }

    function cornerHandles(m) {
      const lb = localBounds(m);
      const c = center(m);
      const corners = [
        { id: 'tl', x: lb.x, y: lb.y },
        { id: 'tr', x: lb.x + lb.w, y: lb.y },
        { id: 'br', x: lb.x + lb.w, y: lb.y + lb.h },
        { id: 'bl', x: lb.x, y: lb.y + lb.h }
      ];
      if (!m.rot) return corners;
      return corners.map(h => ({ id: h.id, ...rotatePt(h, c, m.rot) }));
    }

    function pickRotateHandle(x, y, m) {
      const rh = rotateHandlePos(m);
      return inBox(x, y, { x: rh.x - HANDLE, y: rh.y - HANDLE, w: HANDLE * 2, h: HANDLE * 2 });
    }

    function pickHandle(x, y, m) {
      for (const h of cornerHandles(m)) {
        if (inBox(x, y, { x: h.x - HANDLE, y: h.y - HANDLE, w: HANDLE * 2, h: HANDLE * 2 })) return h.id;
      }
      return null;
    }

    // --- marks ---

    function markById(id) {
      return S.marks.find(m => m.id === id) || null;
    }

    function pushUndo() {
      S.undo.push(JSON.stringify(S.marks));
      if (S.undo.length > 80) S.undo.shift();
    }

    function addMark(type, x, y) {
      pushUndo();
      const markType = type === 'rightTriangle' ? 'triangle' : type;
      const m = {
        id: uid(),
        type: markType,
        color: S.color,
        weight: S.weight,
        fill: CLOSED.has(markType) ? S.fill : 'none',
        lineStyle: (markType === 'line' || markType === 'semicircle') ? S.lineStyle : 'solid',
        stroke: STROKED.has(markType) ? S.stroke : false,
        rot: 0,
        geom: makeGeom(type, x, y)
      };
      snapMark(m);
      S.marks.push(m);
      S.selected = m.id;
      syncUI();
      draw();
    }

    function deleteSelected() {
      if (S.multi.length > 1) {
        pushUndo();
        S.marks = S.marks.filter(m => !S.multi.includes(m.id));
        S.multi = [];
        S.selected = S.marks.length ? S.marks[S.marks.length - 1].id : null;
        syncUI();
        draw();
        return;
      }
      if (!S.selected) return;
      pushUndo();
      S.marks = S.marks.filter(m => m.id !== S.selected);
      S.selected = S.marks.length ? S.marks[S.marks.length - 1].id : null;
      syncUI();
      draw();
    }

    function undo() {
      if (!S.undo.length) return;
      S.marks = JSON.parse(S.undo.pop());
      S.selected = S.marks.length ? S.marks[S.marks.length - 1].id : null;
      syncUI();
      draw();
    }

    // --- pointer ---

    function canvasPos(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width * FIELD_W,
        y: (e.clientY - r.top) / r.height * FIELD_H
      };
    }

    function resetPointer() {
      S.pointer = null;
      canvas.style.cursor = 'crosshair';
    }

    function endPointer() {
      if (S.pointer) {
        if (S.pointer.kind === 'marquee') {
          const x0 = Math.min(S.pointer.x0, S.pointer.x1);
          const y0 = Math.min(S.pointer.y0, S.pointer.y1);
          const x1 = Math.max(S.pointer.x0, S.pointer.x1);
          const y1 = Math.max(S.pointer.y0, S.pointer.y1);
          const w = x1 - x0, h = y1 - y0;
          if (w < 4 && h < 4) {
            S.selected = null;
            S.multi = [];
          } else {
            const hits = S.marks.filter(mk => {
              const b = bounds(mk);
              return b.x >= x0 && b.y >= y0 && (b.x + b.w) <= x1 && (b.y + b.h) <= y1;
            });
            S.multi = hits.map(mk => mk.id);
            S.selected = hits.length ? hits[hits.length - 1].id : null;
          }
          syncUI();
        } else if (S.pointer.kind === 'groupMove') {
          S.pointer.ids.forEach(id => {
            const mk = markById(id);
            if (mk) { snapMark(mk); clampToField(mk); }
          });
        } else {
          const m = markById(S.pointer.id);
          if (m && S.pointer.kind !== 'rotate') snapMark(m);
        }
        draw();
      }
      resetPointer();
    }

    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      endPointer();
      const p = canvasPos(e);
      if (p.x < 0 || p.y < 0 || p.x > FIELD_W || p.y > FIELD_H) return;

      const sel = S.selected ? markById(S.selected) : null;
      if (sel && S.multi.length <= 1) {
        if (pickRotateHandle(p.x, p.y, sel)) {
          S.pointer = {
            kind: 'rotate',
            id: sel.id,
            rot0: sel.rot || 0,
            x0: p.x,
            y0: p.y
          };
          canvas.style.cursor = 'grab';
          return;
        }
        const handle = pickHandle(p.x, p.y, sel);
        if (handle) {
          S.pointer = {
            kind: 'scale',
            id: sel.id,
            handle,
            geom: cloneGeom(sel.geom),
            bounds: localBounds(sel),
            x0: p.x,
            y0: p.y
          };
          canvas.style.cursor = (handle === 'tl' || handle === 'br') ? 'nwse-resize' : 'nesw-resize';
          return;
        }
      }

      const hit = pickMark(p.x, p.y);
      if (hit) {
        if (S.multi.includes(hit.id) && S.multi.length > 1) {
          S.selected = hit.id;
          S.pointer = {
            kind: 'groupMove',
            ids: [...S.multi],
            geoms: S.multi.map(id => cloneGeom(markById(id).geom)),
            types: S.multi.map(id => markById(id).type),
            x0: p.x,
            y0: p.y
          };
          canvas.style.cursor = 'move';
          syncUI();
          return;
        }
        S.selected = hit.id;
        S.multi = [];
        S.pointer = {
          kind: 'move',
          id: hit.id,
          geom: cloneGeom(hit.geom),
          x0: p.x,
          y0: p.y
        };
        canvas.style.cursor = 'move';
        syncUI();
        return;
      }

      if (S.tool === 'select') {
        S.pointer = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }

      addMark(S.tool, p.x, p.y);
      S.tool = 'select';
      syncUI();
    });

    canvas.addEventListener('mousemove', e => {
      const p = canvasPos(e);

      if (!S.pointer) {
        const sel = S.selected ? markById(S.selected) : null;
        if (sel && S.multi.length <= 1 && pickRotateHandle(p.x, p.y, sel)) {
          canvas.style.cursor = 'grab';
        } else {
          const handle = (sel && S.multi.length <= 1) ? pickHandle(p.x, p.y, sel) : null;
          if (handle) {
            canvas.style.cursor = (handle === 'tl' || handle === 'br') ? 'nwse-resize' : 'nesw-resize';
          } else if (pickMark(p.x, p.y)) {
            canvas.style.cursor = 'move';
          } else {
            canvas.style.cursor = S.tool === 'select' ? 'default' : 'crosshair';
          }
        }
        return;
      }

      if (S.pointer.kind === 'marquee') {
        S.pointer.x1 = p.x;
        S.pointer.y1 = p.y;
        draw();
        return;
      }

      if (S.pointer.kind === 'groupMove') {
        const dx = p.x - S.pointer.x0;
        const dy = p.y - S.pointer.y0;
        S.pointer.ids.forEach((id, i) => {
          const mk = markById(id);
          if (!mk) return;
          mk.geom = cloneGeom(S.pointer.geoms[i]);
          translateGeom(mk.geom, S.pointer.types[i], dx, dy);
        });
        draw();
        return;
      }

      const m = markById(S.pointer.id);
      if (!m) return;

      if (S.pointer.kind === 'move') {
        m.geom = cloneGeom(S.pointer.geom);
        translateGeom(m.geom, m.type, p.x - S.pointer.x0, p.y - S.pointer.y0);
        snapMark(m);
        clampToField(m);
        draw();
        return;
      }

      if (S.pointer.kind === 'scale') {
        let rp = { x: snap(p.x), y: snap(p.y) };
        if (m.rot) rp = unrotatePt(rp, center(m), m.rot);
        m.geom = resizeGeom(
          S.pointer.geom, m.type, S.pointer.bounds, S.pointer.handle, rp
        );

        const opp = { tl: 'br', tr: 'bl', br: 'tl', bl: 'tr' };
        const b0 = S.pointer.bounds;
        const corners = {
          tl: { x: b0.x, y: b0.y }, tr: { x: b0.x + b0.w, y: b0.y },
          br: { x: b0.x + b0.w, y: b0.y + b0.h }, bl: { x: b0.x, y: b0.y + b0.h }
        };
        const anchor = corners[opp[S.pointer.handle]];
        const rawBounds = localBounds(m);
        const targetW = Math.max(GRID, Math.round(rawBounds.w / GRID) * GRID);
        const targetH = Math.max(GRID, Math.round(rawBounds.h / GRID) * GRID);
        const signX = corners[S.pointer.handle].x >= anchor.x ? 1 : -1;
        const signY = corners[S.pointer.handle].y >= anchor.y ? 1 : -1;
        const gridPoint = { x: anchor.x + signX * targetW, y: anchor.y + signY * targetH };
        m.geom = resizeGeom(S.pointer.geom, m.type, S.pointer.bounds, S.pointer.handle, gridPoint);

        snapMark(m);
        clampToField(m);
        draw();
        return;
      }

      if (S.pointer.kind === 'rotate') {
        const c = center(m);
        const a0 = Math.atan2(S.pointer.y0 - c.y, S.pointer.x0 - c.x);
        const a1 = Math.atan2(p.y - c.y, p.x - c.x);
        let rot = S.pointer.rot0 + (a1 - a0);
        if (e.shiftKey) rot = Math.round(rot / (Math.PI / 4)) * (Math.PI / 4);
        m.rot = rot;
        draw();
      }
    });

    canvas.addEventListener('mouseup', e => {
      if (e.button !== 0) return;
      endPointer();
    });

    canvas.addEventListener('mouseleave', endPointer);
    window.addEventListener('mouseup', e => {
      if (e.button !== 0) return;
      endPointer();
    });

    document.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.id === 'author' || t.id === 'lexiconName' || t.id === 'description' ||
          (t.matches && t.matches('input, textarea, select')))) return;
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
      else if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') { e.preventDefault(); S.selected = null; S.multi = []; syncUI(); draw(); }
    });

    // --- draw ---

    function setDash(style, w) {
      if (style === 'dashed') ctx.setLineDash([Math.max(w * 3, 8), Math.max(w * 2, 5)]);
      else if (style === 'dotted') ctx.setLineDash([Math.max(w * 0.2, 1), Math.max(w * 2, 4)]);
      else ctx.setLineDash([]);
    }

    function tracePts(pts, close) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (close) ctx.closePath();
    }

    function hatchFill(pts, color, fill, b) {
      ctx.save();
      ctx.beginPath();
      tracePts(pts, true);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      if (fill === 'h' || fill === 'cross') {
        for (let y = b.y; y <= b.y + b.h; y += HATCH_LINE_STEP) {
          ctx.beginPath(); ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); ctx.stroke();
        }
      }
      if (fill === 'd' || fill === 'cross') {
        const span = Math.max(b.w, b.h) * 2;
        for (let d = -span; d <= span; d += HATCH_LINE_STEP) {
          ctx.beginPath(); ctx.moveTo(b.x + d, b.y); ctx.lineTo(b.x + d + span, b.y + b.h); ctx.stroke();
        }
      }
      if (fill === 'dots') {
        for (let y = b.y; y <= b.y + b.h; y += HATCH_DOT_STEP) {
          for (let x = b.x; x <= b.x + b.w; x += HATCH_DOT_STEP) {
            ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    function drawClosed(m) {
      const g = m.geom;
      const b = localBounds(m);
      const pts = g.pts;
      if (m.fill === 'solid') {
        ctx.beginPath(); tracePts(pts, true); ctx.fill();
      } else if (m.fill !== 'none') {
        hatchFill(pts, m.color, m.fill, b);
      }
      if (m.stroke) {
        ctx.beginPath(); tracePts(pts, true); ctx.stroke();
      }
    }

    function semiArc(g) {
      const o = g.orient || 0;
      if (o === 1) return { start: Math.PI / 2, end: -Math.PI / 2, ccw: true };
      if (o === 2) return { start: 0, end: Math.PI, ccw: false };
      if (o === 3) return { start: -Math.PI / 2, end: Math.PI / 2, ccw: false };
      return { start: Math.PI, end: 0, ccw: true };
    }

    function withRotation(m, fn) {
      const rot = m.rot || 0;
      if (!rot) { fn(); return; }
      const c = center(m);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(rot);
      ctx.translate(-c.x, -c.y);
      fn();
      ctx.restore();
    }

    function drawMarkLocal(m) {
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = m.weight;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      const g = m.geom;

      if (m.type === 'dot') {
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      if (m.type === 'line') {
        if (!m.stroke) return;
        ctx.beginPath();
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
        setDash(m.lineStyle, m.weight);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }

      if (m.type === 'semicircle') {
        if (!m.stroke) return;
        const a = semiArc(g);
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.r, a.start, a.end, a.ccw);
        setDash(m.lineStyle, m.weight);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }

      if (m.type === 'circle') {
        if (m.fill === 'solid') {
          ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2); ctx.fill();
        } else if (m.fill !== 'none') {
          const b = localBounds(m);
          const pts = [];
          for (let i = 0; i <= 32; i++) {
            const t = i / 32 * Math.PI * 2;
            pts.push({ x: g.cx + g.r * Math.cos(t), y: g.cy + g.r * Math.sin(t) });
          }
          pts.push(pts[0]);
          hatchFill(pts, m.color, m.fill, b);
        }
        if (m.stroke) {
          ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2); ctx.stroke();
        }
        return;
      }

      drawClosed(m);
    }

    function drawMark(m) {
      withRotation(m, () => drawMarkLocal(m));
    }

    function drawGrid() {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.07)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= FIELD_W; x += GRID) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, FIELD_H); ctx.stroke();
      }
      for (let y = 0; y <= FIELD_H; y += GRID) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(FIELD_W, y + 0.5); ctx.stroke();
      }
      ctx.restore();
    }

    function drawSelection() {
      if (S.multi.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        S.multi.forEach(id => {
          const mk = markById(id);
          if (!mk) return;
          const b = bounds(mk);
          ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
        });
        ctx.setLineDash([]);
        ctx.restore();
        return;
      }
      const m = S.selected ? markById(S.selected) : null;
      if (!m) return;
      const b = bounds(m);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
      ctx.setLineDash([]);
      cornerHandles(m).forEach(h => {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
        ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
      });
      const rh = rotateHandlePos(m);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.arc(rh.x, rh.y, ROT_HANDLE, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawMarquee() {
      if (!S.pointer || S.pointer.kind !== 'marquee') return;
      const x0 = Math.min(S.pointer.x0, S.pointer.x1);
      const y0 = Math.min(S.pointer.y0, S.pointer.y1);
      const w = Math.abs(S.pointer.x1 - S.pointer.x0);
      const h = Math.abs(S.pointer.y1 - S.pointer.y0);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeRect(x0, y0, w, h);
      ctx.setLineDash([]);
      ctx.restore();
    }

    function draw(showGrid = true) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, FIELD_W, FIELD_H);
      if (showGrid) drawGrid();
      S.marks.forEach(drawMark);
      drawSelection();
      drawMarquee();
    }

    // --- UI ---

    function scaleFileSuffix() {
      return S.scaleFt + 'ft';
    }

    function exportFilename() {
      const el = document.getElementById('lexiconName');
      const raw = el ? el.value.trim() : '';
      const safe = raw.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
      return (safe || 'mark') + '_' + scaleFileSuffix() + '.png';
    }

    function updateScaleUI() {
      const scaleBarLabel = document.getElementById('scale-bar-label');
      if (scaleBarLabel) scaleBarLabel.textContent = '\u2014 ' + S.scaleFt + ' ft';
      document.querySelectorAll('.scale-preset').forEach(b => {
        b.classList.toggle('on', Number(b.dataset.ft) === S.scaleFt);
      });
    }

    function layoutStage() {
      const stage = document.getElementById('sketch-stage');
      const block = stage?.closest('.col-centre');
      const fieldWrap = document.getElementById('field-wrap');
      if (!stage || !block) return;

      const isMobile = window.matchMedia('(max-width: 767px)').matches;
      const stageStyle = getComputedStyle(stage);
      const stagePadV = (parseFloat(stageStyle.paddingTop) || 0) + (parseFloat(stageStyle.paddingBottom) || 0);
      const availW = block.clientWidth - 396;
      const availH = block.clientHeight - stagePadV;

      stage.style.width = '100%';
      stage.style.maxWidth = '100%';

      if (isMobile) {
        if (fieldWrap) {
          fieldWrap.style.flex = 'none';
          fieldWrap.style.removeProperty('width');
          fieldWrap.style.maxWidth = '100%';
        }
        return;
      }

      if (availW < 1 || availH < 1) return;

      function chromeHeight() {
        const scaleBand = document.getElementById('scale-band');
        const toolbar = document.getElementById('toolbar');
        const tbmt = toolbar ? (parseFloat(getComputedStyle(toolbar).marginTop) || 0) : 0;
        return (scaleBand?.offsetHeight || 0) + (toolbar?.offsetHeight || 0) + tbmt;
      }

      if (fieldWrap) fieldWrap.style.flex = '0 0 auto';

      let chromeH = chromeHeight();
      let size = Math.min(availW, Math.max(160, (availH - chromeH) * 3 / 4));
      if (fieldWrap) {
        fieldWrap.style.width = size + 'px';
        fieldWrap.style.maxWidth = '100%';
      }
      chromeH = chromeHeight();
      size = Math.min(availW, Math.max(160, (availH - chromeH) * 3 / 4));
      if (fieldWrap && size > 0) {
        fieldWrap.style.width = size + 'px';
        fieldWrap.style.maxWidth = '100%';
      }
    }

    function syncUI() {
      const m = S.selected ? markById(S.selected) : null;
      document.querySelectorAll('.tool').forEach(b => {
        let activeTool = S.tool;
        if (m && m.type === 'triangle') {
          activeTool = m.geom && m.geom.variant === 'right' ? 'rightTriangle' : 'triangle';
        }
        b.classList.toggle('on', b.dataset.shape === activeTool);
      });
      document.querySelectorAll('.sw').forEach(b => {
        b.classList.toggle('on', b.dataset.c === (m ? m.color : S.color));
      });
      document.querySelectorAll('.fill-sw').forEach(b => {
        b.classList.toggle('on', b.dataset.fill === (m && CLOSED.has(m.type) ? m.fill : S.fill));
      });
      document.querySelectorAll('.wt').forEach(b => {
        b.classList.toggle('on', Number(b.dataset.w) === (m ? m.weight : S.weight));
      });
      document.querySelectorAll('[data-ls]').forEach(b => {
        const ls = m && (m.type === 'line' || m.type === 'semicircle') ? m.lineStyle : S.lineStyle;
        b.classList.toggle('on', b.dataset.ls === ls);
      });
      document.querySelectorAll('[data-stroke]').forEach(b => {
        const on = m && STROKED.has(m.type) ? m.stroke : S.stroke;
        b.classList.toggle('on', (b.dataset.stroke === '1') === on);
      });

      updateScaleUI();
    }

    function drawFillPreview(c, fillId) {
      const x = c.getContext('2d');
      const s = c.width;
      x.fillStyle = '#fff';
      x.fillRect(0, 0, s, s);
      x.strokeStyle = '#111';
      x.fillStyle = '#111';
      x.lineWidth = 1;
      if (fillId === 'none') { x.strokeRect(0.5, 0.5, s - 1, s - 1); return; }
      if (fillId === 'solid') { x.fillRect(1, 1, s - 2, s - 2); return; }
      const step = 3;
      if (fillId === 'h') {
        for (let y = 2; y < s - 1; y += step) {
          x.beginPath(); x.moveTo(1, y + 0.5); x.lineTo(s - 1, y + 0.5); x.stroke();
        }
      }
      if (fillId === 'd') {
        for (let d = -s; d <= s; d += step) {
          x.beginPath(); x.moveTo(d, 1); x.lineTo(d + s, s - 1); x.stroke();
        }
      }
      if (fillId === 'cross') {
        x.fillStyle = '#fff';
        x.fillRect(0, 0, s, s);
        x.strokeStyle = '#111';
        x.lineWidth = 1;
        const crossStep = 6;
        for (let y = 3; y < s - 2; y += crossStep) {
          x.beginPath(); x.moveTo(1, y + 0.5); x.lineTo(s - 1, y + 0.5); x.stroke();
        }
        for (let d = -s; d <= s; d += crossStep) {
          x.beginPath(); x.moveTo(d, 1); x.lineTo(d + s, s - 1); x.stroke();
        }
      }
      if (fillId === 'dots') {
        x.fillStyle = '#fff';
        x.fillRect(0, 0, s, s);
        x.fillStyle = '#111';
        const dotStep = 6;
        for (let y = dotStep; y < s - 1; y += dotStep) {
          for (let x0 = dotStep; x0 < s - 1; x0 += dotStep) {
            x.beginPath(); x.arc(x0, y, 1, 0, Math.PI * 2); x.fill();
          }
        }
      }
    }

    SHAPES.forEach(type => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool' + (type === S.tool ? ' on' : '');
      b.dataset.shape = type;
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[type]}</svg>`;
      b.addEventListener('click', () => { S.tool = type; syncUI(); });
      document.getElementById('shapes').appendChild(b);
    });

    COLORS.forEach(hex => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.style.background = hex;
      b.dataset.c = hex;
      b.addEventListener('click', () => {
        S.color = hex;
        const m = S.selected ? markById(S.selected) : null;
        if (m) m.color = hex;
        syncUI(); draw();
      });
      document.getElementById('row-colors').appendChild(b);
    });

    FILLS.forEach(fillId => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fill-sw';
      b.dataset.fill = fillId;
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      drawFillPreview(c, fillId);
      b.appendChild(c);
      b.addEventListener('click', () => {
        S.fill = fillId;
        const m = S.selected ? markById(S.selected) : null;
        if (m && CLOSED.has(m.type)) m.fill = fillId;
        syncUI(); draw();
      });
      document.getElementById('grp-fill').appendChild(b);
    });

    [2, 5, 10].forEach(w => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wt' + (w === 5 ? ' on' : '');
      b.dataset.w = w;
      b.innerHTML = '<span></span>';
      b.addEventListener('click', () => {
        S.weight = w;
        const m = S.selected ? markById(S.selected) : null;
        if (m) m.weight = w;
        syncUI(); draw();
      });
      document.getElementById('grp-weight').appendChild(b);
    });

    const LINE_STYLE_SVGS = {
      solid: '<line x1="4" y1="12" x2="36" y2="12" stroke="#111" stroke-width="2"/>',
      dashed: '<line x1="4" y1="12" x2="36" y2="12" stroke="#111" stroke-width="2" stroke-dasharray="6 4"/>',
      dotted: '<line x1="4" y1="12" x2="36" y2="12" stroke="#111" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>'
    };

    ['solid', 'dashed', 'dotted'].forEach(id => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ls-btn' + (id === S.lineStyle ? ' on' : '');
      b.dataset.ls = id;
      b.innerHTML = `<svg viewBox="0 0 40 24">${LINE_STYLE_SVGS[id]}</svg>`;
      b.addEventListener('click', () => {
        S.lineStyle = id;
        const m = S.selected ? markById(S.selected) : null;
        if (m && (m.type === 'line' || m.type === 'semicircle')) m.lineStyle = id;
        syncUI(); draw();
      });
      document.getElementById('grp-line').appendChild(b);
    });

    [
      { id: '1', label: 'O' },
      { id: '0', label: '\u2212' }
    ].forEach(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stroke-btn' + ((o.id === '1') === S.stroke ? ' on' : '');
      b.dataset.stroke = o.id;
      b.textContent = o.label;
      b.addEventListener('click', () => {
        S.stroke = o.id === '1';
        const m = S.selected ? markById(S.selected) : null;
        if (m && STROKED.has(m.type)) m.stroke = S.stroke;
        syncUI(); draw();
      });
      document.getElementById('grp-stroke').appendChild(b);
    });

    const scalePresets = document.getElementById('scale-presets');
    SCALE_PRESETS.forEach((ft, i) => {
      if (i > 0) {
        const dot = document.createElement('span');
        dot.className = 'scale-dot';
        dot.textContent = '\u00b7';
        scalePresets.appendChild(dot);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scale-preset' + (ft === S.scaleFt ? ' on' : '');
      b.dataset.ft = ft;
      b.textContent = ft + 'ft';
      b.addEventListener('click', () => {
        S.scaleFt = ft;
        updateScaleUI();
      });
      scalePresets.appendChild(b);
    });

    document.querySelectorAll('.tool-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(btn.dataset.panel);
        const isOpen = btn.classList.contains('open');
        document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('open'));
        document.querySelectorAll('.tool-toggle').forEach(b => b.classList.remove('open'));
        if (!isOpen) {
          panel.classList.add('open');
          btn.classList.add('open');
        }
        layoutStage();
      });
    });

    syncUI();
    draw();
    layoutStage();
    requestAnimationFrame(layoutStage);
    window.addEventListener('resize', layoutStage);
    window.addEventListener('load', layoutStage);
    const drawingCol = document.querySelector('.col-centre');
    if (drawingCol && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => layoutStage()).observe(drawingCol);
    }