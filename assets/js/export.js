// Écriture du PDF remplissable avec pdf-lib (AcroForm standard).

/* global PDFLib */

const ESPACES = /[  -​  　\t]/g;
const REMPLACEMENTS = {
  "‐": "-", "‑": "-", "‒": "-", "−": "-",
  "′": "'", "ʼ": "'", "″": '"',
  "≤": "<=", "≥": ">=", "≠": "!=", "→": "->", "←": "<-",
  "✓": "x", "✔": "x", "✕": "x", "✖": "x", "✗": "x", "✘": "x",
};

export function creerNettoyeur(police) {
  const jeu = new Set(police.getCharacterSet());
  let remplaces = 0;
  const nettoyer = (texte, multiligne) => {
    if (texte == null) return "";
    let t = String(texte).normalize("NFC").replace(ESPACES, " ");
    t = multiligne ? t.replace(/\r\n?/g, "\n") : t.replace(/[\r\n]+/g, " ");
    let sortie = "";
    for (const ch of t) {
      const code = ch.codePointAt(0);
      if (ch === "\n" || jeu.has(code)) { sortie += ch; continue; }
      if (REMPLACEMENTS[ch]) { sortie += REMPLACEMENTS[ch]; remplaces++; continue; }
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (base && [...base].every((c) => jeu.has(c.codePointAt(0)))) { sortie += base; remplaces++; continue; }
      if (code < 32) continue;
      sortie += "?";
      remplaces++;
    }
    return sortie;
  };
  nettoyer.compte = () => remplaces;
  return nettoyer;
}

function nomPdf(nom) {
  // Le point sépare les niveaux dans un nom de champ PDF : on l'écarte.
  return String(nom || "").replace(/\./g, " ").replace(/\s+/g, " ").trim() || "Champ";
}

// Convertit un rectangle affiché (points, origine en haut à gauche, page tournée comme à l'écran)
// en paramètres pdf-lib (x, y, largeur, hauteur avant rotation) pour addToPage.
export function versPdfLib(rect, vue) {
  const p1 = vue.convertToPdfPoint(rect.x, rect.y);
  const p2 = vue.convertToPdfPoint(rect.x + rect.w, rect.y + rect.h);
  const minX = Math.min(p1[0], p2[0]), minY = Math.min(p1[1], p2[1]);
  const w = rect.w, h = rect.h; // dimensions vues à l'écran
  const r = ((vue.rotation % 360) + 360) % 360;
  if (r === 90) return { x: minX + h, y: minY, width: w, height: h, rotation: 90 };
  if (r === 180) return { x: minX + w, y: minY + h, width: w, height: h, rotation: 180 };
  if (r === 270) return { x: minX, y: minY + w, width: w, height: h, rotation: 270 };
  return { x: minX, y: minY, width: w, height: h, rotation: 0 };
}

function nomUnique(base, pris) {
  let nom = base;
  let i = 2;
  while (pris.has(nom)) nom = `${base}_${i++}`;
  pris.add(nom);
  return nom;
}

/**
 * @param {object} p
 * @param {Uint8Array} p.octets PDF d'origine
 * @param {Array} p.champs champs créés par l'outil (hors champs d'origine)
 * @param {Array} p.champsExistants champs déjà présents dans le PDF
 * @param {Array} p.vues vues pdf.js à l'échelle 1 (une par page)
 * @param {boolean} p.remplir écrire les valeurs saisies
 * @param {object} p.valeurs valeurs par identifiant de champ, et "radio:<groupe>" pour les groupes
 * @param {boolean} p.figer aplatir le formulaire
 */
