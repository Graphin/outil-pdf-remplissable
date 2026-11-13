// Outil « PDF remplissable » : chargement, détection, ajustement, remplissage, enregistrement.
// Tout se passe dans le navigateur. Aucun fichier n'est envoyé.

/* global PDFLib */
import { chargerConfig, appliquerConfig } from "./config.js?v=5";
import { analyserPage, nettoyerLibelle } from "./detect.js?v=5";
import { construirePdf } from "./export.js?v=5";

const $ = (id) => document.getElementById(id);
const VENDOR = new URL("../../vendor/pdfjs/", import.meta.url).href;
const PAS_ZOOM = [0.33, 0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const TYPES_TEXTE = new Set(["text", "multiline", "comb", "dropdown"]);
const NOMS_DEFAUT = { text: "Texte", multiline: "Zone de texte", comb: "Peigne", checkbox: "Case", radio: "Choix", dropdown: "Liste" };
const ecranEtroit = () => window.matchMedia("(max-width: 819px)").matches;

const etat = {
  config: null,
  lib: null,
  doc: null,
  octets: null,
  nomFichier: "",
  pages: [],
  champs: [],
  existants: [],
  valeurs: {},
  selection: new Set(),
  mode: "ajuster",
  outil: "selection",
  zoom: 1,
  zoomAjuste: true,
  historique: [],
  futur: [],
  sensibilite: 3,
  idSuivant: 1,
  modifie: false,
  observateur: null,
  vueListe: false,
};

// ---------------------------------------------------------------------------
// Démarrage

async function demarrer() {
  // Écran tactile sans souris : pas de glisser-déposer, la phrase « faites-le glisser » est masquée.
  const tactile = window.matchMedia("(pointer: coarse)").matches || (("ontouchstart" in window || navigator.maxTouchPoints > 0) && !window.matchMedia("(hover: hover)").matches);
  document.documentElement.classList.toggle("tactile", tactile);
  const { config } = await chargerConfig();
  etat.config = config;
  appliquerConfig(config);
  brancherAccueil();
  brancherAtelier();
  window.addEventListener("beforeunload", (e) => {
    if (etat.doc && etat.modifie) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  if (!window.showSaveFilePicker) {
    $("note-enregistrement").textContent = "Votre navigateur enregistre le fichier dans son dossier de téléchargements.";
  } else {
    $("note-enregistrement").textContent = "Vous choisirez le dossier et le nom du fichier.";
  }
}

async function chargerPdfJs() {
  if (etat.lib) return etat.lib;
  const lib = await import("../../vendor/pdfjs/pdf.min.js");
  lib.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.js";
  etat.lib = lib;
  return lib;
}

// ---------------------------------------------------------------------------
// Accueil et dépôt

function brancherAccueil() {
  const entree = $("fichier");
  $("btn-choisir").addEventListener("click", () => entree.click());
  entree.addEventListener("change", () => {
    if (entree.files && entree.files[0]) ouvrirFichier(entree.files[0]);
    entree.value = "";
  });
  const depot = $("depot");
  let profondeur = 0;
  document.addEventListener("dragenter", (e) => {
    if (!aDesFichiers(e)) return;
    e.preventDefault();
    profondeur++;
    document.body.classList.add("glisser");
  });
  document.addEventListener("dragleave", (e) => {
    if (!aDesFichiers(e)) return;
    profondeur = Math.max(0, profondeur - 1);
    if (!profondeur) document.body.classList.remove("glisser");
  });
  document.addEventListener("dragover", (e) => {
    if (!aDesFichiers(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("drop", (e) => {
    if (!aDesFichiers(e)) return;
    e.preventDefault();
    profondeur = 0;
    document.body.classList.remove("glisser");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (etat.doc && !confirm("Ouvrir ce nouveau PDF ? Le PDF en cours et vos réglages seront fermés.")) return;
    ouvrirFichier(f);
  });
  depot.addEventListener("click", (e) => {
    if (e.target === depot || e.target.closest(".depot-illu")) entree.click();
  });
}

function aDesFichiers(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}

function erreurDepot(msg) {
  const el = $("erreur-depot");
  el.textContent = msg;
  el.hidden = !msg;
}

async function ouvrirFichier(fichier) {
  try {
    await ouvrirFichierInterne(fichier);
  } catch (e) {
    console.error(e);
    cacherProgression();
    montrerAccueil();
    erreurDepot("Ce PDF n'a pas pu être préparé. Il utilise peut-être une structure que l'outil ne sait pas lire.");
  }
}

async function ouvrirFichierInterne(fichier) {
  erreurDepot("");
  const estPdf = /\.pdf$/i.test(fichier.name) || fichier.type === "application/pdf";
  if (!estPdf) {
    erreurDepot("Ce fichier n'est pas un PDF. Choisissez un fichier qui se termine par .pdf.");
    montrerAccueil();
    return;
  }
  montrerProgression("Ouverture du PDF", 0);
  let lib;
  try {
    lib = await chargerPdfJs();
  } catch (e) {
    cacherProgression();
    erreurDepot("Les fichiers de l'outil sont incomplets sur ce serveur (dossier vendor). Déposez à nouveau tout le dossier de l'outil.");
    return;
  }
  const octets = new Uint8Array(await fichier.arrayBuffer());
  let doc;
  try {
    doc = await lib.getDocument({
      data: octets.slice(),
      cMapUrl: VENDOR + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: VENDOR + "standard_fonts/",
      wasmUrl: VENDOR + "wasm/",
      iccUrl: VENDOR + "iccs/",
      disableWorkerRendering: true,
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  } catch (e) {
    cacherProgression();
    montrerAccueil();
    if (e && e.name === "PasswordException") {
      erreurDepot("Ce PDF est protégé par un mot de passe. Ouvrez-le avec votre lecteur PDF, enregistrez-en une copie sans protection, puis déposez cette copie.");
    } else {
      erreurDepot("Ce PDF n'a pas pu être lu. Il est peut-être abîmé ou incomplet.");
    }
    return;
  }

  // Lecture par pdf-lib : protection et champs déjà présents.
  let docLib;
  try {
    docLib = await PDFLib.PDFDocument.load(octets, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    cacherProgression();
    montrerAccueil();
    erreurDepot("Ce PDF s'affiche, mais sa structure ne permet pas d'y ajouter des champs. Enregistrez-en une nouvelle copie avec votre lecteur PDF puis réessayez.");
    return;
  }
  if (docLib.isEncrypted) {
    cacherProgression();
    montrerAccueil();
    erreurDepot("Ce PDF est protégé contre la modification. L'outil ne peut pas y ajouter de champs. Demandez une version sans protection à son auteur, ou enregistrez-en une copie non protégée.");
    return;
  }

  if (etat.doc) {
    try { etat.doc.destroy(); } catch (e) { /* rien */ }
  }
  Object.assign(etat, {
    doc, octets, nomFichier: fichier.name, pages: [], champs: [], existants: [], valeurs: {},
    selection: new Set(), historique: [], futur: [], idSuivant: 1, modifie: false, outil: "selection",
  });
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    etat.pages.push({ index: i - 1, proxy: page, vue: page.getViewport({ scale: 1 }), rendu: 0, tache: null });
  }
  lireChampsExistants(docLib);

  montrerAtelier();
  etat.zoomAjuste = true;
  ajusterZoom(false);
  construirePages();
  etat.vueListe = ecranEtroit();
  changerMode(ecranEtroit() ? "remplir" : "ajuster", false);
  await lancerDetection(false);
}

function lireChampsExistants(docLib) {
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;
  let form;
  try {
    form = docLib.getForm();
  } catch (e) {
    return;
  }
  const pagesLib = docLib.getPages();
  for (const f of form.getFields()) {
    let nom;
    try { nom = f.getName(); } catch (e) { continue; }
    let type = null;
    const extra = {};
    try {
      if (f instanceof PDFTextField) {
        type = f.isCombed() && f.getMaxLength() ? "comb" : f.isMultiline() ? "multiline" : "text";
        if (type === "comb") extra.cells = f.getMaxLength();
        extra.maxLength = f.getMaxLength();
        const t = f.getText();
        if (t) extra.valeur = t;
      } else if (f instanceof PDFCheckBox) {
        type = "checkbox";
        if (f.isChecked()) extra.valeur = true;
      } else if (f instanceof PDFRadioGroup) {
        type = "radio";
        extra.options = f.getOptions();
        const s = f.getSelected();
        if (s) extra.valeurRadio = s;
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        type = "dropdown";
        extra.options = f.getOptions();
        const s = f.getSelected();
        if (s && s.length) extra.valeur = s[0];
      }
    } catch (e) {
      type = null;
    }
    let widgets = [];
    try { widgets = f.acroField.getWidgets(); } catch (e) { widgets = []; }
    widgets.forEach((w, i) => {
      let pageIndex = -1;
      try {
        const pRef = w.P();
        pageIndex = pagesLib.findIndex((p) => p.ref === pRef);
        if (pageIndex < 0) {
          const ref = docLib.context.getObjectRef(w.dict);
          const p = ref ? docLib.findPageForAnnotationRef(ref) : undefined;
          pageIndex = p ? pagesLib.indexOf(p) : -1;
        }
      } catch (e) { pageIndex = -1; }
      const pg = etat.pages[pageIndex];
      if (!pg) return;
      const r = w.getRectangle();
      const [x1, y1] = pg.vue.convertToViewportPoint(r.x, r.y);
      const [x2, y2] = pg.vue.convertToViewportPoint(r.x + r.width, r.y + r.height);
      const champ = {
        id: "e" + etat.idSuivant++,
        existing: true,
        page: pageIndex,
        x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
        type: type || "autre",
        name: nom,
        label: nom,
        fontSize: 0,
        readOnly: (() => { try { return f.isReadOnly(); } catch (e) { return false; } })(),
      };
      if (type === "comb") champ.cells = extra.cells;
      if (extra.maxLength) champ.maxLength = extra.maxLength;
      if (type === "dropdown") champ.options = extra.options;
      if (type === "radio") {
        let opt = extra.options && extra.options.length === widgets.length ? extra.options[i] : null;
        if (!opt) {
          try { opt = w.getOnValue() ? w.getOnValue().decodeText() : String(i); } catch (e) { opt = String(i); }
        }
        champ.group = nom;
        champ.option = opt;
        if (extra.valeurRadio) etat.valeurs["radio:" + nom] = extra.valeurRadio;
      } else if (extra.valeur !== undefined && i === 0) {
        etat.valeurs[champ.id] = extra.valeur;
      }
      if (type === "checkbox" && i > 0) champ.lie = true;
      etat.existants.push(champ);
    });
  }
}

// ---------------------------------------------------------------------------
// Détection

async function lancerDetection(relance) {
  const lib = etat.lib;
  const n = etat.pages.length;
  let gardes = [];
  if (relance) {
    pousserHistorique();
    gardes = etat.champs.filter((c) => c.source === "manuel");
    etat.champs = gardes;
    etat.selection.clear();
  }
  const groupesPris = new Map();
  let nouveaux = 0;
  for (const pg of etat.pages) {
    montrerProgression(`Analyse de la page ${pg.index + 1} sur ${n}`, pg.index / n);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const zones = [...etat.existants, ...gardes].filter((c) => c.page === pg.index).map(({ x, y, w, h }) => ({ x, y, w, h }));
    let res;
    try {
      res = await analyserPage(pg.proxy, lib, { sensibilite: etat.sensibilite, zonesExistantes: zones });
    } catch (e) {
      console.error(e);
      continue;
    }
    const groupesPage = new Map();
    // Ordre de lecture avant de numéroter les noms (« _2 », « _3 » dans le bon ordre).
    res.champs.sort((a, b) => ordreLecture({ ...a, page: 0 }, { ...b, page: 0 }));
    for (const d of res.champs) {
      const c = {
        id: "c" + etat.idSuivant++,
        page: pg.index,
        x: d.x, y: d.y, w: d.w, h: d.h,
        type: d.type,
        label: d.label,
        fontSize: d.fontSize,
        source: "auto",
      };
      if (d.type === "comb") c.cells = d.cells;
      if (d.question) c.question = d.question;
      if (d.rubrique) c.rubrique = d.rubrique;
      if (d.parties > 1) { c.partie = d.partie; c.parties = d.parties; }
      if (d.type === "radio") {
        let g = groupesPage.get(d.group);
        if (!g) {
          g = groupeUnique(d.group, groupesPris);
          groupesPage.set(d.group, g);
        }
        c.group = g;
        c.name = g;
        c.option = d.option || "Choix";
      } else {
        c.name = nomUnique(d.label || "", c.type, c.id);
      }
      etat.champs.push(c);
      nouveaux++;
    }
    montrerProgression(`Analyse de la page ${pg.index + 1} sur ${n}`, (pg.index + 1) / n);
  }
  cacherProgression();
  redessinerTout();
  majResume();
  const nbEx = new Set(etat.existants.map((c) => c.name)).size;
  if (nbEx && !relance) {
    const pl = nbEx > 1;
    const ajout = nouveaux === 0 ? "Aucun champ n'a été ajouté." : `${nouveaux} champ${nouveaux > 1 ? "s ont été ajoutés" : " a été ajouté"} là où il n'y en avait pas.`;
    toast(`Ce PDF contenait déjà ${nbEx} champ${pl ? "s" : ""}, conservé${pl ? "s" : ""} tel${pl ? "s" : ""} quel${pl ? "s" : ""} et prêt${pl ? "s" : ""} à remplir. ${ajout}`, 8000);
  } else if (!etat.champs.length) {
    toast("Aucune zone à remplir n'a été repérée. Augmentez la sensibilité et relancez la détection, ou tracez les champs vous-même.", 8000);
  } else {
    toast(`${etat.champs.length} champ${etat.champs.length > 1 ? "s posés" : " posé"}. Vérifiez-les avant d'enregistrer.`, 5000);
  }
}

function nomsPris(saufId) {
  const pris = new Set();
  for (const c of etat.existants) pris.add(c.name);
  for (const c of etat.champs) {
    if (c.id === saufId) continue;
    pris.add(c.type === "radio" ? c.group : c.name);
  }
  return pris;
}

function nomUnique(souhait, type, saufId) {
  const pris = nomsPris(saufId);
  let base = (souhait || "").replace(/\./g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!base) {
    let i = 1;
    const prefixe = NOMS_DEFAUT[type] || "Champ";
    while (pris.has(`${prefixe} ${i}`)) i++;
    return `${prefixe} ${i}`;
  }
  let nom = base;
  let i = 2;
  while (pris.has(nom)) nom = `${base}_${i++}`;
  return nom;
}

function groupeUnique(souhait, groupesPris) {
  const pris = nomsPris();
  for (const g of groupesPris.keys()) pris.add(g);
  let base = (souhait || "Choix").replace(/\./g, " ").trim().slice(0, 80) || "Choix";
  let nom = base;
  let i = 2;
  while (pris.has(nom)) nom = `${base}_${i++}`;
  groupesPris.set(nom, true);
  return nom;
}

// ---------------------------------------------------------------------------
// Affichage des pages

function montrerAccueil() {
  $("accueil").hidden = false;
  $("atelier").hidden = true;
  $("btn-changer").hidden = true;
  $("nom-fichier").hidden = true;
  document.body.classList.remove("en-atelier");
}

function montrerAtelier() {
  $("accueil").hidden = true;
  $("atelier").hidden = false;
  $("btn-changer").hidden = false;
  const nf = $("nom-fichier");
  nf.hidden = false;
  nf.textContent = etat.nomFichier;
  nf.title = etat.nomFichier;
  document.body.classList.add("en-atelier");
}

function largeurMax() {
  return Math.max(...etat.pages.map((p) => p.vue.width));
}

function ajusterZoom(redessiner = true) {
  const espace = $("espace");
  const dispo = Math.max(200, espace.clientWidth - (ecranEtroit() ? 16 : 48));
  etat.zoom = Math.max(0.3, Math.min(2, dispo / largeurMax()));
  if (redessiner) appliquerZoom();
  majZoomLibelle();
}

function majZoomLibelle() {
  $("btn-zoom-ajuste").textContent = `${Math.round(etat.zoom * 100)} %`;
}

function changerZoom(sens) {
  const z = etat.zoom;
  let cible;
  if (sens > 0) cible = PAS_ZOOM.find((p) => p > z + 0.01) || PAS_ZOOM[PAS_ZOOM.length - 1];
  else cible = [...PAS_ZOOM].reverse().find((p) => p < z - 0.01) || PAS_ZOOM[0];
  etat.zoom = cible;
  etat.zoomAjuste = false;
  appliquerZoom();
  majZoomLibelle();
}

function appliquerZoom() {
  const espace = $("espace");
  const ratio = espace.scrollHeight ? espace.scrollTop / espace.scrollHeight : 0;
  for (const pg of etat.pages) {
    dimensionnerPage(pg);
    pg.rendu = 0;
  }
  espace.scrollTop = ratio * espace.scrollHeight;
  for (const pg of etat.pages) if (pg.visible) dessinerPage(pg);
  redessinerTout();
}

function dimensionnerPage(pg) {
  if (!pg.el) return;
  pg.el.style.width = `${pg.vue.width * etat.zoom}px`;
  pg.el.style.height = `${pg.vue.height * etat.zoom}px`;
}

function construirePages() {
  const conteneur = $("pages");
  conteneur.textContent = "";
  if (etat.observateur) etat.observateur.disconnect();
  etat.observateur = new IntersectionObserver(
    (entrees) => {
      for (const e of entrees) {
        const pg = etat.pages[+e.target.dataset.page];
        pg.visible = e.isIntersecting;
        if (e.isIntersecting) dessinerPage(pg);
        else liberer(pg);
      }
    },
    { root: $("espace"), rootMargin: "150% 0px" }
  );
  for (const pg of etat.pages) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = pg.index;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `Page ${pg.index + 1} sur ${etat.pages.length}`);
    const canvas = document.createElement("canvas");
    canvas.className = "page-rendu";
    canvas.setAttribute("aria-hidden", "true");
    const calque = document.createElement("div");
    calque.className = "calque";
    calque.dataset.page = pg.index;
    el.append(canvas, calque);
    const num = document.createElement("span");
    num.className = "page-numero";
    num.textContent = `${pg.index + 1} / ${etat.pages.length}`;
    num.setAttribute("aria-hidden", "true");
    el.append(num);
    conteneur.append(el);
    Object.assign(pg, { el, canvas, calque });
    dimensionnerPage(pg);
    brancherCalque(calque, pg);
    etat.observateur.observe(el);
  }
}

function liberer(pg) {
  if (pg.tache) { try { pg.tache.cancel(); } catch (e) { /* rien */ } pg.tache = null; }
  if (pg.canvas && pg.rendu) {
    pg.canvas.width = pg.canvas.height = 0;
    pg.rendu = 0;
  }
}

async function dessinerPage(pg) {
  let dpr = window.devicePixelRatio || 1;
  let echelle = etat.zoom * dpr;
  const maxPixels = 16e6;
  if (pg.vue.width * pg.vue.height * echelle * echelle > maxPixels) {
    echelle = Math.sqrt(maxPixels / (pg.vue.width * pg.vue.height));
  }
  if (pg.rendu === echelle) return;
  if (pg.tache) { try { pg.tache.cancel(); } catch (e) { /* rien */ } }
  const vue = pg.proxy.getViewport({ scale: echelle });
  const tampon = document.createElement("canvas");
  tampon.width = Math.floor(vue.width);
  tampon.height = Math.floor(vue.height);
  const tache = pg.proxy.render({
    canvas: tampon,
    canvasContext: tampon.getContext("2d"),
    viewport: vue,
    annotationMode: etat.lib.AnnotationMode.ENABLE_FORMS,
  });
  pg.tache = tache;
  try {
    await tache.promise;
  } catch (e) {
    return;
  }
  if (pg.tache !== tache) return;
  pg.tache = null;
  const c = pg.canvas;
  c.width = tampon.width;
  c.height = tampon.height;
  c.getContext("2d").drawImage(tampon, 0, 0);
  tampon.width = tampon.height = 0;
  pg.rendu = echelle;
}

// ---------------------------------------------------------------------------
// Calques des champs

function tousLesChamps() {
  return [...etat.existants.filter((c) => c.type !== "autre"), ...etat.champs];
}

function ordreLecture(a, b) {
  if (a.page !== b.page) return a.page - b.page;
  const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
  if (Math.abs(dy) > Math.min(a.h, b.h) * 0.6 && Math.abs(dy) > 3) return dy;
  return a.x - b.x;
}

function redessinerTout() {
  numeroter();
  const liste = etat.mode === "remplir" && etat.vueListe;
  document.body.classList.toggle("vue-liste", liste);
  $("pages").hidden = liste;
  $("liste").hidden = !liste;
  $("btn-vue-page").setAttribute("aria-pressed", liste ? "false" : "true");
  $("btn-vue-liste").setAttribute("aria-pressed", liste ? "true" : "false");
  if (liste) construireListe();
  else for (const pg of etat.pages) dessinerCalque(pg);
  majPanneau();
  majBoutons();
}

// Remplissage en liste : un formulaire classique, champ par champ, dans l'ordre de lecture.
function construireListe() {
  const form = $("liste");
  form.textContent = "";
  const v = etat.valeurs;
  const champs = tousLesChamps().filter((c) => c.type !== "autre").sort(ordreLecture);
  if (!champs.length) {
    const p = document.createElement("p");
    p.className = "liste-aide";
    p.textContent = "Aucun champ à remplir. Passez par l'onglet Ajuster les champs pour en ajouter.";
    form.append(p);
    return;
  }
  const groupesFaits = new Set();
  let pageCourante = -1;
  let n = 0;
  // Libellés identiques (lignes d'un tableau) : on les numérote dans l'ordre de lecture.
  const vus = new Map();
  const totaux = new Map();
  for (const c of champs) {
    if (c.type === "radio" || c.lie) continue;
    const l = libelleLisible(c);
    totaux.set(l, (totaux.get(l) || 0) + 1);
  }
  const libelleListe = (c) => libelleNumerote(c);
  for (const c of champs) {
    if (c.lie) continue;
    if (c.page !== pageCourante) {
      pageCourante = c.page;
      if (etat.pages.length > 1) {
        const h = document.createElement("h3");
        h.textContent = `Page ${c.page + 1}`;
        form.append(h);
      }
    }
    const bloc = document.createElement("div");
    bloc.className = "liste-champ";
    const id = `l-${c.id}`;
    n++;
    if (c.type === "radio") {
      if (groupesFaits.has(c.group)) continue;
      groupesFaits.add(c.group);
      const fs = document.createElement("fieldset");
      const lg = document.createElement("legend");
      lg.textContent = c.group;
      fs.append(lg);
      const cle = "radio:" + c.group;
      for (const o of champs.filter((x) => x.type === "radio" && x.group === c.group)) {
        const lab = document.createElement("label");
        lab.className = "liste-choix";
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `l-radio-${n}`;
        r.value = o.option;
        r.checked = v[cle] === o.option;
        r.disabled = Boolean(o.readOnly);
        r.addEventListener("change", () => {
          if (r.checked) v[cle] = o.option;
          etat.modifie = true;
        });
        lab.append(r, document.createTextNode(o.option));
        fs.append(lab);
      }
      bloc.append(fs);
      form.append(bloc);
      continue;
    }
    if (c.type === "checkbox") {
      const lab = document.createElement("label");
      lab.className = "liste-choix";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.checked = v[c.id] === true;
      cb.disabled = Boolean(c.readOnly);
      cb.addEventListener("change", () => {
        if (cb.checked) v[c.id] = true;
        else delete v[c.id];
        if (c.existing) synchroniserCasesLiees(c, cb.checked);
        etat.modifie = true;
      });
      lab.append(cb, document.createTextNode(libelleListe(c)));
      bloc.append(lab);
      form.append(bloc);
      continue;
    }
    const lab = document.createElement("label");
    lab.htmlFor = id;
    lab.textContent = libelleListe(c);
    let el;
    if (c.type === "multiline") {
      el = document.createElement("textarea");
    } else if (c.type === "dropdown") {
      el = document.createElement("select");
      const vide = document.createElement("option");
      vide.value = "";
      vide.textContent = "Choisir";
      el.append(vide);
      for (const o of c.options || []) {
        const op = document.createElement("option");
        op.value = o;
        op.textContent = o;
        el.append(op);
      }
    } else {
      el = document.createElement("input");
      el.type = "text";
      if (c.type === "comb") el.maxLength = c.cells;
      else if (c.maxLength) el.maxLength = c.maxLength;
    }
    el.id = id;
    el.value = v[c.id] || "";
    el.disabled = Boolean(c.readOnly);
    el.dataset.id = c.id;
    el.addEventListener(c.type === "dropdown" ? "change" : "input", () => {
      if (el.value) v[c.id] = el.value;
      else delete v[c.id];
      etat.modifie = true;
    });
    bloc.append(lab, el);
    if (c.type === "comb") {
      const aide = document.createElement("p");
      aide.className = "liste-aide";
      aide.textContent = `${c.cells} case${c.cells > 1 ? "s" : ""}, une lettre ou un chiffre par case.`;
      bloc.append(aide);
    }
    form.append(bloc);
  }
}

function dessinerCalque(pg) {
  if (!pg.calque) return;
  const calque = pg.calque;
  const actif = document.activeElement;
  const idFocus = actif && calque.contains(actif) ? actif.dataset.id : null;
  calque.textContent = "";
  calque.classList.toggle("mode-remplir", etat.mode === "remplir");
  calque.classList.toggle("mode-trace", etat.mode === "ajuster" && etat.outil !== "selection");
  const z = etat.zoom;
  const liste = tousLesChamps().filter((c) => c.page === pg.index).sort(ordreLecture);
  for (const c of liste) {
    const el = etat.mode === "remplir" ? creerSaisie(c, z) : creerCadre(c, z);
    if (!el) continue;
    calque.append(el);
  }
  if (idFocus) {
    const el = calque.querySelector(`[data-id="${idFocus}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

function placer(el, c, z) {
  el.style.left = `${c.x * z}px`;
  el.style.top = `${c.y * z}px`;
  el.style.width = `${c.w * z}px`;
  el.style.height = `${c.h * z}px`;
}

const LIBELLES_TYPE = {
  text: "texte", multiline: "texte sur plusieurs lignes", comb: "peigne", checkbox: "case à cocher",
  radio: "bouton radio", dropdown: "liste de choix",
};

function creerCadre(c, z) {
  const el = document.createElement("div");
  el.className = `champ type-${c.type}${c.existing ? " existant" : ""}${etat.selection.has(c.id) ? " choisi" : ""}`;
  el.dataset.id = c.id;
  el.tabIndex = 0;
  const desc = c.type === "radio" ? `${c.group}, choix ${c.option}` : libelleLisible(c);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${LIBELLES_TYPE[c.type] || "champ"} ${desc}${c.existing ? ", champ d'origine" : ""}`);
  el.setAttribute("aria-pressed", etat.selection.has(c.id) ? "true" : "false");
  el.title = c.type === "radio" ? `${c.group} : ${c.option}` : c.name;
  placer(el, c, z);
  if (c.type === "comb" && c.cells > 0) el.style.setProperty("--cellule", `${(c.w * z) / c.cells}px`);
  if (etat.selection.has(c.id)) {
    const etiquette = document.createElement("span");
    etiquette.className = "etiquette";
    etiquette.textContent = c.type === "radio" ? `${c.group} : ${c.option}` : c.name;
    el.append(etiquette);
    if (etat.selection.size === 1 && !c.existing) {
      for (const p of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const h = document.createElement("span");
        h.className = `poignee p-${p}`;
        h.dataset.poignee = p;
        h.setAttribute("aria-hidden", "true");
        el.append(h);
      }
    }
  }
  el.addEventListener("focus", () => {
    if (etat.pointeurActif) return;
    if (!etat.selection.has(c.id)) {
      etat.selection = new Set([c.id]);
      majSelectionVisuelle();
    }
  });
  el.addEventListener("dblclick", () => {
    if (!c.existing) $("prop-nom").focus();
  });
  return el;
}

function tailleSaisie(c, z) {
  if (c.fontSize > 0) return c.fontSize * z;
  if (c.type === "multiline") return Math.min(10, c.h * 0.5) * z;
  return Math.max(6, Math.min(12, c.h * 0.65)) * z;
}

// Libellés en double (cellules d'un tableau) : « Nom, ligne 2 » quand ils sont dans une même
// colonne, sinon « Nom (2) ». Calculé une fois pour la page et la liste.
function numeroter() {
  const champs = tousLesChamps().filter((c) => c.type !== "radio" && !c.lie).sort(ordreLecture);
  const groupes = new Map();
  for (const c of champs) {
    const l = libelleLisible(c);
    if (!groupes.has(l)) groupes.set(l, []);
    groupes.get(l).push(c);
  }
  const res = new Map();
  for (const [l, liste] of groupes) {
    if (liste.length < 2) continue;
    // Colonnes de tableau : mêmes x et largeur sur la même page.
    const colonnes = [];
    for (const c of liste) {
      const col = colonnes.find((k) => k[0].page === c.page && Math.abs(k[0].x - c.x) <= 4 && Math.abs(k[0].w - c.w) <= 4);
      if (col) col.push(c);
      else colonnes.push([c]);
    }
    const seuls = [];
    for (const col of colonnes) {
      if (col.length >= 2) col.forEach((c, i) => res.set(c.id, `${l}, ligne ${i + 1}`));
      else seuls.push(col[0]);
    }
    if (seuls.length >= 2) seuls.forEach((c, i) => res.set(c.id, `${l} (${i + 1})`));
  }
  etat.numeros = res;
}

function libelleNumerote(c) {
  return (etat.numeros && etat.numeros.get(c.id)) || libelleLisible(c);
}

// Libellé lisible d'un champ : sa question, son libellé, et sa place dans un peigne découpé.
function libelleLisible(c) {
  let base = c.type === "radio" ? `${c.group} : ${c.option}` : c.label || c.name;
  if (c.type === "checkbox" && c.question && c.question !== base) base = `${c.question} : ${base}`;
  if (c.parties > 1) base += `, partie ${c.partie} sur ${c.parties}`;
  return base;
}

let ctxAvance = null;
function avanceMono(fs) {
  if (!ctxAvance) ctxAvance = document.createElement("canvas").getContext("2d");
  ctxAvance.font = `${fs}px "Courier New", Courier, monospace`;
  return ctxAvance.measureText("MÉ0W").width / 4;
}

function creerSaisie(c, z) {
  let el;
  const v = etat.valeurs;
  const libelle = libelleNumerote(c);
  if (c.type === "checkbox") {
    el = document.createElement("input");
    el.type = "checkbox";
    el.checked = v[c.id] === true;
    el.addEventListener("change", () => {
      if (el.checked) v[c.id] = true;
      else delete v[c.id];
      if (c.existing) synchroniserCasesLiees(c, el.checked);
      etat.modifie = true;
    });
  } else if (c.type === "radio") {
    el = document.createElement("input");
    el.type = "radio";
    el.name = "radio-" + c.group;
    el.value = c.option;
    const cle = "radio:" + c.group;
    el.checked = v[cle] === c.option;
    el.addEventListener("pointerdown", () => { el.dataset.etaitCoche = el.checked ? "1" : ""; });
    el.addEventListener("click", () => {
      if (el.dataset.etaitCoche === "1") {
        el.checked = false;
        delete v[cle];
      } else {
        v[cle] = c.option;
      }
      el.dataset.etaitCoche = "";
      etat.modifie = true;
      document.querySelectorAll(`input[type=radio]`).forEach((r) => {
        if (r.name === el.name && r !== el) r.checked = v[cle] === r.value && r.dataset.groupe === c.group;
      });
    });
    el.addEventListener("change", () => {
      if (el.checked) v[cle] = c.option;
    });
    el.dataset.groupe = c.group;
  } else if (c.type === "dropdown") {
    el = document.createElement("select");
    const vide = document.createElement("option");
    vide.value = "";
    vide.textContent = "";
    el.append(vide);
    for (const o of c.options || []) {
      const op = document.createElement("option");
      op.value = o;
      op.textContent = o;
      el.append(op);
    }
    el.value = v[c.id] || "";
    el.style.fontSize = `${tailleSaisie(c, z)}px`;
    el.addEventListener("change", () => {
      if (el.value) v[c.id] = el.value;
      else delete v[c.id];
      etat.modifie = true;
    });
  } else if (c.type === "multiline") {
    el = document.createElement("textarea");
    el.value = v[c.id] || "";
    el.style.fontSize = `${tailleSaisie(c, z)}px`;
    el.style.padding = `${Math.max(1, 1.5 * z)}px ${Math.max(2, 2 * z)}px`;
    el.addEventListener("input", () => {
      if (el.value) v[c.id] = el.value;
      else delete v[c.id];
      etat.modifie = true;
    });
  } else if (c.type === "text" || c.type === "comb") {
    el = document.createElement("input");
    el.type = "text";
    el.value = v[c.id] || "";
    el.spellcheck = false;
    if (c.type === "comb") {
      el.maxLength = c.cells;
      const cellule = (c.w * z) / c.cells;
      const fs = Math.min(cellule * 1.15, c.h * z * 0.72, (c.fontSize || 99) * z);
      // Avance réelle d'un caractère dans la police affichée, pour centrer chaque lettre dans sa case.
      const largeurCar = avanceMono(fs);
      const espace = Math.max(0, cellule - largeurCar);
      el.style.boxSizing = "content-box";
      el.style.border = "0";
      el.style.textIndent = "0";
      el.style.fontSize = `${fs}px`;
      el.style.letterSpacing = `${espace}px`;
      // Décalage porté par la position de l'input dans son enveloppe, pas par un padding
      // (que Chrome ne respecte pas toujours une fois le champ rempli).
      el.style.padding = "0";
      el.style.left = `${espace / 2}px`;
      // Une case de plus en largeur, masquée : le curseur a sa place et rien ne défile.
      el.style.width = `${c.w * z + cellule}px`;
      el.dataset.cellule = String(cellule);
      const recaler = () => { if (el.scrollLeft) el.scrollLeft = 0; };
      for (const ev of ["input", "focus", "keyup", "click", "select"]) el.addEventListener(ev, recaler);
    } else {
      if (c.maxLength) el.maxLength = c.maxLength;
      el.style.fontSize = `${tailleSaisie(c, z)}px`;
      el.style.padding = `0 ${Math.max(2, 2 * z)}px`;
    }
    el.addEventListener("input", () => {
      if (el.value) v[c.id] = el.value;
      else delete v[c.id];
      etat.modifie = true;
    });
  } else {
    return null;
  }
  el.className = `saisie type-${c.type}`;
  el.dataset.id = c.id;
  el.dataset.nom = c.type === "radio" ? c.group : c.name;
  el.setAttribute("aria-label", libelle);
  el.title = libelle;
  if (c.readOnly) el.disabled = true;
  if (c.type === "comb") {
    const enveloppe = document.createElement("div");
    enveloppe.className = "saisie-peigne";
    placer(enveloppe, c, z);
    enveloppe.style.setProperty("--cellule", `${el.dataset.cellule}px`);
    enveloppe.append(el);
    // Navigateurs sans overflow: clip : l'enveloppe ne doit jamais défiler.
    enveloppe.addEventListener("scroll", () => { if (enveloppe.scrollLeft) enveloppe.scrollLeft = 0; });
    for (const ev of ["input", "focus", "keyup", "click", "select"]) el.addEventListener(ev, () => { if (enveloppe.scrollLeft) enveloppe.scrollLeft = 0; });
    return enveloppe;
  }
  placer(el, c, z);
  return el;
}

function synchroniserCasesLiees(c, coche) {
  for (const autre of etat.existants) {
    if (autre !== c && autre.name === c.name && autre.type === "checkbox") {
      if (coche) etat.valeurs[autre.id] = true;
      else delete etat.valeurs[autre.id];
    }
  }
  const premier = etat.existants.find((e) => e.name === c.name && e.type === "checkbox" && !e.lie);
  if (premier) {
    if (coche) etat.valeurs[premier.id] = true;
    else delete etat.valeurs[premier.id];
  }
}

function majSelectionVisuelle() {
  for (const pg of etat.pages) dessinerCalque(pg);
  majPanneau();
}

// ---------------------------------------------------------------------------
// Souris, doigt et clavier sur les pages

function pointDansCalque(calque, e) {
  const r = calque.getBoundingClientRect();
  return { x: (e.clientX - r.left) / etat.zoom, y: (e.clientY - r.top) / etat.zoom };
}

function trouverChamp(id) {
  return etat.champs.find((c) => c.id === id) || etat.existants.find((c) => c.id === id);
}

function brancherCalque(calque, pg) {
  let geste = null;
  calque.addEventListener("pointerdown", (e) => {
    if (etat.mode !== "ajuster" || e.button > 0) return;
    const p = pointDansCalque(calque, e);
    const cadre = e.target.closest(".champ");
    const poignee = e.target.closest(".poignee");
    etat.pointeurActif = true;
    setTimeout(() => (etat.pointeurActif = false), 0);
    if (etat.outil !== "selection" && !poignee) {
      e.preventDefault();
      const apercu = document.createElement("div");
      apercu.className = "trace-apercu";
      calque.append(apercu);
      geste = { type: "trace", depart: p, apercu };
      calque.setPointerCapture(e.pointerId);
      return;
    }
    if (!cadre) {
      if (!e.shiftKey && etat.selection.size) {
        etat.selection.clear();
        majSelectionVisuelle();
      }
      return;
    }
    const c = trouverChamp(cadre.dataset.id);
    if (!c) return;
    e.preventDefault();
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (etat.selection.has(c.id)) etat.selection.delete(c.id);
      else etat.selection.add(c.id);
      majSelectionVisuelle();
      const el = calque.querySelector(`[data-id="${c.id}"]`);
      if (el) el.focus({ preventScroll: true });
      return;
    }
    if (!etat.selection.has(c.id)) {
      etat.selection = new Set([c.id]);
      majSelectionVisuelle();
    }
    const el = calque.querySelector(`[data-id="${c.id}"]`);
    if (el) el.focus({ preventScroll: true });
    if (c.existing) return;
    const bougeables = [...etat.selection].map(trouverChamp).filter((x) => x && !x.existing && x.page === pg.index);
    geste = {
      type: poignee ? "taille" : "deplacer",
      poignee: poignee ? poignee.dataset.poignee : null,
      depart: p,
      origines: bougeables.map((x) => ({ c: x, x: x.x, y: x.y, w: x.w, h: x.h })),
      bouge: false,
    };
    calque.setPointerCapture(e.pointerId);
  });

  calque.addEventListener("pointermove", (e) => {
    if (!geste) return;
    const p = pointDansCalque(calque, e);
    const W = pg.vue.width, H = pg.vue.height;
    if (geste.type === "trace") {
      const x = Math.max(0, Math.min(p.x, geste.depart.x));
      const y = Math.max(0, Math.min(p.y, geste.depart.y));
      const w = Math.min(W, Math.max(p.x, geste.depart.x)) - x;
      const h = Math.min(H, Math.max(p.y, geste.depart.y)) - y;
      placer(geste.apercu, { x, y, w, h }, etat.zoom);
      geste.rect = { x, y, w, h };
      return;
    }
    const dx = p.x - geste.depart.x, dy = p.y - geste.depart.y;
    if (!geste.bouge && Math.hypot(dx, dy) * etat.zoom < 3) return;
    if (!geste.bouge) {
      pousserHistorique();
      geste.bouge = true;
    }
    if (geste.type === "deplacer") {
      for (const o of geste.origines) {
        o.c.x = Math.max(0, Math.min(W - o.w, o.x + dx));
        o.c.y = Math.max(0, Math.min(H - o.h, o.y + dy));
        o.c.source = "manuel";
        const el = calque.querySelector(`[data-id="${o.c.id}"]`);
        if (el) placer(el, o.c, etat.zoom);
      }
    } else {
      const o = geste.origines[0];
      if (!o) return;
      let { x, y, w, h } = o;
      const sens = geste.poignee;
      const min = 3;
      if (sens.includes("e")) w = Math.max(min, Math.min(W - x, o.w + dx));
      if (sens.includes("s")) h = Math.max(min, Math.min(H - y, o.h + dy));
      if (sens.includes("w")) { const nx = Math.max(0, Math.min(o.x + o.w - min, o.x + dx)); w = o.x + o.w - nx; x = nx; }
      if (sens.includes("n")) { const ny = Math.max(0, Math.min(o.y + o.h - min, o.y + dy)); h = o.y + o.h - ny; y = ny; }
      Object.assign(o.c, { x, y, w, h, source: "manuel" });
      const el = calque.querySelector(`[data-id="${o.c.id}"]`);
      if (el) {
        placer(el, o.c, etat.zoom);
        if (o.c.type === "comb") el.style.setProperty("--cellule", `${(o.c.w * etat.zoom) / o.c.cells}px`);
      }
    }
    majPositionPanneau();
  });

  const finir = () => {
    if (!geste) return;
    const g = geste;
    geste = null;
    if (g.type === "trace") {
      g.apercu.remove();
      let r = g.rect;
      const outil = etat.outil;
      if (!r || r.w < 3 || r.h < 3) {
        const d = { checkbox: [11, 11], text: [140, 16], dropdown: [110, 16] }[outil] || [100, 16];
        r = { x: g.depart.x, y: g.depart.y - d[1] / 2, w: d[0], h: d[1] };
        r.x = Math.max(0, Math.min(pg.vue.width - r.w, r.x));
        r.y = Math.max(0, Math.min(pg.vue.height - r.h, r.y));
      }
      ajouterChamp(pg.index, outil, r);
      choisirOutil("selection");
      return;
    }
    if (g.bouge) {
      etat.modifie = true;
      redessinerTout();
    }
  };
  calque.addEventListener("pointerup", finir);
  calque.addEventListener("pointercancel", () => {
    if (geste && geste.type === "trace") geste.apercu.remove();
    geste = null;
  });
}

function ajouterChamp(page, type, r) {
  pousserHistorique();
  const c = {
    id: "c" + etat.idSuivant++,
    page, x: r.x, y: r.y, w: r.w, h: r.h,
    type, label: "", source: "manuel",
    fontSize: type === "checkbox" ? 0 : Math.max(6, Math.min(11, Math.round(r.h * 0.62))),
  };
  if (type === "dropdown") c.options = ["Choix 1", "Choix 2"];
  c.name = nomUnique("", type, c.id);
  if (type === "text" && r.h >= 30 && r.w >= 60) { c.type = "multiline"; c.fontSize = 10; }
  etat.champs.push(c);
  etat.selection = new Set([c.id]);
  etat.modifie = true;
  redessinerTout();
  majResume();
  const el = document.querySelector(`.champ[data-id="${c.id}"]`);
  if (el) el.focus({ preventScroll: true });
}

function brancherClavier() {
  document.addEventListener("keydown", (e) => {
    if (!etat.doc || $("atelier").hidden) return;
    const cible = e.target;
    const dansSaisie = cible.closest && cible.closest("input, textarea, select, [contenteditable]");
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      if (dansSaisie) return;
      if (etat.mode !== "ajuster") return;
      e.preventDefault();
      if (e.key === "y" || e.shiftKey) retablir();
      else annuler();
      return;
    }
    if (dansSaisie || etat.mode !== "ajuster") return;
    if (e.key === "Escape") {
      if (etat.outil !== "selection") choisirOutil("selection");
      else if (etat.selection.size) {
        etat.selection.clear();
        majSelectionVisuelle();
      }
      return;
    }
    if (!etat.selection.size) return;
    const choisis = [...etat.selection].map(trouverChamp).filter((c) => c && !c.existing);
    if (!choisis.length) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      supprimerSelection();
      return;
    }
    const pas = e.shiftKey ? 10 : 1;
    const dep = { ArrowLeft: [-pas, 0], ArrowRight: [pas, 0], ArrowUp: [0, -pas], ArrowDown: [0, pas] }[e.key];
    if (dep) {
      e.preventDefault();
      pousserHistorique();
      for (const c of choisis) {
        const pg = etat.pages[c.page];
        c.x = Math.max(0, Math.min(pg.vue.width - c.w, c.x + dep[0]));
        c.y = Math.max(0, Math.min(pg.vue.height - c.h, c.y + dep[1]));
        c.source = "manuel";
      }
      etat.modifie = true;
      redessinerTout();
    }
  });
}

// ---------------------------------------------------------------------------
// Historique

function instantane() {
  return JSON.stringify({ champs: etat.champs, selection: [...etat.selection] });
}

function pousserHistorique() {
  etat.historique.push(instantane());
  if (etat.historique.length > 150) etat.historique.shift();
  etat.futur = [];
  majBoutons();
}

function restaurer(json) {
  const d = JSON.parse(json);
  etat.champs = d.champs;
  etat.selection = new Set(d.selection.filter((id) => trouverChamp(id)));
  redessinerTout();
  majResume();
}

function annuler() {
  if (!etat.historique.length) return;
  etat.futur.push(instantane());
  restaurer(etat.historique.pop());
}

function retablir() {
  if (!etat.futur.length) return;
  etat.historique.push(instantane());
  restaurer(etat.futur.pop());
}

// ---------------------------------------------------------------------------
// Panneau

function brancherAtelier() {
  $("toast-fermer").addEventListener("click", () => { $("toast").hidden = true; clearTimeout(minuterieToast); });
  // Dès que l'on commence à remplir, le message s'efface pour ne pas cacher le champ.
  const effacerMessage = (e) => {
    if (e.target.closest && e.target.closest(".saisie, #liste")) { $("toast").hidden = true; clearTimeout(minuterieToast); }
  };
  document.addEventListener("focusin", effacerMessage);
  document.addEventListener("input", effacerMessage);
  $("btn-vue-page").addEventListener("click", () => { etat.vueListe = false; redessinerTout(); });
  $("btn-vue-liste").addEventListener("click", () => { etat.vueListe = true; redessinerTout(); });
  $("liste").addEventListener("submit", (e) => e.preventDefault());
  $("onglet-ajuster").addEventListener("click", () => changerMode("ajuster"));
  $("onglet-remplir").addEventListener("click", () => changerMode("remplir"));
  $("onglet-ajuster").addEventListener("keydown", flecheOnglets);
  $("onglet-remplir").addEventListener("keydown", flecheOnglets);
  document.querySelectorAll("[data-outil]").forEach((b) => b.addEventListener("click", () => choisirOutil(b.dataset.outil)));
  $("btn-annuler").addEventListener("click", annuler);
  $("btn-retablir").addEventListener("click", retablir);
  $("btn-zoom-plus").addEventListener("click", () => changerZoom(1));
  $("btn-zoom-moins").addEventListener("click", () => changerZoom(-1));
  $("btn-zoom-ajuste").addEventListener("click", () => {
    etat.zoomAjuste = true;
    ajusterZoom();
  });
  $("sensibilite").addEventListener("change", (e) => (etat.sensibilite = +e.target.value));
  $("btn-relancer").addEventListener("click", () => lancerDetection(true));
  $("btn-changer").addEventListener("click", () => {
    if (etat.modifie && !confirm("Fermer ce PDF ? Les champs posés et les valeurs saisies seront perdus si vous ne les avez pas enregistrés.")) return;
    if (etat.doc) { try { etat.doc.destroy(); } catch (e) { /* rien */ } }
    etat.doc = null;
    etat.modifie = false;
    montrerAccueil();
    $("btn-choisir").focus();
  });
  $("btn-vierge").addEventListener("click", () => enregistrer(false));
  $("btn-rempli").addEventListener("click", () => enregistrer(true));
  $("btn-supprimer").addEventListener("click", supprimerSelection);
  $("btn-supprimer-multi").addEventListener("click", supprimerSelection);
  $("btn-dupliquer").addEventListener("click", dupliquer);
  $("btn-grouper").addEventListener("click", grouperEnRadio);
  $("btn-en-cases").addEventListener("click", remettreEnCases);
  $("proprietes").addEventListener("submit", (e) => e.preventDefault());
  for (const id of ["prop-nom", "prop-type", "prop-groupe", "prop-option", "prop-cases", "prop-choix", "prop-taille", "prop-x", "prop-y", "prop-w", "prop-h"]) {
    $(id).addEventListener("change", () => appliquerPropriete(id));
  }
  $("prop-nom").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });
  brancherClavier();
  let minuterie = null;
  window.addEventListener("resize", () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(() => {
      if (etat.doc && etat.zoomAjuste) ajusterZoom();
    }, 200);
  });
}

function flecheOnglets(e) {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const autre = e.target.id === "onglet-ajuster" ? "remplir" : "ajuster";
    changerMode(autre);
    $(`onglet-${autre}`).focus();
  }
}

function changerMode(mode, redessiner = true) {
  etat.mode = mode;
  $("onglet-ajuster").setAttribute("aria-selected", mode === "ajuster" ? "true" : "false");
  $("onglet-remplir").setAttribute("aria-selected", mode === "remplir" ? "true" : "false");
  $("onglet-ajuster").tabIndex = mode === "ajuster" ? 0 : -1;
  $("onglet-remplir").tabIndex = mode === "remplir" ? 0 : -1;
  document.body.classList.toggle("mode-remplir", mode === "remplir");
  if (mode === "remplir") {
    etat.selection.clear();
    choisirOutil("selection", false);
  }
  if (redessiner) redessinerTout();
}

function choisirOutil(outil, redessiner = true) {
  etat.outil = outil;
  document.querySelectorAll("[data-outil]").forEach((b) => {
    const actif = b.dataset.outil === outil;
    b.classList.toggle("actif", actif);
    b.setAttribute("aria-pressed", actif ? "true" : "false");
  });
  if (redessiner) for (const pg of etat.pages) if (pg.calque) pg.calque.classList.toggle("mode-trace", etat.mode === "ajuster" && outil !== "selection");
}

function majBoutons() {
  $("btn-annuler").disabled = !etat.historique.length;
  $("btn-retablir").disabled = !etat.futur.length;
}

function majResume() {
  const n = { text: 0, multiline: 0, comb: 0, checkbox: 0, dropdown: 0 };
  const groupes = new Set();
  for (const c of etat.champs) {
    if (c.type === "radio") groupes.add(c.group);
    else n[c.type] = (n[c.type] || 0) + 1;
  }
  const morceaux = [];
  const plur = (k, s, p) => (k > 1 ? `${k} ${p}` : `${k} ${s}`);
  if (n.text + n.multiline) morceaux.push(plur(n.text + n.multiline, "texte", "textes"));
  if (n.comb) morceaux.push(plur(n.comb, "peigne", "peignes"));
  if (n.checkbox) morceaux.push(plur(n.checkbox, "case à cocher", "cases à cocher"));
  if (groupes.size) morceaux.push(plur(groupes.size, "groupe de choix", "groupes de choix"));
  if (n.dropdown) morceaux.push(plur(n.dropdown, "liste", "listes"));
  const total = etat.champs.length;
  let txt = total ? `${total} champ${total > 1 ? "s" : ""} ajouté${total > 1 ? "s" : ""} : ${morceaux.join(", ")}.` : "Aucun champ ajouté pour l'instant.";
  const ex = new Set(etat.existants.map((c) => c.name)).size;
  if (ex) txt += ` Le PDF contenait déjà ${ex} champ${ex > 1 ? "s" : ""}, conservé${ex > 1 ? "s" : ""}.`;
  $("resume-champs").textContent = txt;
}

function choisis() {
  return [...etat.selection].map(trouverChamp).filter(Boolean);
}

function majPanneau() {
  const sel = choisis();
  const form = $("proprietes");
  const multi = $("multi");
  const vide = $("proprietes-vide");
  const info = $("existant-info");
  $("bloc-proprietes").classList.toggle("a-selection", sel.length > 0);
  form.hidden = true;
  multi.hidden = true;
  info.hidden = true;
  vide.hidden = sel.length > 0;
  $("prop-nom-info").hidden = true;
  if (etat.mode !== "ajuster") {
    vide.hidden = true;
    $("bloc-proprietes").hidden = true;
    return;
  }
  $("bloc-proprietes").hidden = false;
  if (sel.length === 1 && sel[0].existing) {
    info.hidden = false;
    return;
  }
  if (sel.length > 1) {
    const modifiables = sel.filter((c) => !c.existing);
    multi.hidden = false;
    $("multi-compte").textContent = `${sel.length} champs sélectionnés.`;
    const tousCases = modifiables.length >= 2 && modifiables.every((c) => c.type === "checkbox" || c.type === "radio");
    $("btn-grouper").hidden = !tousCases;
    $("btn-en-cases").hidden = !modifiables.some((c) => c.type === "radio");
    $("btn-supprimer-multi").hidden = !modifiables.length;
    return;
  }
  if (sel.length !== 1) return;
  const c = sel[0];
  form.hidden = false;
  const estRadio = c.type === "radio";
  $("prop-nom-libelle").textContent = estRadio ? "Nom du groupe" : "Nom";
  $("prop-nom").value = estRadio ? c.group : c.name;
  $("prop-type").value = c.type;
  $("prop-groupe").value = c.group || "";
  $("prop-option").value = c.option || "";
  $("prop-cases").value = c.cells || "";
  $("prop-choix").value = (c.options || []).join("\n");
  $("prop-taille").value = String(TYPES_TEXTE.has(c.type) ? [0, 7, 8, 9, 10, 11, 12, 14, 16, 18].reduce((a, b) => (Math.abs(b - c.fontSize) < Math.abs(a - c.fontSize) ? b : a), 0) : 0);
  form.querySelectorAll("[data-pour]").forEach((el) => {
    el.hidden = !el.dataset.pour.split(" ").includes(c.type);
  });
  // Le groupe est déjà le nom pour un bouton radio : on ne montre pas deux fois le même réglage.
  $("prop-groupe").closest(".ligne-prop").hidden = true;
  const dl = $("liste-groupes");
  dl.textContent = "";
  for (const g of new Set(etat.champs.filter((x) => x.type === "radio").map((x) => x.group))) {
    const o = document.createElement("option");
    o.value = g;
    dl.append(o);
  }
  $("prop-nom").setAttribute("list", estRadio ? "liste-groupes" : "");
  majPositionPanneau();
}

function majPositionPanneau() {
  const sel = choisis();
  if (sel.length !== 1 || sel[0].existing) return;
  const c = sel[0];
  $("prop-x").value = c.x.toFixed(1);
  $("prop-y").value = c.y.toFixed(1);
  $("prop-w").value = c.w.toFixed(1);
  $("prop-h").value = c.h.toFixed(1);
}

function appliquerPropriete(id) {
  const sel = choisis();
  if (sel.length !== 1 || sel[0].existing) return;
  const c = sel[0];
  pousserHistorique();
  c.source = "manuel";
  const info = $("prop-nom-info");
  if (id === "prop-nom") {
    const souhait = $("prop-nom").value.trim();
    if (c.type === "radio") {
      const ancien = c.group;
      const nouveau = (souhait || ancien).replace(/\./g, " ").trim();
      // Renommer le groupe renomme tous ses boutons.
      for (const x of etat.champs) if (x.type === "radio" && x.group === ancien) { x.group = nouveau; x.name = nouveau; x.source = "manuel"; }
      if (etat.valeurs["radio:" + ancien] !== undefined) {
        etat.valeurs["radio:" + nouveau] = etat.valeurs["radio:" + ancien];
        delete etat.valeurs["radio:" + ancien];
      }
    } else {
      const nom = nomUnique(souhait, c.type, c.id);
      c.name = nom;
      if (souhait && nom !== souhait.replace(/\./g, " ").replace(/\s+/g, " ").trim()) {
        info.hidden = false;
        info.textContent = `Ce nom était déjà pris ou contenait un point. Le champ s'appelle « ${nom} ».`;
      }
    }
  } else if (id === "prop-type") {
    changerType(c, $("prop-type").value);
  } else if (id === "prop-option") {
    c.option = $("prop-option").value.trim() || c.option;
  } else if (id === "prop-cases") {
    c.cells = Math.max(1, Math.min(99, parseInt($("prop-cases").value, 10) || c.cells || 1));
  } else if (id === "prop-choix") {
    c.options = $("prop-choix").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!c.options.length) c.options = ["Choix 1"];
  } else if (id === "prop-taille") {
    c.fontSize = parseInt($("prop-taille").value, 10) || 0;
  } else {
    const pg = etat.pages[c.page];
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) {
      if (id === "prop-x") c.x = Math.max(0, Math.min(pg.vue.width - c.w, v));
      if (id === "prop-y") c.y = Math.max(0, Math.min(pg.vue.height - c.h, v));
      if (id === "prop-w") c.w = Math.max(2, Math.min(pg.vue.width - c.x, v));
      if (id === "prop-h") c.h = Math.max(2, Math.min(pg.vue.height - c.y, v));
    }
  }
  etat.modifie = true;
  const garderInfo = !info.hidden ? info.textContent : "";
  redessinerTout();
  majResume();
  if (garderInfo) {
    info.hidden = false;
    info.textContent = garderInfo;
  }
}

