// PowerPoint/Word (equations, symboles mathematiques) exportent souvent des
// variables comme des caracteres Unicode "stylises" -- ex. 𝑎 (italique
// mathematique, U+1D44E) plutot que la lettre normale "a" (U+0061). Ce bloc
// Unicode ("Mathematical Alphanumeric Symbols") est tres mal couvert par les
// polices courantes : resultat, un carre vide a l'affichage (HTML) ou un
// glyphe manquant (LaTeX/PDF).
//
// La norme Unicode prevoit justement une decomposition de compatibilite pour
// ces caracteres vers leur lettre de base (𝑎 -> a, 𝔹 -> B, 𝜆 -> λ...),
// exposee nativement par String.prototype.normalize("NFKD").
//
// Attention : NFKD decompose aussi les lettres accentuees (o + accent
// combinant au lieu de o), que pdflatex/inputenc ne sait pas afficher.
// La recomposition NFC qui suit rend les accents tout en gardant les
// lettres stylisees ramenees a leur forme de base.
function normalizeMathText(str) {
  if (!str) return str;
  return str.normalize("NFKD").normalize("NFC");
}

function normalizerTexteCours(course) {
  return {
    title: normalizeMathText(course.title),
    sections: course.sections.map((s) => ({
      ...s,
      heading: normalizeMathText(s.heading),
      paragraphs: (s.paragraphs || []).map(normalizeMathText),
    })),
  };
}

module.exports = { normalizeMathText, normalizerTexteCours };
