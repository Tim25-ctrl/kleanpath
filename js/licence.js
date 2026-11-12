/* KleanPath — module licence : compteur d'exports gratuits, clé Pro, stockage local.
   Seule la clé de licence est envoyée sur le réseau, au moment de l'activation. Jamais un fichier. */
(function () {
  'use strict';
  const LC = (window.LC = window.LC || {});

  const CONFIG = {
    // Lancement : tout est gratuit et illimité (pas de compteur, pas de licence demandée).
    // Pour réactiver l'offre Pro plus tard, repasser à false.
    allFree: true,
    price: '9 €',                    // à tester : 9 € et 12 € (cahier des charges, section 10)
    checkoutUrl: '',                 // lien Lemon Squeezy ou Stripe Payment Link, à renseigner
    freePerDay: 3,
    lemonSqueezyUrl: 'https://api.lemonsqueezy.com/v1/licenses/validate',
    fallbackUrl: '/api/validate',    // fonction serverless de secours (api/validate.js)
    demoKey: 'KLEANPATH-DEMO'       // accepté uniquement en local, pour tester le parcours
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } }
  };

  const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function usage() { const u = store.get('lc_usage'); return u && u.day === today() ? u : { day: today(), svg: 0, png: 0 }; }
  function licence() { return store.get('lc_licence'); }
  function isPro() { const l = licence(); return !!(l && l.valid); }
  function remaining(kind) { return isPro() || CONFIG.allFree ? Infinity : Math.max(0, CONFIG.freePerDay - (usage()[kind] || 0)); }
  function consume(kind) {
    if (isPro() || CONFIG.allFree) return true;
    const u = usage(); if ((u[kind] || 0) >= CONFIG.freePerDay) return false;
    u[kind] = (u[kind] || 0) + 1; store.set('lc_usage', u); return true;
  }

  const isLocal = () => location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || /\.(localhost|test)$/.test(location.hostname);
  const mask = k => k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : k;

  async function post(url, key) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ license_key: key })
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error('Réponse illisible (' + r.status + ')');
    return j;
  }

  async function activate(raw) {
    const key = (raw || '').trim();
    if (!key) throw new Error('Collez votre clé de licence.');
    if (key === CONFIG.demoKey) {
      if (!isLocal()) throw new Error('Cette clé de démonstration ne fonctionne qu’en local.');
      store.set('lc_licence', { key: 'DEMO', valid: true, demo: true, at: Date.now() });
      return { demo: true };
    }
    let res = null;
    // 1) appel direct à Lemon Squeezy (CORS à confirmer), 2) fonction serverless de secours
    for (const url of [CONFIG.lemonSqueezyUrl, CONFIG.fallbackUrl]) {
      try { res = await post(url, key); break; } catch (e) { /* on tente la suivante */ }
    }
    if (!res) throw new Error('Vérification impossible pour le moment (réseau). Réessayez plus tard.');
    if (!res.valid) throw new Error(res.error ? 'Clé refusée : ' + res.error : 'Cette clé n’est pas valide.');
    store.set('lc_licence', { key: mask(key), valid: true, at: Date.now() });
    return res;
  }

  function deactivate() { store.del('lc_licence'); }

  LC.store = store;
  const unlocked = () => CONFIG.allFree || isPro();
  LC.licence = { CONFIG, unlocked, isPro, remaining, consume, activate, deactivate, licence };
})();