export async function construirePdf(p) {
  const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFHexString, PDFDict, PDFString, PDFArray, PDFRef, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;
  const doc = await PDFDocument.load(p.octets, { updateMetadata: false, ignoreEncryption: true });
  if (doc.isEncrypted) {
    const err = new Error("chiffre");
    err.code = "chiffre";
    throw err;
  }
  const form = doc.getForm();
  const police = await doc.embedFont(StandardFonts.Helvetica);
  const nettoyer = creerNettoyeur(police);
  const pages = doc.getPages();
  const avertissements = [];

  const pris = new Set(form.getFields().map((f) => f.getName()));
  const groupes = new Map();
  const cases = [];
  const options = (rot) => ({
    textColor: rgb(0, 0, 0),
    backgroundColor: undefined,
    borderColor: undefined,
    borderWidth: 0,
    rotate: degrees(rot),
    font: police,
  });

  const poserInfobulle = (champ, texte) => {
    if (!texte) return;
    try {
      champ.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(texte));
    } catch (e) { /* infobulle facultative */ }
  };

  for (const c of p.champs) {
    const page = pages[c.page];
    const vue = p.vues[c.page];
    if (!page || !vue) continue;
    // Marge intérieure : le widget d'un texte est rentré d'1 pt de chaque côté, et pdf-lib ajoute
    // 1 pt de plus, soit 2 pt entre le trait imprimé et le texte saisi.
    const retrait = c.type === "text" || c.type === "multiline" || c.type === "dropdown" ? 1 : 0;
    const rectPose = retrait && c.w > 8 && c.h > 4
      ? { x: c.x + retrait, y: c.y + (c.type === "multiline" ? retrait : 0), w: c.w - 2 * retrait, h: c.h - (c.type === "multiline" ? 2 * retrait : 0) }
      : c;
    const geo = versPdfLib(rectPose, vue);
    const opt = { ...options(geo.rotation), x: geo.x, y: geo.y, width: geo.width, height: geo.height };
    const valeur = p.remplir ? p.valeurs[c.id] : undefined;
    let cree = null;
    try {
      if (c.type === "text" || c.type === "multiline" || c.type === "comb") {
        const tf = (cree = form.createTextField(nomUnique(nomPdf(c.name), pris)));
        if (c.type === "multiline") tf.enableMultiline();
        if (c.type === "comb") {
          tf.setMaxLength(Math.max(1, c.cells | 0));
          tf.enableCombing();
        }
        tf.addToPage(page, opt);
        tfTaille(tf, c.fontSize);
        poserInfobulle(tf, c.label || c.name);
        if (valeur) {
          let t = nettoyer(valeur, c.type === "multiline");
          if (c.type === "comb") t = t.slice(0, Math.max(1, c.cells | 0));
          if (c.type === "text" && c.fontSize > 0) {
            // Texte trop long pour la taille choisie : on réduit la taille plutôt que de couper.
            const dispo = Math.max(4, geo.width - 4);
            const largeur = police.widthOfTextAtSize(t, c.fontSize);
            if (largeur > dispo) tfTaille(tf, Math.max(5, Math.floor((c.fontSize * dispo / largeur) * 10) / 10));
          }
          tf.setText(t);
        }
      } else if (c.type === "checkbox") {
        const cb = (cree = form.createCheckBox(nomUnique(nomPdf(c.name), pris)));
        cb.addToPage(page, opt);
        cases.push({ champ: cb, rond: false, rotation: geo.rotation });
        poserInfobulle(cb, c.label || c.name);
        if (valeur === true) cb.check();
      } else if (c.type === "radio") {
        const nomGroupe = nomPdf(c.group || c.name);
        let g = groupes.get(nomGroupe);
        if (!g) {
          const rg = form.createRadioGroup(nomUnique(nomGroupe, pris));
          g = { rg, options: new Set() };
          groupes.set(nomGroupe, g);
          cases.push({ champ: rg, rond: true, rotation: geo.rotation });
          poserInfobulle(rg, nomGroupe);
        }
        let option = (nettoyer(c.option || "", false).trim() || "Choix").slice(0, 60);
        const baseOpt = option;
        let i = 2;
        while (g.options.has(option)) option = `${baseOpt} ${i++}`;
        g.options.add(option);
        c._optionFinale = option;
        g.rg.addOptionToPage(option, page, opt);
        if (p.remplir && p.valeurs["radio:" + (c.group || c.name)] === c.option) g.aChoisir = option;
      } else if (c.type === "dropdown") {
        const dd = (cree = form.createDropdown(nomUnique(nomPdf(c.name), pris)));
        const liste = (c.options || []).map((o) => nettoyer(o, false).trim()).filter(Boolean);
        dd.addOptions(liste.length ? liste : [" "]);
        dd.addToPage(page, opt);
        tfTaille(dd, c.fontSize);
        poserInfobulle(dd, c.label || c.name);
        if (valeur) {
          const v = nettoyer(valeur, false).trim();
          if (liste.includes(v)) dd.select(v);
        }
      }
    } catch (e) {
      if (cree && !cree.acroField.getWidgets().length) {
        try { form.removeField(cree); } catch (e2) { /* champ laissé vide */ }
      }
      avertissements.push(`Le champ « ${c.name} » n'a pas pu être écrit (${e.message}).`);
    }
  }
  // Ressources du formulaire : la police citée par les champs doit y figurer pour que
  // Acrobat, Aperçu ou un lecteur mobile puissent redessiner le texte saisi.
  if (p.champs.length) {
    try {
      const acro = form.acroForm.dict;
      let dr = acro.lookupMaybe(PDFName.of("DR"), PDFDict);
      if (!dr) { dr = doc.context.obj({}); acro.set(PDFName.of("DR"), dr); }
      let polices = dr.lookupMaybe(PDFName.of("Font"), PDFDict);
      if (!polices) { polices = doc.context.obj({}); dr.set(PDFName.of("Font"), polices); }
      if (!polices.has(PDFName.of("Helvetica"))) polices.set(PDFName.of("Helvetica"), police.ref);
      if (cases.length && !polices.has(PDFName.of("ZaDb"))) {
        polices.set(PDFName.of("ZaDb"), doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" })));
      }
      if (!acro.has(PDFName.of("DA"))) acro.set(PDFName.of("DA"), PDFString.of("/Helvetica 0 Tf 0 g"));
    } catch (e) { /* ressources facultatives */ }
  }

  for (const g of groupes.values()) {
    if (g.aChoisir) {
      try { g.rg.select(g.aChoisir); } catch (e) { /* option absente */ }
    }
  }

  // Champs d'origine : on les laisse en place, on y écrit seulement les valeurs saisies.
  if (p.remplir) {
    // Un champ d'origine peut avoir plusieurs zones (widgets) : on regroupe par nom.
    const parNom = new Map();
    for (const ex of p.champsExistants || []) {
      if (!parNom.has(ex.name)) parNom.set(ex.name, []);
      parNom.get(ex.name).push(ex);
    }
    for (const [nom, zones] of parNom) {
      const ex = zones[0];
      let valeur;
      if (ex.type === "radio") valeur = p.valeurs["radio:" + nom];
      else if (ex.type === "checkbox") valeur = zones.some((z) => p.valeurs[z.id] === true);
      else valeur = zones.map((z) => p.valeurs[z.id]).find((v) => typeof v === "string" && v !== "") || "";
      if (ex.readOnly) continue;
      try {
        const f = form.getField(ex.name);
        if (f instanceof PDFTextField) {
          let t = nettoyer(valeur, f.isMultiline());
          const max = f.getMaxLength();
          if (max !== undefined && t.length > max) t = t.slice(0, max);
          f.setText(t || undefined);
        } else if (f instanceof PDFCheckBox) {
          if (valeur === true) f.check();
          else f.uncheck();
        } else if (f instanceof PDFRadioGroup) {
          if (valeur && f.getOptions().includes(valeur)) f.select(valeur);
          else if (!valeur) f.clear();
        } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
          if (valeur && f.getOptions().includes(valeur)) f.select(valeur);
          else if (!valeur) f.clear();
        }
      } catch (e) {
        avertissements.push(`Le champ d'origine « ${ex.name} » n'a pas pu être rempli.`);
      }
    }
  }

  try {
    form.updateFieldAppearances(police);
  } catch (e) {
    avertissements.push("Certains champs d'origine gardent leur ancienne apparence.");
  }

  // Cases et boutons radio : apparences maison, sans trait ni fond, avec les deux états.
  for (const { champ, rond, rotation } of cases) {
    try {
      apparenceCase(doc, champ, rond, rotation);
    } catch (e) {
      avertissements.push("Une case à cocher garde l'apparence par défaut.");
    }
  }

  if (p.remplir && p.figer) {
    form.flatten({ updateFieldAppearances: false });
    // Ne laisser aucune référence vers les champs aplatis.
    for (const page of pages) {
      const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) continue;
      const garder = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!obj) continue;
        if (obj instanceof PDFDict && obj.get(PDFName.of("Subtype")) === PDFName.of("Widget")) continue;
        garder.push(ref);
      }
      if (garder.length) page.node.set(PDFName.of("Annots"), doc.context.obj(garder));
      else page.node.delete(PDFName.of("Annots"));
    }
    doc.catalog.delete(PDFName.of("AcroForm"));
  }
  retirerReferencesMortes(doc);
  ramasserObjets(doc);

  const octets = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { octets, remplaces: nettoyer.compte(), avertissements };
}

