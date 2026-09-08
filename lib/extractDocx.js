const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Pas de forçage isArray : les elements repetes (w:p, w:r...) deviennent
  // deja des tableaux par defaut chez fast-xml-parser, et asArray()/findAll()
  // ci-dessous gerent aussi bien un objet unique qu'un tableau.
});

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function findAll(node, tag, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, tag, acc);
    return acc;
  }
  for (const key of Object.keys(node)) {
    if (key === tag) {
      for (const item of asArray(node[key])) acc.push(item);
    } else if (typeof node[key] === "object") {
      findAll(node[key], tag, acc);
    }
  }
  return acc;
}

function paragraphText(p) {
  const runs = findAll(p, "w:r");
  return runs
    .map((r) => {
      const texts = findAll(r, "w:t");
      return texts.map((t) => (typeof t === "string" ? t : t["#text"] || "")).join("");
    })
    .join("")
    .trim();
}

function paragraphStyle(p) {
  const pPr = p["w:pPr"];
  const pStyle = pPr && pPr["w:pStyle"];
  return (pStyle && pStyle["@_w:val"]) || "";
}

// Certains documents (dont celui-ci) ne s'appuient pas sur les styles
// "Titre X" de Word : les titres sont juste mis en forme avec une police plus
// grande. Sans style nomme, on repere donc les titres par la taille de
// police (en demi-points ; 24 = 12pt = corps de texte standard observe dans
// ce document, 28+ = 14pt+ = probable titre) sur un paragraphe court.
const TAILLE_MIN_TITRE = 28; // demi-points (14pt)
const LONGUEUR_MAX_TITRE = 120;

function looksLikeManualHeading(p, text) {
  if (!text || text.length > LONGUEUR_MAX_TITRE) return false;
  const runs = findAll(p, "w:r");
  let maxSize = 0;
  for (const r of runs) {
    const sz = r["w:rPr"] && r["w:rPr"]["w:sz"] && r["w:rPr"]["w:sz"]["@_w:val"];
    if (sz) maxSize = Math.max(maxSize, parseInt(sz, 10));
  }
  return maxSize >= TAILLE_MIN_TITRE;
}

/**
 * Extrait le contenu d'un .docx dans l'ordre du document : paragraphes de
 * texte et images inline, avec le titre de style (heading) reperable.
 * @param {Buffer} fileBuffer
 * @returns {{ paragraphs: Array<{type:'text'|'image', text?:string, heading?:boolean, ...}> }}
 */
function extractDocx(fileBuffer) {
  const zip = new AdmZip(fileBuffer);
  const entries = zip.getEntries();

  const docEntry = entries.find((e) => e.entryName === "word/document.xml");
  if (!docEntry) throw new Error("document.xml introuvable dans le .docx");

  const relsEntry = entries.find((e) => e.entryName === "word/_rels/document.xml.rels");
  const relIdToImage = {};
  if (relsEntry) {
    const relsDoc = parser.parse(relsEntry.getData().toString("utf-8"));
    const rels = asArray(relsDoc.Relationships && relsDoc.Relationships.Relationship);
    for (const rel of rels) {
      const target = rel["@_Target"];
      const id = rel["@_Id"];
      if (target && /^media\//.test(target)) {
        const mediaEntry = entries.find((e) => e.entryName === `word/${target}`);
        if (mediaEntry) {
          relIdToImage[id] = { filename: target.replace("media/", ""), buffer: mediaEntry.getData() };
        }
      }
    }
  }

  const xml = docEntry.getData().toString("utf-8");
  const doc = parser.parse(xml);
  const body = doc["w:document"] && doc["w:document"]["w:body"];

  const bodyParagraphs = asArray(body && body["w:p"]);

  const items = [];
  let imgCounter = 0;

  for (const p of bodyParagraphs) {
    const text = paragraphText(p);
    const style = paragraphStyle(p).toLowerCase();
    const isHeading =
      style.includes("heading") || style.includes("titre") || looksLikeManualHeading(p, text);

    if (text) {
      items.push({ type: "text", text, heading: isHeading });
    }

    // Images inline dans le paragraphe : reperees via a:blip r:embed
    const blips = findAll(p, "a:blip");
    for (const blip of blips) {
      const rId = blip["@_r:embed"];
      if (rId && relIdToImage[rId]) {
        imgCounter += 1;
        items.push({
          type: "image",
          id: `img${imgCounter}`,
          filename: relIdToImage[rId].filename,
          buffer: relIdToImage[rId].buffer,
        });
      }
    }
  }

  return { items };
}

module.exports = { extractDocx };
