const Anthropic = require("@anthropic-ai/sdk");
const mistralClient = require("./mistralClient");
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
- Utilise \\section{}, \\subsection{} avec des titres qui refletent le
  contenu reel (jamais "Page 1" ou "Diapositive 3").
- Regroupe logiquement plusieurs pages/diapositives traitant du meme sujet
  dans une seule section si c'est plus clair.

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
function construireBlocs(course) {
  const blocs = [
    {
      type: "text",
      text: `Titre du cours : ${course.title}\n\nContenu source, dans l'ordre du document original (texte puis schemas au fil du contenu) :`,
    },
  ];

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
    text: "Fin du contenu source. Redige maintenant le corps du document LaTeX selon les consignes du systeme.",
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

async function genererAvecMistral(blocs, { apiKey, model }) {
  const content = blocs.map((b) =>
    b.type === "image"
      ? { type: "image_url", image_url: `data:${mimeTypeFor(b.filename)};base64,${b.buffer.toString("base64")}` }
      : { type: "text", text: b.text }
  );

  return mistralClient.chatCompletion({
    apiKey,
    model: model || "mistral-medium-latest",
    system: SYSTEM_PROMPT,
    maxTokens: 16000,
    messages: [{ role: "user", content }],
  });
}

/**
 * @param {{title:string, sections:Array<{heading:string, paragraphs:string[], images:Array<{filename:string, buffer:Buffer}>}>}} course
 * @param {{apiKey:string, model?:string, provider?:'anthropic'|'mistral'}} options
 * @returns {Promise<string>} corps du document (a partir de \section{...})
 */
async function generateLatexAI(course, { apiKey, model, provider = "anthropic" }) {
  if (!apiKey) {
    throw new Error("Cle API requise pour cette generation (voir .env).");
  }

  const blocs = construireBlocs(course);

  // L'API Mistral plafonne a 8 images par requete (contrairement a
  // Anthropic, beaucoup plus permissif) : ce mode envoyant tout le cours en
  // un seul appel, un cours avec plus de 8 schemas depasse systematiquement
  // cette limite avec Mistral.
  const nbImages = blocs.filter((b) => b.type === "image").length;
  if (provider === "mistral" && nbImages > 8) {
    throw new Error(
      `Ce cours contient ${nbImages} schemas : l'API Mistral limite ce mode de generation (un seul appel) a 8 images maximum. Utilisez le mode principal (relecture, un appel par image) ou passez sur Anthropic pour ce cours.`
    );
  }

  const texte =
    provider === "mistral"
      ? await genererAvecMistral(blocs, { apiKey, model })
      : await genererAvecAnthropic(blocs, { apiKey, model });

  if (!texte || !texte.trim()) {
    throw new Error("Reponse vide de l'IA -- reessayez ou reduisez la taille du cours.");
  }
  return texte.trim();
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
