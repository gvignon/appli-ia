const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["a:p", "a:r", "p:sp", "p:pic", "p:grpSp"].includes(name),
});

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOfParagraph(p) {
  const runs = asArray(p["a:r"]);
  return runs
    .map((r) => (r && r["a:t"] !== undefined ? String(r["a:t"]) : ""))
    .join("")
    .trim();
}

// Parcourt l'arbre des formes d'une slide dans l'ordre du XML (proche de
// l'ordre de lecture voulu par l'auteur) et retourne une liste ordonnee de
// blocs { type: 'text'|'image', ... }
function walkShapes(node, relIdToImage, blocks) {
  if (!node || typeof node !== "object") return;

  for (const spNode of asArray(node["p:sp"])) {
    const txBody = spNode["p:txBody"];
    if (txBody) {
      const paragraphs = asArray(txBody["a:p"]);
      const text = paragraphs
        .map(textOfParagraph)
        .filter((t) => t.length > 0)
        .join("\n");
      if (text) {
        const isTitle = JSON.stringify(spNode["p:nvSpPr"] || "").includes("title");
        blocks.push({ type: "text", text, isTitle });
      }
    }
  }

  for (const picNode of asArray(node["p:pic"])) {
    const blipFill = picNode["p:blipFill"];
    const blip = blipFill && blipFill["a:blip"];
    const rId = blip && blip["@_r:embed"];
    if (rId && relIdToImage[rId]) {
      blocks.push({ type: "image", ...relIdToImage[rId] });
    }
  }

  for (const grp of asArray(node["p:grpSp"])) {
    walkShapes(grp, relIdToImage, blocks);
  }
}

/**
 * Extrait le contenu d'un fichier .pptx : pour chaque slide, le texte
 * (titre + corps) et les images, dans l'ordre d'apparition.
 * @param {Buffer} fileBuffer
 * @returns {{ slides: Array<{index:number, title:string|null, textBlocks:string[], images:Array}> }}
 */
function extractPptx(fileBuffer) {
  const zip = new AdmZip(fileBuffer);
  const entries = zip.getEntries();

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  const slides = slideEntries.map((entry, idx) => {
    const slideNum = entry.entryName.match(/slide(\d+)\.xml/)[1];
    const xml = entry.getData().toString("utf-8");
    const doc = parser.parse(xml);

    // Relations de la slide (rId -> fichier media)
    const relsEntry = entries.find(
      (e) => e.entryName === `ppt/slides/_rels/slide${slideNum}.xml.rels`
    );
    const relIdToImage = {};
    if (relsEntry) {
      const relsXml = relsEntry.getData().toString("utf-8");
      const relsDoc = parser.parse(relsXml);
      const rels = asArray(relsDoc.Relationships && relsDoc.Relationships.Relationship);
      for (const rel of rels) {
        const target = rel["@_Target"];
        const id = rel["@_Id"];
        if (target && /\.\.\/media\//.test(target)) {
          const mediaName = target.replace("../media/", "");
          const mediaEntry = entries.find((e) => e.entryName === `ppt/media/${mediaName}`);
          if (mediaEntry) {
            relIdToImage[id] = {
              filename: mediaName,
              buffer: mediaEntry.getData(),
            };
          }
        }
      }
    }

    const sldNode = doc["p:sld"];
    const spTree = sldNode && sldNode["p:cSld"] && sldNode["p:cSld"]["p:spTree"];
    const blocks = [];
    walkShapes(spTree, relIdToImage, blocks);

    const title = (blocks.find((b) => b.type === "text" && b.isTitle) || {}).text || null;
    const textBlocks = blocks
      .filter((b) => b.type === "text" && b.text !== title)
      .map((b) => b.text);
    const images = blocks
      .filter((b) => b.type === "image")
      .map((b, i) => ({ id: `s${idx + 1}-img${i + 1}`, filename: b.filename, buffer: b.buffer }));

    return { index: idx + 1, title, textBlocks, images };
  });

  return { slides };
}

module.exports = { extractPptx };
