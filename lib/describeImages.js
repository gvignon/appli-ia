const Anthropic = require("@anthropic-ai/sdk");
const mistralClient = require("./mistralClient");
const geminiClient = require("./geminiClient");

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
ta description est son seul acces au contenu du schema -- mais elle l'ecoute lue a
voix haute, donc chaque phrase en trop a un cout reel d'attention et de temps.
Vise l'essentiel, pas l'exhaustivite.

Consignes :
- Va droit au but : la toute premiere phrase doit donner ce que le schema demontre
  ou explique (son idee/conclusion), pas son type ("schema montrant...") ni un
  inventaire de ce qu'il contient.
- Ne decris ensuite QUE ce qui est necessaire pour comprendre cette idee : les
  etapes/flux/relations qui portent du sens pedagogique. Omets les elements qui ne
  changent rien a la comprehension (logos, decor, mise en forme, position exacte a
  l'ecran) sauf si leur position/couleur encode elle-meme une information (ex. un
  code couleur, un sens de lecture chronologique).
- Ne fais pas d'inventaire spatial ("en haut a gauche... en bas a droite...") sauf
  si l'agencement spatial EST l'information (ex. un schema en etapes, une chronologie).
- Si l'image contient du texte lisible essentiel au sens (labels, chiffres cles),
  transcris-le ; ignore le texte redondant ou decoratif.
- Longueur cible : 2 a 4 phrases (environ 30 a 60 mots) pour un schema simple.
  Un schema technique dense (circuit, diagramme a nombreux blocs) peut justifier
  plus, mais reste toujours aussi concis que possible sans perdre l'essentiel --
  ce n'est pas une invitation a tout decrire.
- N'invente rien. Ecris des phrases completes, en francais, sans formule du type
  "cette image montre" ni "ce schema represente" en ouverture.
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
 * Meme chose que describeOneImage, via l'API Gemini (generateContent,
 * contenu multimodal : inline_data en base64 + texte).
 * @param {{buffer:Buffer, filename:string}} image
 * @param {{title?:string, context?:string}} context
 */
async function describeOneImageGemini(apiKey, image, context, model) {
  const contextLines = [];
  if (context.title) contextLines.push(`Titre de la diapositive/page : ${context.title}`);
  if (context.context) contextLines.push(`Texte environnant : ${context.context}`);

  const userText =
    (contextLines.length
      ? contextLines.join("\n") + "\n\n"
      : "") + "Decris ce schema pour une etudiante malvoyante, selon les consignes du systeme.";

  return geminiClient.generateContent({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    maxTokens: 600,
    contents: [
      {
        role: "user",
        parts: [
          { text: userText },
          { inline_data: { mime_type: mimeTypeFor(image.filename), data: image.buffer.toString("base64") } },
        ],
      },
    ],
  });
}

const MODELES_PAR_DEFAUT = {
  anthropic: "claude-sonnet-5",
  mistral: "mistral-medium-latest",
  gemini: "gemini-flash-lite-latest",
};

/**
 * Decrit une liste d'images en parallele limite (pour ne pas saturer l'API).
 * @param {Array<{buffer:Buffer, filename:string, context:object}>} images
 * @param {{apiKey:string, model?:string, provider?:'anthropic'|'mistral'|'gemini', concurrency?:number}} options
 * @returns {Promise<string[]>} description par image (meme ordre que le tableau d'entree)
 */
async function describeImages(images, { apiKey, model, provider = "anthropic", concurrency } = {}) {
  const results = new Array(images.length).fill("");
  if (!apiKey) {
    return results; // pas de cle -> descriptions laissees vides pour saisie manuelle
  }

  const anthropicClient = provider === "anthropic" ? new Anthropic({ apiKey }) : null;
  const resolvedModel = model || MODELES_PAR_DEFAUT[provider] || MODELES_PAR_DEFAUT.anthropic;
  // Le niveau gratuit de Gemini est limite en requetes/minute plutot qu'en
  // requetes simultanees : mieux vaut serialiser (1 a la fois, avec retry/
  // backoff automatique dans geminiClient.js) que de multiplier les 429.
  const concurrenceEffective = concurrency || (provider === "gemini" ? 1 : 3);
  let cursor = 0;

  async function worker() {
    while (cursor < images.length) {
      const i = cursor++;
      const img = images[i];
      try {
        if (provider === "mistral") {
          results[i] = await describeOneImageMistral(apiKey, img, img.context || {}, resolvedModel);
        } else if (provider === "gemini") {
          results[i] = await describeOneImageGemini(apiKey, img, img.context || {}, resolvedModel);
        } else {
          results[i] = await describeOneImage(anthropicClient, img, img.context || {}, resolvedModel);
        }
      } catch (err) {
        results[i] = `[Description automatique indisponible : ${err.message}]`;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrenceEffective, images.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { describeImages };
