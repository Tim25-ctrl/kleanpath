/* KleanPath — interface : dépôt, rapport, aperçu, corrections, annuler/rétablir, export. */
(function () {
  'use strict';
  const LC = window.LC;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const fmt = (n, d = 1) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  /* ---------- Réglages ---------- */
  // Fonctions désactivées pour le moment (le code reste en place, il suffit de repasser à true)
  const FEATURES = { imageVectorize: false };

  const DEFAULTS = { bedW: 400, bedH: 400, kerf: 0.1, origin: 'auto', closeTol: 0.5, profile: 'perso', profileName: '' };
  // Zones de travail indicatives (fiches constructeur) — à confirmer avant la mise en ligne.
  const PROFILES = [
    { id: 'perso', name: 'Personnalisé' },
    { id: 'xtool-s1', name: 'xTool S1', w: 498, h: 319 },
    { id: 'xtool-d1pro', name: 'xTool D1 Pro', w: 432, h: 406 },
    { id: 'xtool-p2', name: 'xTool P2', w: 600, h: 308 },
    { id: 'xtool-f1', name: 'xTool F1', w: 115, h: 115 },
    { id: 'glowforge', name: 'Glowforge Pro / Plus / Basic', w: 495, h: 279 },
    { id: 'ortur-lm3', name: 'Ortur Laser Master 3', w: 400, h: 390 },
    { id: 'epilog-zing16', name: 'Epilog Zing 16', w: 406, h: 305 },
    { id: 'epilog-fusion32', name: 'Epilog Fusion Pro 32', w: 812, h: 508 }
  ];
  const settings = Object.assign({}, DEFAULTS, LC.store.get('lc_settings') || {});

  const S = { mode: null, name: '', svg: null, img: null };
  const baseName = n => n.replace(/\.[^.]+$/, '');

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  /**
   * Confirmation affichée dans la page (les fenêtres natives du navigateur peuvent être bloquées,
   * par exemple dans un navigateur intégré). Renvoie true si l'utilisateur confirme.
   */
  function askConfirm(message, okLabel) {
    return new Promise(resolve => {
      const dlg = $('#confirmDlg');
      $('#confirmMsg').textContent = message;
      $('#confirmOk').textContent = okLabel || 'Continuer';
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
      $('#confirmOk').focus();
    });
  }

  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function showView(v) {
    S.mode = v;
    $('#homeView').classList.toggle('hidden', v !== 'home');
    $('#svgView').classList.toggle('hidden', v !== 'svg');
    $('#imgView').classList.toggle('hidden', v !== 'img');
    $('#batchView').classList.toggle('hidden', v !== 'batch');
    window.scrollTo(0, 0);
  }

  function homeError(msg) {
    const e = $('#homeError'); e.textContent = msg; e.classList.toggle('hidden', !msg);
  }

  /* ---------- Ouverture de fichier ---------- */
  const extOf = f => (f.name.split('.').pop() || '').toLowerCase();
  const isVector = f => ['svg', 'dxf'].includes(extOf(f)) || f.type === 'image/svg+xml';

  /** Texte SVG d'un fichier SVG ou DXF (le DXF est converti). */
  async function vectorText(file) {
    const text = await file.text();
    if (extOf(file) !== 'dxf') return { svg: text };
    const r = LC.dxf.toSvg(text);
    return { svg: r.svg, note: [r.note, r.ignored].filter(Boolean).join(' ') };
  }

  async function openFiles(list) {
    const files = [...list];
    if (!files.length) return;
    const vec = files.filter(isVector);
    if (vec.length > 1) {
      if (LC.licence.unlocked()) return runBatch(vec);
      openPro('Le traitement par lot (' + vec.length + ' fichiers d’un coup) est réservé à KleanPath Pro. Le premier fichier est ouvert en attendant.');
      return openFile(vec[0]);
    }
    return openFile(files[0]);
  }

  async function openFile(file) {
    homeError('');
    const ext = extOf(file);
    if (file.size > 20 * 1024 * 1024) return homeError('Fichier trop lourd : 20 Mo maximum.');
    try {
      if (isVector(file)) {
        const r = await vectorText(file);
        const usage = await chooseMode('vector', file.name);
        if (!usage) return;
        loadSvg(r.svg, file.name, usage);
        if (r.note) toast(r.note);
      } else if (['png', 'jpg', 'jpeg'].includes(ext) || /^image\/(png|jpeg)$/.test(file.type)) {
        const tab = FEATURES.imageVectorize ? await chooseMode('image', file.name) : 'grav';
        if (tab) await loadImage(file, file.name, tab);
      }
      else homeError('Format non pris en charge : déposez un SVG, un DXF, un PNG ou un JPG.');
    } catch (e) {
      showView('home'); homeError(e.message || String(e));
    }
  }

  /* ================= SVG ================= */

  let shadow = null;
  function previewContainer() {
    if (!shadow) {
      shadow = $('#svgPreview').attachShadow({ mode: 'open' });
      shadow.append(h('div', { id: 'c' }));
    }
    return shadow.getElementById('c');
  }

  const currentDpi = () => LC.svg.ORIGIN_DPI[settings.origin === 'auto' ? S.svg.origin : settings.origin];
  const currentOrigin = () => settings.origin === 'auto' ? S.svg.origin : settings.origin;

  const MODES = {
    vector: [
      ['auto', 'Auto', 'KleanPath détecte s’il s’agit de découpe, de gravure ou des deux.'],
      ['coupe', 'Découpe', 'Contours à découper : échelle, doublons, tracés ouverts, traits fins, détails trop fins.'],
      ['gravure', 'Gravure', 'Aplats, textes et images à graver : résolution des images, couleurs, export PNG tramé.'],
      ['mixte', 'Découpe + gravure', 'Les deux dans le même fichier.']
    ],
    image: [
      ['grav', 'Gravure', 'Préparer la photo ou l’image : niveaux de gris, tramage, PNG 1 bit à la résolution du laser.'],
      ['vec', 'Vectorisation', 'Transformer l’image en contours SVG, pour la découpe ou la gravure.']
    ]
  };

  /** Demande le mode à l'ouverture d'un fichier ; renvoie la valeur choisie, ou null si annulé. */
  function chooseMode(kind, name) {
    return new Promise(resolve => {
      const dlg = $('#modeDlg');
      $('#modeFile').textContent = name;
      $('#modeChoices').replaceChildren(...MODES[kind].map(([v, t, d], i) =>
        h('button', { value: v, class: 'choice' + (i === 0 ? ' border-orange-400' : '') },
          h('div', { class: 'font-semibold' }, t + (i === 0 && kind === 'vector' ? ' (recommandé)' : '')),
          h('div', { class: 'text-xs text-stone-500 mt-0.5' }, d))));
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue && dlg.returnValue !== 'cancel' ? dlg.returnValue : null), { once: true });
      dlg.showModal();
      dlg.querySelector('.choice').focus();
    });
  }

  function loadSvg(text, name, usage) {
    const doc = LC.svg.parse(text);
    LC.svg.ensureIds(doc);
    S.name = name;
    S.svg = { doc, origin: LC.svg.detectOrigin(text), originalXml: LC.svg.serialize(doc), usage: usage || 'auto', engReq: 0, eng: null, pview: null, pfit: null, selEl: null, hoverEl: null, opsAll: false, opsOnlyIssues: false, ack: new Set(), history: [], future: [], log: [], colorOps: {}, focus: null, result: null, root: null };
    showView('svg');
    $('#svgName').textContent = name;
    renderSvg();
  }

  function renderSvg() {
    const st = S.svg;
    st.root = LC.svg.renderPreview(st.doc, previewContainer());
    try {
      st.result = LC.svg.analyze(analyzeCtx());
    } catch (e) {
      st.result = null;
      $('#svgIssues').replaceChildren(h('p', { class: 'text-sm text-red-600' }, e.message));
      return;
    }
    if (st.focus && !st.result.issues.some(i => i.key === st.focus)) st.focus = null;
    const U = st.result.U, o = currentOrigin();
    $('#svgMeta').textContent = fmt(U.widthMm) + ' × ' + fmt(U.heightMm) + ' mm · ' + st.result.stats.shapes + ' tracé' + (st.result.stats.shapes > 1 ? 's' : '') + ' · ' +
      (settings.origin === 'auto' ? 'détecté : ' : '') + LC.svg.ORIGIN_LABEL[o];
    const USAGE = { coupe: 'découpe', gravure: 'gravure', mixte: 'découpe + gravure' };
    const us = $('#usageSel'); us.value = st.usage;
    us.options[0].textContent = 'Auto (détecté : ' + USAGE[st.result.usage.detected] + ')';
    renderIssues();
    drawSvgOverlay();
    renderLog();
    renderOps();
    renderResize();
    renderExport();
    scheduleEngrave();
  }

  /** Clic sur une zone clignotante : repère le problème et fait défiler jusqu'à sa carte. */
  function pickIssue(key) {
    const st = S.svg; if (!st || !st.result || key === '__el') return;
    if (!FILE_KEYS.has(key)) {
      const el = st.result.elements.find(e => e.problems.some(p => p.key === key));
      if (el) { focusRow(el); return; }
    }
    st.selEl = null;
    st.focus = key;
    renderIssues();
    if (key === 'vtext') zoomToIssue(key); else drawSvgOverlay();
    const card = $('#svgIssues [data-key="' + key + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function drawSvgOverlay() {
    const st = S.svg; if (!st || !st.result) return;
    const hl = st.hoverEl || st.selEl;                   // survol d'une ligne du panneau, ou élément choisi
    const issues = hl ? st.result.issues.concat([{ key: '__el', level: 'info', boxes: [hl.box] }]) : st.result.issues;
    st.pfit = LC.svg.drawOverlay(st.root, st.result.U, issues, hl ? '__el' : st.focus, pickIssue, st.pview);
    $('#pzLabel').textContent = Math.round(st.pfit.w / (st.pview || st.pfit).w * 100) + ' %';
  }

  /* ---------- Zoom de l'aperçu SVG ---------- */
  const pViewOf = () => S.svg.pview || S.svg.pfit;
  function zoomPreview(factor, cx, cy) {
    const st = S.svg; if (!st || !st.pfit) return;
    const v = pViewOf(), w = Math.min(Math.max(v.w * factor, st.pfit.w / 80), st.pfit.w * 1.2), k = w / v.w;
    st.pview = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w, h: v.h * k };
    drawSvgOverlay();
  }
  const zoomPreviewCenter = f => { const v = pViewOf(); if (v) zoomPreview(f, v.x + v.w / 2, v.y + v.h / 2); };
  /** Cadre la vue sur les zones d'un problème (en gardant les proportions de l'aperçu). */
  /** Cadre la vue sur des boîtes (en gardant les proportions de l'aperçu, sans trop zoomer). */
  function zoomToBoxes(boxes, pad = 1.3) {
    const st = S.svg; if (!boxes.length || !st.pfit) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    let w = Math.max((x1 - x0) * pad, st.pfit.w / 12), h = Math.max((y1 - y0) * pad, st.pfit.h / 12);
    const ratio = st.pfit.w / st.pfit.h;
    if (w / h < ratio) w = h * ratio; else h = w / ratio;
    st.pview = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
  }
  function zoomToIssue(key) {
    const st = S.svg, is = st.result.issues.find(i => i.key === key);
    if (!is || !(is.boxes || []).length || !st.pfit) return;
    zoomToBoxes(is.boxes);
    st.selEl = null;
    st.focus = key;
    renderIssues();
    drawSvgOverlay();
    $('#svgPreview').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- Découpe ou gravure, élément par élément ---------- */

  /** Couleurs à utiliser : celles déjà associées à chaque opération dans le fichier. */
  function opColors() {
    const cols = S.svg.result ? S.svg.result.colors : [];
    const find = (kind, op) => { const c = cols.find(x => x.kind === kind && x.op === op); return c && c.hex; };
    return { cut: find('trait', 'coupe') || '#FF0000', mark: find('trait', 'marquage') || '#0000FF', engrave: find('remplissage', 'gravure') || '#000000' };
  }

  const OP_WORD = { coupe: 'découpe', gravure: 'gravure', marquage: 'marquage', both: 'découpe + gravure' };
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');

  function applyOps(ids, op, what) {
    const st = S.svg; if (busy || !ids.length) return;
    st.history.push(snapshot()); st.future = [];
    const n = LC.svg.setOps(st.doc, st.root, currentDpi(), ids, op, opColors());
    if (op === 'both') ids.forEach(id => st.ack.add(id)); else ids.forEach(id => st.ack.delete(id));
    st.log.push({ type: 'op', ids, op, msg: what + ' → ' + OP_WORD[op] + (n > 1 ? ' (' + n + ' éléments)' : '') });
    st.selEl = null; st.hoverEl = null;
    renderSvg();
  }

  function locateElement(el) {
    const st = S.svg;
    st.selEl = { id: el.id, box: el.box };
    zoomToBoxes([el.box], 2.4);
    drawSvgOverlay(); renderOps();
    $('#svgPreview').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Contrôles du fichier entier ; tout le reste se règle élément par élément dans le tableau
  const FILE_KEYS = new Set(['scale', 'dims', 'colors', 'clean', 'thin']);
  const LVL_RANK = { bad: 0, warn: 1, info: 2 };

  /** Met une ligne du tableau en avant et l'élément en surbrillance dans l'aperçu. */
  function focusRow(el) {
    const st = S.svg;
    st.selEl = { id: el.id, box: el.box }; st.focus = null;
    renderIssues(); renderOps(); drawSvgOverlay();
    const row = $('#opsBox [data-id="' + el.id + '"]');
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Correction propre à un élément (supprimer un doublon, fermer, trait fin, vectoriser…). */
  async function applyElementFix(el, p) {
    const st = S.svg; if (busy) return;
    if (p.fix.confirm && !(await askConfirm(p.fix.confirm, p.fix.label))) return;
    busy = true;
    st.history.push(snapshot()); st.future = [];
    let msg = null;
    try { msg = await p.fix.fn(st.doc); } catch (e) { toast('Échec : ' + e.message); }
    finally { busy = false; }
    if (!msg) { st.history.pop(); return toast('Rien à changer pour cet élément.'); }
    st.log.push({ type: 'efix', key: p.key, fixId: p.fix.id, id: el.id, msg: el.label + ' — ' + msg });
    LC.svg.ensureIds(st.doc);
    st.selEl = null; st.hoverEl = null;
    renderSvg();
    toast(msg + '.');
  }

  function renderOps() {
    const st = S.svg, all = (st.result && st.result.elements) || [];
    const box = $('#opsBox');
    box.classList.toggle('hidden', !all.length);
    if (!all.length) return box.replaceChildren();
    const CHIP = { bad: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200', warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200', info: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200' };
    const rank = el => Math.min(3, ...el.problems.map(p => LVL_RANK[p.lvl]));
    const toCheck = el => el.problems.some(p => p.lvl === 'bad' || p.lvl === 'warn');
    // éléments à problème d'abord (bloquants, puis à vérifier), sinon ordre du fichier
    const sorted = all.map((e, i) => [e, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);

    // choix proposés : forme fermée = découpe / gravure / les deux ; ligne ouverte = découpe / marquage
    const seg = el => {
      if (el.kind === 'image') return h('span', { class: 'text-xs text-stone-500 flex-none' }, 'gravée en image');
      const opts = el.open ? [['coupe', 'Découpe'], ['marquage', 'Marquage']] : [['coupe', 'Découpe'], ['gravure', 'Gravure'], ['both', 'Les deux']];
      return h('span', { class: 'inline-flex rounded-md border border-stone-300 dark:border-stone-700 overflow-hidden flex-none' }, opts.map(([op, label]) => {
        const on = el.mode === op;
        return h('button', {
          class: 'px-2.5 py-1.5 text-xs whitespace-nowrap ' + (on ? 'bg-stone-800 text-white dark:bg-stone-200 dark:text-stone-900 font-medium' : 'hover:bg-stone-100 dark:hover:bg-stone-800'),
          'aria-pressed': String(on), title: on ? 'Actuellement : ' + OP_WORD[op] : 'Passer en ' + OP_WORD[op],
          onclick: () => { if (!on) applyOps([el.id], op, el.label); }
        }, label);
      }));
    };
    const chip = (el, p) => h('span', { class: 'inline-flex items-center gap-1 text-xs pl-2 pr-0.5 py-0.5 rounded-md ' + CHIP[p.lvl] },
      p.label,
      p.fix ? h('button', { class: 'font-semibold underline underline-offset-2 hover:no-underline px-1.5 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10', onclick: () => applyElementFix(el, p) }, p.fix.label) : null,
      p.zoom ? h('button', { class: 'font-semibold underline underline-offset-2 hover:no-underline px-1.5 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10', onclick: () => { st.selEl = { id: el.id, box: el.box }; zoomToBoxes([el.box], 1.6); drawSvgOverlay(); renderOps(); $('#svgPreview').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Voir de près') : null);
    const row = el => {
      const sel = st.selEl && st.selEl.id === el.id;
      return h('li', {
        'data-id': el.id,
        class: 'py-2 px-2 rounded-lg ' + (sel ? 'bg-orange-50 ring-1 ring-orange-300 dark:bg-orange-950/30 dark:ring-orange-800' : 'hover:bg-stone-50 dark:hover:bg-stone-800/50'),
        onmouseenter: () => { st.hoverEl = { id: el.id, box: el.box }; drawSvgOverlay(); },
        onmouseleave: () => { st.hoverEl = null; drawSvgOverlay(); }
      },
        h('div', { class: 'flex items-center gap-2' },
          h('span', { class: 'flex -space-x-1 flex-none' }, (el.colors.length ? el.colors : [el.kind === 'image' ? '#d6d3d1' : 'transparent']).map(c => h('span', { class: 'chip-swatch', style: 'background:' + c, title: c }))),
          h('button', { class: 'flex-1 min-w-0 text-left truncate hover:text-orange-600', title: el.label + ' — voir dans l’aperçu', onclick: () => locateElement(el) }, el.label),
          seg(el)),
        el.problems.length ? h('div', { class: 'mt-1 pl-6 flex flex-wrap gap-1' }, el.problems.slice().sort((x, y) => LVL_RANK[x.lvl] - LVL_RANK[y.lvl]).map(p => chip(el, p))) : null);
    };
    const group = (title, list, word, bulk) => {
      if (!list.length) return null;
      const LIMIT = 150, shown = st.opsAll ? list : list.slice(0, LIMIT);
      const closed = list.filter(e => !e.open);
      return h('div', { class: 'mt-3' },
        h('div', { class: 'flex items-center gap-x-3 gap-y-1 flex-wrap px-2' },
          h('span', { class: 'font-medium' }, title + ' (' + list.length + ')'),
          h('span', { class: 'flex-1' }),
          bulk ? h('span', { class: 'text-xs text-stone-500' }, 'Tout en :') : null,
          bulk ? h('button', { class: 'text-xs underline text-stone-500 hover:text-orange-600', onclick: () => applyOps(list.filter(e => e.mode !== 'coupe').map(e => e.id), 'coupe', 'Tous les ' + word) }, 'découpe') : null,
          bulk && closed.length ? h('button', { class: 'text-xs underline text-stone-500 hover:text-orange-600', onclick: () => applyOps(closed.filter(e => e.mode !== 'gravure').map(e => e.id), 'gravure', 'Toutes les ' + word + ' fermées') }, 'gravure') : null),
        h('ul', { class: 'mt-1 space-y-0.5' }, shown.map(row)),
        list.length > LIMIT && !st.opsAll ? h('button', { class: 'mt-1 text-xs underline', onclick: () => { st.opsAll = true; renderOps(); } }, 'Afficher les ' + list.length) : null);
    };
    const count = op => all.filter(e => e.mode === op).length;
    const summary = [['coupe', 'en découpe'], ['gravure', 'en gravure'], ['both', 'en découpe + gravure'], ['marquage', 'en marquage']].filter(([op]) => count(op)).map(([op, w]) => count(op) + ' ' + w);
    const flagged = sorted.filter(toCheck);
    const list = st.opsOnlyIssues ? flagged : sorted;
    box.replaceChildren(...[
      h('div', { class: 'flex items-baseline gap-2 flex-wrap px-2' },
        h('span', { class: 'font-semibold' }, 'Éléments'),
        h('span', { class: 'text-xs text-stone-500' }, summary.join(' · '))),
      h('p', { class: 'mt-1 px-2 text-xs text-stone-500' }, 'Pour chaque texte et chaque forme : ce que fait le laser, et ses problèmes avec leur correction. Survolez pour repérer, cliquez sur le nom pour zoomer.'),
      flagged.length ? h('label', { class: 'mt-2 px-2 flex items-center gap-2 text-xs' },
        h('input', { type: 'checkbox', class: 'accent-orange-500', checked: st.opsOnlyIssues, onchange: e => { st.opsOnlyIssues = e.target.checked; renderOps(); } }),
        'Seulement les éléments à vérifier (' + flagged.length + ')') : h('p', { class: 'mt-2 px-2 text-xs text-emerald-600 dark:text-emerald-400' }, 'Aucun élément à corriger.'),
      group('Textes', list.filter(e => e.kind === 'text'), 'textes', true),
      group('Formes', list.filter(e => e.kind === 'shape'), 'formes', true),
      group('Images', list.filter(e => e.kind === 'image'), 'images', false)
    ].filter(Boolean));
  }

  const LEVEL = {
    bad: { label: 'Bloquant', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400' },
    warn: { label: 'À vérifier', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
    info: { label: 'Info', dot: 'bg-sky-500', text: 'text-sky-700 dark:text-sky-400' },
    ok: { label: 'OK', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' }
  };

  function issueCard(is, opts) {
    const L = LEVEL[is.level];
    const focused = opts.focus === is.key;
    const card = h('div', {
      'data-key': is.key,
      class: 'issue rounded-xl border bg-white dark:bg-stone-900 p-3 ' + (focused ? 'focused border-orange-400' : 'border-stone-200 dark:border-stone-800') + (opts.onFocus && (is.boxes || []).length ? ' cursor-pointer' : ''),
      onclick: e => { if (e.target.closest('button,select,a')) return; if (opts.onFocus && (is.boxes || is.marks || []).length) opts.onFocus(is.key); }
    },
      h('div', { class: 'flex items-start gap-2' },
        h('span', { class: 'mt-1.5 w-2.5 h-2.5 rounded-full flex-none ' + L.dot }),
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'flex flex-wrap items-baseline gap-x-2' },
            h('span', { class: 'font-medium text-sm' }, is.title),
            h('span', { class: 'text-xs ' + L.text }, L.label)),
          h('p', { class: 'mt-0.5 text-xs text-stone-600 dark:text-stone-400 leading-relaxed' }, is.detail))));
    const body = card.firstChild.lastChild;
    if (is.colors && is.colors.length) body.append(colorTable(is.colors));
    const btns = h('div', { class: 'flex flex-wrap gap-2 mt-2' });
    if (is.fix) btns.append(h('button', { class: 'text-xs px-2.5 py-1 rounded-md bg-orange-500 hover:bg-orange-600 text-white font-medium', onclick: () => opts.onFix(is) }, is.fix.label));
    if (is.altFix) btns.append(h('button', { class: 'text-xs px-2.5 py-1 rounded-md border border-orange-400 text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/40 font-medium', onclick: () => opts.onFix(Object.assign({}, is, { fix: is.altFix })) }, is.altFix.label));
    if (is.action) btns.append(h('button', { class: 'text-xs px-2.5 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800', onclick: () => opts.onAction(is.action) }, is.action.label));
    if (btns.childElementCount) body.append(btns);
    return card;
  }

  function colorTable(colors) {
    const wrap = h('div', { class: 'mt-2 space-y-1' });
    for (const c of colors) {
      const sel = h('select', { class: 'text-xs rounded border border-stone-300 dark:border-stone-700 bg-transparent px-1 py-0.5', 'aria-label': 'Opération pour ' + c.hex },
        ...['coupe', 'marquage', 'gravure'].map(op => h('option', { value: op, selected: c.op === op }, op)));
      sel.addEventListener('change', () => {
        S.svg.colorOps[c.kind === 'trait' ? c.hex : 'fill' + c.hex] = sel.value;
        renderSvg();
      });
      wrap.append(h('div', { class: 'flex items-center gap-2 text-xs' },
        h('span', { class: 'chip-swatch', style: 'background:' + c.hex }),
        h('span', { class: 'font-mono' }, c.hex),
        h('span', { class: 'text-stone-500' }, c.kind + ' · ' + c.count),
        h('span', { class: 'flex-1' }), sel));
    }
    return wrap;
  }

  function renderIssues() {
    const st = S.svg, issues = st.result.issues;
    const count = l => issues.filter(i => i.level === l).length;
    $('#svgSummary').replaceChildren(
      ...[['bad', count('bad')], ['warn', count('warn')], ['ok', count('ok') + count('info')]].map(([l, n]) => {
        const label = n + ' ' + (l === 'bad' ? 'bloquant' + (n > 1 ? 's' : '') : l === 'warn' ? 'à vérifier' : 'OK');
        const clickable = l !== 'ok' && n > 0;
        return h(clickable ? 'button' : 'span', {
          class: 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-stone-100 dark:bg-stone-800' + (clickable ? ' hover:ring-2 hover:ring-stone-300 dark:hover:ring-stone-600' : ''),
          title: clickable ? 'Aller au premier problème ' + (l === 'bad' ? 'bloquant' : 'à vérifier') : null,
          onclick: clickable ? () => goToLevel(l) : null
        }, h('i', { class: 'w-2 h-2 rounded-full ' + LEVEL[l].dot }), label);
      }));
    const fixable = issues.filter(i => i.fix);
    const fa = $('#fixAllBtn');
    fa.disabled = !fixable.length;
    fa.textContent = fixable.length ? 'Tout corriger (' + fixable.length + ')' : 'Rien à corriger automatiquement';
    // ce que « Tout corriger » va faire, en clair (les choix qui demandent confirmation sont signalés)
    $('#fixAllNote').textContent = fixable.length
      ? 'Fera : ' + fixable.map(i => i.fix.label.replace(/…$/, '').toLowerCase() + (i.fix.confirm ? ' (après confirmation)' : '')).join(' · ') + '.'
      : '';
    $('#undoBtn').disabled = !st.history.length;
    $('#redoBtn').disabled = !st.future.length;
    const fileIssues = issues.filter(i => FILE_KEYS.has(i.key));
    $('#svgIssues').replaceChildren(...[
      h('div', { class: 'flex items-baseline gap-2 px-1' },
        h('span', { class: 'text-xs font-semibold uppercase tracking-wide text-stone-500' }, 'Fichier'),
        h('span', { class: 'text-xs text-stone-400' }, 'échelle, taille, calques, nettoyage — les éléments sont réglés dans le tableau plus bas')),
      // contrôles réussis : une ligne compacte (le détail reste au survol)
      fileIssues.some(i => i.level === 'ok') ? h('div', { class: 'flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-stone-500' }, fileIssues.filter(i => i.level === 'ok').map(i => h('span', { class: 'inline-flex items-center gap-1.5', title: i.detail }, h('i', { class: 'w-2 h-2 rounded-full bg-emerald-500' }), i.title))) : null,
      ...fileIssues.filter(i => i.level !== 'ok').map(is => issueCard(is, {
      focus: st.focus,
      onFocus: key => { st.selEl = null; st.focus = st.focus === key ? null : key; renderIssues(); drawSvgOverlay(); },
      onFix: is => applySvgFixes([is]),
      onAction: a => {
        if (a.kind === 'zoom') { zoomToIssue(a.key); return; }
        if (a.kind === 'ack') {
          st.history.push(snapshot()); st.future = [];
          a.ids.forEach(id => st.ack.add(id));
          st.log.push({ type: 'ack', ids: a.ids, msg: plural(a.ids.length, 'forme') + ' : gravure + découpe gardées (voulu)' });
          renderSvg(); return;
        } if (a.kind === 'resize') { $('#resizeBox').open = true; $('#resizeBox').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#rsW').focus(); } }
    }))].filter(Boolean));
    $('#focusHint').textContent = st.focus ? 'Problème repéré · cliquez à nouveau pour tout afficher' : 'Cliquez sur un problème pour le repérer';
  }

  /** Pastille « bloquants » / « à vérifier » : va au premier problème de ce niveau (tableau d'abord, sinon carte Fichier). */
  function goToLevel(lvl) {
    const st = S.svg;
    const el = st.result.elements.find(e => e.problems.some(p => p.lvl === lvl));
    if (el) { st.opsOnlyIssues = true; focusRow(el); return; }
    const is = st.result.issues.find(i => i.level === lvl && FILE_KEYS.has(i.key));
    if (is) { st.selEl = null; st.focus = is.key; renderIssues(); drawSvgOverlay(); const c = $('#svgIssues [data-key="' + is.key + '"]'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  /* ---------- Journal : chaque correction est une étape annulable ---------- */
  // st.log : [{ type: 'fix', key, msg } | { type: 'resize', w, msg }]

  function snapshot() { return { xml: LC.svg.serialize(S.svg.doc), log: S.svg.log.slice(), ack: [...S.svg.ack] }; }
  function restore(snap) { S.svg.doc = LC.svg.parse(snap.xml); S.svg.log = snap.log; S.svg.ack = new Set(snap.ack || []); }
  const analyzeCtx = () => ({ doc: S.svg.doc, root: S.svg.root, dpi: currentDpi(), origin: currentOrigin(), settings, colorOps: S.svg.colorOps, usage: S.svg.usage, ack: S.svg.ack });

  let busy = false;
  async function applySvgFixes(list, all) {
    if (busy) return;
    const st = S.svg;
    let go = [];
    for (const is of list) {
      if (is.fix.confirm && !(await askConfirm(is.fix.confirm, is.fix.label.replace(/…$/, '')))) continue;
      go.push(is);
    }
    if (!go.length) return;
    busy = true; $('#fixAllBtn').disabled = true;
    st.history.push(snapshot()); st.future = [];
    const start = st.log.length;
    try {
      // « Tout corriger » enchaîne jusqu'à 3 passes : une fusion de couleurs peut révéler un doublon exact.
      for (let pass = 0; pass < (all ? 3 : 1) && go.length; pass++) {
        // nettoyage en dernier : il supprime des éléments que d'autres corrections ciblent
        go.sort((a, b) => (a.key === 'clean') - (b.key === 'clean'));
        for (const is of go) {
          try {
            const msg = await is.fix.fn(st.doc);
            if (!msg) continue;
            // une même correction répétée dans ce clic = une seule ligne du journal
            const fixId = is.fix.id || null;
            const same = st.log.slice(start).find(s => s.key === is.key && s.fixId === fixId);
            if (same) same.msg += ' + ' + msg; else st.log.push({ type: 'fix', key: is.key, fixId, msg });
          } catch (e) { toast('Échec : ' + is.title + ' (' + e.message + ')'); }
        }
        LC.svg.ensureIds(st.doc);
        renderSvg();
        go = st.result ? st.result.issues.filter(i => i.fix && !i.fix.confirm) : [];
      }
    } finally { busy = false; }
    renderIssues();
    const remaining = st.result ? st.result.issues.filter(i => i.level === 'bad').length : 0;
    if (st.log.slice(start).some(l => l.key === 'text') && st.result && st.result.issues.some(i => i.key === 'vtext')) {
      toast('Texte vectorisé : cliquez sur « Voir de près » pour contrôler le résultat.');
      return;
    }
    toast(remaining ? 'Corrigé. Il reste ' + remaining + ' point' + (remaining > 1 ? 's' : '') + ' bloquant' + (remaining > 1 ? 's' : '') + ' à traiter à la main.' : 'Corrigé. Rapport recalculé.');
  }

  function undo() { const st = S.svg; if (!st.history.length) return; st.future.push(snapshot()); restore(st.history.pop()); renderSvg(); toast('Dernière modification annulée.'); }
  function redo() { const st = S.svg; if (!st.future.length) return; st.history.push(snapshot()); restore(st.future.pop()); renderSvg(); toast('Modification rétablie.'); }

  /**
   * Annule une étape précise du journal : on repart du fichier d'origine et on rejoue
   * toutes les autres étapes (chacune recalculée sur le fichier du moment).
   */
  async function undoStep(index) {
    const st = S.svg; if (busy) return;
    const removed = st.log[index];
    // les étapes suivantes du même type sont annulées aussi : sinon le rejeu referait la même correction
    const keep = st.log.filter((s, i) => i < index || (i > index && !(s.type === 'fix' && removed.type === 'fix' && s.key === removed.key)));
    // (les corrections « efix » ne visent qu'un élément : on rejoue toutes les autres)
    busy = true;
    st.history.push(snapshot()); st.future = [];
    try {
      st.doc = LC.svg.parse(st.originalXml);
      st.ack = new Set();
      const done = [];
      for (const step of keep) {
        if (step.type === 'ack') { step.ids.forEach(id => st.ack.add(id)); done.push(step); continue; }
        if (step.type === 'resize') { LC.svg.resize(st.doc, currentDpi(), step.w); done.push(step); continue; }
        st.root = LC.svg.renderPreview(st.doc, previewContainer());
        const res = LC.svg.analyze(analyzeCtx());
        if (step.type === 'op') {
          st.result = res;
          LC.svg.setOps(st.doc, st.root, currentDpi(), step.ids, step.op, opColors());
          if (step.op === 'both') step.ids.forEach(id => st.ack.add(id));
          done.push(step); continue;
        }
        if (step.type === 'efix') {
          const e = res.elements.find(x => x.id === step.id);
          const p = e && e.problems.find(q => q.key === step.key && q.fix && q.fix.id === step.fixId);
          if (!p) continue;
          if (await p.fix.fn(st.doc)) { LC.svg.ensureIds(st.doc); done.push(step); }
          continue;
        }
        const is = res.issues.find(i => i.key === step.key);
        const fix = is && [is.fix, is.altFix].find(f => f && (f.id || null) === (step.fixId || null));
        if (!fix) continue;                                  // plus rien à corriger pour cette étape
        const msg = await fix.fn(st.doc);
        LC.svg.ensureIds(st.doc);
        done.push(Object.assign({}, step, { msg: msg || step.msg }));
      }
      st.log = done;
    } finally { busy = false; }
    renderSvg();
    toast('Annulé : ' + removed.msg);
  }

  function renderLog() {
    const st = S.svg;
    $('#logCount').textContent = st.log.length ? '(' + st.log.length + ')' : '';
    const ctrl = $('#logCtrl');
    ctrl.replaceChildren(
      h('button', { class: 'text-xs px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40', disabled: !st.history.length, onclick: undo }, '↶ Annuler la dernière'),
      h('button', { class: 'text-xs px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40', disabled: !st.future.length, onclick: redo }, '↷ Rétablir'),
      h('button', { class: 'text-xs px-2 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40', disabled: !st.log.length, onclick: async () => {
        if (!(await askConfirm('Revenir au fichier d’origine ?\n\nToutes les corrections seront annulées.', 'Tout annuler'))) return;
        st.history.push(snapshot()); st.future = [];
        st.doc = LC.svg.parse(st.originalXml); st.log = []; renderSvg(); toast('Fichier d’origine restauré.');
      } }, 'Tout annuler'));
    $('#svgLog').replaceChildren(...(st.log.length ? st.log.map((step, i) => h('li', { class: 'flex items-start gap-2 py-1 border-b border-stone-100 dark:border-stone-800 last:border-0' },
      h('span', { class: 'text-stone-400 tabular-nums w-5 flex-none' }, (i + 1) + '.'),
      h('span', { class: 'flex-1' }, step.msg),
      h('button', { class: 'text-xs px-2 py-0.5 rounded-md border border-stone-300 dark:border-stone-700 hover:border-red-400 hover:text-red-600 flex-none', title: 'Annuler cette correction', onclick: () => undoStep(i) }, 'Annuler')))
      : [h('li', { class: 'text-stone-400' }, 'Aucune modification pour l’instant.')]));
  }

  function renderResize() {
    const U = S.svg.result.U;
    $('#rsW').value = +U.widthMm.toFixed(2);
    $('#rsH').value = +U.heightMm.toFixed(2);
    $('#rsP').value = 100;
  }

  function applyResize() {
    const st = S.svg, U = st.result.U;
    const w = parseFloat($('#rsW').value);
    if (!(w > 0)) return toast('Largeur invalide.');
    if (Math.abs(w - U.widthMm) < 0.005) return toast('Même taille : rien à faire.');
    st.history.push(snapshot()); st.future = [];
    st.log.push({ type: 'resize', w, msg: LC.svg.resize(st.doc, currentDpi(), w) });
    renderSvg();
  }

  function renderExport() {
    const st = S.svg, issues = st.result.issues;
    const bad = issues.filter(i => i.level === 'bad');
    $('#svgExportNote').textContent = 'Fichier : ' + baseName(S.name) + '_kleanpath.svg · unités en mm si l’échelle a été corrigée, sans métadonnées d’éditeur.' +
      (bad.length ? ' Attention : ' + bad.length + ' point' + (bad.length > 1 ? 's' : '') + ' bloquant' + (bad.length > 1 ? 's' : '') + ' restant' + (bad.length > 1 ? 's' : '') + '.' : '');
    renderCredits();
  }

  function exportSvg() {
    if (!LC.licence.consume('svg')) return openPro('Vous avez utilisé vos 3 exports SVG gratuits du jour. Passez en Pro pour des corrections et exports illimités, ou revenez demain.');
    download(new Blob([LC.svg.exportText(S.svg.doc)], { type: 'image/svg+xml' }), baseName(S.name) + '_kleanpath.svg');
    renderCredits();
  }

  function exportDxf() {
    if (!LC.licence.consume('svg')) return openPro('Vous avez utilisé vos 3 exports gratuits du jour. Passez en Pro pour des exports illimités, ou revenez demain.');
    const r = LC.svg.exportDxf({ doc: S.svg.doc, root: S.svg.root, dpi: currentDpi(), colorOps: S.svg.colorOps, usage: S.svg.result ? S.svg.result.usage.mode : 'mixte' });
    download(new Blob([r.text], { type: 'application/dxf' }), baseName(S.name) + '_kleanpath.dxf');
    const sk = [];
    if (r.skipped.texts) sk.push(r.skipped.texts + ' texte' + (r.skipped.texts > 1 ? 's' : ''));
    if (r.skipped.images) sk.push(r.skipped.images + ' image' + (r.skipped.images > 1 ? 's' : ''));
    toast('DXF exporté : ' + r.polylines + ' polyligne' + (r.polylines > 1 ? 's' : '') + (sk.length ? '. Non exporté : ' + sk.join(', ') + ' (à vectoriser).' : '.'));
    renderCredits();
  }

  /* ================= Gravure d'un SVG : PNG tramé ================= */

  let engTimer = 0;
  function scheduleEngrave() { clearTimeout(engTimer); engTimer = setTimeout(renderEngrave, 250); }

  async function renderEngrave() {
    const st = S.svg; if (!st || !st.result || S.mode !== 'svg') return;
    const show = st.result.usage.mode !== 'coupe';
    $('#engraveBox').classList.toggle('hidden', !show);
    if (!show || !$('#engraveBox').open) return;
    const id = ++st.engReq, dpi = +$('#eDpi').value, only = $('#eOnly').checked;
    $('#eStats').textContent = 'Calcul…';
    // Ce qui part dans le PNG, et ce qui reste en vecteurs
    const els = st.result.elements, engraved = els.filter(e => e.mode === 'gravure' || e.mode === 'both' || e.kind === 'image');
    const rest = els.length - engraved.length, info = $('#eInfo');
    const pl = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
    if (!only) { info.className = 'text-xs text-stone-500'; info.textContent = 'Tout le dessin est rendu en image, y compris les traits de découpe et de marquage.'; }
    else if (!engraved.length) {
      info.className = 'text-xs p-2 rounded-md bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200';
      info.textContent = 'Aucun élément n’est en gravure : rien à graver. Passez des éléments en « Gravure » dans le tableau Éléments, ou décochez « Seulement les couleurs associées à la gravure ».';
    } else {
      info.className = 'text-xs text-stone-500';
      info.textContent = 'Dans ce PNG : ' + pl(engraved.length, 'élément') + ' en gravure (' + engraved.slice(0, 3).map(e => e.label).join(', ') + (engraved.length > 3 ? '…' : '') + ').' +
        (rest ? ' Les ' + pl(rest, 'autre') + ' (découpe, marquage) ne sont pas dans le PNG.' : '');
    }
    $('#eOutline').src = LC.svg.outlineURL(st.doc, currentDpi(), st.result.elOps);
    syncGuides();
    let r;
    try { r = await LC.svg.rasterize(st.doc, currentDpi(), st.result.elOps, dpi, only); }
    catch (e) { $('#eStats').textContent = e.message; st.eng = null; return; }
    if (id !== st.engReq || S.svg !== st) return;
    const bits = await LC.image.dither(r.rgba, r.w, r.h, { contrast: 0, brightness: 0, gamma: 1, invert: $('#eInvert').checked, algo: $('#eAlgo').value, threshold: 128 });
    if (id !== st.engReq || S.svg !== st) return;
    st.eng = { bits, w: r.w, h: r.h, dpi };
    let black = 0; for (let i = 0; i < bits.length; i++) if (!bits[i]) black++;
    const cv = $('#ePreview'); cv.width = r.w; cv.height = r.h;
    const c = cv.getContext('2d'), im = c.createImageData(r.w, r.h);
    for (let i = 0; i < bits.length; i++) { const v = bits[i] ? 255 : 0; im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = v; im.data[4 * i + 3] = 255; }
    c.putImageData(im, 0, 0);
    $('#eStats').textContent = r.w + ' × ' + r.h + ' px · ' + dpi + ' DPI · ' + fmt(r.widthMm) + ' × ' + fmt(r.heightMm) + ' mm' +
      (black ? '' : ' · rien à graver avec ces réglages');
    $('#eExportBtn').disabled = !black;
  }

  /** Repères (contours non gravés) : seulement si on ne grave qu'une partie, et si la case est cochée. */
  function syncGuides() {
    const on = $('#eOnly').checked && $('#eGuides').checked;
    $('#eOutline').classList.toggle('hidden', !on);
    $('#eBigOutline').classList.toggle('hidden', !on);
    $('#eLegendGuide').classList.toggle('hidden', !on);
    $('#eGuidesRow').classList.toggle('hidden', !$('#eOnly').checked);
  }

  /** Aperçu de la gravure en grand, avec les contours en repère. */
  function enlargeEngrave() {
    const src = $('#ePreview'); if (!src.width) return;
    const big = $('#eBig'); big.width = src.width; big.height = src.height;
    big.getContext('2d').drawImage(src, 0, 0);
    $('#eBigOutline').src = $('#eOutline').src;
    syncGuides();
    $('#engDlg').showModal();
  }

  async function exportEngrave() {
    const st = S.svg; if (!st.eng) return;
    if (!LC.licence.consume('png')) return openPro('Vous avez utilisé vos 3 exports PNG gratuits du jour. Passez en Pro pour des exports illimités, ou revenez demain.');
    download(await LC.image.encodePng1bit(st.eng.bits, st.eng.w, st.eng.h, st.eng.dpi), baseName(S.name) + '_gravure.png');
    renderCredits();
  }

  /* ================= Traitement par lot (Pro) ================= */

  async function runBatch(files) {
    showView('batch');
    const inputs = [], errors = [];
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { errors.push({ name: f.name, error: 'Fichier trop lourd (20 Mo maximum).' }); continue; }
      try { inputs.push({ name: f.name, text: (await vectorText(f)).svg }); }
      catch (e) { errors.push({ name: f.name, error: e.message }); }
    }
    S.batch = { inputs, errors, results: [] };
    await processBatch();
  }

  async function processBatch() {
    const B = S.batch, bar = $('#batchProgress').firstElementChild;
    $('#batchZipBtn').disabled = true;
    $('#batchMeta').textContent = (B.inputs.length + B.errors.length) + ' fichiers';
    $('#batchRows').replaceChildren();
    const res = await LC.batch.run(B.inputs, { settings, removeFills: $('#batchFills').checked },
      (i, n) => { bar.style.width = (n ? i / n * 100 : 100) + '%'; $('#batchMeta').textContent = 'Analyse ' + Math.min(i + 1, n) + ' / ' + n + '…'; });
    B.results = res.concat(B.errors);
    const ok = B.results.filter(r => !r.error);
    const clean = ok.filter(r => !r.after.bad).length;
    $('#batchMeta').textContent = B.results.length + ' fichiers · ' + clean + ' sans point bloquant après correction';
    const pill = (n, cls) => h('span', { class: 'inline-flex items-center gap-1 mr-2' }, h('i', { class: 'w-2 h-2 rounded-full ' + cls }), n);
    $('#batchRows').replaceChildren(...B.results.map(r => h('tr', { class: 'border-b border-stone-100 dark:border-stone-800 align-top' },
      h('td', { class: 'py-2 pr-3 font-medium break-all' }, r.name),
      r.error ? h('td', { class: 'py-2 pr-3 text-red-600', colspan: '3' }, r.error) : [
        h('td', { class: 'py-2 pr-3 whitespace-nowrap' }, pill(r.before.bad, 'bg-red-500'), pill(r.before.warn, 'bg-amber-500')),
        h('td', { class: 'py-2 pr-3 whitespace-nowrap' }, pill(r.after.bad, 'bg-red-500'), pill(r.after.warn, 'bg-amber-500')),
        h('td', { class: 'py-2 pr-3 text-xs text-stone-500' }, r.left.length ? r.left.join(' · ') : 'Rien')],
      h('td', { class: 'py-2 text-right' }, r.source ? h('button', { class: 'text-xs underline', onclick: () => { loadSvg(r.source, r.name.replace(/\.dxf$/i, '.svg')); } }, 'Ouvrir') : ''))));
    $('#batchZipBtn').disabled = !ok.length;
  }

  function batchZip() {
    const ok = S.batch.results.filter(r => !r.error);
    const used = new Set();
    const entries = ok.map(r => {
      let n = baseName(r.name) + '_kleanpath.svg', i = 2;
      while (used.has(n)) n = baseName(r.name) + '_kleanpath_' + (i++) + '.svg';
      used.add(n);
      return { name: n, data: r.out };
    });
    const report = ['KleanPath — rapport du lot', new Date().toLocaleString('fr-FR'), ''].concat(S.batch.results.map(r => r.error
      ? r.name + ' : ERREUR — ' + r.error
      : r.name + ' : ' + r.before.bad + ' bloquant(s) → ' + r.after.bad + ' ; corrections : ' + (r.log.join(' ; ') || 'aucune') + (r.left.length ? ' ; reste : ' + r.left.join(' · ') : '')));
    entries.push({ name: 'rapport.txt', data: report.join('\r\n') + '\r\n' });
    download(LC.batch.zip(entries), 'kleanpath_lot.zip');
  }

  /* ================= Image ================= */

  const IMG_DEFAULT = { dpi: 318, brightness: 0, contrast: 0, gamma: 1, invert: false, algo: 'floyd', threshold: 128 };

  async function loadImage(blob, name, tab) {
    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch (e) { throw new Error('Image illisible : le fichier est peut-être abîmé.'); }
    const info = LC.image.analyzeSource(bitmap);
    const native = info.width / IMG_DEFAULT.dpi * 25.4;
    S.name = name;
    S.img = { bitmap, info, params: Object.assign({}, IMG_DEFAULT, { widthMm: Math.round(Math.min(native, 100)) || 1 }), req: 0, bits: null, tw: 0, th: 0, zoom: 0, log: [], vecReq: 0, vec: null, tab: tab || 'grav', view: null, srcURL: sourceURL(bitmap) };
    showView('img');
    setImgTab(S.img.tab);
    $('#imgName').textContent = name;
    $('#vecPreview').replaceChildren(); $('#vecStats').textContent = '';
    syncImgControls();
    processImage();
  }

  function syncImgControls() {
    const p = S.img.params;
    $('#pDpi').value = p.dpi; $('#pWidth').value = p.widthMm; $('#pAlgo').value = p.algo;
    $('#pBright').value = p.brightness; $('#pContrast').value = p.contrast; $('#pGamma').value = p.gamma; $('#pThreshold').value = p.threshold;
    $('#pInvert').checked = p.invert;
    $('#oBright').textContent = p.brightness; $('#oContrast').textContent = p.contrast; $('#oGamma').textContent = fmt(p.gamma, 2); $('#oThreshold').textContent = p.threshold;
    const thr = p.algo === 'threshold' && S.img.tab !== 'vec';
    $('#thresholdRow').classList.toggle('hidden', !thr);
    $('#thresholdRow').classList.toggle('block', thr);
  }

  let procTimer = 0;
  function scheduleProcess() { clearTimeout(procTimer); procTimer = setTimeout(processImage, 120); }

  async function processImage() {
    const st = S.img, p = st.params, info = st.info;
    const tw = Math.max(1, Math.round(p.widthMm / 25.4 * p.dpi));
    const th = Math.max(1, Math.round(tw * info.height / info.width));
    if (tw * th > 40e6) { toast('Taille trop grande à cette résolution : réduisez la largeur.'); return; }
    const id = ++st.req;
    $('#imgBusy').classList.remove('hidden');
    const before = $('#beforeCanvas');
    before.width = tw; before.height = th;
    const ctx = before.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);   // aplatissement sur fond blanc
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(st.bitmap, 0, 0, tw, th);              // rééchantillonnage : 1 pixel = 1 point laser
    const rgba = new Uint8ClampedArray(ctx.getImageData(0, 0, tw, th).data);
    let bits;
    try { bits = await LC.image.dither(rgba, tw, th, p); } catch (e) { toast(e.message); $('#imgBusy').classList.add('hidden'); return; }
    if (id !== st.req) return;                            // un réglage plus récent est en cours
    const after = $('#afterCanvas'); after.width = tw; after.height = th;
    const actx = after.getContext('2d'); const out = actx.createImageData(tw, th);
    for (let i = 0; i < bits.length; i++) { const v = bits[i] ? 255 : 0; out.data[4 * i] = out.data[4 * i + 1] = out.data[4 * i + 2] = v; out.data[4 * i + 3] = 255; }
    actx.putImageData(out, 0, 0);
    st.bits = bits; st.tw = tw; st.th = th;
    $('#imgBusy').classList.add('hidden');
    $('#imgMeta').textContent = info.width + ' × ' + info.height + ' px → ' + tw + ' × ' + th + ' points · ' + fmt(p.widthMm) + ' × ' + fmt(p.widthMm * th / tw) + ' mm';
    applyZoom();
    renderImgIssues();
    scheduleVector();
  }

  function renderImgIssues() {
    const st = S.img;
    const bed = { w: settings.bedW, h: settings.bedH };
    const issues = st.tab === 'vec' ? LC.image.issuesForVector(st.info, st.params, bed) : LC.image.issuesFor(st.info, st.params, bed);
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    issues.sort((a, b) => order[a.level] - order[b.level]);
    $('#imgIssues').replaceChildren(...issues.map(is => issueCard(is, {
      onFix: is => { is.fix.fn(st.params); syncImgControls(); processImage(); if (st.tab === 'vec') scheduleVector(); }
    })));
    $('#imgExportNote').textContent = 'Fichier : ' + baseName(S.name) + '_kleanpath.png · PNG 1 bit, ' + st.params.dpi + ' DPI inscrits dans le fichier (' + st.tw + ' × ' + st.th + ' px).';
    renderCredits();
  }

  function applyZoom() {
    const st = S.img, z = st.zoom;
    const fit = z === 0;
    const scale = fit ? null : Math.pow(2, (z - 50) / 25);  // 25 % → 400 %
    $('#zoomLabel').textContent = fit ? 'Ajusté' : fmt(scale * 100, 0) + ' %';
    $('#gravHint').textContent = fit ? 'Zoomez, puis glissez pour vous déplacer' : 'Glisser pour se déplacer';
    for (const id of ['#beforeWrap', '#afterWrap']) $(id).classList.toggle('fit', fit);
    for (const id of ['#beforeCanvas', '#afterCanvas']) {
      const c = $(id);
      c.style.width = fit ? '' : (st.tw * scale) + 'px';
      c.style.height = fit ? '' : (st.th * scale) + 'px';
    }
  }

  async function exportPng() {
    const st = S.img; if (!st.bits) return;
    if (!LC.licence.consume('png')) return openPro('Vous avez utilisé vos 3 exports PNG gratuits du jour. Passez en Pro pour des exports illimités, ou revenez demain.');
    const blob = await LC.image.encodePng1bit(st.bits, st.tw, st.th, st.params.dpi);
    download(blob, baseName(S.name) + '_kleanpath.png');
    renderCredits();
  }

  /* ================= Vectorisation ================= */

  let vecTimer = 0;
  function scheduleVector() {
    if (S.mode !== 'img' || !S.img || S.img.tab !== 'vec') return;
    clearTimeout(vecTimer); vecTimer = setTimeout(runVector, 250);
  }

  async function runVector() {
    const st = S.img, p = st.params, info = st.info;
    const tol = +$('#vSmooth').value, gravure = $('#vMode').value === 'gravure';
    // « toutes les formes » trace des contours empilés : en gravure (aplats), on garde « zones sombres » ou « couleurs »
    const detect = $('#vDetect').value, mode = gravure && detect === 'all' ? 'dark' : detect;
    // résolution de l'image d'origine (le bord est trouvé entre les pixels), plafonnée à 2400 px (1400 en couleurs)
    const s = Math.min(1, (mode === 'color' ? 1400 : 2400) / Math.max(info.width, info.height));
    const vw = Math.max(1, Math.round(info.width * s)), vh = Math.max(1, Math.round(info.height * s));
    const cv = document.createElement('canvas'); cv.width = vw; cv.height = vh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(st.bitmap, 0, 0, vw, vh);
    const id = ++st.vecReq;
    $('#vecStats').textContent = 'Calcul…';
    await new Promise(r => setTimeout(r, 0));
    if (id !== st.vecReq || S.img !== st) return;
    const data = ctx.getImageData(0, 0, vw, vh).data;
    const common = { tolPx: tol || 0.05, smooth: tol > 0, cornerCos: +$('#vCorners').value, minAreaMm2: Math.max(0, +$('#vMinArea').value || 0) };
    const v = mode === 'color'
      ? LC.vectorize.fromColors(data, vw, vh, p.widthMm / vw, Object.assign({ colors: +$('#vColors').value, skipBg: $('#vSkipBg').checked }, common))
      : LC.vectorize.fromGray(LC.vectorize.grayOf(data, vw, vh, p), vw, vh, p.widthMm / vw, Object.assign({ mode, threshold: +$('#vThreshold').value, margin: +$('#vMargin').value }, common));
    if (id !== st.vecReq || S.img !== st) return;
    if (!st.vec || Math.abs(st.vec.widthMm - v.widthMm) > 1e-6) st.view = null;
    st.vec = v;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const under = document.createElementNS(NS, 'image');
    under.setAttribute('id', 'vecUnder'); under.setAttribute('href', st.srcURL);
    under.setAttribute('x', 0); under.setAttribute('y', 0); under.setAttribute('width', v.widthMm); under.setAttribute('height', v.heightMm);
    under.setAttribute('preserveAspectRatio', 'none'); under.setAttribute('opacity', '0.35');
    under.setAttribute('display', $('#vzUnder').checked ? 'inline' : 'none');
    svg.append(under);
    const items = v.layers ? v.layers.map(l => ({ d: l.d, hex: l.hex })) : v.paths.map(d => ({ d, hex: null }));
    const light = h => { const n = parseInt(h.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) > 225; };
    for (const it of items.length ? items : [{ d: 'M0 0', hex: null }]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', it.d);
      path.setAttribute('fill-rule', 'evenodd');
      // un trait très clair resterait invisible sur fond blanc : on le fonce dans l'aperçu seulement
      const strokeCol = it.hex ? (light(it.hex) ? '#a8a29e' : it.hex) : '#e11d48';
      path.setAttribute('style', gravure ? 'fill:' + (it.hex || '#000') : 'fill:none;stroke:' + strokeCol + ';stroke-width:1px;vector-effect:non-scaling-stroke');
      svg.append(path);
    }
    renderPalette(v);
    $('#vecPreview').replaceChildren(svg);
    renderBeforeVec();
    applyView();
    $('#vecStats').textContent = (v.layers ? v.layers.length + ' calque' + (v.layers.length > 1 ? 's' : '') + ' de couleur · ' : '') + v.count + ' contour' + (v.count > 1 ? 's' : '') + ' · ' + v.nodes + ' nœuds · ' + fmt(v.widthMm) + ' × ' + fmt(v.heightMm) + ' mm' +
      (v.count > 1500 ? '. Beaucoup de contours : pour une photo, préférez la gravure tramée, ou augmentez le lissage et la surface ignorée.' : v.count ? '' : '. Aucune zone sombre : baissez ou montez le seuil.');
    $('#vecBtn').disabled = !v.count;
  }

  /** Palette du mode couleurs : chaque teinte devient un calque (une puissance laser dans LightBurn). */
  function renderPalette(v) {
    const box = $('#vecPalette');
    if (!v.palette) { box.replaceChildren(); box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const kept = new Set((v.layers || []).map(l => l.hex));
    box.replaceChildren(...v.palette.slice().sort((a, b) => b.share - a.share).map(c => h('span', {
      class: 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-stone-200 dark:border-stone-700 text-xs' + (kept.has(c.hex) ? '' : ' opacity-50 line-through'),
      title: c.background ? 'Fond (ignoré)' : kept.has(c.hex) ? 'Calque ' + c.hex : 'Trop petit : ignoré'
    }, h('span', { class: 'chip-swatch', style: 'background:' + c.hex }), c.hex + ' · ' + fmt(c.share * 100, 0) + ' %' + (c.background ? ' (fond)' : ''))));
  }

  /** Image d'origine sur fond blanc (pour la vue zoomable de la vectorisation). */
  function sourceURL(bitmap) {
    const sc = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bitmap.width * sc)); cv.height = Math.max(1, Math.round(bitmap.height * sc));
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    c.imageSmoothingQuality = 'high'; c.drawImage(bitmap, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.92);
  }

  /* ---------- Vue zoomable de la vectorisation (Avant et Vecteur synchronisés) ---------- */
  const fitView = () => ({ x: 0, y: 0, w: S.img.vec.widthMm, h: S.img.vec.heightMm });
  const viewOf = () => S.img.view || fitView();
  function applyView() {
    const st = S.img; if (!st || !st.vec) return;
    const v = viewOf(), vb = [v.x, v.y, v.w, v.h].map(n => +n.toFixed(4)).join(' ');
    for (const sel of ['#beforeVec svg', '#vecPreview svg']) { const e = $(sel); if (e) e.setAttribute('viewBox', vb); }
    $('#vzLabel').textContent = Math.round(fitView().w / v.w * 100) + ' %';
  }
  function zoomAt(factor, cx, cy) {
    const st = S.img; if (!st || !st.vec) return;
    const v = viewOf(), fw = st.vec.widthMm;
    const w = Math.min(Math.max(v.w * factor, fw / 64), fw * 1.5), k = w / v.w;
    st.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w, h: v.h * k };
    applyView();
  }
  const zoomCenter = factor => { const v = viewOf(); zoomAt(factor, v.x + v.w / 2, v.y + v.h / 2); };
  function svgPoint(svg, x, y) { const m = svg.getScreenCTM().inverse(); return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }

  function renderBeforeVec() {
    const st = S.img, v = st.vec; if (!v) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const img = document.createElementNS(NS, 'image');
    img.setAttribute('href', st.srcURL); img.setAttribute('x', 0); img.setAttribute('y', 0);
    img.setAttribute('width', v.widthMm); img.setAttribute('height', v.heightMm); img.setAttribute('preserveAspectRatio', 'none');
    svg.append(img);
    $('#beforeVec').replaceChildren(svg);
  }

  function setImgTab(t) {
    if (!FEATURES.imageVectorize) t = 'grav';
    $('#imgTabs').classList.toggle('hidden', !FEATURES.imageVectorize);
    const st = S.img; st.tab = t; const vec = t === 'vec';
    $('#tabGrav').classList.toggle('active', !vec); $('#tabVec').classList.toggle('active', vec);
    $('#tabGrav').setAttribute('aria-selected', String(!vec)); $('#tabVec').setAttribute('aria-selected', String(vec));
    $('#afterCol').classList.toggle('hidden', vec); $('#vecCol').classList.toggle('hidden', !vec);
    $('#vecBox').classList.toggle('hidden', !vec); $('#imgExportCard').classList.toggle('hidden', vec);
    $('#algoRow').classList.toggle('hidden', vec);
    $('#dpiRow').classList.toggle('hidden', vec);
    $('#prepTitle').textContent = vec ? 'Réglages appliqués avant la vectorisation' : 'Réglages de l’image';
    $('#prepNote').classList.toggle('hidden', !vec);
    if (st.info) renderImgIssues();
    $('#beforeWrap').classList.toggle('hidden', vec); $('#beforeVec').classList.toggle('hidden', !vec);
    $('#gravZoom').classList.toggle('hidden', vec); $('#vecZoom').classList.toggle('hidden', !vec);
    $('#gravHint').classList.toggle('hidden', vec); $('#vecHint').classList.toggle('hidden', !vec);
    syncImgControls();
    if (vec) scheduleVector();
  }

  async function saveVector() {
    const st = S.img;
    if (!st.vec) await runVector();
    if (!st.vec || !st.vec.count) return toast('Rien à vectoriser avec ces réglages.');
    if (!LC.licence.consume('svg')) return openPro('Vous avez utilisé vos 3 exports gratuits du jour. Passez en Pro pour des exports illimités, ou revenez demain.');
    download(new Blob([LC.vectorize.toSvg(st.vec, $('#vMode').value)], { type: 'image/svg+xml' }), baseName(S.name) + '_vecteur.svg');
    renderCredits();
  }

  async function openVector() {
    const st = S.img;
    if (!st.vec) await runVector();
    if (!st.vec || !st.vec.count) return toast('Rien à vectoriser avec ces réglages.');
    loadSvg(LC.vectorize.toSvg(st.vec, $('#vMode').value), baseName(S.name) + '_vecteur.svg', $('#vMode').value);
    toast('SVG créé à partir de l’image : vérifiez le rapport, puis exportez.');
  }

  /* ================= Pro, crédits, encarts ================= */

  function renderCredits() {
    const free = LC.licence.CONFIG.allFree, pro = LC.licence.isPro();
    // Tout gratuit : ni bouton Pro, ni compteur, ni encart
    $('#proBtn').classList.toggle('hidden', free);
    $('#proBadge').classList.toggle('hidden', free || !pro);
    $('#proBtn').textContent = pro ? 'Licence' : 'Passer en Pro';
    if (free) {
      for (const el of $$('.credits, .credits-svg, .credits-png')) { el.textContent = ''; el.classList.add('hidden'); }
      for (const el of $$('.promo')) el.replaceChildren();
      return;
    }
    for (const el of $$('.credits, .credits-svg, .credits-png')) {
      const kind = el.classList.contains('credits-svg') ? 'svg' : el.classList.contains('credits-png') ? 'png' : el.closest('#imgView') ? 'png' : 'svg';
      const r = LC.licence.remaining(kind);
      el.textContent = pro ? 'Pro : exports illimités' : r + ' export' + (r > 1 ? 's' : '') + ' gratuit' + (r > 1 ? 's' : '') + ' restant' + (r > 1 ? 's' : '') + ' aujourd’hui';
    }
    for (const el of $$('.promo')) {
      el.replaceChildren();
      if (pro) continue;
      el.append(
        h('div', { class: 'rounded-2xl p-4 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-900 text-sm' },
          h('div', { class: 'font-semibold' }, 'KleanPath Pro — ' + LC.licence.CONFIG.price + ', à vie'),
          h('p', { class: 'mt-1 text-xs text-stone-600 dark:text-stone-400' }, 'Corrections et exports illimités, sans abonnement, sans encart. Toujours 100 % local.'),
          h('button', { class: 'mt-2 text-xs font-medium underline text-orange-700 dark:text-orange-400', onclick: () => openPro() }, 'En savoir plus')));
    }
  }

  function openPro(reason) {
    const pro = LC.licence.isPro(), l = LC.licence.licence();
    $('#proTitle').textContent = pro ? 'Votre licence Pro' : 'KleanPath Pro';
    $('#proReason').textContent = reason || '';
    $('#proReason').classList.toggle('hidden', !reason);
    $('#proOffer').classList.toggle('hidden', pro);
    $('#buyBtn').textContent = 'Acheter — ' + LC.licence.CONFIG.price + ', accès à vie';
    $('#keyInput').value = '';
    $('#keyInput').disabled = pro;
    $('#activateBtn').classList.toggle('hidden', pro);
    $('#deactivateBtn').classList.toggle('hidden', !pro);
    const m = $('#keyMsg'); m.className = 'mt-2 text-xs';
    m.textContent = pro ? 'Licence active sur cet ordinateur' + (l && l.key ? ' (clé ' + l.key + ')' : '') + '.' : '';
    $('#proDlg').showModal();
  }

  /* ================= Réglages ================= */

  function openSettings() {
    $('#sBedW').value = settings.bedW; $('#sBedH').value = settings.bedH; $('#sKerf').value = settings.kerf;
    $('#sOrigin').value = settings.origin; $('#sCloseTol').value = settings.closeTol;
    $('#sProfile').value = PROFILES.some(p => p.id === settings.profile) ? settings.profile : 'perso';
    $('#settingsDlg').showModal();
  }
  function saveSettings() {
    const n = (id, def, min) => { const v = parseFloat($(id).value); return v >= min ? v : def; };
    settings.bedW = n('#sBedW', DEFAULTS.bedW, 1); settings.bedH = n('#sBedH', DEFAULTS.bedH, 1);
    settings.kerf = n('#sKerf', DEFAULTS.kerf, 0); settings.closeTol = n('#sCloseTol', DEFAULTS.closeTol, 0.01);
    settings.origin = $('#sOrigin').value;
    const prof = PROFILES.find(p => p.id === $('#sProfile').value);
    settings.profile = prof ? prof.id : 'perso';
    settings.profileName = prof && prof.w ? prof.name : '';
    LC.store.set('lc_settings', settings);
    if (S.mode === 'batch' && S.batch) processBatch();
    if (S.mode === 'svg') renderSvg();
    if (S.mode === 'img') renderImgIssues();
    toast('Réglages enregistrés.');
  }

  /* ================= Branchements ================= */

  function wire() {
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => openFiles(e.dataTransfer.files));
    // dépôt possible n'importe où, même après un premier fichier
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => { e.preventDefault(); if (!dz.contains(e.target)) openFiles(e.dataTransfer.files); });
    $('#fileInput').addEventListener('change', e => { openFiles(e.target.files); e.target.value = ''; });

    $('#demoSvgBtn').addEventListener('click', async () => {
      const usage = await chooseMode('vector', 'exemple-illustrator.svg'); if (!usage) return;
      try { loadSvg(LC.SAMPLE_SVG, 'exemple-illustrator.svg', usage); } catch (e) { homeError(e.message); }
    });
    $('#demoImgBtn').addEventListener('click', async () => {
      const tab = FEATURES.imageVectorize ? await chooseMode('image', 'exemple-photo.png') : 'grav'; if (!tab) return;
      loadImage(await LC.image.demoBlob(), 'exemple-photo.png', tab);
    });
    $('#homeBtn').addEventListener('click', () => showView('home'));
    $$('.newFileBtn').forEach(b => b.addEventListener('click', () => $('#fileInput').click()));

    $('#themeBtn').addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('lc_theme', dark ? 'dark' : 'light'); } catch (e) { /* rien */ }
    });
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsSave').addEventListener('click', saveSettings);
    $('#proBtn').addEventListener('click', () => openPro());

    $('#buyBtn').addEventListener('click', () => {
      const url = LC.licence.CONFIG.checkoutUrl;
      if (url) window.open(url, '_blank', 'noopener'); else toast('Lien de paiement pas encore configuré (js/licence.js).');
    });
    $('#activateBtn').addEventListener('click', async () => {
      const m = $('#keyMsg'), b = $('#activateBtn');
      b.disabled = true; m.className = 'mt-2 text-xs text-stone-500'; m.textContent = 'Vérification…';
      try {
        const r = await LC.licence.activate($('#keyInput').value);
        m.className = 'mt-2 text-xs text-emerald-600'; m.textContent = r.demo ? 'Licence de démonstration activée.' : 'Licence activée. Merci !';
        renderCredits(); setTimeout(() => $('#proDlg').close(), 900);
      } catch (e) { m.className = 'mt-2 text-xs text-red-600'; m.textContent = e.message; }
      b.disabled = false;
    });
    $('#deactivateBtn').addEventListener('click', () => { LC.licence.deactivate(); renderCredits(); $('#proDlg').close(); toast('Licence retirée de cet ordinateur.'); });

    // SVG
    $('#fixAllBtn').addEventListener('click', () => applySvgFixes(S.svg.result.issues.filter(i => i.fix), true));
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    document.addEventListener('keydown', e => {
      if (S.mode !== 'svg' || !(e.ctrlKey || e.metaKey) || e.target.closest('input,select,textarea')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    const ratio = () => S.svg.result.U.heightMm / S.svg.result.U.widthMm;
    $('#rsW').addEventListener('input', () => { const w = +$('#rsW').value; $('#rsH').value = +(w * ratio()).toFixed(2); $('#rsP').value = +(w / S.svg.result.U.widthMm * 100).toFixed(1); });
    $('#rsH').addEventListener('input', () => { const hh = +$('#rsH').value; const w = hh / ratio(); $('#rsW').value = +w.toFixed(2); $('#rsP').value = +(w / S.svg.result.U.widthMm * 100).toFixed(1); });
    $('#rsP').addEventListener('input', () => { const w = S.svg.result.U.widthMm * +$('#rsP').value / 100; $('#rsW').value = +w.toFixed(2); $('#rsH').value = +(w * ratio()).toFixed(2); });
    $('#rsApply').addEventListener('click', applyResize);
    $('#svgExportBtn').addEventListener('click', exportSvg);
    $('#dxfExportBtn').addEventListener('click', exportDxf);
    $('#batchZipBtn').addEventListener('click', batchZip);
    $('#batchFills').addEventListener('change', () => { if (S.batch) processBatch(); });
    $('#sProfile').replaceChildren(...PROFILES.map(p => h('option', { value: p.id }, p.name + (p.w ? ' — ' + p.w + ' × ' + p.h + ' mm' : ''))));
    $('#sProfile').addEventListener('change', () => {
      const p = PROFILES.find(x => x.id === $('#sProfile').value);
      if (p && p.w) { $('#sBedW').value = p.w; $('#sBedH').value = p.h; }
    });
    ['#sBedW', '#sBedH'].forEach(id => $(id).addEventListener('input', () => { $('#sProfile').value = 'perso'; }));

    // Image
    const bind = (id, key, conv, out) => $(id).addEventListener('input', e => {
      const p = S.img.params; p[key] = conv(e.target);
      if (out) $(out).textContent = key === 'gamma' ? fmt(p[key], 2) : p[key];
      if (key === 'algo') syncImgControls();
      scheduleProcess();
    });
    bind('#pDpi', 'dpi', t => +t.value);
    bind('#pWidth', 'widthMm', t => Math.max(1, +t.value || 1));
    bind('#pAlgo', 'algo', t => t.value);
    bind('#pBright', 'brightness', t => +t.value, '#oBright');
    bind('#pContrast', 'contrast', t => +t.value, '#oContrast');
    bind('#pGamma', 'gamma', t => +t.value, '#oGamma');
    bind('#pThreshold', 'threshold', t => +t.value, '#oThreshold');
    bind('#pInvert', 'invert', t => t.checked);
    $('#imgResetBtn').addEventListener('click', () => { const w = S.img.params.widthMm; S.img.params = Object.assign({}, IMG_DEFAULT, { widthMm: w }); syncImgControls(); processImage(); });
    $('#zoom').addEventListener('input', e => { S.img.zoom = +e.target.value; applyZoom(); });
    // défilement synchronisé avant / après
    let syncing = false;
    const sync = (a, b) => $(a).addEventListener('scroll', () => { if (syncing) return; syncing = true; $(b).scrollLeft = $(a).scrollLeft; $(b).scrollTop = $(a).scrollTop; requestAnimationFrame(() => { syncing = false; }); });
    sync('#beforeWrap', '#afterWrap'); sync('#afterWrap', '#beforeWrap');
    $('#imgExportBtn').addEventListener('click', exportPng);
    // Vectorisation : molette = zoom autour du curseur, clic gauche maintenu = déplacement, double-clic = ajuster
    let drag = null;
    for (const box of [$('#beforeVec'), $('#vecPreview')]) {
      box.addEventListener('wheel', e => {
        const svg = box.querySelector('svg'); if (!svg || !S.img || !S.img.vec) return;
        e.preventDefault();
        const p = svgPoint(svg, e.clientX, e.clientY);
        zoomAt(Math.pow(1.0015, e.deltaY), p.x, p.y);
      }, { passive: false });
      box.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const svg = box.querySelector('svg'); if (!svg || !S.img || !S.img.vec) return;
        drag = { box, sx: e.clientX, sy: e.clientY, v: viewOf(), k: svg.getScreenCTM().a };
        box.setPointerCapture(e.pointerId); box.classList.add('dragging');
      });
      box.addEventListener('pointermove', e => {
        if (!drag || drag.box !== box) return;
        S.img.view = { x: drag.v.x - (e.clientX - drag.sx) / drag.k, y: drag.v.y - (e.clientY - drag.sy) / drag.k, w: drag.v.w, h: drag.v.h };
        applyView();
      });
      const end = () => { if (drag && drag.box === box) { drag = null; box.classList.remove('dragging'); } };
      box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
      box.addEventListener('dblclick', () => { if (S.img) { S.img.view = null; applyView(); } });
    }
    $('#vzIn').addEventListener('click', () => zoomCenter(1 / 1.5));
    $('#vzOut').addEventListener('click', () => zoomCenter(1.5));
    $('#vzFit').addEventListener('click', () => { if (S.img) { S.img.view = null; applyView(); } });
    $('#vzUnder').addEventListener('change', e => { const u = $('#vecUnder'); if (u) u.setAttribute('display', e.target.checked ? 'inline' : 'none'); });

    // Gravure : déplacement au clic gauche dans les vues zoomées
    let gdrag = null;
    for (const w of [$('#beforeWrap'), $('#afterWrap')]) {
      w.addEventListener('pointerdown', e => {
        if (e.button !== 0 || w.classList.contains('fit')) return;
        gdrag = { w, sx: e.clientX, sy: e.clientY, l: w.scrollLeft, t: w.scrollTop };
        w.setPointerCapture(e.pointerId); w.classList.add('dragging');
      });
      w.addEventListener('pointermove', e => {
        if (!gdrag || gdrag.w !== w) return;
        w.scrollLeft = gdrag.l - (e.clientX - gdrag.sx); w.scrollTop = gdrag.t - (e.clientY - gdrag.sy);
      });
      const end = () => { if (gdrag && gdrag.w === w) { gdrag = null; w.classList.remove('dragging'); } };
      w.addEventListener('pointerup', end); w.addEventListener('pointercancel', end);
    }

    {
      const host = $('#svgPreview');
      const rootSvg = () => S.svg && S.svg.root;
      const toUser = (x, y) => { const m = rootSvg().getScreenCTM().inverse(); return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; };
      host.addEventListener('wheel', e => {
        if (!rootSvg() || !S.svg.pfit) return;
        e.preventDefault();
        const p = toUser(e.clientX, e.clientY);
        zoomPreview(Math.pow(1.0015, e.deltaY), p.x, p.y);
      }, { passive: false });
      let pd = null, swallowClick = false;
      host.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !rootSvg() || !S.svg.pfit) return;
        pd = { sx: e.clientX, sy: e.clientY, v: pViewOf(), k: rootSvg().getScreenCTM().a, moved: false, id: e.pointerId };
      });
      host.addEventListener('pointermove', e => {
        if (!pd) return;
        const dx = e.clientX - pd.sx, dy = e.clientY - pd.sy;
        if (!pd.moved && Math.hypot(dx, dy) < 4) return;          // petit mouvement : c'est un clic
        if (!pd.moved) { pd.moved = true; host.setPointerCapture(pd.id); host.classList.add('dragging'); }
        S.svg.pview = { x: pd.v.x - dx / pd.k, y: pd.v.y - dy / pd.k, w: pd.v.w, h: pd.v.h };
        drawSvgOverlay();
      });
      const end = () => { if (pd && pd.moved) swallowClick = true; pd = null; host.classList.remove('dragging'); };
      host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
      host.addEventListener('click', e => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);
      host.addEventListener('dblclick', () => { if (S.svg) { S.svg.pview = null; drawSvgOverlay(); } });
      $('#pzIn').addEventListener('click', () => zoomPreviewCenter(1 / 1.5));
      $('#pzOut').addEventListener('click', () => zoomPreviewCenter(1.5));
      $('#pzFit').addEventListener('click', () => { if (S.svg) { S.svg.pview = null; drawSvgOverlay(); } });
    }

    $('#tabGrav').addEventListener('click', () => setImgTab('grav'));
    $('#tabVec').addEventListener('click', () => setImgTab('vec'));
    $('#vecSaveBtn').addEventListener('click', saveVector);
    ['#eDpi', '#eAlgo', '#eOnly', '#eInvert'].forEach(id => $(id).addEventListener('input', scheduleEngrave));
    $('#eExportBtn').addEventListener('click', exportEngrave);
    $('#eEnlarge').addEventListener('click', enlargeEngrave);
    $('#eGuides').addEventListener('change', syncGuides);
    $('#engraveBox').addEventListener('toggle', scheduleEngrave);
    $('#ePreviewBox').addEventListener('click', enlargeEngrave);
    $('#vThreshold').addEventListener('input', e => { $('#oVThreshold').textContent = e.target.value; scheduleVector(); });
    $('#vMargin').addEventListener('input', e => { $('#oVMargin').textContent = e.target.value; scheduleVector(); });
    const syncDetect = () => {
      const grav = $('#vMode').value === 'gravure', det = $('#vDetect');
      det.querySelector('option[value="all"]').disabled = grav;
      if (grav && det.value === 'all') det.value = 'dark';
      const color = det.value === 'color';
      $('#vMarginRow').classList.toggle('hidden', det.value !== 'all');
      $('#vThresholdRow').classList.toggle('hidden', color);
      $('#vColorsRow').classList.toggle('hidden', !color);
    };
    $('#vColors').addEventListener('input', e => { $('#oVColors').textContent = e.target.value; scheduleVector(); });
    $('#vSkipBg').addEventListener('change', scheduleVector);
    ['#vSmooth', '#vCorners', '#vMinArea', '#vMode', '#vDetect'].forEach(id => $(id).addEventListener('input', () => { syncDetect(); scheduleVector(); }));
    $('#usageSel').addEventListener('change', e => { if (S.svg) { S.svg.usage = e.target.value; renderSvg(); } });
    $('#vecBtn').addEventListener('click', openVector);

    window.addEventListener('resize', () => { if (S.mode === 'svg' && S.svg && S.svg.result) drawSvgOverlay(); });
  }

  wire();
  renderCredits();
  showView('home');
  LC.app = { S, loadSvg, loadImage, settings }; // accès pour le débogage
})();
