// Mise en forme commune aux sorties LaTeX et HTML : listes a puces et
// hierarchie chapitres / sous-parties.

const PUCE = /^[•▪●◦○■□►▶✓✔\-–—*]\s+/;
const NUMERO = /^\d{1,2}[.)]\s+/;

/**
 * Regroupe les paragraphes qui commencent par une puce (ou un numero) en
 * listes, pour que le lecteur d'ecran annonce "liste de N elements" et que
 * chaque element soit sur sa propre ligne.
 * @param {string[]} paragraphs
 * @returns {Array<{type:'p', texte:string} | {type:'ul'|'ol', items:string[]}>}
 */
function grouperListes(paragraphs) {
  const blocs = [];
  for (const p of paragraphs || []) {
    if (!p || !p.trim()) continue;
    const type = PUCE.test(p) ? "ul" : NUMERO.test(p) ? "ol" : "p";
    if (type === "p") {
      blocs.push({ type, texte: p });
      continue;
    }
    const texte = p.replace(type === "ul" ? PUCE : NUMERO, "");
    const prec = blocs[blocs.length - 1];
    if (prec && prec.type === type) prec.items.push(texte);
    else blocs.push({ type, items: [texte] });
  }
  return blocs;
}

/**
 * Niveau de titre de chaque section : une section reduite a son titre (page
 * de titre d'une lecon, diapositive intercalaire) ouvre un chapitre (niveau
 * 1) ; les sections suivantes deviennent ses sous-parties (niveau 2).
 * Sans aucun chapitre detecte, tout reste au niveau 1.
 * @returns {number[]}
 */
function niveauxTitres(sections) {
  const estChapitre = (s, i) =>
    i > 0 && s.heading && !(s.paragraphs || []).some((p) => p && p.trim()) && !(s.images || []).length;
  let dansChapitre = false;
  return sections.map((s, i) => {
    if (estChapitre(s, i)) {
      dansChapitre = true;
      return 1;
    }
    return dansChapitre ? 2 : 1;
  });
}

module.exports = { grouperListes, niveauxTitres };
