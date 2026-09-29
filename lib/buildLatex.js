// Genere un document LaTeX accessible : la description de chaque schema est
// inseree comme texte normal (pas seulement en alt-text), afin d'etre lue de
// maniere fiable par un lecteur d'ecran quel que soit le niveau de balisage
// du PDF final. L'image elle-meme reste incluse (utile pour un enseignant ou
// un binome qui relit le document), avec l'attribut alt= de hyperref.

// Les polices de texte standard de pdflatex (Latin Modern, encodage T1) ne
// couvrent pas l'alphabet grec en mode texte normal : un caractere grec brut
// s'affiche comme un glyphe manquant. On le reecrit donc en commande LaTeX
// mathematique ($\alpha$...), qui fonctionne sans package ni moteur
// supplementaire. Les majuscules visuellement identiques a des lettres
// latines (Α, Β, Ε...) sont simplement remplacees par leur equivalent latin.
const GREC_VERS_LATEX = {
  α: "$\\alpha$", β: "$\\beta$", γ: "$\\gamma$", δ: "$\\delta$", ε: "$\\varepsilon$",
  ζ: "$\\zeta$", η: "$\\eta$", θ: "$\\theta$", ι: "$\\iota$", κ: "$\\kappa$",
  λ: "$\\lambda$", μ: "$\\mu$", ν: "$\\nu$", ξ: "$\\xi$", ο: "o",
  π: "$\\pi$", ρ: "$\\rho$", σ: "$\\sigma$", ς: "$\\sigma$", τ: "$\\tau$",
  υ: "$\\upsilon$", φ: "$\\varphi$", χ: "$\\chi$", ψ: "$\\psi$", ω: "$\\omega$",
  Α: "A", Β: "B", Γ: "$\\Gamma$", Δ: "$\\Delta$", Ε: "E",
  Ζ: "Z", Η: "H", Θ: "$\\Theta$", Ι: "I", Κ: "K",
  Λ: "$\\Lambda$", Μ: "M", Ν: "N", Ξ: "$\\Xi$", Ο: "O",
  Π: "$\\Pi$", Ρ: "P", Σ: "$\\Sigma$", Τ: "T", Υ: "$\\Upsilon$",
  Φ: "$\\Phi$", Χ: "X", Ψ: "$\\Psi$", Ω: "$\\Omega$",
};
const REGEX_GREC = new RegExp(`[${Object.keys(GREC_VERS_LATEX).join("")}]`, "g");

// Echappement des caracteres reserves LaTeX en une seule passe. Important :
// un enchainement de plusieurs .replace() successifs (l'ancienne version)
// est incorrect ici, car le remplacement du backslash (\ -> \textbackslash{})
// insere lui-meme des accolades, qui se faisaient ensuite re-echapper par
// l'etape suivante (\textbackslash{} devenait \textbackslash\{\}, ajoutant
// des "{}" parasites visibles dans le document final). Un seul passage sur
// la chaine d'origine, caractere par caractere, evite ce probleme : le texte
// insere par le remplacement n'est jamais rescanne.
const LATEX_SPECIAUX = {
  "\\": "\\textbackslash{}",
  "%": "\\%",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};
const REGEX_SPECIAUX = /[\\%$&#_{}~^]/g;

function escapeLatex(str) {
  if (!str) return "";
  return String(str)
    .replace(REGEX_SPECIAUX, (c) => LATEX_SPECIAUX[c])
    .replace(REGEX_GREC, (c) => GREC_VERS_LATEX[c])
    // Un simple saut de ligne a l'interieur d'un paragraphe est ignore par
    // LaTeX (traite comme une espace) : il faut le forcer explicitement,
    // sinon les retours a la ligne du texte source (listes a puces, titres
    // multi-lignes...) disparaissent a la compilation. Equivalent du <br>
    // deja utilise dans buildHtml.js.
    .replace(/\r\n|\r|\n/g, " \\\\\n");
}

function escapeAlt(str) {
  // hyperref alt= n'accepte pas certains caracteres speciaux (accolades, %)
  return escapeLatex(str).replace(/[{}]/g, "");
}

const PREAMBLE = (title) => `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[french]{babel}
\\usepackage[a4paper,margin=2.5cm]{geometry}
\\usepackage{graphicx}
\\usepackage{parskip}
\\usepackage[colorlinks=true,linkcolor=black,pdfusetitle]{hyperref}
\\usepackage{tagpdf}
\\tagpdfsetup{activate-all}

\\title{${escapeLatex(title)}}
\\author{Version accessible -- descriptions des sch\\'emas incluses}
\\date{}

\\hypersetup{
  pdftitle={${escapeLatex(title)}},
  pdflang={fr-FR}
}

\\begin{document}
\\maketitle
\\tableofcontents
\\clearpage
`;

const CLOSING = `
\\end{document}
`;

function imageBlock({ filename, relPath, description, altShort }) {
  return `
\\begin{figure}[h!]
  \\centering
  \\includegraphics[width=0.75\\linewidth,alt={${escapeAlt(altShort)}}]{${relPath}}
\\end{figure}

\\paragraph{Description du sch\\'ema.}
${escapeLatex(description) || "\\textit{(description \\`a compl\\'eter)}"}

`;
}

/**
 * @param {string} title Titre du document
 * @param {Array} sections Liste de { heading: string|null, paragraphs: string[], images: [{filename, relPath, description}] }
 *   Chaque section correspond a une diapositive ou une page du document source.
 */
function buildLatex(title, sections) {
  let body = "";

  sections.forEach((section, idx) => {
    const heading = section.heading || `Section ${idx + 1}`;
    body += `\\section{${escapeLatex(heading)}}\n\n`;

    for (const para of section.paragraphs) {
      if (!para) continue;
      body += `${escapeLatex(para)}\n\n`;
    }

    section.images.forEach((img, i) => {
      const altShort = `Schéma ${idx + 1}.${i + 1}`;
      body += imageBlock({ ...img, altShort });
    });

    body += "\\clearpage\n\n";
  });

  return PREAMBLE(title) + body + CLOSING;
}

module.exports = { buildLatex, escapeLatex };
