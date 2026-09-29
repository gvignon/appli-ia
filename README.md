# Cours accessible — cours → LaTeX/HTML décrit

Application web locale qui transforme un support de cours (`.pptx`, `.docx` ou `.pdf`) en document LaTeX et HTML accessibles : chaque schéma/image est accompagné d'une description textuelle (générée par IA, puis relue et corrigée par l'enseignant), lisible au lecteur d'écran par l'étudiante malvoyante.

## Installation

```bash
cd accessibilite-app
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez **une** des clés API (pas besoin de toutes les remplir) :
- `ANTHROPIC_API_KEY` (clé obtenue sur [console.anthropic.com](https://console.anthropic.com)), ou
- `MISTRAL_API_KEY` (clé obtenue sur [console.mistral.ai](https://console.mistral.ai)), ou
- `GEMINI_API_KEY` (clé obtenue gratuitement sur [aistudio.google.com](https://aistudio.google.com) -- **niveau gratuit sans carte bancaire**, le plus simple pour demarrer ; attention a ne pas confondre avec un abonnement Gemini/Gemini Advanced personnel payant, qui est un produit different et non utilisable ici).

L'appli choisit automatiquement le fournisseur selon la clé presente (ordre de priorité : Anthropic, puis Mistral, puis Gemini) ; forcez `IA_PROVIDER=anthropic|mistral|gemini` dans `.env` pour choisir explicitement. Sans aucune clé, l'application fonctionne quand même : les champs de description restent à remplir à la main dans l'étape de relecture.

**Retour d'expérience par fournisseur (testé en conditions réelles) :**

*Mistral*
- Modèle vision à utiliser : `mistral-medium-latest` (le nom `pixtral-large-latest` qu'on pourrait attendre n'existe plus/pas dans l'API -- vérifié via `GET /v1/models`, qui expose un champ `capabilities.vision` par modèle).
- **Mode principal (relecture, un appel par image)** : fonctionne bien, 0 échec sur un test de 35 images, descriptions de bonne qualité en français.
- **Mode génération IA directe (`ia.html`, un seul appel pour tout le cours)** : deux limites reelles constatées --
  1. L'API Mistral plafonne à **8 images par requête** (contre une centaine chez Anthropic) ; un cours avec plus de schémas déclenche une erreur explicite (gérée proprement, cf. `lib/generateLatexAI.js`).
  2. Sur un test réduit (2 images, sous la limite), Mistral a produit un texte bien restructuré mais **n'a décrit aucun des deux schémas** -- alors que la même image, décrite isolément via le mode principal, donnait une bonne description. Le modèle semble sous-prioriser les images quand elles sont noyées dans beaucoup de texte en un seul message. Comportement non constaté avec Anthropic (non testé en conditions réelles faute de crédit au moment de l'écriture). À surveiller/relire systématiquement si vous utilisez ce mode avec Mistral.
- Les clés Mistral peuvent avoir une **date d'expiration** (30/90 jours selon le choix fait à la création) et un **plafond de dépense mensuel** configurable sur [admin.mistral.ai/subscription](https://admin.mistral.ai/subscription) -- une clé qui « arrêtait de marcher » a été tracée jusque-là deux fois pendant le développement. Vérifiez ces deux points si les descriptions cessent de fonctionner.

*Gemini*
- Modèle par défaut : `gemini-flash-lite-latest` (alias toujours à jour, comme `mistral-medium-latest`/`claude-sonnet-5`). **Ne pas utiliser `gemini-2.0-flash`** ni le modèle "Flash" standard (`gemini-flash-latest`/`gemini-3.8-flash`) : testés, tous deux obsolètes ou trop strictement limités en niveau gratuit (5 requêtes/minute seulement pour Flash, contre ~9-10/min pour Flash-Lite dans nos tests).
- Même avec Flash-Lite, le niveau gratuit reste limité en requêtes/minute : `lib/geminiClient.js` relit le délai suggéré par Google dans les erreurs 429/503 et reessaie automatiquement (jusqu'à 4 tentatives), et `describeImages.js` traite les images **une par une** pour Gemini (pas en parallèle) plutôt que d'empiler les erreurs de quota. Résultat testé : 35/35 descriptions réussies, mais ~2min pour un cours de 35 schémas (contre quelques secondes avec Anthropic/Mistral) -- normal pour un niveau gratuit, à anticiper sur un gros cours.

## Lancement

```bash
npm start
```

Puis ouvrez [http://localhost:3000](http://localhost:3000) dans un navigateur.

## Fonctionnement

1. **Dépôt du cours** — glissez un fichier `.pptx`, `.docx` ou `.pdf`.
2. **Analyse** — le serveur extrait le texte et les images de chaque diapositive/page, et (si une clé API est configurée) appelle Claude pour générer une description accessible de chaque schéma.
3. **Relecture** — chaque titre, texte et description est affiché dans un formulaire éditable. **Cette étape est essentielle** : une description générée automatiquement doit toujours être relue et corrigée par l'enseignant avant diffusion à l'étudiante.
4. **Génération** — deux documents sont produits à partir du même contenu relu :
   - `document.html` : page **totalement autonome** (images encodées en base64 directement dans le fichier) — un seul fichier à transmettre, sans dossier `images/` annexe à garder à côté. S'ouvre directement dans n'importe quel navigateur, aucune compilation nécessaire. C'est le fichier à remettre en priorité à l'étudiante pour une lecture au lecteur d'écran sur son propre ordinateur. Attention : les images encodées gonflent le poids du fichier (plusieurs Mo à quelques dizaines de Mo selon le nombre de schémas) — pratique pour une clé USB ou un lien de partage, mais à vérifier si l'envoi passe par une pièce jointe e-mail limitée en taille.
   - `document.tex` : texte structuré en `\section`, descriptions insérées comme texte normal après chaque image, alt-text PDF via `hyperref`/`tagpdf` — utile pour l'enseignant (recompilation, mise en forme avancée, partage académique).

   Une archive `.zip` (tex + html + images) est aussi proposée pour recompilation sur [Overleaf](https://overleaf.com) si aucun moteur LaTeX n'est installé localement.

## Second mode : génération IA directe (`ia.html`)

En plus du mode principal (relecture manuelle obligatoire, décrit ci-dessus), une seconde page — accessible via le lien en haut de `index.html`, ou directement sur `/ia.html` — propose une génération **en un seul appel IA holistique** : l'intégralité du texte et des schémas du cours est envoyée à l'IA dans un seul message, avec pour consigne de rédiger directement un document LaTeX complet, restructuré en chapitres/sections logiques (pas "une section par page"), avec les formules transcrites en vraies mathématiques LaTeX (`$...$`, `\begin{equation}`, matrices...) et une description en texte normal pour chaque schéma.

Ce mode reproduit ce qui a été fait manuellement pour valider l'approche sur un cours réel (voir `lib/generateLatexAI.js` pour le prompt, qui encode explicitement les erreurs rencontrées à cette occasion : syntaxe `_..._` invalide hors mode mathématique, blocs `\begin{verbatim}` qui empêchent les vraies formules de s'afficher).

**Différences avec le mode principal :**
- Un seul appel API, pas d'étape de relecture avant génération (donc **pas de garde-fou humain avant la première version** — à relire après coup, surtout les formules).
- **Nécessite obligatoirement une clé API** : contrairement au mode principal, il n'y a pas de repli "saisie manuelle" possible ici, puisque la génération EST l'appel IA.
- Aucune image n'est jointe au `.tex` produit (`\includegraphics` volontairement exclu par consigne) : uniquement du texte et des descriptions.
- **Limite de taille** : un seul appel signifie un seul budget de tokens (entrée et sortie), et pour Mistral un plafond dur de **8 images par requête** (voir plus haut). Fonctionne bien pour un support de taille modeste ; un cours avec beaucoup de schémas dépassera les limites -- non géré pour l'instant (pas de découpage en plusieurs appels).
- **Testé avec un vrai appel Mistral** (`mistral-medium-latest`) sur un cas réduit : la restructuration du texte fonctionne bien, mais **les descriptions de schémas ont été omises** dans ce test -- comportement à surveiller, voir le retour d'expérience Mistral plus haut. Non testé avec un vrai appel Anthropic (pas de crédit disponible au moment de l'écriture).

## Compilation du PDF

L'application tente de compiler automatiquement le `.tex` en PDF si `tectonic` ou `pdflatex` est disponible dans le `PATH` de la machine. Si aucun des deux n'est installé, le `.html` reste utilisable immédiatement ; le `.tex` (et l'archive `.zip`) permettent d'obtenir un PDF en le déposant sur Overleaf, ou en installant une distribution LaTeX (MiKTeX sur Windows, TeX Live).

## Schémas vectoriels dans un PDF

Beaucoup de cours exportés en PDF ne contiennent aucune image bitmap : leurs schémas sont dessinés directement en formes vectorielles (rectangles, flèches, dégradés — le style recommandé par la charte du projet, plutôt que des captures d'écran). Une extraction classique d'« images intégrées » ne trouve alors rien.

`extractPdf.js` détecte ce cas : pour chaque page sans image bitmap, il compte les opérations de tracé/remplissage vectoriel (`fill`, `stroke`, `shadingFill`) et, au-delà d'un seuil (`SEUIL_SCORE_VECTORIEL`, 8 par défaut), **rasterise la page entière** en image via `@napi-rs/canvas`, puis la traite comme un schéma à décrire. Testé sur un vrai support de cours de 110 pages : 73 pages détectées, incluant de vrais schémas denses (ex. diagramme radio Alice/Bob) manqués sans ce mécanisme.

C'est une heuristique volontairement généreuse : certaines pages sans vrai schéma (ex. une liste à puces avec icônes flèche) seront aussi rasterisées. Sans gravité — leur texte est de toute façon déjà extrait normalement, et la description IA/manuelle correspondante peut simplement être vidée en relecture. Ajustez `SEUIL_SCORE_VECTORIEL` dans `lib/extractPdf.js` si le taux de faux positifs gêne.

**Piège d'installation à connaître** : `pdfjs-dist` déclare `@napi-rs/canvas` en dépendance optionnelle avec une plage de version différente de celle installée à la racine. Si npm ne peut pas dédupliquer (deux versions incompatibles), deux copies du module natif coexistent et le rendu échoue avec `Value is none of these types Image, ImageData, CanvasElement...`. Le `package.json` de ce projet épingle `@napi-rs/canvas` dans la plage attendue par `pdfjs-dist` pour éviter ça — si l'erreur réapparaît après une mise à jour, vérifiez qu'il n'y a qu'un seul `node_modules/@napi-rs` (pas de copie imbriquée sous `node_modules/pdfjs-dist/node_modules/`).

## Autres limites connues

- **Ordre de lecture PDF** : un PDF ne garantit pas d'ordre entre texte et images sur une page ; le texte de la page est présenté en un seul bloc, suivi des schémas qu'elle contient.
- **Images décoratives** : logos, puces ou pages rasterisées à tort (voir ci-dessus) peuvent apparaître comme des "schémas" ; supprimez leur bloc ou videz leur description dans l'étape de relecture si besoin.
- **Volume** : un PDF long et graphique (ex. 110 pages) peut déclencher des dizaines d'appels IA vision — vérifiez le temps/coût attendu avant de lancer l'analyse sur un très gros document.
- Les sessions (fichiers extraits, images, `.tex`/`.html` générés) sont stockées dans `output/<id-session>/` et ne sont pas nettoyées automatiquement — à vider périodiquement.

## Structure

```
accessibilite-app/
  server.js            serveur Express (upload, extraction, IA, génération LaTeX)
  lib/
    extractPptx.js      extraction texte + images depuis .pptx
    extractDocx.js      extraction texte + images depuis .docx
    extractPdf.js        extraction texte + images depuis .pdf, avec rendu des pages a schemas vectoriels (pdfjs-dist + @napi-rs/canvas)
    describeImages.js    appels à l'API Claude (vision) pour décrire les schémas
    buildLatex.js          génération du document .tex (mode principal, avec relecture)
    buildHtml.js            génération de la page .html accessible autonome
    generateLatexAI.js       génération IA directe du .tex (mode ia.html, un seul appel holistique)
  public/               interface de dépôt / relecture / téléchargement
    index.html/app.js        mode principal (relecture des descriptions)
    ia.html/ia.js             mode génération IA directe
```
