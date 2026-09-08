require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");

const { extractPptx } = require("./lib/extractPptx");
const { extractDocx } = require("./lib/extractDocx");
const { extractPdf } = require("./lib/extractPdf");
const { describeImages } = require("./lib/describeImages");
const { buildLatex } = require("./lib/buildLatex");
const { buildHtml } = require("./lib/buildHtml");
const { generateLatexAI, wrapDocument } = require("./lib/generateLatexAI");

function mimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";

// Fournisseur IA a utiliser : force par IA_PROVIDER si defini, sinon
// determine automatiquement selon la cle presente (Anthropic prioritaire
// si les deux sont renseignees).
const IA_PROVIDER =
  (process.env.IA_PROVIDER || "").toLowerCase() ||
  (ANTHROPIC_API_KEY ? "anthropic" : MISTRAL_API_KEY ? "mistral" : "");

const API_KEY = IA_PROVIDER === "mistral" ? MISTRAL_API_KEY : ANTHROPIC_API_KEY;
const MODEL =
  IA_PROVIDER === "mistral"
    ? process.env.MISTRAL_MODEL || "mistral-medium-latest"
    : process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const OUTPUT_DIR = path.join(__dirname, "output");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/fichiers", express.static(OUTPUT_DIR));

// ---------------------------------------------------------------------
// Normalisation : chaque format source est ramene a une structure commune
// { title, sections: [{ heading, paragraphs, images: [{id, filename, buffer}] }] }
// ---------------------------------------------------------------------

function normalizePptx(data, sourceTitle) {
  const sections = data.slides.map((slide) => ({
    heading: slide.title || `Diapositive ${slide.index}`,
    paragraphs: slide.textBlocks,
    images: slide.images,
  }));
  return { title: sourceTitle, sections };
}

function normalizeDocx(data, sourceTitle) {
  const sections = [];
  let current = { heading: null, paragraphs: [], images: [] };

  function pushCurrent() {
    if (current.heading || current.paragraphs.length || current.images.length) {
      sections.push(current);
    }
  }

  for (const item of data.items) {
    if (item.type === "text" && item.heading) {
      pushCurrent();
      current = { heading: item.text, paragraphs: [], images: [] };
    } else if (item.type === "text") {
      current.paragraphs.push(item.text);
    } else if (item.type === "image") {
      current.images.push(item);
    }
  }
  pushCurrent();

  if (sections.length === 0) {
    sections.push({ heading: sourceTitle, paragraphs: [], images: [] });
  }
  // Si aucune section n'a de titre (pas de styles Heading), regrouper en une seule section nommee
  if (sections.every((s) => !s.heading)) {
    const merged = { heading: sourceTitle, paragraphs: [], images: [] };
    for (const s of sections) {
      merged.paragraphs.push(...s.paragraphs);
      merged.images.push(...s.images);
    }
    return { title: sourceTitle, sections: [merged] };
  }
  sections.forEach((s) => {
    if (!s.heading) s.heading = "Introduction";
  });

  return { title: sourceTitle, sections };
}

function normalizePdf(data, sourceTitle) {
  const sections = data.pages.map((page) => ({
    heading: `Page ${page.index}`,
    paragraphs: page.text ? [page.text] : [],
    images: page.images,
  }));
  return { title: sourceTitle, sections };
}

// Extraction + normalisation commune aux deux modes de generation
// (relecture manuelle et generation IA directe).
async function extraireEtNormaliser(buffer, ext, sourceTitle) {
  if (ext === ".pptx") return normalizePptx(extractPptx(buffer), sourceTitle);
  if (ext === ".docx") return normalizeDocx(extractDocx(buffer), sourceTitle);
  if (ext === ".pdf") return normalizePdf(await extractPdf(buffer), sourceTitle);
  return null;
}

