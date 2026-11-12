/* KleanPath — vectorisation : image → contours fermés → SVG en mm.
   1. Champ continu (gris lissé) : le bord est cherché ENTRE les pixels (marching squares
      avec interpolation), donc sans escalier.
   2. Simplification Douglas-Peucker au dixième de pixel près.
   3. Courbes de Bézier cubiques passant par les points, angles vifs conservés.
   Sert aussi à vectoriser les textes des SVG. Tout est calculé dans le navigateur. */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});

  /**
   * Isolignes du niveau 0 d'un champ f (w × h, valeurs aux centres des pixels ; f > 0 = dans la forme).
   * Renvoie des boucles fermées [[x, y], …] en coordonnées pixels.
   */
  function isolines(f, w, h) {
    // bordure « dehors » pour que toutes les formes se referment
    const W = w + 2, H = h + 2, F = new Float32Array(W * H).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f[y * w + x]; F[(y + 1) * W + x + 1] = v === 0 ? 1e-6 : v; }
    const inside = (x, y) => F[y * W + x] > 0;
    // point d'intersection sur une arête, identifié par une clé unique
    const hKey = (x, y) => 2 * (y * W + x), vKey = (x, y) => 2 * (y * W + x) + 1;
    const pts = new Map();
    const cross = (key, ax, ay, bx, by) => {
      if (!pts.has(key)) {
        const fa = F[ay * W + ax], fb = F[by * W + bx], t = fa / (fa - fb);
        pts.set(key, [ax + (bx - ax) * t - 1, ay + (by - ay) * t - 1]);   // -1 : retire la bordure, centre des pixels
      }
      return key;
    };
    const next = new Map();
    const seg = (a, b, cx, cy, cIn) => {
      // orientation cohérente : l'intérieur toujours du même côté
      const [px, py] = pts.get(a), [qx, qy] = pts.get(b);
      const c = (qx - px) * (cy - 1 - py) - (qy - py) * (cx - 1 - px);
      if ((c > 0) === cIn) next.set(a, b); else next.set(b, a);
    };
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const tl = inside(x, y), tr = inside(x + 1, y), br = inside(x + 1, y + 1), bl = inside(x, y + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = () => cross(hKey(x, y), x, y, x + 1, y), B = () => cross(hKey(x, y + 1), x, y + 1, x + 1, y + 1);
      const L = () => cross(vKey(x, y), x, y, x, y + 1), R = () => cross(vKey(x + 1, y), x + 1, y, x + 1, y + 1);
      switch (code) {
        case 8: case 7: seg(L(), T(), x, y, tl); break;               // coin haut-gauche
        case 4: case 11: seg(T(), R(), x + 1, y, tr); break;          // coin haut-droit
        case 2: case 13: seg(R(), B(), x + 1, y + 1, br); break;      // coin bas-droit
        case 1: case 14: seg(B(), L(), x, y + 1, bl); break;          // coin bas-gauche
        case 12: case 3: seg(L(), R(), x, y, tl); break;              // horizontal
        case 9: case 6: seg(T(), B(), x, y, tl); break;               // vertical
        case 10: case 5: {                                            // point selle : on regarde le centre
          const center = (F[y * W + x] + F[y * W + x + 1] + F[(y + 1) * W + x] + F[(y + 1) * W + x + 1]) / 4 > 0;
          const diagTlBr = code === 10;                               // tl et br dedans
          if (diagTlBr === center) { seg(T(), R(), x + 1, y, tr); seg(B(), L(), x, y + 1, bl); }
          else { seg(L(), T(), x, y, tl); seg(R(), B(), x + 1, y + 1, br); }
          break;
        }
      }
    }
    const loops = [], used = new Set();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const loop = []; let k = start, guard = 0;
      while (k !== undefined && !used.has(k) && guard++ < 5e6) { used.add(k); loop.push(pts.get(k)); k = next.get(k); }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function rdp(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]], t2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let best = -1, bd = t2;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = pts[i];
        let d;
        if (L === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
        else { const c = (px - ax) * dy - (py - ay) * dx; d = c * c / L; }
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function simplifyClosed(pts, tol) {
    if (pts.length < 4) return pts;
    let far = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
    const a = rdp(pts.slice(0, far + 1), tol), b = rdp(pts.slice(far).concat([pts[0]]), tol);
    return a.concat(b.slice(1, -1));
  }

  const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; } return s / 2; };
  const bbox = p => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
  const r3 = v => +v.toFixed(3);

  /** Chemin SVG : Bézier cubiques par les sommets, segments droits autour des angles vifs. */
  function pathFor(p, k, smooth, ox, oy, cornerCos) {
    const n = p.length, P = i => p[(i + n) % n];
    const f = q => r3(q[0] * k + ox) + ',' + r3(q[1] * k + oy);
    if (!smooth) return 'M' + p.map(f).join('L') + 'Z';
    const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
    const tin = [], tout = [], corner = [];
    for (let i = 0; i < n; i++) {
      const a = P(i - 1), b = P(i), c = P(i + 1);
      const u = unit(b[0] - a[0], b[1] - a[1]), v = unit(c[0] - b[0], c[1] - b[1]);
      const isCorner = u[0] * v[0] + u[1] * v[1] < cornerCos;          // virage plus marqué que le seuil : angle vif
      corner.push(isCorner);
      if (isCorner) { tin.push(u); tout.push(v); }
      else { const t = unit(c[0] - a[0], c[1] - a[1]); tin.push(t); tout.push(t); }
    }
    let d = 'M' + f(P(0));
    for (let i = 0; i < n; i++) {
      const a = P(i), b = P(i + 1), j = (i + 1) % n, L = Math.hypot(b[0] - a[0], b[1] - a[1]) / 3;
      if (corner[i] && corner[j]) { d += 'L' + f(b); continue; }
      const c1 = [a[0] + tout[i][0] * L, a[1] + tout[i][1] * L], c2 = [b[0] - tin[j][0] * L, b[1] - tin[j][1] * L];
      d += 'C' + f(c1) + ' ' + f(c2) + ' ' + f(b);
    }
    return d + 'Z';
  }

  /** Léger flou 3×3 (1-2-1) : enlève le bruit JPEG sans arrondir les formes. */
  function blur(f, w, h) {
    const t = new Float32Array(f.length), o = new Float32Array(f.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = x > 0 ? f[i - 1] : f[i], r = x < w - 1 ? f[i + 1] : f[i];
      t[i] = (l + 2 * f[i] + r) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, u = y > 0 ? t[i - w] : t[i], d = y < h - 1 ? t[i + w] : t[i];
      o[i] = (u + 2 * t[i] + d) / 4;
    }
    return o;
  }

  /**
   * fields : un ou plusieurs champs (f > 0 = forme), w × h ; scale : unités par pixel.
   * opts : { tolPx, minAreaMm2 (en unités²), smooth, ox, oy }. Un contour déjà trouvé n'est pas répété.
   */
  function vectorizeFields(fields, w, h, scale, opts) {
    const minPx = (opts.minAreaMm2 || 0) / (scale * scale), ox = opts.ox || 0, oy = opts.oy || 0;
    const paths = []; let count = 0, nodes = 0;
    // Contours déjà retenus, rangés dans une grille : un contour d'un champ suivant qui longe
    // un contour existant (à moins de NEAR px sur 85 % de sa longueur) serait une double coupe.
    const NEAR = 3, CELL = 6, grid = new Map();
    const key = (cx, cy) => cx * 92821 + cy;
    const addLoop = p => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const cx0 = Math.floor((Math.min(a[0], b[0]) - NEAR) / CELL), cx1 = Math.floor((Math.max(a[0], b[0]) + NEAR) / CELL);
        const cy0 = Math.floor((Math.min(a[1], b[1]) - NEAR) / CELL), cy1 = Math.floor((Math.max(a[1], b[1]) + NEAR) / CELL);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
          const k = key(cx, cy); let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(a[0], a[1], b[0], b[1]);
        }
      }
    };
    const near = (x, y) => {
      const arr = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL))); if (!arr) return false;
      for (let j = 0; j < arr.length; j += 4) {
        const x1 = arr[j], y1 = arr[j + 1], dx = arr[j + 2] - x1, dy = arr[j + 3] - y1, L = dx * dx + dy * dy;
        let t = L ? ((x - x1) * dx + (y - y1) * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x1 + t * dx - x, y1 + t * dy - y) <= NEAR) return true;
      }
      return false;
    };
    const duplicate = loop => {
      let n = 0, hit = 0;
      for (let i = 0; i < loop.length; i += Math.max(1, loop.length >> 7)) { n++; if (near(loop[i][0], loop[i][1])) hit++; }
      return n > 0 && hit / n >= 0.85;
    };
    fields.forEach((field, fi) => {
      const parts = [];
      for (const loop of isolines(field, w, h)) {
        if (fi > 0 && duplicate(loop)) continue;
        const p = simplifyClosed(loop, opts.tolPx);
        if (p.length < 3) continue;
        if (Math.abs(area(p)) < Math.max(minPx, 0.5)) continue;
        if (fields.length > 1) addLoop(p);
        nodes += p.length; parts.push(pathFor(p, scale, opts.smooth, ox, oy, opts.cornerCos || 0.72));
      }
      if (parts.length) { paths.push(parts.join('')); count += parts.length; }
    });
    return { paths, d: paths.join(''), count, nodes, widthMm: w * scale, heightMm: h * scale };
  }

  const vectorizeField = (field, w, h, scale, opts) => vectorizeFields([field], w, h, scale, opts);
  /** Compatibilité : masque binaire (1 = forme). */
  const vectorize = (mask, w, h, scale, opts) => {
    const f = new Float32Array(mask.length); for (let i = 0; i < mask.length; i++) f[i] = mask[i] ? 1 : -1;
    return vectorizeField(f, w, h, scale, opts);
  };

  /** Gris après réglages (luminosité, contraste, gamma, inversion), sur fond blanc. */
  function grayOf(rgba, w, h, p) {
    const n = w * h, g = new Float32Array(n);
    const c = p.contrast * 2.55, cf = (259 * (c + 255)) / (255 * (259 - c)), br = p.brightness * 2.55, ig = 1 / p.gamma;
    for (let i = 0; i < n; i++) {
      const a = rgba[4 * i + 3] / 255;
      let v = (0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]) * a + 255 * (1 - a);
      v = cf * (v - 128) + 128 + br; v = v < 0 ? 0 : v > 255 ? 255 : v;
      v = 255 * Math.pow(v / 255, ig); if (p.invert) v = 255 - v;
      g[i] = v;
    }
    return g;
  }

  /** Teinte du fond : médiane des pixels du bord. */
  function background(g, w, h) {
    const v = [];
    for (let x = 0; x < w; x++) v.push(g[x], g[(h - 1) * w + x]);
    for (let y = 0; y < h; y++) v.push(g[y * w], g[y * w + w - 1]);
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  }

  /**
   * mode 'dark' : zones plus sombres que le seuil.
   * mode 'all'  : en plus, le contour de toute zone qui se distingue du fond (même claire).
   */
  function fromGray(g0, w, h, scale, o) {
    const g = blur(g0, w, h);
    const dark = new Float32Array(w * h);
    for (let i = 0; i < dark.length; i++) dark[i] = o.threshold - g[i];
    if (o.mode !== 'all') return vectorizeField(dark, w, h, scale, o);
    const bg = background(g, w, h), shape = new Float32Array(w * h);
    for (let i = 0; i < shape.length; i++) shape[i] = Math.abs(g[i] - bg) - o.margin;
    // zones sombres d'abord : le contour des zones claires n'ajoute que ce qui manque
    return vectorizeFields([dark, shape], w, h, scale, o);
  }

  /* ---------- Vectorisation par couleurs : un calque par couleur ---------- */

  const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

  /** Regroupe les couleurs de l'image en k teintes (k-means, départ k-means++ reproductible). */
  function palette(rgba, n, k) {
    const step = Math.max(1, Math.floor(n / 40000)), S = [];
    for (let i = 0; i < n; i += step) { const a = rgba[4 * i + 3] / 255; S.push([rgba[4 * i] * a + 255 * (1 - a), rgba[4 * i + 1] * a + 255 * (1 - a), rgba[4 * i + 2] * a + 255 * (1 - a)]); }
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const C = [S[Math.floor(rnd() * S.length)].slice()];
    while (C.length < k) {
      const D = S.map(p => Math.min(...C.map(c => d2(p, c)))), tot = D.reduce((a, b) => a + b, 0);
      if (!tot) break;
      let r = rnd() * tot, i = 0; while (i < D.length - 1 && (r -= D[i]) > 0) i++;
      C.push(S[i].slice());
    }
    for (let it = 0; it < 12; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (const p of S) { let b = 0, bd = Infinity; for (let j = 0; j < C.length; j++) { const d = d2(p, C[j]); if (d < bd) { bd = d; b = j; } } const a = acc[b]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++; }
      acc.forEach((a, j) => { if (a[3]) C[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    }
    return C;
  }

  /**
   * o : { colors (2-8), skipBg, tolPx, smooth, cornerCos, minAreaMm2 }.
   * Pour chaque teinte, le champ vaut « distance à la 2e teinte la plus proche − distance à la sienne » :
   * il passe par zéro au milieu de l'anticrénelage, donc les bords entre couleurs sont nets.
   */
  function fromColors(rgba, w, h, scale, o) {
    const n = w * h, C = palette(rgba, n, Math.max(2, Math.min(8, o.colors || 4))), K = C.length;
    const px = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rgba[4 * i + 3] / 255;
      for (let c = 0; c < 3; c++) px[3 * i + c] = rgba[4 * i + c] * a + 255 * (1 - a);
    }
    const dist = (i, j) => Math.hypot(px[3 * i] - C[j][0], px[3 * i + 1] - C[j][1], px[3 * i + 2] - C[j][2]);
    // teinte la plus proche et distances aux deux plus proches : calculées une seule fois
    const owner = new Uint8Array(n), best = new Float32Array(n), second = new Float32Array(n), counts = new Array(K).fill(0);
    for (let i = 0; i < n; i++) {
      let b = 0, bd = Infinity, sd = Infinity;
      for (let j = 0; j < K; j++) { const d = dist(i, j); if (d < bd) { sd = bd; bd = d; b = j; } else if (d < sd) sd = d; }
      owner[i] = b; best[i] = bd; second[i] = sd; counts[b]++;
    }
    // fond = teinte majoritaire sur le bord de l'image
    const border = new Array(K).fill(0);
    for (let x = 0; x < w; x++) { border[owner[x]]++; border[owner[(h - 1) * w + x]]++; }
    for (let y = 0; y < h; y++) { border[owner[y * w]]++; border[owner[y * w + w - 1]]++; }
    const bg = border.indexOf(Math.max(...border));
    const layers = [];
    const order = C.map((c, j) => j).sort((a, b) => (0.299 * C[b][0] + 0.587 * C[b][1] + 0.114 * C[b][2]) - (0.299 * C[a][0] + 0.587 * C[a][1] + 0.114 * C[a][2]));
    for (const k of order) {                                    // du plus clair au plus foncé
      if ((o.skipBg && k === bg) || counts[k] < n * 0.0005) continue;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = owner[i] === k ? second[i] - best[i] : best[i] - dist(i, k);
      const v = vectorizeField(blur(f, w, h), w, h, scale, o);
      if (v.count) layers.push({ hex: hex(C[k]), d: v.d, count: v.count, nodes: v.nodes, share: counts[k] / n });
    }
    return {
      layers, paths: layers.map(l => l.d), d: layers.map(l => l.d).join(''),
      count: layers.reduce((a, l) => a + l.count, 0), nodes: layers.reduce((a, l) => a + l.nodes, 0),
      widthMm: w * scale, heightMm: h * scale,
      palette: C.map((c, j) => ({ hex: hex(c), share: counts[j] / n, background: j === bg }))
    };
  }

  function toSvg(v, mode) {
    const W = r3(v.widthMm), H = r3(v.heightMm);
    const items = v.layers ? v.layers.map((l, i) => ({ d: l.d, hex: l.hex, id: 'couleur-' + (i + 1) + '-' + l.hex.slice(1) })) : v.paths.map(d => ({ d, hex: null }));
    const style = c => mode === 'gravure' ? 'fill:' + (c || '#000000') + ';stroke:none' : 'fill:none;stroke:' + (c || '#FF0000') + ';stroke-width:0.01';
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" viewBox="0 0 ' + W + ' ' + H + '">\n' +
      items.map(it => '<path' + (it.id ? ' id="' + it.id + '"' : '') + ' fill-rule="evenodd" style="' + style(it.hex) + '" d="' + it.d + '"/>').join('\n') + '\n</svg>\n';
  }

  LC.vectorize = { vectorize, vectorizeField, vectorizeFields, fromGray, fromColors, grayOf, blur, toSvg, isolines };
})();
