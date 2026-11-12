/* KleanPath — import DXF (ASCII) → SVG en mm, puis mêmes contrôles que le SVG.
   Lecteur maison, sans dépendance : LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE,
   SPLINE, TEXT, MTEXT, INSERT (blocs), couleurs ACI / vraies couleurs, calques. */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});

  const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100 };
  const ACI = { 1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF', 5: '#0000FF', 6: '#FF00FF', 7: '#000000', 8: '#808080', 9: '#C0C0C0' };
  const aciHex = n => ACI[n] || '#333333';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f = v => +(+v).toFixed(5);

  function pairs(text) {
    const L = text.split(/\r\n|\r|\n/), out = [];
    for (let i = 0; i + 1 < L.length; i += 2) {
      const c = parseInt(L[i].trim(), 10);
      if (Number.isNaN(c)) throw new Error('DXF illisible (ligne ' + (i + 1) + ').');
      out.push([c, L[i + 1].replace(/\s+$/, '')]);
    }
    return out;
  }

  /** Découpe une liste de paires en enregistrements commençant par le code 0. */
  function records(P) {
    const out = []; let cur = null;
    for (const [c, v] of P) {
      if (c === 0) { cur = { type: v.trim(), codes: [] }; out.push(cur); }
      else if (cur) cur.codes.push([c, v]);
    }
    return out;
  }

  const get = (r, code) => { const p = r.codes.find(x => x[0] === code); return p ? p[1] : undefined; };
  const num = (r, code, def) => { const v = get(r, code); const n = v === undefined ? NaN : parseFloat(v); return Number.isFinite(n) ? n : def; };

  function toSvg(text) {
    if (/^AutoCAD Binary DXF/.test(text)) throw new Error('DXF binaire non pris en charge : réenregistrez-le en DXF ASCII.');
    const P = pairs(text);
    const sections = {};
    for (let i = 0; i < P.length; i++) {
      if (P[i][0] === 0 && P[i][1].trim() === 'SECTION' && P[i + 1]) {
        const name = P[i + 1][1].trim(), start = i + 2; let j = start;
        while (j < P.length && !(P[j][0] === 0 && P[j][1].trim() === 'ENDSEC')) j++;
        sections[name] = P.slice(start, j); i = j;
      }
    }
    if (!sections.ENTITIES) throw new Error('Aucune section ENTITIES : ce fichier DXF ne contient pas de dessin.');

    // En-tête : unités
    let insunits = null, measurement = null;
    const H = sections.HEADER || [];
    for (let i = 0; i < H.length; i++) {
      if (H[i][0] === 9 && H[i][1].trim() === '$INSUNITS' && H[i + 1]) insunits = parseInt(H[i + 1][1], 10);
      if (H[i][0] === 9 && H[i][1].trim() === '$MEASUREMENT' && H[i + 1]) measurement = parseInt(H[i + 1][1], 10);
    }
    let unitMm, note = '';
    if (UNIT_MM[insunits]) unitMm = UNIT_MM[insunits];
    else if (measurement === 0) { unitMm = 25.4; note = 'Unités absentes du DXF : pouces supposés (dessin impérial). Vérifiez les dimensions.'; }
    else { unitMm = 1; note = 'Unités absentes du DXF : millimètres supposés. Vérifiez les dimensions.'; }

    // Calques
    const layers = {};
    for (const r of records(sections.TABLES || [])) {
      if (r.type !== 'LAYER') continue;
      const name = get(r, 2); if (name === undefined) continue;
      const c = num(r, 62, 7), tc = get(r, 420);
      layers[name] = { off: c < 0, color: tc !== undefined ? '#' + (+tc).toString(16).padStart(6, '0').toUpperCase() : aciHex(Math.abs(c)) };
    }

    // Blocs
    const blocks = {};
    {
      let cur = null;
      for (const r of records(sections.BLOCKS || [])) {
        if (r.type === 'BLOCK') { cur = { name: get(r, 2), bx: num(r, 10, 0), by: num(r, 20, 0), ents: [] }; blocks[cur.name] = cur; }
        else if (r.type === 'ENDBLK') cur = null;
        else if (cur) cur.ents.push(r);
      }
    }

    const hair = f(0.01 / unitMm);
    const ignored = {};
    const colorOf = r => {
      const tc = get(r, 420);
      if (tc !== undefined) return '#' + (+tc).toString(16).padStart(6, '0').toUpperCase();
      const c = num(r, 62, 256), L = layers[get(r, 8)];
      if (c === 256 || c === undefined) return L ? L.color : '#000000';
      if (c === 0) return '#000000';
      return aciHex(Math.abs(c));
    };
    const strokeStyle = c => 'style="fill:none;stroke:' + c + ';stroke-width:' + hair + '"';

    const arcSeg = (x0, y0, x1, y1, bulge) => {  // segment avec renflement, coordonnées DXF
      const th = 4 * Math.atan(Math.abs(bulge)), chord = Math.hypot(x1 - x0, y1 - y0);
      const r = chord / (2 * Math.sin(th / 2));
      return 'A' + f(r) + ' ' + f(r) + ' 0 ' + (th > Math.PI ? 1 : 0) + ' ' + (bulge > 0 ? 0 : 1) + ' ' + f(x1) + ' ' + f(-y1);
    };
    const polyPath = (verts, closed) => {
      if (verts.length < 2) return '';
      let d = 'M' + f(verts[0].x) + ' ' + f(-verts[0].y);
      const n = verts.length, last = closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = verts[i], b = verts[(i + 1) % n];
        d += a.b ? arcSeg(a.x, a.y, b.x, b.y, a.b) : 'L' + f(b.x) + ' ' + f(-b.y);
      }
      return d + (closed ? 'Z' : '');
    };

    function bspline(deg, knots, ctrl, weights, samples) {
      const n = ctrl.length - 1, lo = knots[deg], hi = knots[n + 1], pts = [];
      for (let s = 0; s <= samples; s++) {
        const t = s === samples ? hi - 1e-9 : lo + (hi - lo) * s / samples;
        let k = deg; while (k < n && t >= knots[k + 1]) k++;
        const d = []; for (let j = 0; j <= deg; j++) { const c = ctrl[k - deg + j], w = weights[k - deg + j]; d.push([c.x * w, c.y * w, w]); }
        for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
          const i = k - deg + j, den = knots[i + deg + 1 - r] - knots[i], a = den ? (t - knots[i]) / den : 0;
          for (let q = 0; q < 3; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
        }
        pts.push({ x: d[deg][0] / d[deg][2], y: d[deg][1] / d[deg][2] });
      }
      return pts;
    }

    function entity(r, list, idx, depth) {
      if (num(r, 67, 0) === 1) return { svg: '', skip: 0 };                 // espace papier
      const L = layers[get(r, 8)]; if (L && L.off) return { svg: '', skip: 0 }; // calque éteint
      const col = colorOf(r), st = strokeStyle(col), mirror = num(r, 230, 1) < 0;
      const mx = x => (mirror ? -x : x);
      switch (r.type) {
        case 'LINE':
          return { svg: '<line x1="' + f(mx(num(r, 10, 0))) + '" y1="' + f(-num(r, 20, 0)) + '" x2="' + f(mx(num(r, 11, 0))) + '" y2="' + f(-num(r, 21, 0)) + '" ' + st + '/>' };
        case 'CIRCLE':
          return { svg: '<circle cx="' + f(mx(num(r, 10, 0))) + '" cy="' + f(-num(r, 20, 0)) + '" r="' + f(num(r, 40, 0)) + '" ' + st + '/>' };
        case 'ARC': {
          const cx = mx(num(r, 10, 0)), cy = num(r, 20, 0), R = num(r, 40, 0);
          let a0 = num(r, 50, 0), a1 = num(r, 51, 360);
          if (mirror) [a0, a1] = [180 - a1, 180 - a0];
          let span = ((a1 - a0) % 360 + 360) % 360; if (span === 0) span = 360;
          if (span >= 359.999) return { svg: '<circle cx="' + f(cx) + '" cy="' + f(-cy) + '" r="' + f(R) + '" ' + st + '/>' };
          const p = a => ({ x: cx + R * Math.cos(a * Math.PI / 180), y: cy + R * Math.sin(a * Math.PI / 180) });
          const s = p(a0), e = p(a0 + span);
          return { svg: '<path d="M' + f(s.x) + ' ' + f(-s.y) + 'A' + f(R) + ' ' + f(R) + ' 0 ' + (span > 180 ? 1 : 0) + ' 0 ' + f(e.x) + ' ' + f(-e.y) + '" ' + st + '/>' };
        }
        case 'ELLIPSE': {
          const cx = num(r, 10, 0), cy = num(r, 20, 0), mxv = num(r, 11, 1), myv = num(r, 21, 0), ratio = num(r, 40, 1);
          let t0 = num(r, 41, 0), t1 = num(r, 42, Math.PI * 2);
          let span = t1 - t0; while (span <= 0) span += Math.PI * 2;
          const rx = Math.hypot(mxv, myv), ry = rx * ratio, rot = -Math.atan2(myv, mxv) * 180 / Math.PI;
          const pt = t => ({ x: cx + mxv * Math.cos(t) - ratio * myv * Math.sin(t), y: cy + myv * Math.cos(t) + ratio * mxv * Math.sin(t) });
          const A = (t, big) => { const q = pt(t); return 'A' + f(rx) + ' ' + f(ry) + ' ' + f(rot) + ' ' + big + ' 0 ' + f(q.x) + ' ' + f(-q.y); };
          const s = pt(t0);
          let d = 'M' + f(s.x) + ' ' + f(-s.y);
          if (span >= Math.PI * 2 - 1e-6) d += A(t0 + Math.PI, 0) + A(t0 + 2 * Math.PI, 0) + 'Z';
          else d += A(t0 + span, span > Math.PI ? 1 : 0);
          return { svg: '<path d="' + d + '" ' + st + (mirror ? ' transform="scale(-1 1)"' : '') + '/>' };
        }
        case 'LWPOLYLINE': {
          const verts = [];
          for (const [c, v] of r.codes) {
            if (c === 10) verts.push({ x: mx(parseFloat(v)), y: 0, b: 0 });
            else if (c === 20 && verts.length) verts[verts.length - 1].y = parseFloat(v);
            else if (c === 42 && verts.length) verts[verts.length - 1].b = mirror ? -parseFloat(v) : parseFloat(v);
          }
          const d = polyPath(verts, (num(r, 70, 0) & 1) === 1);
          return { svg: d ? '<path d="' + d + '" ' + st + '/>' : '' };
        }
        case 'POLYLINE': {
          const flags = num(r, 70, 0); const verts = []; let j = idx + 1;
          while (j < list.length && list[j].type === 'VERTEX') {
            const v = list[j]; if (!(num(v, 70, 0) & 128 && num(v, 70, 0) & 64)) verts.push({ x: mx(num(v, 10, 0)), y: num(v, 20, 0), b: (mirror ? -1 : 1) * num(v, 42, 0) });
            j++;
          }
          if (j < list.length && list[j].type === 'SEQEND') j++;
          if (flags & (16 | 64)) return { svg: '', skip: j - idx - 1, ignore: 'POLYLINE 3D' };   // maillages 3D
          const d = polyPath(verts, (flags & 1) === 1);
          return { svg: d ? '<path d="' + d + '" ' + st + '/>' : '', skip: j - idx - 1 };
        }
        case 'SPLINE': {
          const deg = num(r, 71, 3), knots = [], ctrl = [], fit = [], w = [];
          for (const [c, v] of r.codes) {
            if (c === 40) knots.push(parseFloat(v));
            else if (c === 41) w.push(parseFloat(v));
            else if (c === 10) ctrl.push({ x: mx(parseFloat(v)), y: 0 });
            else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1].y = parseFloat(v);
            else if (c === 11) fit.push({ x: mx(parseFloat(v)), y: 0 });
            else if (c === 21 && fit.length) fit[fit.length - 1].y = parseFloat(v);
          }
          let pts;
          if (ctrl.length > deg && knots.length === ctrl.length + deg + 1) {
            const weights = w.length === ctrl.length ? w : ctrl.map(() => 1);
            pts = bspline(deg, knots, ctrl, weights, Math.min(2000, Math.max(24, ctrl.length * 12)));
          } else pts = fit.length > 1 ? fit : ctrl;
          if (pts.length < 2) return { svg: '' };
          const closed = (num(r, 70, 0) & 1) === 1;
          return { svg: '<path d="M' + pts.map(p => f(p.x) + ' ' + f(-p.y)).join('L') + (closed ? 'Z' : '') + '" ' + st + '/>' };
        }
        case 'TEXT': case 'MTEXT': {
          let t = r.type === 'TEXT' ? (get(r, 1) || '') : r.codes.filter(c => c[0] === 3 || c[0] === 1).map(c => c[1]).join('');
          t = t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\{}]*;/g, '').replace(/[{}]/g, '').replace(/%%[cdp]/gi, '').trim();
          if (!t) return { svg: '' };
          const x = mx(num(r, 10, 0)), y = num(r, 20, 0), h = num(r, 40, 2.5), rot = num(r, 50, 0);
          return { svg: '<text x="' + f(x) + '" y="' + f(-y) + '" font-size="' + f(h) + '" font-family="sans-serif" style="fill:' + col + '"' + (rot ? ' transform="rotate(' + f(-rot) + ' ' + f(x) + ' ' + f(-y) + ')"' : '') + '>' + esc(t) + '</text>' };
        }
        case 'INSERT': {
          const b = blocks[get(r, 2)];
          if (!b || depth > 8) return { svg: '' };
          const x = num(r, 10, 0), y = num(r, 20, 0), sx = num(r, 41, 1), sy = num(r, 42, 1), rot = num(r, 50, 0);
          const inner = render(b.ents, depth + 1);
          return { svg: '<g transform="translate(' + f(x) + ' ' + f(-y) + ') rotate(' + f(-rot) + ') scale(' + f(sx) + ' ' + f(sy) + ') translate(' + f(-b.bx) + ' ' + f(b.by) + ')">' + inner + '</g>' };
        }
        case 'VERTEX': case 'SEQEND': case 'ATTRIB': case 'ATTDEF': return { svg: '' };
        default: return { svg: '', ignore: r.type };
      }
    }

    function render(list, depth) {
      let s = '';
      for (let i = 0; i < list.length; i++) {
        const res = entity(list[i], list, i, depth);
        s += res.svg;
        if (res.ignore) ignored[res.ignore] = (ignored[res.ignore] || 0) + 1;
        if (res.skip) i += res.skip;
      }
      return s;
    }

    const ents = records(sections.ENTITIES);
    // regroupement par calque pour garder la structure du dessin
    const byLayer = new Map();
    for (let i = 0; i < ents.length; i++) {
      const r = ents[i], name = get(r, 8) || '0';
      if (r.type === 'VERTEX' || r.type === 'SEQEND') continue;
      let span = 1;
      if (r.type === 'POLYLINE') { let j = i + 1; while (j < ents.length && ents[j].type === 'VERTEX') j++; if (j < ents.length && ents[j].type === 'SEQEND') j++; span = j - i; }
      if (!byLayer.has(name)) byLayer.set(name, []);
      byLayer.get(name).push(...ents.slice(i, i + span));
      i += span - 1;
    }
    let body = '', li = 0;
    for (const [name, list] of byLayer) {
      const inner = render(list, 0);
      if (inner) body += '<g id="calque-' + (++li) + '-' + esc(name.replace(/[^\w-]/g, '_')) + '">' + inner + '</g>';
    }
    if (!body) throw new Error('Aucune géométrie exploitable dans ce DXF.');

    // Boîte englobante calculée par le moteur SVG du navigateur
    const tmp = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><g>' + body + '</g></svg>', 'image/svg+xml');
    if (tmp.getElementsByTagName('parsererror')[0]) throw new Error('Conversion DXF impossible.');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden';
    const svgEl = document.importNode(tmp.documentElement, true);
    host.append(svgEl); document.body.append(host);
    const bb = svgEl.firstChild.getBBox();
    host.remove();
    if (!(bb.width > 0 || bb.height > 0)) throw new Error('Le dessin DXF est vide.');
    const w = Math.max(bb.width, 1e-6), h = Math.max(bb.height, 1e-6);
    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="' + f(w * unitMm) + 'mm" height="' + f(h * unitMm) + 'mm" viewBox="' +
      [bb.x, bb.y, w, h].map(f).join(' ') + '">\n' + body + '\n</svg>\n';
    const ign = Object.entries(ignored);
    return { svg, note, ignored: ign.length ? 'Éléments DXF ignorés : ' + ign.map(([t, n]) => t + ' (' + n + ')').join(', ') + '.' : '' };
  }

  LC.dxf = { toSvg };
})();
