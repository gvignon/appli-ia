(() => {
  const etapeUpload = document.getElementById("etape-upload");
  const etapeChargement = document.getElementById("etape-chargement");
  const etapeResultat = document.getElementById("etape-resultat");
  const etapeErreur = document.getElementById("etape-erreur");

  const formUpload = document.getElementById("form-upload");
  const inputFichier = document.getElementById("fichier-cours");
  const erreurUpload = document.getElementById("erreur-upload");

  const messageCompilation = document.getElementById("message-compilation");
  const liensTelechargement = document.getElementById("liens-telechargement");
  const apercuTex = document.getElementById("apercu-tex");
  const messageErreur = document.getElementById("message-erreur");

  function afficherEtape(etape) {
    for (const e of [etapeUpload, etapeChargement, etapeResultat, etapeErreur]) {
      e.hidden = e !== etape;
    }
    etape.querySelector("h2")?.focus?.();
  }

  async function lancerGeneration() {
    const fichier = inputFichier.files[0];
    if (!fichier) return;

    erreurUpload.textContent = "";
    afficherEtape(etapeChargement);

    const fd = new FormData();
    fd.append("cours", fichier);

    try {
      const resp = await fetch("/api/generer-latex-ia", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.erreur || "Erreur inconnue.");

      messageCompilation.textContent = data.messageCompilation;
      apercuTex.value = data.texte;

      liensTelechargement.innerHTML = "";
      const liens = [
        { url: data.telechargementTex, label: "Télécharger le fichier LaTeX (.tex)" },
        data.telechargementPdf ? { url: data.telechargementPdf, label: "Télécharger le PDF compilé" } : null,
      ].filter(Boolean);
      for (const lien of liens) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = lien.url;
        a.textContent = lien.label;
        a.setAttribute("download", "");
        li.appendChild(a);
        liensTelechargement.appendChild(li);
      }

      afficherEtape(etapeResultat);
    } catch (err) {
      messageErreur.textContent = err.message;
      afficherEtape(etapeErreur);
    }
  }

  formUpload.addEventListener("submit", (ev) => {
    ev.preventDefault();
    lancerGeneration();
  });

  document.getElementById("btn-recommencer").addEventListener("click", () => {
    formUpload.reset();
    afficherEtape(etapeUpload);
  });
  document.getElementById("btn-recommencer-erreur").addEventListener("click", () => {
    formUpload.reset();
    afficherEtape(etapeUpload);
  });
})();
