// Fonction serverless Vercel de secours : vérifie une clé auprès de Lemon Squeezy
// si l'appel direct depuis le navigateur est bloqué (CORS).
// Ne reçoit que la clé de licence, jamais de fichier.
// Variable d'environnement facultative : LS_PRODUCT_ID (refuse les clés d'un autre produit).

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ valid: false, error: 'POST attendu' });

  const key = String((req.body && req.body.license_key) || '').trim();
  if (!key || key.length > 200) return res.status(400).json({ valid: false, error: 'clé manquante' });

  try {
    const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ license_key: key })
    });
    const data = await r.json();
    let valid = !!data.valid;
    const productId = process.env.LS_PRODUCT_ID;
    if (valid && productId && String(data.meta && data.meta.product_id) !== String(productId)) valid = false;
    return res.status(200).json({ valid, error: valid ? null : (data.error || 'clé invalide') });
  } catch (e) {
    return res.status(502).json({ valid: false, error: 'Lemon Squeezy injoignable' });
  }
};
