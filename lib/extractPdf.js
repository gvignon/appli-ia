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
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  return {
    id: `p${pageNum}-schema`,
    filename: `page${pageNum}-schema-vectoriel.png`,
    buffer: canvas.toBuffer("image/png"),
  };
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

/**
 * Extrait le texte et les images de chaque page d'un PDF.
 * NB: un PDF n'a pas d'ordre de lecture garanti entre texte et images ;
 * le texte de la page est regroupe en un seul bloc, suivi des images
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
    const text = textContent.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

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

    pages.push({ index: pageNum, text, images });
  }

  return { pages };
}

module.exports = { extractPdf };