function tfTaille(champ, taille) {
  try {
    champ.setFontSize(taille > 0 ? taille : 0);
  } catch (e) { /* taille par défaut */ }
}

// Apparence d'une case (coche) ou d'un bouton radio (point), dans le sens de lecture de la page.
// États « coché » et « Off » tous deux présents ; pas de trait ni de fond, le cadre imprimé suffit.
function apparenceCase(doc, champ, rond, rotation) {
  const { PDFName, PDFDict, PDFString } = PDFLib;
  const ctx = doc.context;
  const r = ((rotation % 360) + 360) % 360;
  const matrice = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[r];
  champ.acroField.dict.set(PDFName.of("DA"), PDFString.of("/ZaDb 0 Tf 0 g"));
  for (const w of champ.acroField.getWidgets()) {
    const rect = w.getRectangle();
    const vw = r === 90 || r === 270 ? rect.height : rect.width;
    const vh = r === 90 || r === 270 ? rect.width : rect.height;
    const m = Math.min(vw, vh);
    const f = (n) => n.toFixed(3);
    let dessin;
    if (rond) {
      const cx = vw / 2, cy = vh / 2, ra = m * 0.28, k = ra * 0.5523;
      dessin = `q 0 g ${f(cx + ra)} ${f(cy)} m ${f(cx + ra)} ${f(cy + k)} ${f(cx + k)} ${f(cy + ra)} ${f(cx)} ${f(cy + ra)} c ` +
        `${f(cx - k)} ${f(cy + ra)} ${f(cx - ra)} ${f(cy + k)} ${f(cx - ra)} ${f(cy)} c ` +
        `${f(cx - ra)} ${f(cy - k)} ${f(cx - k)} ${f(cy - ra)} ${f(cx)} ${f(cy - ra)} c ` +
        `${f(cx + k)} ${f(cy - ra)} ${f(cx + ra)} ${f(cy - k)} ${f(cx + ra)} ${f(cy)} c f Q`;
    } else {
      const x0 = (vw - m) / 2, y0 = (vh - m) / 2;
      dessin = `q 0 G ${f(Math.max(0.6, m * 0.12))} w 1 J 1 j ${f(x0 + m * 0.2)} ${f(y0 + m * 0.52)} m ` +
        `${f(x0 + m * 0.42)} ${f(y0 + m * 0.26)} l ${f(x0 + m * 0.8)} ${f(y0 + m * 0.78)} l S Q`;
    }
    const flux = (contenu) => ctx.register(ctx.stream(contenu, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, vw, vh], Matrix: matrice, Resources: {},
    }));
    let nomOn = null;
    try {
      const on = w.getOnValue();
      if (on) nomOn = on;
    } catch (e) { /* pas d'état connu */ }
    if (!nomOn) nomOn = PDFName.of("Yes");
    const ap = ctx.obj({});
    const normal = ctx.obj({});
    normal.set(nomOn, flux(dessin));
    normal.set(PDFName.of("Off"), flux(""));
    ap.set(PDFName.of("N"), normal);
    w.dict.set(PDFName.of("AP"), ap);
    const mk = w.dict.lookupMaybe(PDFName.of("MK"), PDFDict) || ctx.obj({});
    mk.delete(PDFName.of("BG"));
    mk.delete(PDFName.of("BC"));
    mk.set(PDFName.of("CA"), PDFString.of(rond ? "l" : "4"));
    if (r) mk.set(PDFName.of("R"), ctx.obj(r));
    w.dict.set(PDFName.of("MK"), mk);
    const bs = w.getOrCreateBorderStyle();
    bs.setWidth(0);
    const etat = w.getAppearanceState();
    if (!etat || (etat !== PDFName.of("Off") && etat !== nomOn)) w.setAppearanceState(PDFName.of("Off"));
  }
}

