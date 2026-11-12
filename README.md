# KleanPath

Vérifie et corrige, dans le navigateur, les fichiers de découpe et gravure laser.
Aucun fichier n'est envoyé sur le réseau.

## Lancer

```bash
node server.js
```

Puis ouvrir http://localhost:5173. On peut aussi ouvrir `index.html` directement (double-clic) : tout fonctionne, sauf la licence de démonstration qui reste réservée au local.

Boutons « Essayer un SVG d'exemple » / « une image d'exemple » sur l'accueil pour voir tous les contrôles sans fichier. Clé Pro de démonstration en local : `KLEANPATH-DEMO`.

## Fonctions

- **SVG et DXF** : 10 contrôles (échelle/DPI, dimensions vs plateau, tracés ouverts, doublons, texte, images, couleurs, épaisseur de trait et remplissages, détails trop fins, nettoyage), aperçu surligné, corrections annulables, redimensionnement, export SVG en mm et export DXF R12.
- **Images PNG/JPG** : analyse (résolution, plateau, transparence, contraste), préparation à la gravure (6 tramages), export PNG 1 bit avec DPI inscrits.
- **Usage du fichier** : découpe, gravure ou les deux, détecté automatiquement (modifiable). En gravure : couleurs par défaut en gravure/marquage, résolution réelle des images intégrées (DPI), tracés ouverts signalés sans alarme.
- **Texte → chemins** : correction automatique du contrôle 5, avec la police installée sur l'ordinateur (avertissement et confirmation si elle manque).
- **Journal** : chaque correction a son bouton « Annuler » (les autres sont rejouées), plus « Annuler la dernière », « Rétablir » et « Tout annuler ».
- **Vectorisation d'image : désactivée pour le moment** (`FEATURES.imageVectorize = false` en haut de `js/app.js`). Défauts restants : un dégradé est découpé en paliers, et des liserés blancs apparaissent entre couleurs. Le moteur reste utilisé pour vectoriser les textes des SVG. Description du moteur, pour plus tard : image → contours fermés → SVG en mm (découpe ou gravure). Bords trouvés entre les pixels (sans escalier), courbes de Bézier, angles vifs/normaux/arrondis. Trois détections : zones sombres, toutes les formes (y compris claires), ou par couleurs (un calque par couleur, fond ignoré). Vue zoomable synchronisée avec l'image d'origine.
- **Pourquoi pas Potrace** : sa licence GPL (y compris esm-potrace-wasm) imposerait de publier tout le code de KleanPath sous GPL.
- **Traitement par lot (Pro)** : plusieurs SVG/DXF déposés d'un coup → corrections automatiques → ZIP + rapport.
- **Profils machine** : zones de travail prédéfinies (xTool, Glowforge, Ortur, Epilog).
- **Modèle économique** : **tout est gratuit et illimité pour le lancement** (`allFree: true` dans `js/licence.js`). Le système Pro (3 exports/jour, licence à vie via Lemon Squeezy) reste dans le code : repasser `allFree` à `false` pour le réactiver. Pas de liens affiliés.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html`, `css/app.css` | Interface (Tailwind via CDN pour le prototype) |
| `legal.html` | Mentions légales, CGV, confidentialité (modèle à compléter) |
| `js/svg.js` | Contrôles 1 à 10, corrections, redimensionnement, export SVG mm et DXF |
| `js/dxf.js` | Lecteur DXF ASCII → SVG (lignes, polylignes avec arcs, cercles, arcs, ellipses, splines, textes, blocs) |
| `js/image.js` | Analyse image, réglages, 6 tramages (Web Worker), encodeur PNG 1 bit + pHYs |
| `js/vectorize.js` | Vectorisation image → SVG |
| `js/batch.js` | Traitement par lot et archive ZIP |
| `js/licence.js` | Compteur d'exports, clé Pro, appel Lemon Squeezy |
| `js/app.js` | Interface : rapport, aperçu, annuler/rétablir, exports, réglages, lot |
| `js/samples.js` | SVG d'exemple type Illustrator qui cumule les erreurs |
| `api/validate.js` | Fonction serverless Vercel de secours pour la licence |
| `server.js` | Serveur statique de développement |

## Choix techniques

- **Aucune dépendance** : géométrie par le moteur SVG du navigateur, lecteur DXF, encodeur PNG et ZIP écrits à la main.
- **Fermeture des tracés** : seuil réglable (0,5 mm par défaut).
- **Doublons** : suppression automatique des doublons exacts de même couleur seulement.
- **Détails trop fins** : lignes de coupe parallèles à moins de 2 × kerf (entre deux formes ou dans une même forme), et pièces plus petites que 2 × kerf. Signalé, sans correction automatique.
- **Export DXF** : R12 (le plus compatible), polylignes en mm, un calque par couleur nommé d'après l'opération (COUPE_FF0000…). Les courbes sont découpées tous les 0,1 mm. Textes et images ne sont pas exportés.
- **Hors périmètre** : contrôles pour l'impression 3D (STL), qui relèvent d'un autre produit.

## Avant la mise en ligne

- [ ] Renseigner `checkoutUrl` et le prix dans `js/licence.js`.
- [ ] Compléter `legal.html` (passages surlignés) et le faire relire.
- [ ] Vérifier les zones de travail des profils machine (`PROFILES` dans `js/app.js`).
- [ ] Remplacer le CDN Tailwind par un build Tailwind CLI.
- [ ] Vérifier dans l'onglet Réseau qu'aucun fichier ne part (seule la clé de licence est envoyée, à l'activation).
- [ ] Tester sur de vrais fichiers Inkscape, Illustrator, Affinity, et des DXF de LibreCAD, Fusion 360, AutoCAD.
- [ ] Tester Safari et Firefox.