function changerType(c, type) {
  const avant = c.type;
  if (avant === type) return;
  if (avant === "radio") {
    c.name = nomUnique(c.option || c.group, type, c.id);
    delete c.group;
    delete c.option;
  }
  c.type = type;
  if (type === "comb") {
    c.cells = c.cells || Math.max(1, Math.min(60, Math.round(c.w / Math.max(6, c.h * 0.85))));
    if (!c.fontSize) c.fontSize = Math.max(6, Math.min(14, Math.round(Math.min(c.h * 0.7, c.w / c.cells))));
  }
  if (type === "multiline" && !c.fontSize) c.fontSize = 10;
  if ((type === "text" || type === "dropdown") && !c.fontSize) c.fontSize = Math.max(6, Math.min(11, Math.round(c.h * 0.62)));
  if (type === "dropdown" && !(c.options && c.options.length)) c.options = ["Choix 1", "Choix 2"];
  if (type === "checkbox" || type === "radio") c.fontSize = 0;
  if (type === "radio") {
    const groupe = nomUnique(c.label || c.name, "radio", c.id);
    c.group = groupe;
    c.option = c.label || "Choix 1";
    c.name = groupe;
  }
}

function supprimerSelection() {
  const ids = choisis().filter((c) => !c.existing).map((c) => c.id);
  if (!ids.length) return;
  pousserHistorique();
  etat.champs = etat.champs.filter((c) => !ids.includes(c.id));
  for (const id of ids) delete etat.valeurs[id];
  etat.selection.clear();
  etat.modifie = true;
  redessinerTout();
  majResume();
  toast(ids.length > 1 ? `${ids.length} champs supprimés. Ctrl ou Cmd + Z pour annuler.` : "Champ supprimé. Ctrl ou Cmd + Z pour annuler.", 3500);
}

