const { PNG } = require("pngjs");
const { createCanvas } = require("@napi-rs/canvas");

// pdfjs-dist n'expose plus qu'un bundle ESM (.mjs) : on le charge en
// import() dynamique depuis ce module CommonJS, une seule fois.
let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsLibPromise;
}

// Factory explicite pour page.render() : garantit que les canvas
// intermediaires (motifs de remplissage, degrades) sont crees avec la meme
// instance de @napi-rs/canvas que le canvas principal. Sans elle, si deux
// copies du module coexistent dans node_modules (root + imbriquee dans
// pdfjs-dist), le rendu echoue avec "Value is none of these types Image,
// ImageData, CanvasElement..." -- cf. README pour le detail du probleme.
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// Nombre minimal d'operations de tracé/remplissage vectoriel pour qu'une
// page soit consideree comme contenant un schema (par opposition a du texte
// simple, parfois souligne/surligne avec quelques rectangles de couleur).
// Heuristique ajustable : mieux vaut un faux positif (rendu inutile, ecarte
// en relecture) qu'un schema jamais detecte.
const SEUIL_SCORE_VECTORIEL = 8;

function scoreVectoriel(opList, OPS) {
  let score = 0;
  for (const fn of opList.fnArray) {
    if (fn === OPS.fill || fn === OPS.stroke || fn === OPS.fillStroke || fn === OPS.shadingFill) {
      score += 1;
    }
  }
  return score;
}

async function rasteriserPage(page, pageNum) {
  const viewport = page.getViewport({ scale: 1.5 });
  const canvasFactory = new NodeCanvasFactory();
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  const canvasAndContext = { canvas, context };
  try {
    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
    return {
      id: `p${pageNum}-schema`,
      filename: `page${pageNum}-schema-vectoriel.png`,
      buffer: canvas.toBuffer("image/png"),
    };
  } finally {
    canvasFactory.destroy(canvasAndContext); // libere la memoire native du canvas
  }
}

function imageDataToPngBuffer(imgData) {
  const { width, height, data, kind } = imgData;
  if (!width || !height || !data) return null;

  const png = new PNG({ width, height });

  // ImageKind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (kind === 3 || data.length === width * height * 4) {
    data.copy ? data.copy(png.data) : png.data.set(data);
  } else if (kind === 2 || data.length === width * height * 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      png.data[j] = data[i];
      png.data[j + 1] = data[i + 1];
      png.data[j + 2] = data[i + 2];
      png.data[j + 3] = 255;
    }
  } else if (kind === 1 || data.length === Math.ceil(width / 8) * height) {
    // 1bpp grayscale, rarement rencontre pour des schemas -> best effort
    let bitIdx = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[bitIdx >> 3];
        const bit = (byte >> (7 - (bitIdx % 8))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        png.data[j] = v;
        png.data[j + 1] = v;
        png.data[j + 2] = v;
        png.data[j + 3] = 255;
        bitIdx++;
      }
    }
  } else {
    return null;
  }

  return PNG.sync.write(png);
}

// Taille de police d'un fragment de texte pdfjs (hauteur de la matrice).
function taillePolice(item) {
  const t = item.transform || [];
  return Math.round((Math.hypot(t[2] || 0, t[3] || 0) || item.height || 0) * 10) / 10;
}

