/* KleanPath — traitement par lot (Pro) : analyse, corrections automatiques et archive ZIP.
   Chaque fichier est rendu hors écran pour que le moteur SVG mesure sa géométrie. */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});

  let host = null;
  function container() {
    if (!host) {
      const div = document.createElement('div');
      // hors écran mais rendu (pas de visibility:hidden, qui fausserait l'analyse)
      div.style.cssText = 'position:fixed;left:-30000px;top:0;width:900px;pointer-events:none';
      document.body.append(div);
      host = div.attachShadow({ mode: 'open' });
      host.append(document.createElement('div'));
    }
    return host.firstChild;
  }

  const count = issues => ({ bad: issues.filter(i => i.level === 'bad').length, warn: issues.filter(i => i.level === 'warn').length });

  /**
   * files : [{ name, text }] (SVG déjà converti si DXF) ; opts : { settings, removeFills }
   * onProgress(i, total) ; renvoie [{ name, before, after, left, out, error }]
   */
  async function run(files, opts, onProgress) {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onProgress && onProgress(i, files.length);
      await new Promise(r => setTimeout(r, 0));       // laisse l'interface respirer
      try {
        const doc = LC.svg.parse(f.text); LC.svg.ensureIds(doc);
        const origin = opts.settings.origin === 'auto' ? LC.svg.detectOrigin(f.text) : opts.settings.origin;
        const ctx = () => ({ doc, root: LC.svg.renderPreview(doc, container()), dpi: LC.svg.ORIGIN_DPI[origin], origin, settings: opts.settings, colorOps: {} });
        let res = LC.svg.analyze(ctx());
        const before = count(res.issues), log = [];
        for (let pass = 0; pass < 3; pass++) {
          // corrections sans décision ; « retirer les remplissages » seulement si la case est cochée
          const fixes = res.issues.map(is => ({ key: is.key, f: is.key === 'fill' ? (opts.removeFills ? [is.fix, is.altFix].find(x => x && x.id === 'nofill') : null) : (is.fix && !is.fix.confirm ? is.fix : null) }))
            .filter(x => x.f).sort((a, b) => (a.key === 'clean') - (b.key === 'clean'));
          if (!fixes.length) break;
          for (const x of fixes) { const m = await x.f.fn(doc); if (m) log.push(m); }
          LC.svg.ensureIds(doc);
          res = LC.svg.analyze(ctx());
        }
        const after = count(res.issues);
        results.push({ name: f.name, before, after, log, left: res.issues.filter(x => x.level === 'bad' || x.level === 'warn').map(x => x.title), out: LC.svg.exportText(doc), source: f.text });
      } catch (e) {
        results.push({ name: f.name, error: e.message || String(e), source: f.text });
      }
    }
    onProgress && onProgress(files.length, files.length);
    return results;
  }

  /* ---------- Archive ZIP (sans compression, noms UTF-8) ---------- */

  function zip(entries) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = LC.image.crc32(data), size = data.length;
      const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      local.set(name, 30);
      const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true); cen.set(name, 46);
      parts.push(local, data); central.push(cen);
      offset += local.length + size;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  LC.batch = { run, zip };
})();