// Tente de compiler document.tex en PDF si un moteur LaTeX est present sur
// la machine (tectonic puis pdflatex) ; sinon renvoie un message explicatif.
async function tenterCompilationPdf(sessionDir) {
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "tectonic",
        ["document.tex", "--outdir", sessionDir],
        { cwd: sessionDir, timeout: 60000 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    if (fs.existsSync(path.join(sessionDir, "document.pdf"))) {
      return { pdfGenere: true, messageCompilation: "PDF compile avec succes (tectonic)." };
    }
  } catch (e) {
    // tectonic absent ou echec -> essai pdflatex
    try {
      await new Promise((resolve, reject) => {
        execFile(
          "pdflatex",
          ["-interaction=nonstopmode", "document.tex"],
          { cwd: sessionDir, timeout: 60000 },
          (err) => (err ? reject(err) : resolve())
        );
      });
      if (fs.existsSync(path.join(sessionDir, "document.pdf"))) {
        return { pdfGenere: true, messageCompilation: "PDF compile avec succes (pdflatex)." };
      }
    } catch (e2) {
      // ni tectonic ni pdflatex disponibles : on livre le .tex seul
    }
  }
  return {
    pdfGenere: false,
    messageCompilation:
      "Aucun moteur LaTeX detecte sur cette machine. Compilez document.tex avec Overleaf, TeX Live ou MiKTeX pour obtenir le PDF.",
  };
}

// ---------------------------------------------------------------------
// POST /api/analyser : upload + extraction + description IA
// ---------------------------------------------------------------------