function dupliquer() {
  const sel = choisis();
  if (sel.length !== 1 || sel[0].existing) return;
  pousserHistorique();
  const c = JSON.parse(JSON.stringify(sel[0]));
  c.id = "c" + etat.idSuivant++;
  const pg = etat.pages[c.page];
  c.y = Math.min(pg.vue.height - c.h, c.y + c.h + 4);
  c.source = "manuel";
  if (c.type === "radio") c.option = `${c.option} (copie)`;
  else c.name = nomUnique(c.name, c.type, c.id);
  etat.champs.push(c);
  etat.selection = new Set([c.id]);
  etat.modifie = true;
  redessinerTout();
  majResume();
}

function grouperEnRadio() {
  const sel = choisis().filter((c) => !c.existing && (c.type === "checkbox" || c.type === "radio"));
  if (sel.length < 2) return;
  pousserHistorique();
  sel.sort(ordreLecture);
  const premier = sel[0];
  // Un groupe déjà nommé garde son nom ; sinon la question commune repérée à la détection
  // (« Vous êtes », titre de rubrique), et à défaut « Choix 1 », « Choix 2 »...
  const question = sel.map((c) => c.question).find(Boolean) || sel.map((c) => c.rubrique).find(Boolean);
  const groupe = premier.type === "radio" ? premier.group : nomUnique(question || "", "radio", null);
  const opts = new Set();
  sel.forEach((c, i) => {
    let o = (c.type === "radio" ? c.option : nettoyerLibelle(c.label) || c.name) || `Choix ${i + 1}`;
    const b = o;
    let k = 2;
    while (opts.has(o)) o = `${b} ${k++}`;
    opts.add(o);
    delete etat.valeurs[c.id];
    if (!c.question && question) c.question = question;
    c.type = "radio";
    c.group = groupe;
    c.name = groupe;
    c.option = o;
    c.fontSize = 0;
    c.source = "manuel";
  });
  etat.modifie = true;
  redessinerTout();
  majResume();
  toast(`Groupe « ${groupe} » créé avec ${sel.length} choix.`, 3500);
}

