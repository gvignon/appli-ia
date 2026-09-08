const Anthropic = require("@anthropic-ai/sdk");
const mistralClient = require("./mistralClient");

function mimeTypeFor(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

const SYSTEM_PROMPT = `Tu rediges des descriptions d'images pour un support de cours, a destination
d'une etudiante malvoyante qui utilise un lecteur d'ecran. Elle ne voit pas l'image :
ta description est son seul acces au contenu du schema.

Consignes :
- Commence par identifier le type de visuel (schema, graphique, capture d'ecran, photo, diagramme, tableau...).
- Decris la structure et les elements essentiels : etapes, flux, relations, hierarchie, legendes.
- Si l'image contient du texte lisible (labels, chiffres, titres), transcris-le fidelement.
- Reste centree sur le contenu pedagogique : n'invente rien, ne decris pas des details esthetiques sans interet (couleurs, style) sauf s'ils portent du sens (ex: code couleur d'un schema).
- Sois concise mais complete : 60 a 150 mots suffisent en general, plus si le schema est dense.
- Ecris des phrases completes, en francais, sans formule du type "cette image montre" repetee inutilement.
- N'utilise pas de markdown, juste du texte simple en paragraphe(s).`;

/**
 * Appelle Claude (vision) pour decrire une image de maniere accessible.
 * @param {Anthropic} client
 * @param {{buffer:Buffer, filename:string}} image
 * @param {{title?:string, context?:string}} context texte environnant (slide/page) pour situer l'image
 * @param {string} model
 */
async function describeOneImage(client, image, context, model) {
  const contextLines = [];
  if (context.title) contextLines.push(`Titre de la diapositive/page : ${context.title}`);
  if (context.context) contextLines.push(`Texte environnant : ${context.context}`);

  const userText =
    (contextLines.length
      ? contextLines.join("\n") + "\n\n"
      : "") + "Decris ce schema pour une etudiante malvoyante, selon les consignes du systeme.";

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeTypeFor(image.filename),
              data: image.buffer.toString("base64"),
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "";
}

/**
 * Meme chose que describeOneImage, via l'API Mistral (chat/completions,
 * contenu multimodal : image_url en base64 + texte).
 * @param {{buffer:Buffer, filename:string}} image
 * @param {{title?:string, context?:string}} context
 */
async function describeOneImageMistral(apiKey, image, context, model) {
  const contextLines = [];
  if (context.title) contextLines.push(`Titre de la diapositive/page : ${context.title}`);
  if (context.context) contextLines.push(`Texte environnant : ${context.context}`);

  const userText =
    (contextLines.length
      ? contextLines.join("\n") + "\n\n"
      : "") + "Decris ce schema pour une etudiante malvoyante, selon les consignes du systeme.";

  return mistralClient.chatCompletion({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    maxTokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: `data:${mimeTypeFor(image.filename)};base64,${image.buffer.toString("base64")}`,
          },
        ],
      },
    ],
  });
}

/**
 * Decrit une liste d'images en parallele limite (pour ne pas saturer l'API).
 * @param {Array<{buffer:Buffer, filename:string, context:object}>} images
 * @param {{apiKey:string, model?:string, provider?:'anthropic'|'mistral', concurrency?:number}} options
 * @returns {Promise<string[]>} description par image (meme ordre que le tableau d'entree)
 */
async function describeImages(images, { apiKey, model, provider = "anthropic", concurrency = 3 } = {}) {
  const results = new Array(images.length).fill("");
  if (!apiKey) {
    return results; // pas de cle -> descriptions laissees vides pour saisie manuelle
  }

  const anthropicClient = provider === "anthropic" ? new Anthropic({ apiKey }) : null;
  const resolvedModel = model || (provider === "mistral" ? "mistral-medium-latest" : "claude-sonnet-5");
  let cursor = 0;

  async function worker() {
    while (cursor < images.length) {
      const i = cursor++;
      const img = images[i];
      try {
        results[i] =
          provider === "mistral"
            ? await describeOneImageMistral(apiKey, img, img.context || {}, resolvedModel)
            : await describeOneImage(anthropicClient, img, img.context || {}, resolvedModel);
      } catch (err) {
        results[i] = `[Description automatique indisponible : ${err.message}]`;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, images.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { describeImages };