// Enlève des tableaux /Annots et /Fields toute référence vers un objet absent.
function retirerReferencesMortes(doc) {
  const { PDFName, PDFArray, PDFRef, PDFDict } = PDFLib;
  const ctx = doc.context;
  const filtrer = (dict, cle) => {
    const tab = dict.lookupMaybe(PDFName.of(cle), PDFArray);
    if (!tab) return;
    const garder = [];
    for (let i = 0; i < tab.size(); i++) {
      const v = tab.get(i);
      if (v instanceof PDFRef && !ctx.lookup(v)) continue;
      garder.push(v);
    }
    if (garder.length !== tab.size()) dict.set(PDFName.of(cle), ctx.obj(garder));
  };
  for (const page of doc.getPages()) filtrer(page.node, "Annots");
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (acro) filtrer(acro, "Fields");
}

// Supprime les objets que plus rien ne référence (champs aplatis, apparences remplacées).
function ramasserObjets(doc) {
  const { PDFRef, PDFDict, PDFArray } = PDFLib;
  const ctx = doc.context;
  const vus = new Set();
  const pile = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (pile.length) {
    const o = pile.pop();
    if (o instanceof PDFRef) {
      if (vus.has(o.tag)) continue;
      vus.add(o.tag);
      const cible = ctx.lookup(o);
      if (cible) pile.push(cible);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) pile.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) pile.push(o.get(i));
    } else if (o && o.dict instanceof PDFDict) {
      pile.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!vus.has(ref.tag)) ctx.delete(ref);
  }
}
