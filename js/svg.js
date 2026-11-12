/* KleanPath — module SVG : lecture, contrôles découpe laser, corrections, export.
   Tout est calculé dans le navigateur : la géométrie vient du moteur SVG natif
   (getScreenCTM, getBBox, getPointAtLength), sans librairie externe. */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});

  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const GEOM = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
  const NON_RENDER = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'linearGradient',
    'radialGradient', 'filter', 'metadata', 'style', 'title', 'desc', 'script']);
  const UNIT_MM = { mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };
  const ORIGIN_DPI = { inkscape: 96, illustrator: 72, affinity: 72, autre: 96 };
  const ORIGIN_LABEL = { inkscape: 'Inkscape', illustrator: 'Illustrator', affinity: 'Affinity', autre: 'logiciel inconnu' };
  const EDITOR_NS = new Set([
    'http://www.inkscape.org/namespaces/inkscape', 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
    'http://ns.adobe.com/AdobeIllustrator/10.0/', 'http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/',
    'http://ns.adobe.com/Extensibility/1.0/', 'http://ns.adobe.com/Graphs/1.0/', 'http://ns.adobe.com/SaveForWeb/1.0/',
    'http://ns.adobe.com/Variables/1.0/', 'http://ns.adobe.com/ImageReplacement/1.0/',
    'http://ns.adobe.com/GenericCustomNamespace/1.0/', 'http://ns.adobe.com/XPath/1.0/', 'http://www.serif.com/',
    'http://creativecommons.org/ns#', 'http://purl.org/dc/elements/1.1/', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
  ]);
  const NUMRE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  const THICK_MM = 0.1;      // au-delà, un trait de coupe est considéré comme épais
  const HAIRLINE_MM = 0.01;  // trait fin appliqué par la correction
  const SAME_POINT_MM = 0.01;

  const fmt = (n, d = 1) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });
  const num = (n, d = 4) => String(+Number(n).toFixed(d));
  const plural = (n, one, many) => n + ' ' + (n > 1 ? (many || one + 's') : one);
  const tp = (M, x, y) => ({ x: M.a * x + M.c * y + M.e, y: M.b * x + M.d * y + M.f });

  /* ---------- Lecture ---------- */

  function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
      const m = err.textContent.match(/line (\d+)/i);
      throw new Error('Ce fichier SVG est mal formé (fichier tronqué ou abîmé' + (m ? ', erreur ligne ' + m[1] : '') + ') : réexportez-le depuis votre logiciel.');
    }
    if (!doc.documentElement || doc.documentElement.localName !== 'svg') throw new Error("Ce fichier n'est pas un SVG.");
    return doc;
  }

  function detectOrigin(text) {
    if (/Adobe Illustrator|ns\.adobe\.com\/AdobeIllustrator/i.test(text)) return 'illustrator';
    if (/inkscape\.org\/namespaces|sodipodi/i.test(text)) return 'inkscape';
    if (/serif\.com|Affinity/i.test(text)) return 'affinity';
    return 'autre';
  }

  /** Attribue un identifiant stable data-lc à chaque élément (retiré à l'export). */
  function ensureIds(doc) {
    let max = 0;
    const all = doc.getElementsByTagName('*');
    for (const el of all) { const v = +el.getAttribute('data-lc'); if (v > max) max = v; }
    for (const el of all) if (!el.hasAttribute('data-lc')) el.setAttribute('data-lc', ++max);
  }

  const byId = (doc, id) => doc.querySelector('[data-lc="' + id + '"]');

  function parseLen(v) {
    if (v == null) return null;
    const m = String(v).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
    return m ? { n: parseFloat(m[1]), u: m[2].toLowerCase(), raw: String(v).trim() } : null;
  }

  /** Taille réelle du document et facteur unités utilisateur → mm. */
  function units(doc, dpi) {
    const r = doc.documentElement;
    const a = (r.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const vb = a.length === 4 && a.every(isFinite) && a[2] > 0 && a[3] > 0 ? { x: a[0], y: a[1], w: a[2], h: a[3] } : null;
    const W = parseLen(r.getAttribute('width')), H = parseLen(r.getAttribute('height'));
    const pxmm = 25.4 / dpi;
    const userW = vb ? vb.w : (W && W.u !== '%' ? W.n : null);
    const userH = vb ? vb.h : (H && H.u !== '%' ? H.n : null);
    if (!userW || !userH) return { ok: false, error: 'Impossible de déterminer la taille du document (ni viewBox, ni largeur/hauteur).' };
    const side = (L, user) => {
      if (!L || L.u === '%') return { mm: user * pxmm, abs: false, label: L ? L.raw : 'absente' };
      if (UNIT_MM[L.u]) return { mm: L.n * UNIT_MM[L.u], abs: true, label: L.raw };
      return { mm: L.n * pxmm, abs: false, label: L.raw };   // px, sans unité, em…
    };
    const w = side(W, userW), h = side(H, userH);
    return {
      ok: true, vb, userW, userH, widthMm: w.mm, heightMm: h.mm, absolute: w.abs && h.abs,
      wLabel: w.label, hLabel: h.label, mmPerUser: w.mm / userW,
      page: vb ? { x0: vb.x, y0: vb.y, x1: vb.x + vb.w, y1: vb.y + vb.h } : { x0: 0, y0: 0, x1: userW, y1: userH }
    };
  }

  function setMm(doc, U, wMm, hMm) {
    const r = doc.documentElement;
    if (!U.vb) r.setAttribute('viewBox', '0 0 ' + num(U.userW) + ' ' + num(U.userH));
    r.setAttribute('width', num(wMm, 3) + 'mm');
    r.setAttribute('height', num(hMm, 3) + 'mm');
  }

  /* ---------- Aperçu (copie assainie) ---------- */

  function sanitize(root) {
    root.querySelectorAll('script, foreignObject, iframe, embed, object, audio, video').forEach(e => e.remove());
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const at of [...el.attributes]) {
        const n = at.name.toLowerCase();
        if (n.startsWith('on')) el.removeAttribute(at.name);
        else if ((n === 'href' || n === 'xlink:href') && !/^\s*(#|data:image\/)/i.test(at.value)) el.removeAttribute(at.name);
        else if (n === 'style' && /url\(\s*['"]?\s*(https?:|\/\/)/i.test(at.value)) el.setAttribute('style', at.value.replace(/url\([^)]*\)/gi, 'none'));
      }
    }
    // Aucune ressource externe : le fichier ne doit déclencher aucune requête réseau
    root.querySelectorAll('style').forEach(s => {
      s.textContent = s.textContent.replace(/@import[^;]*;/gi, '').replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, 'none');
    });
  }

  function renderPreview(doc, container) {
    const root = document.importNode(doc.documentElement, true);
    sanitize(root);
    if (!root.getAttribute('viewBox')) {
      const U = units(doc, 96);
      if (U.ok) root.setAttribute('viewBox', '0 0 ' + U.userW + ' ' + U.userH);
    }
    root.style.cssText = 'display:block;width:100%;height:auto;max-height:var(--pv-max, 64vh);overflow:hidden';
    container.replaceChildren(root);
    return root;
  }

  /* ---------- Outils géométrie ---------- */

  function parseColor(v) {
    if (!v || v === 'none' || v === 'transparent') return null;
    const m = v.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?/);
    if (!m) return { hex: 'dégradé/motif', r: 0, g: 0, b: 0, other: true };
    let alpha = m[4] == null ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
    if (alpha === 0) return null;
    const c = [m[1], m[2], m[3]].map(x => Math.round(+x));
    return { hex: '#' + c.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(), r: c[0], g: c[1], b: c[2] };
  }

  /** Découpe un attribut d en sous-chemins : début, fin, fermé, position de fin dans la chaîne. */
  function parsePathD(d) {
    let i = 0; const n = d.length;
    const ws = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
    const nb = () => { ws(); const m = NUMRE.exec(d.slice(i, i + 64)); if (!m) return null; i += m[0].length; return parseFloat(m[0]); };
    const flag = () => { ws(); const c = d[i]; if (c === '0' || c === '1') { i++; return +c; } return null; };
    const subs = []; let cur = null, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
    const ARGS = { L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 };
    while (true) {
      ws(); if (i >= n) break;
      const c = d[i];
      if (/[A-Za-z]/.test(c)) {
        cmd = c; i++;
        if (c === 'Z' || c === 'z') { if (cur) { cur.closed = true; cur.endIdx = i; } cx = sx; cy = sy; continue; }
      } else if (cmd === null || cmd === 'Z' || cmd === 'z') break;
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      let x, y;
      if (C === 'M') {
        const a = nb(), b = nb(); if (b === null) break;
        x = rel ? cx + a : a; y = rel ? cy + b : b; sx = x; sy = y; cx = x; cy = y;
        cur = { start: { x, y }, end: { x, y }, closed: false, endIdx: i, segs: 0, pts: [{ x, y }], curved: false }; subs.push(cur);
        cmd = rel ? 'l' : 'L'; continue;
      }
      if (C === 'A') {
        const v = [nb(), nb(), nb(), flag(), flag(), nb(), nb()];
        if (v.some(t => t === null)) break;
        x = rel ? cx + v[5] : v[5]; y = rel ? cy + v[6] : v[6];
      } else if (ARGS[C]) {
        const v = []; for (let k = 0; k < ARGS[C]; k++) v.push(nb());
        if (v.some(t => t === null)) break;
        if (C === 'H') { x = rel ? cx + v[0] : v[0]; y = cy; }
        else if (C === 'V') { x = cx; y = rel ? cy + v[0] : v[0]; }
        else { x = rel ? cx + v[v.length - 2] : v[v.length - 2]; y = rel ? cy + v[v.length - 1] : v[v.length - 1]; }
      } else break;
      if (!cur || cur.closed) { cur = { start: { x: sx, y: sy }, end: { x: sx, y: sy }, closed: false, endIdx: i, segs: 0, pts: [{ x: sx, y: sy }], curved: false }; subs.push(cur); }
      cur.end = { x, y }; cur.endIdx = i; cur.segs++; cx = x; cy = y;
      cur.pts.push({ x, y }); if ('CSQTA'.includes(C)) cur.curved = true;
    }
    return subs.filter(s => s.segs > 0);
  }

  function parsePoints(s) {
    const v = (s || '').trim().split(/[\s,]+/).map(Number).filter(isFinite);
    const pts = []; for (let k = 0; k + 1 < v.length; k += 2) pts.push({ x: v[k], y: v[k + 1] });
    return pts;
  }

  function getStyleProp(el, prop) {
    const m = (el.getAttribute('style') || '').match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
    return m ? m[1].trim() : null;
  }
  function setStyleProp(el, prop, value) {
    const rest = (el.getAttribute('style') || '').split(';').map(s => s.trim()).filter(s => s && !new RegExp('^' + prop + '\\s*:', 'i').test(s));
    rest.push(prop + ':' + value);
    el.setAttribute('style', rest.join(';'));
  }

  const opGuess = c => {
    if (!c || c.other) return 'coupe';
    if (c.r > 180 && c.g < 90 && c.b < 90) return 'coupe';
    if (c.b > 150 && c.r < 90) return 'marquage';
    return 'coupe';
  };

  /* ---------- Polices, images intégrées, vectorisation du texte ---------- */

  /** Une police est-elle installée ? (comparaison de largeurs avec les polices génériques) */
  const fontAvailable = (() => {
    const cache = new Map(); let ctx2d = null;
    return fam => {
      if (!fam || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(fam)) return true;
      if (cache.has(fam)) return cache.get(fam);
      ctx2d = ctx2d || document.createElement('canvas').getContext('2d');
      const t = 'mmmmmmmmmmlli1WQ@#àé'; let ok = false;
      for (const base of ['monospace', 'serif', 'sans-serif']) {
        ctx2d.font = '72px ' + base; const w0 = ctx2d.measureText(t).width;
        ctx2d.font = '72px "' + fam.replace(/"/g, '') + '", ' + base;
        if (Math.abs(ctx2d.measureText(t).width - w0) > 0.01) { ok = true; break; }
      }
      cache.set(fam, ok); return ok;
    };
  })();

  /** Taille en pixels d'une image intégrée en data:URI (PNG ou JPEG), sans la décoder. */
  function imagePixels(el) {
    const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '';
    const m = href.match(/^data:image\/(png|jpe?g);base64,(.*)$/i); if (!m) return null;
    try {
      const s = m[2].replace(/[^A-Za-z0-9+/=]/g, ''), len = Math.min(s.length, 120000);
      const bin = atob(s.slice(0, len - (len % 4)));
      const b = i => bin.charCodeAt(i);
      if (/png/i.test(m[1])) return { w: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0, h: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0 };
      for (let i = 2; i + 9 < bin.length;) {
        if (b(i) !== 0xFF) { i++; continue; }
        const mk = b(i + 1);
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { h: b(i + 5) << 8 | b(i + 6), w: b(i + 7) << 8 | b(i + 8) };
        i += 2 + (b(i + 2) << 8 | b(i + 3));
      }
    } catch (e) { /* illisible */ }
    return null;
  }

  /**
   * Remplace un <text> par un <path> : le texte est dessiné avec la police installée,
   * à 30 px/mm, puis ses contours sont tracés (même moteur que la vectorisation d'image).
   */
  async function textToPath(t, k, d) {
    const el = t.el; let bb;
    try { bb = el.getBBox(); } catch (e) { return false; }
    if (!(bb.width > 0 && bb.height > 0)) return false;
    const pad = Math.max(bb.width, bb.height) * 0.05;
    const x0 = bb.x - pad, y0 = bb.y - pad, w = bb.width + 2 * pad, h = bb.height + 2 * pad;
    const unitMm = t.s * k;
    let ppu = 30 * unitMm;                                   // pixels par unité locale
    ppu = Math.max(Math.min(ppu, 4000 / w, 4000 / h), Math.min(8, 4000 / w, 4000 / h));
    const W = Math.max(1, Math.ceil(w * ppu)), H = Math.max(1, Math.ceil(h * ppu));
    const PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'letter-spacing', 'word-spacing',
      'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'writing-mode', 'text-decoration', 'white-space'];
    const inline = (src, dst) => {
      const cs = getComputedStyle(src);
      dst.removeAttribute('class');
      dst.setAttribute('style', PROPS.map(p => p + ':' + cs.getPropertyValue(p)).join(';') + ';fill:#000;stroke:none');
    };
    const clone = el.cloneNode(true);
    inline(el, clone);
    const src = el.querySelectorAll('*'), dst = clone.querySelectorAll('*');
    src.forEach((s, i) => { if (dst[i]) inline(s, dst[i]); });
    clone.removeAttribute('transform');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="' + [x0, y0, w, h].join(' ') + '">' + new XMLSerializer().serializeToString(clone) + '</svg>';
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.drawImage(img, 0, 0, W, H);
    // champ continu : le bord est pris au milieu de l'anticrénelage, donc lisse
    const px = c.getImageData(0, 0, W, H).data, field = new Float32Array(W * H);
    for (let i = 0; i < field.length; i++) field[i] = 128 - px[4 * i];
    const v = LC.vectorize.vectorizeField(field, W, H, 1 / ppu, { tolPx: 0.4, smooth: true, minAreaMm2: 0, ox: x0, oy: y0 });
    if (!v.count) return false;
    const target = byId(d, t.id); if (!target) return false;
    const p = d.createElementNS(NS, 'path');
    p.setAttribute('d', v.d); p.setAttribute('fill-rule', 'evenodd'); p.setAttribute('data-lc-text', '1');
    if (target.getAttribute('transform')) p.setAttribute('transform', target.getAttribute('transform'));
    if (target.getAttribute('id')) p.setAttribute('id', target.getAttribute('id'));
    const cs = getComputedStyle(el), fill = parseColor(cs.fill), stroke = parseColor(cs.stroke);
    p.setAttribute('style', 'fill:' + (fill && !fill.other ? fill.hex : stroke ? 'none' : '#000000') +
      (stroke && !stroke.other ? ';stroke:' + stroke.hex + ';stroke-width:' + parseFloat(cs.strokeWidth) : ';stroke:none'));
    target.replaceWith(p);
    return true;
  }

  /** Ferme des sous-chemins (Z ajouté) ou transforme une polyligne en polygone. Renvoie le nombre fermé. */
  function closeRecs(d, recs) {
    const byEl = new Map();
    for (const r of recs) { if (!byEl.has(r.id)) byEl.set(r.id, []); byEl.get(r.id).push(r); }
    let done = 0;
    for (const [id, rs] of byEl) {
      const el = byId(d, id); if (!el) continue;
      if (el.localName === 'path') {
        let dd = el.getAttribute('d');
        for (const r of rs.slice().sort((x, y) => y.endIdx - x.endIdx)) { dd = dd.slice(0, r.endIdx) + 'Z' + dd.slice(r.endIdx); done++; }
        el.setAttribute('d', dd);
      } else if (el.localName === 'polyline') {
        const pg = d.createElementNS(NS, 'polygon');
        for (const at of [...el.attributes]) pg.setAttributeNS(at.namespaceURI, at.name, at.value);
        el.replaceWith(pg); done++;
      }
    }
    return done;
  }

  /* ---------- Parcours du rendu ---------- */

  /** Éléments visibles du rendu, avec leur matrice vers le repère racine et leur boîte englobante. */
  function collect(root, rootInv) {
    const shapes = [], texts = [], images = [], hiddenRoots = [];
    const info = el => {
      const M = rootInv.multiply(el.getScreenCTM());
      let bb; try { bb = el.getBBox(); } catch (e) { bb = { x: 0, y: 0, width: 0, height: 0 }; }
      const c = [tp(M, bb.x, bb.y), tp(M, bb.x + bb.width, bb.y), tp(M, bb.x, bb.y + bb.height), tp(M, bb.x + bb.width, bb.y + bb.height)];
      const box = { x0: Math.min(...c.map(p => p.x)), y0: Math.min(...c.map(p => p.y)), x1: Math.max(...c.map(p => p.x)), y1: Math.max(...c.map(p => p.y)) };
      return { M, s: Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)), box };
    };
    const walk = (parent, hiddenAnc) => {
      for (const el of parent.children) {
        // les éléments ajoutés par l'aperçu (page, surimpression) n'ont pas d'identifiant : on les ignore
        if (el.namespaceURI !== NS || NON_RENDER.has(el.localName) || !el.hasAttribute('data-lc')) continue;
        const cs = getComputedStyle(el);
        const id = el.getAttribute('data-lc');
        const selfHidden = cs.display === 'none' || parseFloat(cs.opacity) === 0;
        if (selfHidden && !hiddenAnc) hiddenRoots.push(id);
        const hidden = hiddenAnc || selfHidden;
        if (hidden) { walk(el, true); continue; }
        const tag = el.localName;
        if (GEOM.has(tag)) {
          const stroke = parseColor(cs.stroke), fill = parseColor(cs.fill);
          if (cs.visibility === 'hidden' || (!stroke && !fill)) { hiddenRoots.push(id); continue; }
          shapes.push(Object.assign({ el, id, tag, cs, stroke, fill, sw: parseFloat(cs.strokeWidth) || 0 }, info(el)));
        } else if (tag === 'text' || tag === 'flowRoot') {
          texts.push(Object.assign({ el, id, fill: parseColor(cs.fill) }, info(el)));
          continue;
        } else if (tag === 'image') {
          images.push(Object.assign({ el, id }, info(el)));
        } else if (tag === 'use') {
          shapes.push(Object.assign({ el, id, tag, cs, stroke: parseColor(cs.stroke), fill: parseColor(cs.fill), sw: 0, isUse: true }, info(el)));
        }
        walk(el, false);
      }
    };
    walk(root, false);
    return { shapes, texts, images, hiddenRoots };
  }

  function closedShape(s) {
    if (s.tag === 'rect' || s.tag === 'circle' || s.tag === 'ellipse' || s.tag === 'polygon') return true;
    if (s.tag === 'path') { const subs = parsePathD(s.el.getAttribute('d') || ''); return subs.length > 0 && subs.every(x => x.closed); }
    return false;
  }

  /* ---------- Doublons et détails trop fins : échantillonnage + grille de segments ---------- */

  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /**
   * geoms : formes visibles ; k : mm par unité ; kerf : largeur de coupe (mm) ; isCut[i] : forme à couper.
   * Renvoie cover[a] (formes qui recouvrent entièrement a), les points de détails trop fins et les formes concernées.
   */
  function proximity(geoms, k, kerf, isCut) {
    const DUP = 0.06, thin = 2 * kerf, R = Math.max(thin, DUP);
    const lens = geoms.map(g => { try { return g.el.getTotalLength() * g.s * k; } catch (e) { return 0; } });
    const total = lens.reduce((a, b) => a + b, 0);
    const baseStep = Math.max(0.2, total / 250000);    // ≈ 250 000 points maximum
    const smp = geoms.map((g, gi) => {
      const Lmm = lens[gi]; if (!(Lmm > 0)) return null;
      const n = Math.max(8, Math.min(8000, Math.ceil(Lmm / baseStep) + 1));
      const L = Lmm / (g.s * k), pts = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const p = g.el.getPointAtLength(L * i / (n - 1)), q = tp(g.M, p.x, p.y);
        pts[2 * i] = q.x * k; pts[2 * i + 1] = q.y * k;
      }
      // Découpe en sous-chemins (un « saut » entre deux échantillons = nouveau sous-chemin) :
      // la distance le long du tracé se mesure à l'intérieur d'un même sous-chemin, en faisant le tour s'il est fermé.
      const step = Lmm / (n - 1), run = new Int32Array(n), runs = [];
      for (let i = 1, r0 = 0; i <= n; i++) {
        if (i === n || Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]) > 3 * step + 0.01) {
          const e = i - 1;
          runs.push({ len: e - r0, closed: Math.hypot(pts[2 * r0] - pts[2 * e], pts[2 * r0 + 1] - pts[2 * e + 1]) <= 2 * step + 0.01 });
          for (let q = r0; q <= e; q++) run[q] = runs.length - 1;
          r0 = i;
        }
      }
      return { pts, n, step, run, runs };
    });
    const CELL = 1, grid = new Map();
    const key = (cx, cy) => cx * 73856093 ^ cy * 19349663;
    smp.forEach((s, b) => {
      if (!s) return;
      for (let j = 0; j + 1 < s.n; j++) {
        const x1 = s.pts[2 * j], y1 = s.pts[2 * j + 1], x2 = s.pts[2 * j + 2], y2 = s.pts[2 * j + 3];
        if (Math.hypot(x2 - x1, y2 - y1) > 3 * s.step + 0.01) continue;   // saut entre sous-chemins
        const cx0 = Math.floor((Math.min(x1, x2) - R) / CELL), cx1 = Math.floor((Math.max(x1, x2) + R) / CELL);
        const cy0 = Math.floor((Math.min(y1, y2) - R) / CELL), cy1 = Math.floor((Math.max(y1, y2) + R) / CELL);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
          const kk = key(cx, cy); let arr = grid.get(kk); if (!arr) grid.set(kk, arr = []);
          arr.push(b, j, x1, y1, x2, y2);
        }
      }
    });
    const cover = geoms.map(() => new Set()), marks = new Map(), thinEls = new Set();
    const minD = new Map(), minSeg = new Map();
    smp.forEach((s, a) => {
      if (!s) return;
      const counts = new Map(), arcThr = Math.max(1, 6 * thin);
      for (let i = 0; i < s.n; i++) {
        const x = s.pts[2 * i], y = s.pts[2 * i + 1];
        const arr = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL))); if (!arr) continue;
        // direction locale de a, pour ne garder que les bords parallèles (pas les jonctions)
        const i0 = Math.max(0, i - 1), i1 = Math.min(s.n - 1, i + 1);
        const ux = s.pts[2 * i1] - s.pts[2 * i0], uy = s.pts[2 * i1 + 1] - s.pts[2 * i0 + 1], ul = Math.hypot(ux, uy) || 1;
        const parallel = j => { const vx = arr[j + 4] - arr[j + 2], vy = arr[j + 5] - arr[j + 3]; return Math.abs(ux * vx + uy * vy) / (ul * (Math.hypot(vx, vy) || 1)) > 0.85; };
        minD.clear(); minSeg.clear(); let selfThin = false;
        for (let j = 0; j < arr.length; j += 6) {
          const b = arr[j], d = segDist(x, y, arr[j + 2], arr[j + 3], arr[j + 4], arr[j + 5]);
          if (b === a) {
            if (!isCut[a] || d >= thin || !parallel(j)) continue;
            const jj = arr[j + 1];
            // deux sous-chemins différents (contour et trou d'une lettre, deux lettres) trop proches : vrai détail fin
            if (s.run[i] !== s.run[jj]) { selfThin = true; continue; }
            const R = s.runs[s.run[i]];
            let ad = Math.abs(i - jj); if (R.closed) ad = Math.min(ad, R.len - ad);
            if (ad * s.step > arcThr) selfThin = true;
            continue;
          }
          const prev = minD.get(b);
          if (prev === undefined || d < prev) { minD.set(b, d); minSeg.set(b, j); }
        }
        let gap = false;
        for (const [b, d] of minD) {
          if (d <= DUP) counts.set(b, (counts.get(b) || 0) + 1);
          else if (d < thin && isCut[a] && isCut[b] && parallel(minSeg.get(b))) { gap = true; thinEls.add(b); }
        }
        if (gap || selfThin) {
          thinEls.add(a);
          const mk = Math.round(x / 0.5) + ',' + Math.round(y / 0.5);
          if (!marks.has(mk)) marks.set(mk, { x: x / k, y: y / k });
        }
      }
      for (const [b, c] of counts) if (c / s.n >= 0.97) cover[a].add(b);
    });
    return { cover, thinMarks: [...marks.values()], thinEls };
  }

  /* ---------- Conversion en polylignes (export DXF) ---------- */

  function polylinesOf(s, k) {
    const el = s.el, T = (x, y) => tp(s.M, x, y);
    const num = a => parseFloat(el.getAttribute(a)) || 0;
    if (s.tag === 'line') return [{ pts: [T(num('x1'), num('y1')), T(num('x2'), num('y2'))], closed: false }];
    if (s.tag === 'polyline' || s.tag === 'polygon') return [{ pts: parsePoints(el.getAttribute('points')).map(p => T(p.x, p.y)), closed: s.tag === 'polygon' }];
    if (s.tag === 'rect' && !(num('rx') > 0 || num('ry') > 0)) {
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      return [{ pts: [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)], closed: true }];
    }
    if (s.tag === 'path') {
      const subs = parsePathD(el.getAttribute('d') || '');
      if (subs.length && subs.every(sp => !sp.curved)) return subs.map(sp => ({ pts: sp.pts.map(p => T(p.x, p.y)), closed: sp.closed }));
    }
    // courbes : échantillonnage tous les 0,1 mm environ
    let L; try { L = el.getTotalLength(); } catch (e) { return []; }
    const Lmm = L * s.s * k; if (!(Lmm > 0)) return [];
    const n = Math.max(8, Math.min(40000, Math.ceil(Lmm / 0.1) + 1));
    const stepRoot = L * s.s / (n - 1);
    const runs = []; let cur = [];
    for (let i = 0; i < n; i++) {
      const p = el.getPointAtLength(L * i / (n - 1)), q = T(p.x, p.y);
      if (cur.length && Math.hypot(q.x - cur[cur.length - 1].x, q.y - cur[cur.length - 1].y) > 3 * stepRoot) { runs.push(cur); cur = []; }
      cur.push(q);
    }
    runs.push(cur);
    return runs.filter(r => r.length > 1).map(r => {
      const f = r[0], l = r[r.length - 1], closed = Math.hypot(f.x - l.x, f.y - l.y) <= 2 * stepRoot;
      if (closed && Math.hypot(f.x - l.x, f.y - l.y) < stepRoot * 0.01) r.pop();
      return { pts: r, closed };
    });
  }
  /* ---------- Analyse ---------- */

  function analyze(ctx) {
    const { doc, root, dpi, origin, settings, colorOps } = ctx;
    const ack = ctx.ack || new Set();                     // éléments marqués « gravure + découpe voulues »
    // Problèmes de chaque élément, avec leur correction propre (tableau « élément par élément »)
    const EP = new Map();
    const addP = (id, p) => { if (!EP.has(id)) EP.set(id, []); const l = EP.get(id); if (!l.some(q => q.key === p.key && q.label === p.label)) l.push(p); };
    const removeEl = (id, msg) => ({ id: 'remove', label: 'Supprimer', fn: d => { const el = byId(d, id); if (!el) return null; el.remove(); return msg; } });
    const U = units(doc, dpi);
    if (!U.ok) throw new Error(U.error);
    const k = U.mmPerUser;
    const rootCTM = root.getScreenCTM();
    if (!rootCTM) throw new Error("L'aperçu n'a pas pu être affiché.");
    const rootInv = rootCTM.inverse();
    const issues = [];

    const { shapes, texts, images, hiddenRoots } = collect(root, rootInv);
    const geoms = shapes.filter(s => !s.isUse);
    const boxMm = b => ({ w: (b.x1 - b.x0) * k, h: (b.y1 - b.y0) * k });
    const visibleAll = [...shapes, ...texts, ...images];

    // --- Usage du fichier : découpe, gravure ou les deux (détecté ou choisi) ---
    const nStroke = geoms.filter(s => s.stroke).length;
    const nFill = geoms.filter(s => s.fill && !s.stroke).length + texts.length + images.length;
    const autoUsage = nStroke && !nFill ? 'coupe' : nFill && !nStroke ? 'gravure' : 'mixte';
    const usage = ctx.usage && ctx.usage !== 'auto' ? ctx.usage : autoUsage;
    const strokeOp = c => colorOps[c.hex] || (usage === 'gravure' ? 'marquage' : opGuess(c));

    // --- 1. Échelle / DPI ---
    {
      const altDpi = dpi === 72 ? 96 : 72;
      if (U.absolute) {
        issues.push({ key: 'scale', check: 1, level: 'ok', title: 'Échelle : unités réelles',
          detail: 'Largeur « ' + U.wLabel + ' », hauteur « ' + U.hLabel + ' » : la taille est la même dans tous les logiciels.' });
      } else {
        const ratio = dpi / altDpi;
        const other = U.widthMm * ratio;
        const pct = Math.round(Math.abs(ratio - 1) * 100);
        issues.push({
          key: 'scale', check: 1, level: 'bad', title: 'Échelle ambiguë : pas d’unité réelle',
          detail: 'Largeur « ' + U.wLabel + ' » sans unité physique. Fichier ' + ORIGIN_LABEL[origin] + ' → lu à ' + dpi + ' DPI, soit ' +
            fmt(U.widthMm) + ' × ' + fmt(U.heightMm) + ' mm. Un logiciel qui le lit à ' + altDpi + ' DPI produira une pièce de ' +
            fmt(other) + ' mm de large, ' + pct + ' % trop ' + (ratio > 1 ? 'grande' : 'petite') + '.',
          fix: { label: 'Convertir en mm', fn: d => { setMm(d, U, U.widthMm, U.heightMm); return 'Échelle convertie de ' + dpi + ' DPI vers mm (' + fmt(U.widthMm) + ' × ' + fmt(U.heightMm) + ' mm)'; } }
        });
      }
    }

    // --- 2. Dimensions ---
    {
      let cb = null;
      for (const s of visibleAll) {
        const b = s.box; if (!cb) cb = Object.assign({}, b);
        else { cb.x0 = Math.min(cb.x0, b.x0); cb.y0 = Math.min(cb.y0, b.y0); cb.x1 = Math.max(cb.x1, b.x1); cb.y1 = Math.max(cb.y1, b.y1); }
      }
      U.extent = cb;
      const c = cb ? boxMm(cb) : { w: 0, h: 0 };
      const W = Math.max(U.widthMm, c.w), H = Math.max(U.heightMm, c.h);
      const bw = settings.bedW, bh = settings.bedH;
      const fits = W <= bw && H <= bh, fitsRot = H <= bw && W <= bh;
      const base = 'Page ' + fmt(U.widthMm) + ' × ' + fmt(U.heightMm) + ' mm, contenu ' + fmt(c.w) + ' × ' + fmt(c.h) + ' mm. Plateau' + (settings.profileName ? ' ' + settings.profileName : '') + ' : ' + fmt(bw, 0) + ' × ' + fmt(bh, 0) + ' mm.';
      issues.push({
        key: 'dims', check: 2, level: fits ? 'ok' : fitsRot ? 'warn' : 'bad',
        title: fits ? 'Dimensions : tient sur le plateau' : fitsRot ? 'Dimensions : tient seulement tourné de 90°' : 'Dimensions : plus grand que le plateau',
        detail: base + (U.absolute ? '' : ' (taille calculée à ' + dpi + ' DPI)'),
        boxes: fits ? [] : cb ? [cb] : [],
        action: fits ? null : { label: 'Redimensionner…', kind: 'resize' }
      });
    }

    // --- 3. Tracés ouverts ---
    {
      const tol = settings.closeTol;
      const closable = [], open = [], marks = [], boxes = [];
      for (const s of geoms) {
        let subs = [];
        if (s.tag === 'path') subs = parsePathD(s.el.getAttribute('d') || '');
        else if (s.tag === 'polyline' || s.tag === 'line') {
          const pts = s.tag === 'line'
            ? [{ x: +s.el.getAttribute('x1') || 0, y: +s.el.getAttribute('y1') || 0 }, { x: +s.el.getAttribute('x2') || 0, y: +s.el.getAttribute('y2') || 0 }]
            : parsePoints(s.el.getAttribute('points'));
          if (pts.length > 1) subs = [{ start: pts[0], end: pts[pts.length - 1], closed: false, line: s.tag === 'line' }];
        }
        for (const sp of subs) {
          if (sp.closed) continue;
          const a = tp(s.M, sp.start.x, sp.start.y), b = tp(s.M, sp.end.x, sp.end.y);
          const gap = Math.hypot(a.x - b.x, a.y - b.y) * k;
          const rec = { id: s.id, tag: s.tag, endIdx: sp.endIdx, gap };
          if (!sp.line && gap <= tol) closable.push(rec); else open.push(rec);
          marks.push(a); if (gap > SAME_POINT_MM) marks.push(b);
          boxes.push(s.box);
        }
      }
      for (const r of closable) addP(r.id, { key: 'open', label: 'presque fermé (écart ' + fmt(r.gap, 2) + ' mm)', lvl: 'warn',
        fix: { id: 'close', label: 'Fermer', fn: d => closeRecs(d, closable.filter(x => x.id === r.id)) ? 'Tracé fermé' : null } });
      for (const r of open) addP(r.id, { key: 'open', label: r.tag === 'line' ? 'ligne ouverte' : 'tracé ouvert', lvl: usage === 'gravure' ? 'info' : 'warn' });
      const n = closable.length + open.length;
      if (!n) issues.push({ key: 'open', check: 3, level: 'ok', title: 'Tracés : tous fermés', detail: 'Aucun tracé ouvert.' });
      else issues.push({
        key: 'open', check: 3, level: usage === 'gravure' ? 'info' : 'warn', title: 'Tracés ouverts : ' + n,
        detail: (usage === 'gravure' ? 'En gravure, une forme ouverte n’est pas remplie (elle est gravée en trait seulement). ' : '') + (closable.length ? plural(closable.length, 'tracé') + ' à moins de ' + fmt(tol, 2) + ' mm de se refermer (fermeture automatique). ' : '') +
          (open.length ? plural(open.length, 'tracé') + ' nettement ouvert' + (open.length > 1 ? 's' : '') + ' : ligne de marquage ou de pliage voulue ? Sinon, à fermer dans votre logiciel.' : ''),
        boxes, marks, ids: [...new Set([...closable, ...open].map(r => r.id))],
        fix: closable.length ? { label: 'Fermer ' + plural(closable.length, 'tracé'), fn: d => {
          const done = closeRecs(d, closable);
          return plural(done, 'tracé') + ' fermé' + (done > 1 ? 's' : '');
        } } : null
      });
    }

    // --- 4. Doublons ---
    {
      const kerf = settings.kerf > 0 ? settings.kerf : 0.1;
      const isCut = geoms.map(s => !!s.stroke && strokeOp(s.stroke) === 'coupe');
      const prox = proximity(geoms, k, kerf, isCut);
      const cover = prox.cover;
      // --- 9. Détails trop fins (calculé ici : même échantillonnage que les doublons) ---
      {
        const thin = 2 * kerf;
        const tiny = geoms.filter((s, i) => isCut[i] && closedShape(s) && Math.max(s.box.x1 - s.box.x0, s.box.y1 - s.box.y0) * k <= thin);
        // regroupe les points distants de moins de 1 mm en zones
        const mp = prox.thinMarks.slice(0, 3000).map(m => [m.x * k, m.y * k]), seen = new Uint8Array(mp.length);
        let zones = 0;
        for (let i = 0; i < mp.length; i++) {
          if (seen[i]) continue;
          zones++; seen[i] = 1; const stack = [i];
          while (stack.length) {
            const a = stack.pop();
            for (let j = 0; j < mp.length; j++) if (!seen[j] && Math.hypot(mp[j][0] - mp[a][0], mp[j][1] - mp[a][1]) <= 1.01) { seen[j] = 1; stack.push(j); }
          }
        }
        for (const t of tiny) addP(t.id, { key: 'thin', label: 'trop petit', lvl: 'warn', fix: removeEl(t.id, 'Pièce minuscule supprimée') });
        for (const i of prox.thinEls) if (!tiny.some(t => t.id === geoms[i].id)) addP(geoms[i].id, { key: 'thin', label: 'trop fin par endroits', lvl: 'warn' });
        if (!zones && !tiny.length) issues.push({ key: 'thin', check: 9, level: 'ok', title: 'Détails : rien de trop fin', detail: 'Aucun écart ni partie de moins de ' + fmt(thin, 2) + ' mm (2 × kerf de ' + fmt(kerf, 2) + ' mm).' });
        else {
          const parts = [];
          if (zones) parts.push(plural(zones, 'zone') + ' où deux lignes de coupe sont à moins de ' + fmt(thin, 2) + ' mm : la matière entre les deux va brûler ou se détacher.');
          if (tiny.length) parts.push(plural(tiny.length, 'pièce') + ' plus petite' + (tiny.length > 1 ? 's' : '') + ' que ' + fmt(thin, 2) + ' mm : elle' + (tiny.length > 1 ? 's' : '') + ' disparaîtra dans le trait de coupe.');
          issues.push({ key: 'thin', check: 9, level: 'warn', title: 'Détails trop fins : ' + (zones + tiny.length),
            detail: parts.join(' ') + ' Élargissez ces parties dans votre logiciel, ou réglez le kerf (Réglages machine).',
            marks: prox.thinMarks.slice(0, 400), boxes: tiny.map(s => s.box),
            ids: [...tiny.map(t => t.id), ...[...prox.thinEls].map(i => geoms[i].id)], tinyIds: tiny.map(t => t.id) });
        }
      }
      const dupOf = new Map(), diffColor = [], partial = [];
      const sameLook = (a, b) => (a.stroke && a.stroke.hex) === (b.stroke && b.stroke.hex) && (a.fill && a.fill.hex) === (b.fill && b.fill.hex);
      for (let a = 0; a < geoms.length; a++) {
        for (const b of cover[a]) {
          if (cover[b].has(a)) {
            if (b <= a) continue;                 // paire traitée une fois, a = le premier dans le document
            if (dupOf.has(geoms[b].id) || dupOf.has(geoms[a].id)) continue;
            if (sameLook(geoms[a], geoms[b])) dupOf.set(geoms[b].id, geoms[a].id);
            else diffColor.push([a, b]);
          } else partial.push([a, b]);             // a est entièrement recouvert par b
        }
      }
      const dupIds = [...dupOf.keys()];
      for (const id of dupIds) addP(id, { key: 'dup', label: 'doublon', lvl: 'bad', fix: removeEl(id, 'Doublon supprimé') });
      for (const p of diffColor) addP(geoms[p[1]].id, { key: 'dup', label: 'superposé (autre couleur)', lvl: 'warn' });
      for (const p of partial) addP(geoms[p[0]].id, { key: 'dup', label: 'recouvert par un autre tracé', lvl: 'warn' });
      const boxes = [...dupIds.map(id => geoms.find(g => g.id === id).box), ...diffColor.map(p => geoms[p[1]].box), ...partial.map(p => geoms[p[0]].box)];
      if (!boxes.length) issues.push({ key: 'dup', check: 4, level: 'ok', title: 'Doublons : aucun', detail: 'Aucun tracé superposé : rien ne sera coupé deux fois.' });
      else {
        const parts = [];
        if (dupIds.length) parts.push(plural(dupIds.length, 'doublon exact') + ' : le laser coupera deux fois au même endroit (bords brûlés, temps perdu).');
        if (diffColor.length) parts.push(plural(diffColor.length, 'tracé') + ' superposé' + (diffColor.length > 1 ? 's' : '') + ' dans une autre couleur : deux opérations au même endroit, voulu ?');
        if (partial.length) parts.push(plural(partial.length, 'segment') + ' recouvert' + (partial.length > 1 ? 's' : '') + ' par un autre tracé (bords communs).');
        issues.push({
          key: 'dup', check: 4, level: dupIds.length ? 'bad' : 'warn', title: 'Doublons : ' + (dupIds.length + diffColor.length + partial.length),
          detail: parts.join(' '), boxes, ids: [...dupIds, ...diffColor.map(p => geoms[p[1]].id), ...partial.map(p => geoms[p[0]].id)], dupIds,
          fix: dupIds.length ? { label: 'Supprimer ' + plural(dupIds.length, 'doublon'), fn: d => {
            let n = 0; for (const id of dupIds) { const el = byId(d, id); if (el) { el.remove(); n++; } }
            return plural(n, 'doublon') + ' supprimé' + (n > 1 ? 's' : '');
          } } : null
        });
      }
    }

    // --- 5. Texte non vectorisé ---
    {
      const tip = { inkscape: 'Inkscape : Chemin > Objet en chemin', illustrator: 'Illustrator : Texte > Vectoriser', affinity: 'Affinity : Calque > Convertir en courbes', autre: 'Convertissez le texte en chemins (« Objet en chemin », « Vectoriser »)' }[origin];
      const advice = 'Pour un tracé parfaitement fidèle à la police, le mieux reste de vectoriser dans votre logiciel de dessin (' + tip + '). ' +
        'KleanPath redessine le texte à partir d’un rendu très fin : le résultat est très proche, mais pas identique au tracé de la police.';
      const vtext = geoms.filter(g => g.el.hasAttribute('data-lc-text'));
      for (const g of vtext) addP(g.id, { key: 'vtext', label: 'vectorisé par KleanPath', lvl: 'info', zoom: true });
      if (vtext.length) issues.push({ key: 'vtext', check: 5, level: 'info', title: 'Texte vectorisé par KleanPath : ' + vtext.length,
        detail: 'Vérifiez le résultat de près avant la découpe. ' + advice,
        boxes: vtext.map(g => g.box), action: { label: 'Voir de près', kind: 'zoom', key: 'vtext' } });
      if (!texts.length) { if (!vtext.length) issues.push({ key: 'text', check: 5, level: 'ok', title: 'Texte : tout est vectorisé', detail: 'Aucun texte éditable.' }); }
      else {
        const fonts = [...new Set(texts.map(t => getComputedStyle(t.el).fontFamily.split(',')[0].replace(/["']/g, '').trim()).filter(Boolean))];
        const missing = fonts.filter(f => !fontAvailable(f));
        for (const t of texts) addP(t.id, { key: 'text', label: 'non vectorisé', lvl: 'bad', fix: { id: 'vectorize', label: 'Vectoriser',
          confirm: missing.length ? 'Police absente de cet ordinateur : ' + missing.join(', ') + '.\n\nLe texte sera vectorisé avec une police de remplacement : son apparence va changer. Continuer ?' : null,
          fn: async d => (await textToPath(t, k, d)) ? 'Texte vectorisé' + (missing.length ? ' (police de remplacement)' : '') : null } });
        issues.push({ key: 'text', check: 5, level: 'bad', title: 'Texte non vectorisé : ' + texts.length,
          detail: 'Police' + (fonts.length > 1 ? 's' : '') + ' ' + fonts.join(', ') + ' : si elle manque sur le poste du laser, le texte change ou disparaît. ' +
            (missing.length ? 'Attention : ' + missing.join(', ') + (missing.length > 1 ? ' ne sont pas installées' : ' n’est pas installée') + ' sur cet ordinateur, la vectorisation ici utiliserait une police de remplacement. Mieux vaut : ' + tip + '.'
              : 'KleanPath peut le vectoriser ici, avec la police installée sur cet ordinateur. ' + advice),
          boxes: texts.map(t => t.box), ids: texts.map(t => t.id),
          fix: { label: 'Vectoriser ' + (texts.length > 1 ? 'les textes' : 'le texte'),
            confirm: missing.length ? 'Police absente de cet ordinateur : ' + missing.join(', ') + '.\n\nLe texte sera vectorisé avec une police de remplacement : son apparence va changer. Continuer ?' : null,
            fn: async d => {
              let n = 0; for (const t of texts) if (await textToPath(t, k, d)) n++;
              return plural(n, 'texte') + ' vectorisé' + (n > 1 ? 's' : '') + (missing.length ? ' (police de remplacement pour ' + missing.join(', ') + ')' : '');
            } } });
      }
    }

    // --- 6. Images intégrées ---
    if (!images.length) issues.push({ key: 'img', check: 6, level: 'ok', title: 'Images intégrées : aucune', detail: 'Le fichier ne contient que des vecteurs.' });
    else if (usage === 'coupe') issues.push({ key: 'img', check: 6, level: 'warn', title: 'Images intégrées : ' + images.length,
      detail: 'Dans un fichier de découpe, une image sera gravée en raster, ou ignorée, selon le logiciel. Vectorisez-la, ou préparez-la à part en déposant le PNG/JPG dans KleanPath.',
      boxes: images.map(t => t.box) });
    else {
      // Gravure : on vérifie la résolution réelle de chaque image
      const res = images.map(t => { const px = imagePixels(t.el); const wMm = (t.box.x1 - t.box.x0) * k; return px && wMm > 0 ? Math.round(px.w / (wMm / 25.4)) : null; });
      const low = images.filter((t, i) => res[i] !== null && res[i] < 150);
      const known = res.filter(r => r !== null);
      issues.push({ key: 'img', check: 6, level: low.length ? 'warn' : 'info', title: low.length ? 'Images trop peu résolues : ' + low.length : 'Images gravées : ' + images.length,
        detail: (known.length ? 'Résolution à la taille gravée : ' + known.map(r => r + ' DPI').join(', ') + '. ' : '') +
          (low.length ? 'Sous 150 DPI, la gravure sera floue ou pixelisée : agrandissez l’image source ou réduisez sa taille. ' : '') +
          'Pour un meilleur résultat, préparez l’image (tramage) en déposant le PNG/JPG dans KleanPath.',
        boxes: (low.length ? low : images).map(t => t.box) });
    }

    images.forEach(t => {
      const px = imagePixels(t.el), wMm = (t.box.x1 - t.box.x0) * k, dpiImg = px && wMm > 0 ? Math.round(px.w / (wMm / 25.4)) : null;
      if (usage === 'coupe') addP(t.id, { key: 'img', label: 'image dans un fichier de découpe', lvl: 'warn' });
      else if (dpiImg !== null && dpiImg < 150) addP(t.id, { key: 'img', label: dpiImg + ' DPI : trop peu résolue', lvl: 'warn' });
      else if (dpiImg !== null) addP(t.id, { key: 'img', label: dpiImg + ' DPI', lvl: 'info' });
    });

    // --- 7. Couleurs et calques ---
    const colors = new Map();
    const addColor = (c, kind, s) => {
      if (!c || c.other) return;
      const key = kind + c.hex;
      if (!colors.has(key)) colors.set(key, { hex: c.hex, c, kind, count: 0, ids: [] });
      const e = colors.get(key); e.count++; e.ids.push(s.id);
    };
    for (const s of geoms) { addColor(s.stroke, 'trait', s); if (s.fill && !s.stroke) addColor(s.fill, 'remplissage', s); else if (s.fill) addColor(s.fill, 'remplissage', s); }
    for (const t of texts) addColor(t.fill, 'remplissage', t);
    const list = [...colors.values()].sort((a, b) => (a.kind > b.kind ? -1 : a.kind < b.kind ? 1 : b.count - a.count));
    const opOf = hex => { const c = list.find(x => x.hex === hex && x.kind === 'trait'); return c ? strokeOp(c.c) : (colorOps[hex] || 'gravure'); };
    for (const c of list) c.op = c.kind === 'trait' ? opOf(c.hex) : (colorOps['fill' + c.hex] || 'gravure');
    {
      const strokes = list.filter(c => c.kind === 'trait');
      const parent = strokes.map((_, i) => i);
      const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < strokes.length; i++) for (let j = i + 1; j < strokes.length; j++) {
        const a = strokes[i].c, b = strokes[j].c;
        if (Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) <= 12) parent[find(j)] = find(i);
      }
      const groups = new Map();
      strokes.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
      const near = [...groups.values()].filter(g => g.length > 1);
      const detail = plural(strokes.length, 'couleur') + ' de trait, ' + plural(list.length - strokes.length, 'couleur') + ' de remplissage. Associez chaque couleur à une opération : le choix s’applique à tous les éléments de cette couleur (pour un seul élément, utilisez le tableau Éléments).';
      const issue = { key: 'colors', check: 7, level: near.length ? 'warn' : 'info', title: near.length ? 'Couleurs presque identiques : ' + near.length + ' groupe' + (near.length > 1 ? 's' : '') : 'Couleurs et calques',
        detail: near.length ? near.map(g => g.map(c => c.hex).join(' / ')).join(', ') + ' : à l’œil c’est la même couleur, mais le logiciel laser en fera des calques séparés. ' + detail : detail,
        colors: list, boxes: near.flatMap(g => g.slice(1).flatMap(c => c.ids)).map(id => (shapes.find(s => s.id === id) || {}).box).filter(Boolean) };
      if (near.length) issue.fix = { label: 'Fusionner les couleurs', fn: d => {
        let n = 0; const msgs = [];
        for (const g of near) {
          const target = g.slice().sort((a, b) => b.count - a.count)[0];
          for (const c of g) if (c !== target) { for (const id of c.ids) { const el = byId(d, id); if (el) { setStyleProp(el, 'stroke', target.hex); n++; } } msgs.push(c.hex + ' → ' + target.hex); }
        }
        return plural(near.reduce((a, g) => a + g.length - 1, 0), 'couleur') + ' fusionnée' + (n > 1 ? 's' : '') + ' (' + msgs.join(', ') + ')';
      } };
      issues.push(issue);
    }

    // --- 8. Épaisseur de trait et remplissages sur la coupe ---
    {
      const cut = geoms.filter(s => s.stroke && opOf(s.stroke.hex) === 'coupe');
      const thick = cut.filter(s => s.sw * s.s * k > THICK_MM + 1e-9);
      for (const t of thick) addP(t.id, { key: 'thick', label: 'trait épais (' + fmt(t.sw * t.s * k, 2) + ' mm)', lvl: 'warn',
        fix: { id: 'hairline', label: 'Trait fin', fn: d => { const el = byId(d, t.id); if (!el) return null; setStyleProp(el, 'stroke-width', num(HAIRLINE_MM / (t.s * k), 6)); return 'Trait passé à 0,01 mm'; } } });
      if (!thick.length) issues.push({ key: 'thick', check: 8, level: 'ok', title: 'Traits de coupe : fins', detail: cut.length ? 'Tous les traits de coupe font ' + fmt(THICK_MM, 2) + ' mm ou moins.' : 'Aucune couleur associée à la coupe.' });
      else {
        const max = Math.max(...thick.map(s => s.sw * s.s * k));
        issues.push({ key: 'thick', check: 8, level: 'warn', title: 'Traits de coupe épais : ' + thick.length,
          detail: 'Jusqu’à ' + fmt(max, 2) + ' mm. Certains logiciels (Glowforge, xTool) traitent un trait épais comme une gravure, et l’aperçu ne montre plus la vraie ligne de coupe.',
          boxes: thick.map(s => s.box), ids: thick.map(t => t.id),
          fix: { label: 'Passer en trait fin (0,01 mm)', fn: d => {
            let n = 0; for (const s of thick) { const el = byId(d, s.id); if (el) { setStyleProp(el, 'stroke-width', num(HAIRLINE_MM / (s.s * k), 6)); n++; } }
            return plural(n, 'trait') + ' passé' + (n > 1 ? 's' : '') + ' à 0,01 mm';
          } } });
      }
      const filledAll = cut.filter(s => s.fill), filled = filledAll.filter(s => !ack.has(s.id));
      const accepted = filledAll.length - filled.length;
      for (const t of filled) addP(t.id, { key: 'fill', label: 'gravure + découpe ?', lvl: 'warn' });
      if (!filled.length && accepted) issues.push({ key: 'fill', check: 8, level: 'ok', title: 'Gravure + découpe voulues : ' + accepted,
        detail: 'Ces formes seront gravées puis découpées, comme vous l’avez indiqué.', ids: filledAll.map(s => s.id) });
      if (filled.length) {
        const nf = plural(filled.length, 'forme');
        const noFill = { id: 'nofill', label: 'Retirer le remplissage (garder la découpe)',
          confirm: 'Retirer le remplissage de ' + nf + ' ?\n\nElles seront seulement découpées, plus gravées.',
          fn: d => { let n = 0; for (const s of filled) { const el = byId(d, s.id); if (el) { setStyleProp(el, 'fill', 'none'); n++; } } return plural(n, 'remplissage') + ' retiré' + (n > 1 ? 's' : '') + ' (découpe seule)'; } };
        const noStroke = { id: 'nostroke', label: 'Retirer le trait de coupe (garder la gravure)',
          confirm: 'Retirer le trait de coupe de ' + nf + ' ?\n\nElles seront seulement gravées, plus découpées.',
          fn: d => { let n = 0; for (const s of filled) { const el = byId(d, s.id); if (el) { setStyleProp(el, 'stroke', 'none'); n++; } } return plural(n, 'trait') + ' de coupe retiré' + (n > 1 ? 's' : '') + ' (gravure seule)'; } };
        // le choix proposé en premier dépend du mode choisi
        const first = usage === 'gravure' ? noStroke : noFill;
        issues.push({ key: 'fill', check: 8, level: 'warn', title: 'Gravure et découpe sur les mêmes formes : ' + filled.length,
          detail: 'Ces formes ont un trait de coupe et un remplissage : le laser va graver la zone, puis la découper. ' +
            (usage === 'gravure' ? 'Pour un fichier de gravure, retirez plutôt le trait de coupe.' : usage === 'coupe' ? 'Pour un fichier de découpe, retirez plutôt le remplissage.' : 'Choisissez ce que vous voulez garder, ou laissez tel quel si c’est voulu.'),
          boxes: filled.map(s => s.box), ids: filled.map(s => s.id), fix: first, altFix: first === noFill ? noStroke : noFill,
          action: { label: 'C’est voulu (garder les deux)', kind: 'ack', ids: filled.map(s => s.id) } });
      }
    }

    // --- 10. Nettoyage ---
    {
      const editorEls = [], comments = [];
      let editorAttrs = 0;
      for (const el of doc.getElementsByTagName('*')) {
        if (EDITOR_NS.has(el.namespaceURI) || (el.namespaceURI === NS && el.localName === 'metadata')) { editorEls.push(el.getAttribute('data-lc')); continue; }
        for (const at of el.attributes) if (EDITOR_NS.has(at.namespaceURI) || (at.prefix === 'xmlns' && EDITOR_NS.has(at.value))) editorAttrs++;
      }
      const tw = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT); while (tw.nextNode()) comments.push(tw.currentNode);
      const emptyGroups = [...doc.getElementsByTagNameNS(NS, 'g')].filter(g => !g.firstElementChild).length;
      const P = U.page;
      const off = visibleAll.filter(s => s.box.x1 < P.x0 || s.box.x0 > P.x1 || s.box.y1 < P.y0 || s.box.y0 > P.y1);
      for (const t of off) addP(t.id, { key: 'clean', label: 'hors page', lvl: 'warn', fix: removeEl(t.id, 'Objet hors page supprimé') });
      const parts = [];
      if (editorEls.length || editorAttrs || comments.length) parts.push('métadonnées d’éditeur (' + (editorEls.length + editorAttrs + comments.length) + ')');
      if (emptyGroups) parts.push(plural(emptyGroups, 'groupe') + ' vide' + (emptyGroups > 1 ? 's' : ''));
      if (hiddenRoots.length) parts.push(plural(hiddenRoots.length, 'objet') + ' invisible' + (hiddenRoots.length > 1 ? 's' : '') + ' (calque masqué, sans trait ni remplissage)');
      if (off.length) parts.push(plural(off.length, 'objet') + ' hors page');
      if (!parts.length) issues.push({ key: 'clean', check: 10, level: 'ok', title: 'Nettoyage : rien à faire', detail: 'Pas de métadonnées, de groupes vides ni d’objets cachés.' });
      else issues.push({ key: 'clean', check: 10, level: 'info', title: 'Nettoyage possible',
        detail: parts.join(', ') + '. Les objets cachés ou hors page peuvent quand même être envoyés au laser selon le logiciel.',
        boxes: off.map(s => s.box), ids: off.map(s => s.id),
        fix: { label: 'Nettoyer', fn: d => {
          const r = cleanEditor(d);
          let n = 0; for (const id of [...hiddenRoots, ...off.map(s => s.id)]) { const el = byId(d, id); if (el) { el.remove(); n++; } }
          const g = removeEmptyGroups(d);
          const m = [];
          if (r) m.push(plural(r, 'métadonnée') + ' d’éditeur');
          if (n) m.push(plural(n, 'objet') + ' caché' + (n > 1 ? 's' : '') + ' ou hors page');
          if (g) m.push(plural(g, 'groupe') + ' vide' + (g > 1 ? 's' : ''));
          return 'Nettoyage : ' + (m.join(', ') || 'rien') + ' supprimé' + (r + n + g > 1 ? 's' : '');
        } } });
    }

    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    issues.sort((a, b) => order[a.level] - order[b.level] || a.check - b.check);
    // opération de chaque élément (pour la gravure en PNG)
    const elOps = {};
    for (const s of geoms) elOps[s.id] = { stroke: s.stroke ? strokeOp(s.stroke) : null, fill: s.fill ? (colorOps['fill' + s.fill.hex] || 'gravure') : null };
    for (const t of texts) elOps[t.id] = { stroke: null, fill: t.fill ? (colorOps['fill' + t.fill.hex] || 'gravure') : null };

    // Éléments un par un (panneau « découpe ou gravure ») : textes, puis formes
    const NAMES = { rect: 'Rectangle', circle: 'Cercle', ellipse: 'Ellipse', line: 'Ligne', polyline: 'Ligne brisée', polygon: 'Polygone', path: 'Tracé' };
    const dims = b => fmt((b.x1 - b.x0) * k) + ' × ' + fmt((b.y1 - b.y0) * k) + ' mm';
    const modeOf = (stroke, fill, sOp, fOp) => {
      const cut = !!stroke && sOp === 'coupe', grav = (!!fill && fOp === 'gravure') || (!!stroke && sOp === 'gravure');
      return cut && grav ? 'both' : cut ? 'coupe' : grav ? 'gravure' : stroke && sOp === 'marquage' ? 'marquage' : 'autre';
    };
    const elements = [];
    for (const t of texts) {
      const st = parseColor(getComputedStyle(t.el).stroke);
      elements.push({ id: t.id, kind: 'text', box: t.box, open: false, colors: [t.fill && !t.fill.other ? t.fill.hex : null].filter(Boolean),
        label: '« ' + ((t.el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) || 'texte') + ' »',
        mode: modeOf(st, t.fill, st ? strokeOp(st) : null, elOps[t.id].fill) });
    }
    for (const g of geoms) {
      const vt = g.el.hasAttribute('data-lc-text');
      const w = (g.box.x1 - g.box.x0) * k, hh = (g.box.y1 - g.box.y0) * k;
      elements.push({ id: g.id, kind: vt ? 'text' : 'shape', box: g.box, open: !closedShape(g),
        colors: [g.stroke && !g.stroke.other ? g.stroke.hex : null, g.fill && !g.fill.other ? g.fill.hex : null].filter(Boolean),
        label: vt ? 'Texte vectorisé · ' + dims(g.box) : g.tag === 'circle' ? 'Cercle Ø ' + fmt(w) + ' mm'
          : g.tag === 'line' ? 'Ligne · ' + fmt(Math.hypot(w, hh)) + ' mm' : (NAMES[g.tag] || 'Forme') + ' · ' + dims(g.box),
        mode: modeOf(g.stroke, g.fill, elOps[g.id].stroke, elOps[g.id].fill) });
    }
    for (const im of images) elements.push({ id: im.id, kind: 'image', box: im.box, open: false, colors: [], label: 'Image · ' + dims(im.box), mode: 'image' });
    for (const e of elements) e.problems = EP.get(e.id) || [];
    return { issues, U, elOps, elements, colors: list, usage: { mode: usage, detected: autoUsage }, stats: { shapes: geoms.length, texts: texts.length, images: images.length } };
  }

  function cleanEditor(doc) {
    let n = 0;
    for (const el of [...doc.getElementsByTagName('*')]) {
      if (!el.isConnected) continue;
      if (EDITOR_NS.has(el.namespaceURI) || (el.namespaceURI === NS && el.localName === 'metadata')) { el.remove(); n++; continue; }
      for (const at of [...el.attributes]) {
        if (EDITOR_NS.has(at.namespaceURI) || (at.prefix === 'xmlns' && EDITOR_NS.has(at.value))) { el.removeAttributeNode(at); n++; }
      }
    }
    const tw = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT); const cm = [];
    while (tw.nextNode()) cm.push(tw.currentNode);
    cm.forEach(c => c.remove()); n += cm.length;
    return n;
  }

  function removeEmptyGroups(doc) {
    let n = 0, again = true;
    while (again) {
      again = false;
      for (const g of [...doc.getElementsByTagNameNS(NS, 'g')]) if (!g.firstElementChild) { g.remove(); n++; again = true; }
    }
    return n;
  }

  /* ---------- Redimensionnement et export ---------- */

  function resize(doc, dpi, wMm) {
    const U = units(doc, dpi);
    const hMm = wMm * U.heightMm / U.widthMm;
    setMm(doc, U, wMm, hMm);
    return 'Redimensionné à ' + fmt(wMm) + ' × ' + fmt(hMm) + ' mm (' + fmt(wMm / U.widthMm * 100, 0) + ' %)';
  }

  function serialize(doc) { return new XMLSerializer().serializeToString(doc); }

  /** Export : pas de métadonnées d'éditeur, pas d'attributs internes. Les unités sont celles du document courant. */
  function exportText(doc) {
    const d = parse(serialize(doc));
    cleanEditor(d);
    for (const el of d.getElementsByTagName('*')) { el.removeAttribute('data-lc'); el.removeAttribute('data-lc-text'); }
    if (!d.documentElement.getAttribute('xmlns:xlink') && d.querySelector('[*|href]')) d.documentElement.setAttribute('xmlns:xlink', XLINK);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(d).replace(/^<\?xml[^>]*>\s*/, '');
  }

  /* ---------- Export DXF (R12, polylignes en mm, un calque par couleur) ---------- */

  const ACI = [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [7, 0, 0, 0], [8, 128, 128, 128], [9, 192, 192, 192]];
  const nearestAci = c => {
    if (!c || c.other) return 7;
    let best = 7, bd = Infinity;
    for (const [n, r, g, b] of ACI) { const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  };

  /** ctx : { doc, root (aperçu affiché), dpi, colorOps } → { text, polylines, skipped } */
  function exportDxf(ctx) {
    const U = units(ctx.doc, ctx.dpi), k = U.mmPerUser, P = U.page;
    const { shapes, texts, images } = collect(ctx.root, ctx.root.getScreenCTM().inverse());
    const out = [], layers = new Map();
    const g = (code, v) => out.push(String(code), String(v));
    const X = p => +((p.x - P.x0) * k).toFixed(4), Y = p => +((P.y1 - p.y) * k).toFixed(4);
    const ents = [];
    for (const s of shapes) {
      if (s.isUse) continue;
      const c = s.stroke || s.fill;
      const op = s.stroke ? (ctx.colorOps[s.stroke.hex] || (ctx.usage === 'gravure' ? 'marquage' : opGuess(s.stroke))) : (ctx.colorOps['fill' + (s.fill && s.fill.hex)] || 'gravure');
      const layer = (op.toUpperCase() + '_' + (c && !c.other ? c.hex.slice(1) : 'MOTIF')).replace(/[^\w]/g, '_');
      if (!layers.has(layer)) layers.set(layer, nearestAci(c));
      for (const pl of polylinesOf(s, k)) if (pl.pts.length > 1) ents.push({ layer, pl });
    }
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, 4);
    g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(9, '$EXTMAX'); g(10, +U.widthMm.toFixed(4)); g(20, +U.heightMm.toFixed(4)); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1); g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0); g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size);
    for (const [name, aci] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, aci); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const { layer, pl } of ents) {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, pl.closed ? 1 : 0);
      for (const p of pl.pts) { g(0, 'VERTEX'); g(8, layer); g(10, X(p)); g(20, Y(p)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return { text: out.join('\r\n') + '\r\n', polylines: ents.length, skipped: { texts: texts.length, images: images.length } };
  }

  /* ---------- Découpe ou gravure, élément par élément ---------- */

  /**
   * op 'coupe'   : trait fin de la couleur de découpe, sans remplissage.
   * op 'gravure' : remplissage (la couleur actuelle si l'élément en a une, sinon celle de la gravure), sans trait.
   * root : aperçu affiché (pour l'échelle de chaque élément). colors : { cut, engrave }.
   */
  function setOps(doc, root, dpi, ids, op, colors) {
    const U = units(doc, dpi), k = U.mmPerUser;
    const rootInv = root.getScreenCTM().inverse();
    let n = 0;
    for (const id of ids) {
      const el = byId(doc, id); if (!el) continue;
      const pv = root.querySelector('[data-lc="' + id + '"]');
      let s = 1, curFill = null;
      if (pv) {
        const M = rootInv.multiply(pv.getScreenCTM());
        s = Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)) || 1;
        curFill = parseColor(getComputedStyle(pv).fill);
      }
      for (const t of [el, ...el.querySelectorAll('tspan, textPath')]) {
        if (op === 'coupe' || op === 'marquage') {
          setStyleProp(t, 'fill', 'none'); setStyleProp(t, 'stroke', op === 'coupe' ? colors.cut : colors.mark);
          setStyleProp(t, 'stroke-width', num(HAIRLINE_MM / (s * k), 6));
        } else if (op === 'both') {
          setStyleProp(t, 'fill', curFill && !curFill.other ? curFill.hex : colors.engrave);
          setStyleProp(t, 'stroke', colors.cut); setStyleProp(t, 'stroke-width', num(HAIRLINE_MM / (s * k), 6));
        } else {
          setStyleProp(t, 'fill', curFill && !curFill.other ? curFill.hex : colors.engrave); setStyleProp(t, 'stroke', 'none');
        }
      }
      n++;
    }
    return n;
  }

  /* ---------- Gravure : rendu du SVG en image à la résolution du laser ---------- */

  async function rasterize(doc, dpi0, elOps, dpi, onlyEngrave) {
    const U = units(doc, dpi0);
    const W = Math.max(1, Math.round(U.widthMm / 25.4 * dpi)), H = Math.max(1, Math.round(U.heightMm / 25.4 * dpi));
    if (W * H > 40e6) throw new Error('Image trop grande à cette résolution (' + W + ' × ' + H + ' px) : choisissez une résolution plus basse.');
    const d = parse(serialize(doc));
    if (onlyEngrave) for (const el of [...d.querySelectorAll('[data-lc]')]) {
      const o = elOps[el.getAttribute('data-lc')]; if (!o) continue;
      if (o.stroke !== 'gravure') setStyleProp(el, 'stroke', 'none');
      if (o.fill !== 'gravure') setStyleProp(el, 'fill', 'none');
    }
    cleanEditor(d);
    for (const el of d.getElementsByTagName('*')) { el.removeAttribute('data-lc'); el.removeAttribute('data-lc-text'); }
    const r = d.documentElement;
    if (!r.getAttribute('viewBox')) r.setAttribute('viewBox', '0 0 ' + U.userW + ' ' + U.userH);
    r.setAttribute('width', W); r.setAttribute('height', H); r.setAttribute('preserveAspectRatio', 'none');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialize(d));
    await img.decode();
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.drawImage(img, 0, 0, W, H);
    return { rgba: new Uint8ClampedArray(c.getImageData(0, 0, W, H).data), w: W, h: H, widthMm: U.widthMm, heightMm: U.heightMm };
  }

  /** Contours de tout le dessin (trait de 1 px, sans remplissage), cadrés comme rasterize : repère visuel seulement. */
  function outlineURL(doc, dpi0, elOps) {
    const U = units(doc, dpi0), d = parse(serialize(doc));
    cleanEditor(d);
    // seuls les tracés non gravés servent de repère (une découpe reste un repère même si la forme est aussi gravée)
    if (elOps) for (const el of [...d.querySelectorAll('[data-lc]')]) {
      const o = elOps[el.getAttribute('data-lc')];
      if (o && o.stroke !== 'coupe' && o.stroke !== 'marquage') el.setAttribute('display', 'none');
    }
    for (const el of d.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text')) {
      // une seule couleur neutre, en pointillés : impossible de confondre avec ce qui est gravé (noir)
      setStyleProp(el, 'fill', 'none'); setStyleProp(el, 'stroke', '#94a3b8');
      setStyleProp(el, 'stroke-width', '1.2px'); setStyleProp(el, 'stroke-dasharray', '5 4');
      setStyleProp(el, 'vector-effect', 'non-scaling-stroke');
    }
    d.querySelectorAll('image').forEach(e => e.remove());
    for (const el of d.getElementsByTagName('*')) { el.removeAttribute('data-lc'); el.removeAttribute('data-lc-text'); }
    const r = d.documentElement;
    if (!r.getAttribute('viewBox')) r.setAttribute('viewBox', '0 0 ' + U.userW + ' ' + U.userH);
    const W = 1200, H = Math.max(1, Math.round(1200 * U.heightMm / U.widthMm));
    r.setAttribute('width', W); r.setAttribute('height', H); r.setAttribute('preserveAspectRatio', 'none');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialize(d));
  }

  /* ---------- Surimpression des problèmes sur l'aperçu ---------- */

  function drawOverlay(root, U, issues, focusKey, onPick, view) {
    root.querySelectorAll('#lc-overlay, #lc-page').forEach(e => e.remove());
    // Cadre visible = page + objets hors page, pour montrer ce qui dépasse
    const P = U.page, E = U.extent || P;
    const x0 = Math.min(P.x0, E.x0), y0 = Math.min(P.y0, E.y0), x1 = Math.max(P.x1, E.x1), y1 = Math.max(P.y1, E.y1);
    const m = Math.max(x1 - x0, y1 - y0) * 0.03;
    const fit = { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
    const vb = view || fit;
    root.setAttribute('viewBox', [vb.x, vb.y, vb.w, vb.h].map(v => +v.toFixed(4)).join(' '));
    root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const pageRect = document.createElementNS(NS, 'rect'); pageRect.id = 'lc-page';
    for (const [k, v] of Object.entries({ x: P.x0, y: P.y0, width: P.x1 - P.x0, height: P.y1 - P.y0, fill: '#fff' })) pageRect.setAttribute(k, v);
    root.insertBefore(pageRect, root.firstChild);
    // Un trait de 0,01 mm est invisible à l'écran : on l'affiche à 1 px (aperçu seulement)
    for (const el of root.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')) {
      if (el.id === 'lc-page' || el.dataset.lcThin) continue;
      const cs = getComputedStyle(el), m = el.getScreenCTM();
      if (!m || cs.stroke === 'none') continue;
      if (parseFloat(cs.strokeWidth) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) < 1) {
        el.style.strokeWidth = '1px'; el.style.vectorEffect = 'non-scaling-stroke'; el.dataset.lcThin = '1';
      }
    }
    const ctm = root.getScreenCTM(); if (!ctm) return;
    const px = 1 / Math.hypot(ctm.a, ctm.b);
    const g = document.createElementNS(NS, 'g'); g.id = 'lc-overlay';
    g.setAttribute('pointer-events', 'none');
    const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); g.appendChild(e); return e; };
    el('rect', { x: P.x0, y: P.y0, width: P.x1 - P.x0, height: P.y1 - P.y0, fill: 'none', stroke: '#a8a29e', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' });
    const COL = { bad: '#ef4444', warn: '#f59e0b', info: '#0ea5e9', ok: '#10b981' };
    const shown = focusKey ? issues.filter(i => i.key === focusKey) : issues.filter(i => i.level === 'bad' || i.level === 'warn');
    // Les zones signalées clignotent (sauf si le système demande moins d'animations)
    const marksG = document.createElementNS(NS, 'g'); g.appendChild(marksG);
    const add = (tag, attrs) => { const e = el(tag, attrs); marksG.appendChild(e); return e; };
    // zones cliquables : un grand cadre (toute la page) ne réagit que sur son bord, pour ne pas masquer les autres
    const pageArea = (P.x1 - P.x0) * (P.y1 - P.y0);
    const clickable = (e, key, big) => {
      if (!onPick) return;
      e.setAttribute('data-key', key);
      e.setAttribute('pointer-events', big ? 'stroke' : 'visiblePainted');
      e.style.cursor = 'pointer';
      const t = document.createElementNS(NS, 'title'); t.textContent = 'Voir ce problème'; e.appendChild(t);
    };
    const strong = !!focusKey;
    for (const is of shown) {
      const c = COL[is.level];
      for (const b of (is.boxes || []).slice(0, 800)) {
        const pad = 3 * px;
        const r = add('rect', { x: b.x0 - pad, y: b.y0 - pad, width: b.x1 - b.x0 + 2 * pad, height: b.y1 - b.y0 + 2 * pad, rx: 2 * px,
          fill: c, 'fill-opacity': strong ? 0.18 : 0.08, stroke: c, 'stroke-width': strong ? 3 : 2,
          'stroke-dasharray': strong ? 'none' : '5 3', 'vector-effect': 'non-scaling-stroke' });
        clickable(r, is.key, (b.x1 - b.x0) * (b.y1 - b.y0) > 0.25 * pageArea);
      }
      for (const m of (is.marks || []).slice(0, 800)) {
        clickable(add('circle', { cx: m.x, cy: m.y, r: (strong ? 7 : 5) * px, fill: c, 'fill-opacity': 0.15, stroke: c, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }), is.key, false);
      }
    }
    if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      const a = document.createElementNS(NS, 'animate');
      a.setAttribute('attributeName', 'opacity'); a.setAttribute('values', '1;0.12;1');
      a.setAttribute('dur', strong ? '0.8s' : '1.2s'); a.setAttribute('repeatCount', 'indefinite');
      marksG.appendChild(a);
    }
    if (onPick) {
      marksG.setAttribute('pointer-events', 'visiblePainted');
      marksG.addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t) { e.stopPropagation(); onPick(t.getAttribute('data-key')); } });
    }
    root.appendChild(g);
    return fit;
  }

  LC.svg = { parse, detectOrigin, ensureIds, units, renderPreview, analyze, drawOverlay, resize, serialize, exportText, exportDxf, rasterize, outlineURL, setOps, ORIGIN_DPI, ORIGIN_LABEL, parsePathD };
})();
