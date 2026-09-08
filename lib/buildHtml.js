// Genere une page HTML accessible autonome : lisible directement dans un
// navigateur avec un lecteur d'ecran, sans aucun compilateur LaTeX. C'est le
// livrable garanti pour l'etudiante -- le .tex reste utile pour l'enseignant
// (recompilation, partage), mais l'HTML fonctionne dans tous les cas.

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphsHtml(paragraphs) {
  return paragraphs
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function imageHtml(img, sectionIdx, imgIdx) {
  const alt = `Schéma ${sectionIdx + 1}.${imgIdx + 1}`;
  const description = img.description || "(description à compléter)";
  // dataUri (base64) rend le fichier .html totalement autonome : aucune image
  // annexe a transmettre a cote. On retombe sur relPath si non fourni.
  const src = img.dataUri || img.relPath;
  return `
<figure>
  <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">
  <figcaption>
    <strong>Description du schéma.</strong> ${escapeHtml(description)}
  </figcaption>
</figure>`;
}

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: Arial, sans-serif; max-width: 54rem; margin: 2rem auto; padding: 0 1.25rem; line-height: 1.6; font-size: 1.15rem; color: #111; background: #fff; }
  h1 { font-size: 1.9rem; }
  h2 { font-size: 1.5rem; margin-top: 3rem; border-bottom: 2px solid #C71748; padding-bottom: 0.3rem; }
  nav[aria-label="Sommaire"] ol { line-height: 1.9; }
  figure { margin: 1.5rem 0; border: 1px solid #ccc; border-radius: 6px; padding: 1rem; background: #fafafa; }
  figure img { max-width: 100%; display: block; margin: 0 auto 1rem; }
  figcaption { font-size: 1.05rem; }
  a { color: #C71748; }
`;

/**
 * @param {string} title
 * @param {Array} sections Liste de { heading, paragraphs, images: [{relPath|dataUri, description}] }
 */
function buildHtml(title, sections) {
  const toc = sections
    .map((s, i) => `<li><a href="#section-${i + 1}">${escapeHtml(s.heading || `Section ${i + 1}`)}</a></li>`)
    .join("\n");

  const body = sections
    .map((section, idx) => {
      const heading = section.heading || `Section ${idx + 1}`;
      const images = section.images.map((img, i) => imageHtml(img, idx, i)).join("\n");
      return `
<section id="section-${idx + 1}" aria-labelledby="titre-${idx + 1}">
  <h2 id="titre-${idx + 1}">${escapeHtml(heading)}</h2>
  ${paragraphsHtml(section.paragraphs)}
  ${images}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<nav aria-label="Sommaire">
  <h2>Sommaire</h2>
  <ol>
${toc}
  </ol>
</nav>
${body}
</body>
</html>
`;
}

module.exports = { buildHtml };
