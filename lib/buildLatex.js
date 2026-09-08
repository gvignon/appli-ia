// Genere un document LaTeX accessible : la description de chaque schema est
// inseree comme texte normal (pas seulement en alt-text), afin d'etre lue de
// maniere fiable par un lecteur d'ecran quel que soit le niveau de balisage
// du PDF final. L'image elle-meme reste incluse (utile pour un enseignant ou
// un binome qui relit le document), avec l'attribut alt= de hyperref.

function escapeLatex(str) {
  if (!str) return "";
  return String(str)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([%$&#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
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