// Regroupe les fragments de texte pdfjs en lignes : nouvelle ligne quand le
// fragment precedent porte hasEOL ou quand la position verticale change.
function construireLignes(items) {
  const lignes = [];
  let cur = null;
  let finDeLigne = true;
  for (const it of items) {
    if (!("str" in it)) continue;
    const y = it.transform ? it.transform[5] : 0;
    const taille = taillePolice(it);
    if (it.str !== "") {
      const memeLigne = cur && !finDeLigne && Math.abs(y - cur.y) <= Math.max(cur.taille, taille) * 0.5;
      if (!memeLigne) {
        cur = { texte: "", y, taille: 0, nbCars: 0, poidsTaille: 0 };
        lignes.push(cur);
      }
      cur.texte += it.str;
      cur.taille = Math.max(cur.taille, taille);
      cur.nbCars += it.str.trim().length;
      cur.poidsTaille += taille * it.str.trim().length;
    }
    finDeLigne = Boolean(it.hasEOL);
  }
  return lignes
    .map((l) => ({ ...l, texte: l.texte.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.texte);
}

const PUCE = /^[•▪●◦○■□►▶✓✔\-–—*]\s|^\d{1,2}[.)]\s/;

// Regroupe les lignes en paragraphes : coupure sur un ecart vertical
// nettement plus grand que l'interligne, un changement de taille de police
// ou un debut de puce.
function construireParagraphes(lignes) {
  const paras = [];
  let cur = null;
  let prec = null;
  for (const l of lignes) {
    const ecart = prec ? Math.abs(prec.y - l.y) : 0;
    const nouveau =
      !cur ||
      ecart > Math.max(prec.taille, l.taille) * 1.75 ||
      Math.abs(l.taille - prec.taille) > Math.max(l.taille, prec.taille) * 0.15 ||
      PUCE.test(l.texte);
    if (nouveau) {
      cur = { lignes: [], taille: l.taille };
      paras.push(cur);
    }
    cur.lignes.push(l.texte);
    cur.taille = Math.max(cur.taille, l.taille);
    prec = l;
  }
  return paras.map((p) => ({
    taille: p.taille,
    // Un mot coupe en fin de ligne ("inter-" + "ministeriel") est recolle.
    texte: p.lignes.reduce((acc, t) => (acc.endsWith("-") ? acc + t : acc ? `${acc} ${t}` : t), ""),
  }));
}

// Taille de police du corps de texte : la plus frequente, ponderee par le
// nombre de caracteres, sur tout le document.
function tailleCorps(toutesLignes) {
  const poids = new Map();
  for (const l of toutesLignes) poids.set(l.taille, (poids.get(l.taille) || 0) + l.nbCars);
  let meilleure = 0;
  let max = -1;
  for (const [t, p] of poids) if (p > max) [meilleure, max] = [t, p];
  return meilleure;
}

// Cle de comparaison d'une ligne : les nombres sont neutralises pour que
// "3/61 ... " et "4/61 ..." (pied de page numerote) soient reconnus identiques.
const cleLigne = (texte) => texte.replace(/\d+/g, "#");

// Lignes repetees sur une bonne part des pages (en-tetes / pieds de page
// courants) : elles parasitent la lecture et ne doivent pas servir de titre.
function lignesRepetees(lignesParPage) {
  const compte = new Map();
  for (const lignes of lignesParPage) {
    for (const t of new Set(lignes.map((l) => cleLigne(l.texte)))) compte.set(t, (compte.get(t) || 0) + 1);
  }
  const seuil = Math.max(3, lignesParPage.length * 0.4);
  return new Set([...compte].filter(([, n]) => n >= seuil).map(([t]) => t));
}

/**
 * Transforme les lignes d'une page en { heading, paragraphs } : le titre est
 * le premier paragraphe en police nettement plus grande que le corps, a
 * defaut un premier paragraphe court sans point final. Les numeros de page
 * seuls et les en-tetes/pieds de page repetes sont retires.
 */
function structurerPage(lignes, corps, repetees) {
  const utiles = lignes.filter((l) => !repetees.has(cleLigne(l.texte)) && !/^\d{1,4}$/.test(l.texte));
  const paras = construireParagraphes(utiles);
  // Un titre contient au moins un vrai mot (ecarte les etiquettes de schema).
  const ressembleTitre = (t) => t.length <= 150 && /\p{L}{3,}/u.test(t);
  let idxTitre = paras.findIndex((p) => corps && p.taille >= corps * 1.2 && ressembleTitre(p.texte));
  if (idxTitre === -1 && paras.length > 0 && paras[0].texte.length <= 90 && !/[.:;,]$/.test(paras[0].texte)) {
    idxTitre = 0;
  }
  const heading = idxTitre >= 0 ? paras[idxTitre].texte : null;
  const paragraphs = paras.filter((_, i) => i !== idxTitre).map((p) => p.texte);
  return { heading, paragraphs };
}

/**
 * Extrait le texte et les images de chaque page d'un PDF.
 * NB: un PDF n'a pas d'ordre de lecture garanti entre texte et images ;
 * le texte de la page est decoupe en titre + paragraphes, suivis des images
 * trouvees sur cette page.
 * @param {Buffer} fileBuffer
 */
async function extractPdf(fileBuffer) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);

    const textContent = await page.getTextContent();
    const lignes = construireLignes(textContent.items);

    const opList = await page.getOperatorList();
    const images = [];
    let imgCounter = 0;

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      if (
        fn === pdfjsLib.OPS.paintImageXObject ||
        fn === pdfjsLib.OPS.paintImageXObjectRepeat
      ) {
        const objId = opList.argsArray[i][0];
        try {
          let imgData = page.objs.has(objId) ? page.objs.get(objId) : null;
          if (!imgData && page.commonObjs.has(objId)) {
            imgData = page.commonObjs.get(objId);
          }
          if (!imgData) continue;
          if (imgData.width < 40 || imgData.height < 40) continue; // ignore puces/icones minuscules

          const buffer = imageDataToPngBuffer(imgData);
          if (buffer) {
            imgCounter += 1;
            images.push({
              id: `p${pageNum}-img${imgCounter}`,
              filename: `page${pageNum}-img${imgCounter}.png`,
              buffer,
            });
          }
        } catch (e) {
          // image non decodable (format inhabituel) : on l'ignore proprement
        }
      }
    }

    // Aucune image bitmap sur cette page mais un contenu vectoriel dense :
    // probablement un schema dessine avec des formes (rectangles, fleches,
    // degrades) plutot qu'avec une image integree. On rasterise la page
    // entiere pour permettre une description par IA vision.
    if (images.length === 0) {
      const score = scoreVectoriel(opList, pdfjsLib.OPS);
      if (score >= SEUIL_SCORE_VECTORIEL) {
        try {
          images.push(await rasteriserPage(page, pageNum));
        } catch (e) {
          // rendu impossible (police ou motif non supporte) : on ignore
        }
      }
    }

    pages.push({ index: pageNum, lignes, images });
    // Libere les images decodees et les ressources de la page : sans cela,
    // pdfjs les conserve en memoire jusqu'a la fin du document.
    page.cleanup();
  }

  await loadingTask.destroy();

  // La structure (titres, en-tetes repetes) se decide sur tout le document.
  const corps = tailleCorps(pages.flatMap((p) => p.lignes));
  const repetees = lignesRepetees(pages.map((p) => p.lignes));
  for (const p of pages) {
    const { heading, paragraphs } = structurerPage(p.lignes, corps, repetees);
    p.heading = heading;
    p.paragraphs = paragraphs;
    p.text = paragraphs.join("\n\n");
    delete p.lignes;
  }
  return { pages };
}

module.exports = { extractPdf };
