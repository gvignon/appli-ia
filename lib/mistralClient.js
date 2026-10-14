// Petit client Mistral minimal (pas de SDK : l'API chat/completions est une
// simple requete REST JSON, et Node 24 a fetch en global).
// Sert aussi pour toute API compatible OpenAI (ex. ILaaS) via apiUrl.

const API_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * @param {{apiKey:string, model:string, system?:string, messages:Array, maxTokens?:number, apiUrl?:string}} params
 * @returns {Promise<string>} le texte de la reponse
 */
async function chatCompletion({ apiKey, model, system, messages, maxTokens = 1024, apiUrl = API_URL }) {
  const body = {
    model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    max_tokens: maxTokens,
  };

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("Reponse Mistral vide ou inattendue.");
  return (typeof content === "string" ? content : String(content)).trim();
}

// Adresse chat/completions d'ILaaS, deduite de ILAAS_API_URL (base ".../v1"
// ou adresse complete acceptees).
function ilaasUrl() {
  const base = (process.env.ILAAS_API_URL || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("ILAAS_API_URL manquante dans .env (adresse de l'API ILaaS).");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

module.exports = { chatCompletion, ilaasUrl };
