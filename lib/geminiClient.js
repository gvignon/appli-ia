// Petit client Gemini minimal (pas de SDK : l'API generateContent est une
// simple requete REST JSON, et Node 24 a fetch en global). Format different
// des API "chat completions" (Anthropic/Mistral) : la cle passe en parametre
// d'URL, les instructions systeme dans system_instruction, et les blocs de
// contenu (texte/image) dans contents[].parts[].

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Le niveau gratuit de l'API Gemini est limite en requetes par minute (pas
// seulement en volume) -- avec plusieurs schemas a decrire d'affilee, on
// finit par recevoir des 429 meme sans rien faire d'anormal. On relit le
// delai suggere par Google dans le message d'erreur ("Please retry in Xs")
// et on reessaie automatiquement plutot que d'abandonner.
function delaiSuggereMs(messageErreur) {
  const m = /retry in ([\d.]+)s/i.exec(messageErreur || "");
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : null;
}

/**
 * @param {{apiKey:string, model:string, system?:string, contents:Array, maxTokens?:number, maxTentatives?:number}} params
 *   contents : tableau d'objets Gemini "Content", ex.
 *   [{ role: "user", parts: [{ text }, { inline_data: { mime_type, data } }] }]
 * @returns {Promise<string>} le texte de la reponse
 */
async function generateContent({ apiKey, model, system, contents, maxTokens = 1024, maxTentatives = 4 }) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };

  let derniereErreur;
  for (let tentative = 1; tentative <= maxTentatives; tentative++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const data = await resp.json();
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = (parts || []).map((p) => p.text || "").join("").trim();
      if (!text) throw new Error("Reponse Gemini vide ou inattendue.");
      return text;
    }

    const text = await resp.text();
    derniereErreur = new Error(`${resp.status} ${text}`);

    // 429 (quota atteint) et 503 (surcharge temporaire) valent la peine
    // d'etre retentes ; les autres erreurs (cle invalide, modele inconnu...)
    // ne se resoudront pas en reessayant.
    if ((resp.status === 429 || resp.status === 503) && tentative < maxTentatives) {
      const delai = delaiSuggereMs(text) || tentative * 3000;
      await attendre(delai);
      continue;
    }
    throw derniereErreur;
  }
  throw derniereErreur;
}

module.exports = { generateContent };
