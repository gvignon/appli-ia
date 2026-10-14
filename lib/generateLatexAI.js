const Anthropic = require("@anthropic-ai/sdk");
const mistralClient = require("./mistralClient");
const geminiClient = require("./geminiClient");
const { escapeLatex } = require("./buildLatex");

function mimeTypeFor(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

// Ce prompt encode les lecons tirees d'un cas reel : un premier essai
// produisait `_,,_ E _._` (syntaxe invalide, `_` hors mode mathematique) et
// des blocs `\begin{verbatim}` qui empechaient les vraies formules de
// s'afficher -- d'ou les consignes explicites ci-dessous.
const SYSTEM_PROMPT = `Tu es un enseignant qui retranscrit un support de cours en document LaTeX
academique complet, destine a une etudiante malvoyante qui le lira via un
lecteur d'ecran ou un logiciel de conversion braille compatible LaTeX.

MISSION
On te fournit l'integralite du contenu d'un cours (texte et schemas/images,
dans l'ordre d'origine du support). Redige un cours restructure et coherent
-- pas une transcription mecanique "une section par diapositive/page" -- en
regroupant les idees par chapitres et sections logiques, comme le ferait un
enseignant redigeant un polycopie.

FORMAT DE REPONSE
Reponds UNIQUEMENT avec le corps du document, a partir du premier
\\section{...}. N'inclus PAS \\documentclass, \\usepackage, \\title,
\\begin{document} ni \\end{document} : ils sont ajoutes automatiquement
autour de ta reponse. N'ajoute aucun commentaire ni balise markdown (pas de
\`\`\`) avant, apres ou autour du LaTeX.

STRUCTURE
- Utilise \\section{}, \\subsection{}, \\subsubsection{} avec des titres qui
  refletent le contenu reel (jamais "Page 1" ou "Diapositive 3") : une
  lecon ou un grand theme = \\section, une diapositive = \\subsection.
- Regroupe logiquement plusieurs pages/diapositives traitant du meme sujet
  dans une seule section si c'est plus clair.
- Les petits intertitres a l'interieur d'une partie ("Definitions",
  "Consequences", "Exemple 1 :") s'ecrivent en \\textbf{...} sur leur propre
  ligne, suivis d'une ligne vide.
- Separe chaque paragraphe du suivant par une ligne vide.
- N'ajoute jamais \\clearpage ni \\newpage.

LISTES -- point critique pour la lisibilite
- Toute enumeration s'ecrit avec \\begin{itemize} \\item ... \\end{itemize}
  (ou \\begin{enumerate} si elle est numerotee). N'ecris JAMAIS une liste
  avec des tirets "- " tapes en debut de ligne : LaTeX les colle sur une
  seule ligne et le lecteur d'ecran n'annonce pas la liste.

ELEMENTS A SUPPRIMER
- Pieds et en-tetes de page repetes (nom de l'enseignant, ecole, code du
  cours, numero de page) : ne les recopie pas.
- Pages de garde repetees (titre du cours redonne en debut de chaque lecon) :
  garde seulement l'information utile une fois.

LIENS
- Ecris chaque adresse web avec \\url{...}.

FORMULES MATHEMATIQUES -- point critique
- Transcris toute formule en syntaxe LaTeX mathematique reelle : $...$ pour
  le mode en ligne, \\begin{equation}...\\end{equation} ou
  \\begin{align}...\\end{align} pour les formules isolees ou systemes
  d'equations. Utilise normalement \\frac{}{}, les indices _{...}, exposants
  ^{...}, \\begin{bmatrix}...\\end{bmatrix} pour les matrices.
- INTERDICTION ABSOLUE d'utiliser _ (souligne) ou ^ en dehors d'une zone
  mathematique ($...$, equation, align). Hors de ces zones, ecris les
  variables et valeurs en texte normal sans aucun symbole de mise en forme
  mathematique.
  Exemple CORRECT : "le vecteur $E$" ou "on note $V_{max}$".
  Exemple INTERDIT : "le vecteur _,,_ E _._" ou "note _,,_ V_{max} _._".
- Si une formule du contenu source n'est pas lisible avec certitude, ecris
  "[formule a verifier : ...]" plutot que d'inventer.

SCHEMAS ET IMAGES
- N'utilise JAMAIS \\includegraphics : les images ne sont pas jointes au
  document, seule la description textuelle compte pour l'etudiante.
- N'utilise JAMAIS \\begin{verbatim} pour une description de schema : ecris
  un paragraphe LaTeX normal (le mode mathematique $...$ doit pouvoir y
  fonctionner). Introduis-le par une formule du type "Description du
  schema." en gras (\\textbf{}), suivie d'une description precise et
  structuree : elements presents, leur position, les fleches/connexions, le
  texte lisible sur l'image, ce que le schema demontre. Sois aussi detaille
  que necessaire pour qu'une personne qui ne voit pas l'image comprenne tout
  ce que le schema apporte au cours.
- Ignore silencieusement toute image purement decorative (logo, puce,
  filet) : n'ecris pas de description pour elle.

CARACTERES SPECIAUX (en dehors des zones mathematiques)
- % devient \\%, & devient \\&, # devient \\#, _ reste reserve au mode
  mathematique (voir plus haut).

LANGUE ET RIGUEUR
- Redige entierement en francais, ton clair et pedagogique.
- Fidelite au contenu source : n'invente aucune information, ne complete pas
  les formules incertaines (voir plus haut).`;

// Construit la liste ordonnee des blocs (texte/image) a partir du cours,
// independamment du fournisseur -- convertie ensuite au format attendu par
// chaque API.
function construireBlocs(course, partie) {
  const intro = partie
    ? `Titre du cours : ${course.title}\n\nCe cours est long : il t'est envoye en ${partie.total} parties. Voici la partie ${partie.numero}/${partie.total}.` +
      (partie.numero > 1
        ? ` Les parties precedentes ont deja ete redigees${partie.dernierTitre ? ` (la derniere section s'intitulait "${partie.dernierTitre}")` : ""} : continue directement la redaction, sans introduction ni rappel du titre du cours.`
        : "") +
      `\n\nContenu source de cette partie, dans l'ordre du document original :`
    : `Titre du cours : ${course.title}\n\nContenu source, dans l'ordre du document original (texte puis schemas au fil du contenu) :`;
  const blocs = [{ type: "text", text: intro }];

  for (const section of course.sections) {
    if (section.heading) {
      blocs.push({ type: "text", text: `\n--- ${section.heading} ---` });
    }
    for (const p of section.paragraphs || []) {
      if (p && p.trim()) blocs.push({ type: "text", text: p });
    }
    for (const img of section.images || []) {
      blocs.push({ type: "image", filename: img.filename, buffer: img.buffer });
    }
  }

  blocs.push({
    type: "text",
    text: partie
      ? `Fin de la partie ${partie.numero}/${partie.total}. Redige maintenant le corps LaTeX de cette partie seulement, selon les consignes du systeme.`
      : "Fin du contenu source. Redige maintenant le corps du document LaTeX selon les consignes du systeme.",
  });

  return blocs;
}

async function genererAvecAnthropic(blocs, { apiKey, model }) {
  const client = new Anthropic({ apiKey });
  const content = blocs.map((b) =>
    b.type === "image"
      ? {
          type: "image",
          source: { type: "base64", media_type: mimeTypeFor(b.filename), data: b.buffer.toString("base64") },
        }
      : { type: "text", text: b.text }
  );

  const response = await client.messages.create({
    model: model || "claude-sonnet-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "";
}

async function genererAvecMistral(blocs, { apiKey, model, ilaas = false }) {
  const content = blocs.map((b) => {
    if (b.type !== "image") return { type: "text", text: b.text };
    const dataUrl = `data:${mimeTypeFor(b.filename)};base64,${b.buffer.toString("base64")}`;
    // ILaaS suit le format OpenAI : image_url est un objet { url }.
    return { type: "image_url", image_url: ilaas ? { url: dataUrl } : dataUrl };
  });

  return mistralClient.chatCompletion({
    apiKey,
    ...(ilaas ? { apiUrl: mistralClient.ilaasUrl() } : {}),
    model: model || "mistral-medium-latest",
    system: SYSTEM_PROMPT,
    maxTokens: 16000,
    messages: [{ role: "user", content }],
  });
}

async function genererAvecGemini(blocs, { apiKey, model }) {
  const parts = blocs.map((b) =>
    b.type === "image"
      ? { inline_data: { mime_type: mimeTypeFor(b.filename), data: b.buffer.toString("base64") } }
      : { text: b.text }
  );

  return geminiClient.generateContent({
    apiKey,
    model: model || "gemini-flash-lite-latest",
    system: SYSTEM_PROMPT,
    maxTokens: 16000,
    contents: [{ role: "user", parts }],
  });
}

/**
 * @param {{title:string, sections:Array<{heading:string, paragraphs:string[], images:Array<{filename:string, buffer:Buffer}>}>}} course
 * @param {{apiKey:string, model?:string, provider?:'anthropic'|'mistral'|'gemini'|'ilaas'}} options
 * @returns {Promise<string>} corps du document (a partir de \section{...})
 */
async function generateLatexAI(course, { apiKey, model, provider = "anthropic" }) {
  if (!apiKey) {
    throw new Error("Cle API requise pour cette generation (voir .env).");
  }

  // Un cours entier en un seul appel depasse la longueur de reponse du
  // modele (texte coupe) et, chez Mistral/ILaaS, la limite de 8 images par
  // requete : on l'envoie par paquets de pages, rediges l'un apres l'autre.
  const paquets = decouperEnPaquets(course.sections);
  const morceaux = [];
  let dernierTitre = null;
  for (let i = 0; i < paquets.length; i++) {
    const partie = paquets.length > 1 ? { numero: i + 1, total: paquets.length, dernierTitre } : null;
    const blocs = construireBlocs({ title: course.title, sections: paquets[i] }, partie);

    let texte;
    if (provider === "mistral" || provider === "ilaas") {
      texte = await genererAvecMistral(blocs, { apiKey, model, ilaas: provider === "ilaas" });
    } else if (provider === "gemini") {
      texte = await genererAvecGemini(blocs, { apiKey, model });
    } else {
      texte = await genererAvecAnthropic(blocs, { apiKey, model });
    }
    if (!texte || !texte.trim()) {
      throw new Error(`Reponse vide de l'IA (partie ${i + 1}/${paquets.length}) -- reessayez.`);
    }
    texte = nettoyerReponse(texte);
    morceaux.push(texte);
    const titres = [...texte.matchAll(/\\(?:sub)*section\*?\{([^}]*)\}/g)];
    if (titres.length) dernierTitre = titres[titres.length - 1][1];
  }
  return morceaux.join("\n\n").trim();
}

const PAGES_PAR_PAQUET = 10;
const IMAGES_PAR_PAQUET = 8;

function decouperEnPaquets(sections) {
  const paquets = [];
  let cur = [];
  let nbImages = 0;
  for (const s of sections) {
    const n = (s.images || []).length;
    if (cur.length && (cur.length >= PAGES_PAR_PAQUET || nbImages + n > IMAGES_PAR_PAQUET)) {
      paquets.push(cur);
      cur = [];
      nbImages = 0;
    }
    cur.push(s);
    nbImages += n;
  }
  if (cur.length) paquets.push(cur);
  return paquets;
}

// Retire un eventuel habillage markdown (```latex ... ```) ou un preambule
// que le modele aurait ajoute malgre les consignes.
function nettoyerReponse(texte) {
  let t = texte.trim().replace(/^```(?:latex|tex)?\s*/i, "").replace(/```\s*$/, "");
  const debut = t.indexOf("\\begin{document}");
  if (debut !== -1) t = t.slice(debut + "\\begin{document}".length);
  t = t.replace(/\\end\{document\}[\s\S]*$/, "").replace(/\\maketitle|\\tableofcontents/g, "");
  return separerParagraphes(t.trim());
}

// En LaTeX, deux lignes consecutives sans ligne vide forment un seul
// paragraphe : "\textbf{Definition}" suivi de son texte, ou deux phrases
// ecrites sur deux lignes, s'affichent colles. Hors environnements (listes,
// formules, tableaux), on insere donc une ligne vide entre lignes de texte.
function separerParagraphes(texte) {
  const lignes = texte.split("\n");
  const out = [];
  let profondeur = 0;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    out.push(l);
    profondeur += (l.match(/\\begin\{/g) || []).length - (l.match(/\\end\{/g) || []).length;
    // \[ ... \] (formule centree) compte aussi comme environnement
    profondeur += (l.match(/\\\[/g) || []).length - (l.match(/\\\]/g) || []).length;
    const suivante = lignes[i + 1];
    if (
      profondeur <= 0 &&
      l.trim() &&
      suivante !== undefined &&
      suivante.trim() &&
      !/^\s*\\(begin|end|item)\b/.test(suivante) &&
      !/^\s*\\\[/.test(suivante) &&
      !/%\s*$/.test(l)
    ) {
      out.push("");
    }
  }
  return out.join("\n");
}

function wrapDocument(title, body) {
  return `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[french]{babel}
\\usepackage[a4paper,margin=2.5cm]{geometry}
\\usepackage{amsmath}
\\usepackage{amsfonts}
\\usepackage{amssymb}
\\usepackage{parskip}
\\usepackage[colorlinks=true,linkcolor=black,pdfusetitle]{hyperref}

\\title{${escapeLatex(title)}}
\\author{Version accessible -- cours restructure et schemas decrits pour lecteur d'ecran}
\\date{}

\\begin{document}
\\maketitle
\\tableofcontents
\\clearpage

${body}

\\end{document}
`;
}

module.exports = { generateLatexAI, wrapDocument };
