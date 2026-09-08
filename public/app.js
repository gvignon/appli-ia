(() => {
  const etapeUpload = document.getElementById("etape-upload");
  const etapeChargement = document.getElementById("etape-chargement");
  const etapeRelecture = document.getElementById("etape-relecture");
  const etapeTelechargement = document.getElementById("etape-telechargement");

  const formUpload = document.getElementById("form-upload");
  const inputFichier = document.getElementById("fichier-cours");
  const erreurUpload = document.getElementById("erreur-upload");
  const etatIa = document.getElementById("etat-ia");

  const titreDoc = document.getElementById("titre-doc");
  const listeSections = document.getElementById("liste-sections");
  const btnGenerer = document.getElementById("btn-generer");
  const erreurGeneration = document.getElementById("erreur-generation");

  const messageCompilation = document.getElementById("message-compilation");
  const liensTelechargement = document.getElementById("liens-telechargement");
  const btnRecommencer = document.getElementById("btn-recommencer");

  const tplSection = document.getElementById("tpl-section");
  const tplImage = document.getElementById("tpl-image");

  let sessionId = null;

  function afficherEtape(etape) {
    for (const e of [etapeUpload, etapeChargement, etapeRelecture, etapeTelechargement]) {
      e.hidden = e !== etape;
    }
    etape.querySelector("h2")?.focus?.();
  }

  function construireSection(section) {
    const node = tplSection.content.cloneNode(true);
    const fieldset = node.querySelector(".section-cours");
    const heading = node.querySelector(".section-heading");
    const paragraphes = node.querySelector(".section-paragraphes");
    const imagesWrap = node.querySelector(".section-images");

    heading.value = section.heading || "";
    paragraphes.value = (section.paragraphs || []).join("\n\n");

    section.images.forEach((img) => {
      const imgNode = tplImage.content.cloneNode(true);
      const imgEl = imgNode.querySelector(".image-apercu");
      const descEl = imgNode.querySelector(".image-description");
      imgEl.src = img.url;
      descEl.value = img.description || "";
      descEl.dataset.imageId = img.id;
      descEl.dataset.filename = img.filename;
      imagesWrap.appendChild(imgNode);
    });

    fieldset.dataset.imagesJson = JSON.stringify(section.images.map((i) => ({ id: i.id, filename: i.filename })));

    return fieldset;
  }

  formUpload.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    erreurUpload.textContent = "";
    const fichier = inputFichier.files[0];
    if (!fichier) return;

    afficherEtape(etapeChargement);

    const fd = new FormData();
    fd.append("cours", fichier);

    try {
      const resp = await fetch("/api/analyser", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.erreur || "Erreur inconnue lors de l'analyse.");

      sessionId = data.sessionId;
      titreDoc.value = data.title || "";
      etatIa.textContent = data.iaDisponible
        ? "Descriptions générées automatiquement par IA — relisez-les avant export."
        : "Aucune clé API configurée : les descriptions sont à saisir manuellement ci-dessous.";

      listeSections.innerHTML = "";
      data.sections.forEach((section) => {
        listeSections.appendChild(construireSection(section));
      });

      afficherEtape(etapeRelecture);
    } catch (err) {
      afficherEtape(etapeUpload);
      erreurUpload.textContent = `Échec de l'analyse : ${err.message}`;
    }
  });

  btnGenerer.addEventListener("click", async () => {
    erreurGeneration.textContent = "";
    if (!sessionId) return;

    const sections = [...listeSections.querySelectorAll(".section-cours")].map((fieldset) => {
      const heading = fieldset.querySelector(".section-heading").value;
      const paragraphs = fieldset
        .querySelector(".section-paragraphes")
        .value.split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      const imagesMeta = JSON.parse(fieldset.dataset.imagesJson || "[]");
      const descriptions = [...fieldset.querySelectorAll(".image-description")].map((el) => el.value.trim());
      const images = imagesMeta.map((meta, i) => ({ ...meta, description: descriptions[i] || "" }));
      return { heading, paragraphs, images };
    });

    btnGenerer.disabled = true;
    btnGenerer.textContent = "Génération en cours…";

    try {
      const resp = await fetch("/api/generer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, title: titreDoc.value, sections }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.erreur || "Erreur inconnue lors de la génération.");

      messageCompilation.textContent = data.messageCompilation;
      liensTelechargement.innerHTML = "";

      const liens = [
        { url: data.telechargementHtml, label: "Télécharger la version HTML accessible (à donner directement à l'étudiante)" },
        { url: data.telechargementTex, label: "Télécharger le fichier LaTeX (.tex)" },
        data.telechargementPdf ? { url: data.telechargementPdf, label: "Télécharger le PDF compilé" } : null,
        { url: data.telechargementZip, label: "Télécharger l'archive complète (.tex + .html + images)" },
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

      afficherEtape(etapeTelechargement);
    } catch (err) {
      erreurGeneration.textContent = `Échec de la génération : ${err.message}`;
    } finally {
      btnGenerer.disabled = false;
      btnGenerer.textContent = "Générer le document LaTeX";
    }
  });

  btnRecommencer.addEventListener("click", () => {
    sessionId = null;
    formUpload.reset();
    listeSections.innerHTML = "";
    afficherEtape(etapeUpload);
  });
})();