app.post("/api/analyser", upload.single("cours"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier recu." });

    const original = req.file.originalname;
    const ext = path.extname(original).toLowerCase();
    const sourceTitle = path.basename(original, ext);
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    const imagesDir = path.join(sessionDir, "images");
    fs.mkdirSync(imagesDir, { recursive: true });

    const normalized = await extraireEtNormaliser(req.file.buffer, ext, sourceTitle);
    if (!normalized) {
      return res.status(400).json({ erreur: `Format non supporte : ${ext}. Utilisez .pptx, .docx ou .pdf.` });
    }

    // Ecrit les images sur disque et prepare la liste pour la description IA
    const imagesToDescribe = [];
    normalized.sections.forEach((section, sIdx) => {
      section.images.forEach((img, iIdx) => {
        const safeName = `s${sIdx + 1}-i${iIdx + 1}${path.extname(img.filename) || ".png"}`;
        fs.writeFileSync(path.join(imagesDir, safeName), img.buffer);
        img.savedFilename = safeName;
        img.url = `/fichiers/${sessionId}/images/${safeName}`;
        imagesToDescribe.push({
          buffer: img.buffer,
          filename: img.filename,
          context: { title: section.heading, context: section.paragraphs.join(" ").slice(0, 500) },
          ref: img,
        });
      });
    });

    const descriptions = await describeImages(imagesToDescribe, {
      apiKey: API_KEY,
      model: MODEL,
      provider: IA_PROVIDER || "anthropic",
    });
    imagesToDescribe.forEach((entry, i) => {
      entry.ref.description = descriptions[i] || "";
    });

    // Sauvegarde la structure (sans les buffers) pour l'etape de generation
    const forClient = {
      sessionId,
      title: normalized.title,
      iaDisponible: Boolean(API_KEY),
      sections: normalized.sections.map((s) => ({
        heading: s.heading,
        paragraphs: s.paragraphs,
        images: s.images.map((img) => ({
          id: img.id,
          filename: img.savedFilename,
          url: img.url,
          description: img.description || "",
        })),
      })),
    };

    fs.writeFileSync(path.join(sessionDir, "structure.json"), JSON.stringify(forClient, null, 2));

    res.json(forClient);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/generer : reconstruit le .tex a partir du contenu relu/edite
// ---------------------------------------------------------------------

app.post("/api/generer", async (req, res) => {
  try {
    const { sessionId, title, sections } = req.body;
    if (!sessionId || !sections) return res.status(400).json({ erreur: "Requete incomplete." });

    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) return res.status(404).json({ erreur: "Session introuvable ou expiree." });

    const texSections = sections.map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs || [],
      images: (s.images || []).map((img) => ({
        filename: img.filename,
        relPath: `images/${img.filename}`,
        description: img.description || "",
      })),
    }));

    const tex = buildLatex(title || "Support de cours accessible", texSections);
    const texPath = path.join(sessionDir, "document.tex");
    fs.writeFileSync(texPath, tex, "utf-8");

    // Version HTML : images encodees en base64 (data URI) pour que le fichier
    // .html soit totalement autonome, transmissible seul (aucun dossier
    // images/ a garder a cote), lisible directement au lecteur d'ecran.
    const imagesDirPath = path.join(sessionDir, "images");
    const htmlSections = sections.map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs || [],
      images: (s.images || []).map((img) => {
        const filePath = path.join(imagesDirPath, img.filename);
        const dataUri = fs.existsSync(filePath)
          ? `data:${mimeType(img.filename)};base64,${fs.readFileSync(filePath).toString("base64")}`
          : "";
        return { dataUri, description: img.description || "" };
      }),
    }));

    const html = buildHtml(title || "Support de cours accessible", htmlSections);
    const htmlPath = path.join(sessionDir, "document.html");
    fs.writeFileSync(htmlPath, html, "utf-8");

    // Tentative de compilation locale si un moteur LaTeX est present (facultatif)
    const { pdfGenere, messageCompilation } = await tenterCompilationPdf(sessionDir);

    // Zip de livraison (tex + html + images, pret a etre recompile ailleurs
    // ou remis directement a l'etudiante)
    const zip = new AdmZip();
    zip.addLocalFile(texPath);
    zip.addLocalFile(htmlPath);
    const imagesDir = path.join(sessionDir, "images");
    if (fs.existsSync(imagesDir)) zip.addLocalFolder(imagesDir, "images");
    if (pdfGenere) zip.addLocalFile(path.join(sessionDir, "document.pdf"));
    zip.writeZip(path.join(sessionDir, "livraison.zip"));

    res.json({
      sessionId,
      pdfGenere,
      messageCompilation,
      telechargementTex: `/fichiers/${sessionId}/document.tex`,
      telechargementHtml: `/fichiers/${sessionId}/document.html`,
      telechargementPdf: pdfGenere ? `/fichiers/${sessionId}/document.pdf` : null,
      telechargementZip: `/fichiers/${sessionId}/livraison.zip`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/generer-latex-ia : upload -> un seul appel IA qui redige le
// document LaTeX complet (structure academique + formules + descriptions
// de schemas), sur le modele du fichier exemple valide manuellement.
// Necessite ANTHROPIC_API_KEY : pas de mode degrade ici, la generation
// EST l'appel IA.
// ---------------------------------------------------------------------

app.post("/api/generer-latex-ia", upload.single("cours"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier recu." });
    if (!API_KEY) {
      return res.status(400).json({
        erreur:
          "Aucune cle API configuree dans .env (ANTHROPIC_API_KEY ou MISTRAL_API_KEY) : cette generation necessite une cle API.",
      });
    }

    const original = req.file.originalname;
    const ext = path.extname(original).toLowerCase();
    const sourceTitle = path.basename(original, ext);

    const normalized = await extraireEtNormaliser(req.file.buffer, ext, sourceTitle);
    if (!normalized) {
      return res.status(400).json({ erreur: `Format non supporte : ${ext}. Utilisez .pptx, .docx ou .pdf.` });
    }

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const body = await generateLatexAI(normalized, {
      apiKey: API_KEY,
      model: MODEL,
      provider: IA_PROVIDER || "anthropic",
    });
    const tex = wrapDocument(normalized.title, body);
    const texPath = path.join(sessionDir, "document.tex");
    fs.writeFileSync(texPath, tex, "utf-8");

    const { pdfGenere, messageCompilation } = await tenterCompilationPdf(sessionDir);

    res.json({
      sessionId,
      pdfGenere,
      messageCompilation,
      texte: tex,
      telechargementTex: `/fichiers/${sessionId}/document.tex`,
      telechargementPdf: pdfGenere ? `/fichiers/${sessionId}/document.pdf` : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Application accessibilite cours -> http://localhost:${PORT}`);
  if (!API_KEY) {
    console.log(
      "Aucune cle API definie (ANTHROPIC_API_KEY ou MISTRAL_API_KEY) : les descriptions IA seront vides (saisie manuelle)."
    );
  } else {
    console.log(`Fournisseur IA actif : ${IA_PROVIDER} (modele ${MODEL}).`);
  }
});