function remettreEnCases() {
  const sel = choisis().filter((c) => !c.existing && c.type === "radio");
  if (!sel.length) return;
  pousserHistorique();
  for (const c of sel) {
    const nom = nomUnique(c.option || c.group, "checkbox", c.id);
    if (!c.question) c.question = c.group;
    if (c.option) c.label = c.option;
    delete etat.valeurs["radio:" + c.group];
    delete c.group;
    delete c.option;
    c.type = "checkbox";
    c.name = nom;
    c.source = "manuel";
  }
  etat.modifie = true;
  redessinerTout();
  majResume();
}

// ---------------------------------------------------------------------------
// Enregistrement

function nomDeBase() {
  return (etat.nomFichier || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "document";
}

function aDesValeurs() {
  return Object.keys(etat.valeurs).some((k) => {
    const v = etat.valeurs[k];
    return v === true || (typeof v === "string" && v.trim() !== "");
  });
}

async function enregistrer(remplir) {
  if (!etat.doc) return;
  if (remplir && !aDesValeurs()) {
    changerMode("remplir");
    toast("Remplissez d'abord les champs dans l'onglet Remplir, puis enregistrez le PDF rempli.", 5000);
    return;
  }
  const fige = remplir && $("figer").checked;
  const nom = `${nomDeBase()}-${fige ? "fige" : remplir ? "rempli" : "remplissable"}.pdf`;
  let poignee = null;
  if (window.showSaveFilePicker) {
    try {
      poignee = await window.showSaveFilePicker({
        suggestedName: nom,
        types: [{ description: "Document PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      poignee = null;
    }
  }
  montrerProgression("Préparation du PDF", 0.5);
  let resultat;
  try {
    resultat = await construirePdf({
      octets: etat.octets,
      champs: etat.champs,
      champsExistants: etat.existants,
      vues: etat.pages.map((p) => p.vue),
      remplir,
      valeurs: etat.valeurs,
      figer: remplir && $("figer").checked,
    });
  } catch (e) {
    cacherProgression();
    console.error(e);
    toast(e && e.code === "chiffre"
      ? "Ce PDF est protégé contre la modification. L'outil ne peut pas l'enregistrer avec des champs."
      : "Le PDF n'a pas pu être préparé. Essayez de supprimer le dernier champ modifié, puis recommencez.", 8000);
    return;
  }
  cacherProgression();
  const blob = new Blob([resultat.octets], { type: "application/pdf" });
  let nomFinal = nom;
  try {
    if (poignee) {
      const flux = await poignee.createWritable();
      await flux.write(blob);
      await flux.close();
      nomFinal = poignee.name || nom;
    } else {
      telecharger(blob, nom);
    }
  } catch (e) {
    telecharger(blob, nom);
  }
  etat.modifie = false;
  let msg = `PDF enregistré : ${nomFinal}.`;
  if (resultat.remplaces) msg += ` ${resultat.remplaces} caractère${resultat.remplaces > 1 ? "s" : ""} hors de la police standard ${resultat.remplaces > 1 ? "ont été remplacés" : "a été remplacé"}.`;
  if (resultat.avertissements.length) msg += " " + resultat.avertissements[0];
  toast(msg, 6000);
}

function telecharger(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Retours visuels

function montrerProgression(texte, part) {
  $("progression").hidden = false;
  $("progression-texte").textContent = texte;
  $("progression-barre").style.width = `${Math.round(Math.max(0, Math.min(1, part)) * 100)}%`;
}

function cacherProgression() {
  $("progression").hidden = true;
}

let minuterieToast = null;
function toast(msg, duree = 4000) {
  const t = $("toast");
  $("toast-texte").textContent = msg;
  t.hidden = false;
  // Sur téléphone, le message se place au-dessus de la barre d'enregistrement.
  const panneau = document.querySelector(".panneau");
  if (ecranEtroit() && !$("atelier").hidden && panneau) {
    t.style.bottom = `${Math.max(12, window.innerHeight - panneau.getBoundingClientRect().top + 10)}px`;
  } else {
    t.style.bottom = "";
  }
  clearTimeout(minuterieToast);
  minuterieToast = setTimeout(() => (t.hidden = true), duree);
}

// Lecture seule, pour le diagnostic et les tests automatiques.
window.outilPdf = Object.freeze({
  champs: () => JSON.parse(JSON.stringify(etat.champs)),
  existants: () => JSON.parse(JSON.stringify(etat.existants)),
  config: () => JSON.parse(JSON.stringify(etat.config)),
  pret: () => Boolean(etat.doc) && $("progression").hidden,
});

demarrer();
