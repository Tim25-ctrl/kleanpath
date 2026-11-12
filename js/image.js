/* KleanPath — module image : analyse, préparation à la gravure (gris, réglages, tramage)
   et export PNG 1 bit avec la résolution inscrite dans le fichier (bloc pHYs). */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});
  const fmt = (n, d = 1) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });

  /* ---------- Tramage (exécuté dans un Web Worker) ---------- */

  // Fonction autonome : son code source est copié tel quel dans le worker.
  function ditherCore(rgba, w, h, p) {
    const n = w * h, g = new Float32Array(n);
    const c = p.contrast * 2.55, cf = (259 * (c + 255)) / (255 * (259 - c));
    const br = p.brightness * 2.55, ig = 1 / p.gamma;
    for (let i = 0; i < n; i++) {
      const a = rgba[4 * i + 3] / 255;
      let v = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
      v = v * a + 255 * (1 - a);
      v = cf * (v - 128) + 128 + br;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      v = 255 * Math.pow(v / 255, ig);
      if (p.invert) v = 255 - v;
      g[i] = v;
    }
    const bits = new Uint8Array(n); // 1 = blanc (ne grave pas), 0 = noir (grave)
    if (p.algo === 'threshold') {
      const t = p.threshold || 128;
      for (let i = 0; i < n; i++) bits[i] = g[i] >= t ? 1 : 0;
    } else if (p.algo === 'bayer') {
      const B = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; bits[i] = g[i] >= (B[(y & 7) * 8 + (x & 7)] + 0.5) * 4 ? 1 : 0;
      }
    } else {
      const K = {
        floyd: [16, [1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]],
        jarvis: [48, [1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
        stucki: [42, [1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
        atkinson: [8, [1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]
      }[p.algo] || [16, [1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];
      const div = K[0], ker = K.slice(1);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, old = g[i], nv = old >= 128 ? 255 : 0;
        bits[i] = nv ? 1 : 0;
        const err = (old - nv) / div;
        for (let q = 0; q < ker.length; q++) {
          const xx = x + ker[q][0], yy = y + ker[q][1];
          if (xx >= 0 && xx < w && yy < h) g[yy * w + xx] += err * ker[q][2];
        }
      }
    }
    return bits;
  }

  let worker = null, seq = 0;
  const pending = new Map();
  try {
    const src = ditherCore.toString() + '\nonmessage = function (e) { var d = e.data; var bits = ditherCore(d.rgba, d.w, d.h, d.p); postMessage({ id: d.id, bits: bits }, [bits.buffer]); };';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = e => { const r = pending.get(e.data.id); if (r) { pending.delete(e.data.id); r.resolve(e.data.bits); } };
    worker.onerror = e => { for (const r of pending.values()) r.reject(new Error('Le calcul du tramage a échoué.')); pending.clear(); worker = null; e.preventDefault(); };
  } catch (e) { worker = null; }

  function dither(rgba, w, h, p) {
    const params = { contrast: +p.contrast, brightness: +p.brightness, gamma: +p.gamma, invert: !!p.invert, algo: p.algo, threshold: +p.threshold };
    if (!worker) return Promise.resolve(ditherCore(rgba, w, h, params));
    return new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      worker.postMessage({ id, rgba, w, h, p: params }, [rgba.buffer]);
    });
  }

  /* ---------- Encodeur PNG 1 bit (niveaux de gris) + pHYs ---------- */

  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  function zlibStored(data) { // repli sans compression si CompressionStream est absent
    const nb = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + data.length + nb * 5 + 4); out[0] = 0x78; out[1] = 0x01;
    let o = 2;
    for (let b = 0; b < nb; b++) {
      const s = b * 65535, len = Math.min(65535, data.length - s);
      out[o++] = b === nb - 1 ? 1 : 0; out[o++] = len & 255; out[o++] = len >> 8; out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
      out.set(data.subarray(s, s + len), o); o += len;
    }
    let a = 1, b2 = 0; for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b2 = (b2 + a) % 65521; }
    new DataView(out.buffer).setUint32(o, ((b2 << 16) | a) >>> 0);
    return out;
  }

  async function zlib(data) {
    if (typeof CompressionStream === 'undefined') return zlibStored(data);
    const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function encodePng1bit(bits, w, h, dpi) {
    const rb = Math.ceil(w / 8), raw = new Uint8Array((rb + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (rb + 1) + 1, r = y * w;
      for (let x = 0; x < w; x++) if (bits[r + x]) raw[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 1; ihdr[9] = 0;
    const phys = new Uint8Array(9), pv = new DataView(phys.buffer), ppm = Math.round(dpi / 0.0254);
    pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('pHYs', phys), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
    return new Blob(parts, { type: 'image/png' });
  }

  /* ---------- Analyse de la source ---------- */

  function analyzeSource(bitmap) {
    const s = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256); let alpha = false;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]; if (a < 250) alpha = true;
      const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a / 255 + 255 * (1 - a / 255);
      hist[Math.round(v)]++;
    }
    const total = w * h; let acc = 0, p5 = 0, p95 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc <= total * 0.05) p5 = v; if (acc < total * 0.95) p95 = v + 1; }
    return { width: bitmap.width, height: bitmap.height, alpha, hist, p5, p95, spread: p95 - p5 };
  }

  /** Rapport image, même format que le rapport SVG. */
  function issuesFor(info, p, bed) {
    const out = [];
    const nativeMm = info.width / p.dpi * 25.4;
    const hMm = p.widthMm * info.height / info.width;
    const needPx = Math.round(p.widthMm / 25.4 * p.dpi);
    const up = needPx / info.width;
    out.push({ key: 'res', check: 'I1', level: up > 3 ? 'bad' : up > 1.5 ? 'warn' : 'ok',
      title: up > 1.5 ? 'Résolution trop faible pour cette taille' : 'Résolution suffisante',
      detail: info.width + ' × ' + info.height + ' px. À ' + p.dpi + ' DPI, l’image fait ' + fmt(nativeMm) + ' mm de large sans agrandissement. ' +
        (up > 1.5 ? 'Pour ' + fmt(p.widthMm, 0) + ' mm, il faut l’agrandir ×' + fmt(up) + ' : la gravure sera floue. Réduisez la largeur ou partez d’une image plus grande.'
          : 'Pour ' + fmt(p.widthMm, 0) + ' mm, il faut ' + needPx + ' px de large.'),
      fix: up > 1.5 ? { label: 'Ramener à ' + fmt(nativeMm * 1.5, 0) + ' mm', fn: q => { q.widthMm = Math.max(1, Math.floor(nativeMm * 1.5)); return 'Largeur ramenée à ' + q.widthMm + ' mm'; } } : null });
    const fits = (p.widthMm <= bed.w && hMm <= bed.h) || (hMm <= bed.w && p.widthMm <= bed.h);
    out.push({ key: 'bed', check: 'I2', level: fits ? 'ok' : 'bad', title: fits ? 'Taille : tient sur le plateau' : 'Taille : plus grande que le plateau',
      detail: 'Gravure de ' + fmt(p.widthMm) + ' × ' + fmt(hMm) + ' mm, plateau de ' + fmt(bed.w, 0) + ' × ' + fmt(bed.h, 0) + ' mm.' });
    out.push(info.alpha
      ? { key: 'alpha', check: 'I3', level: 'info', title: 'Transparence aplatie sur fond blanc', detail: 'Les zones transparentes deviennent blanches : elles ne seront pas gravées.' }
      : { key: 'alpha', check: 'I3', level: 'ok', title: 'Pas de transparence', detail: 'Rien à aplatir.' });
    const dull = info.spread < 110;
    out.push({ key: 'contrast', check: 'I4', level: dull && p.contrast < 30 ? 'warn' : 'ok',
      title: dull ? (p.contrast < 30 ? 'Image terne' : 'Image terne, contraste relevé') : 'Contraste correct',
      detail: 'Écart de gris utile : ' + info.spread + ' / 255.' + (dull ? ' Une image terne donne une gravure grise et plate : augmentez le contraste.' : ''),
      fix: dull && p.contrast < 30 ? { label: 'Contraste +40', fn: q => { q.contrast = 40; return 'Contraste réglé à +40'; } } : null });
    return out;
  }

  /** Rapport de l'onglet Vectorisation : ce qui compte pour des contours propres. */
  function issuesForVector(info, p, bed) {
    const out = [];
    const pxPerMm = info.width / p.widthMm;
    const hMm = p.widthMm * info.height / info.width;
    out.push({ key: 'vprec', check: 'V1', level: pxPerMm < 3 ? 'bad' : pxPerMm < 6 ? 'warn' : 'ok',
      title: pxPerMm < 6 ? 'Image peu détaillée pour cette taille' : 'Détail suffisant pour des contours précis',
      detail: fmt(pxPerMm) + ' pixels par mm (' + info.width + ' px pour ' + fmt(p.widthMm, 0) + ' mm). ' +
        (pxPerMm < 6 ? 'Les petits détails et les angles seront approximatifs : partez d’une image plus grande, ou réduisez la largeur.' : 'Les bords sont trouvés entre les pixels, au dixième de pixel près.'),
      fix: pxPerMm < 3 ? { label: 'Réduire à ' + fmt(info.width / 6, 0) + ' mm', fn: q => { q.widthMm = Math.max(1, Math.floor(info.width / 6)); return 'Largeur réduite à ' + q.widthMm + ' mm'; } } : null });
    const dull = info.spread < 110;
    out.push({ key: 'contrast', check: 'V2', level: dull && p.contrast < 30 ? 'warn' : 'ok',
      title: dull ? (p.contrast < 30 ? 'Bords peu marqués' : 'Bords peu marqués, contraste relevé') : 'Bords nets',
      detail: dull ? 'L’image est terne : la limite entre la forme et le fond est floue, les contours peuvent trembler. Augmentez le contraste.'
        : 'La forme se détache bien du fond : les seuils de détection fonctionneront bien.',
      fix: dull && p.contrast < 30 ? { label: 'Contraste +40', fn: q => { q.contrast = 40; return 'Contraste réglé à +40'; } } : null });
    return out;
  }

  /** Image d'exemple dessinée sur place (aucun téléchargement). */
  function demoBlob() {
    const w = 360, h = 300, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(150, 120, 10, 180, 150, 170);
    g.addColorStop(0, '#f3ece1'); g.addColorStop(1, '#b8a68c');
    c.fillStyle = g; c.beginPath(); c.ellipse(180, 150, 160, 130, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#3b3128'; c.beginPath(); c.arc(135, 110, 20, 0, Math.PI * 2); c.arc(225, 110, 20, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#3b3128'; c.lineWidth = 10; c.lineCap = 'round'; c.beginPath(); c.arc(180, 140, 55, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
    c.fillStyle = '#2a221b'; c.font = 'bold 34px Georgia, serif'; c.textAlign = 'center'; c.fillText('KleanPath', 180, 245);
    return new Promise(r => cv.toBlob(r, 'image/png'));
  }

  LC.image = { dither, encodePng1bit, analyzeSource, issuesFor, issuesForVector, demoBlob, ditherCore, crc32 };
})();
