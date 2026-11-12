// Habillage de l'outil : lecture de config.json, valeurs par défaut, application au document.
// Si config.json manque ou contient une erreur, l'outil garde les valeurs par défaut.

export const DEFAUTS = {
  nomOutil: "PDF remplissable",
  nomStructure: "Graph'in",
  logo: "",
  logoTexteAlternatif: "",
  couleurPrincipale: "#00A19A",
  couleurSecondaire: "#1D1D1B",
  couleurClaire: "#9CCAC8",
  couleurAccent: "#E94655",
  policeTitres: "Byington, 'Byington Bold', Georgia, 'Times New Roman', serif",
  fichierPoliceTitres: "",
  policeTexte: "Verdana, Geneva, Tahoma, sans-serif",
  fichierPoliceTexte: "",
  piedDePageTexte: "Un outil Graph'in",
  piedDePageLien: "https://graph-in.fr",
};

const RE_COULEUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RE_POLICE = /^[\p{L}\p{N}\s,'"_-]{1,200}$/u;
const RE_FICHIER_POLICE = /^(?!\/\/)(?![a-z]+:)[\w./ -]{1,200}\.(woff2|woff|ttf|otf)$/i;

function cheminSur(valeur) {
  // Chemin relatif (logo.svg, images/logo.png) ou adresse https. Rien d'autre.
  if (typeof valeur !== "string") return "";
  const v = valeur.trim();
  if (!v) return "";
  if (/^https:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) return "";
  return v;
}

function lienSur(valeur) {
  if (typeof valeur !== "string") return "";
  const v = valeur.trim();
  return /^(https?:\/\/|mailto:)/i.test(v) ? v : "";
}

function texteSur(valeur, max = 120) {
  if (typeof valeur !== "string") return null;
  return valeur.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

export function fusionner(brut) {
  const c = { ...DEFAUTS };
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return c;
  for (const cle of ["nomOutil", "nomStructure", "logoTexteAlternatif", "piedDePageTexte"]) {
    const t = texteSur(brut[cle]);
    if (t !== null) c[cle] = t;
  }
  if (!c.nomOutil) c.nomOutil = DEFAUTS.nomOutil;
  for (const cle of ["couleurPrincipale", "couleurSecondaire", "couleurClaire", "couleurAccent"]) {
    if (typeof brut[cle] === "string" && RE_COULEUR.test(brut[cle].trim())) c[cle] = brut[cle].trim();
  }
  for (const cle of ["policeTitres", "policeTexte"]) {
    if (typeof brut[cle] === "string" && RE_POLICE.test(brut[cle].trim())) c[cle] = brut[cle].trim();
  }
  for (const cle of ["fichierPoliceTitres", "fichierPoliceTexte"]) {
    if (typeof brut[cle] === "string" && RE_FICHIER_POLICE.test(brut[cle].trim())) c[cle] = brut[cle].trim();
    else c[cle] = "";
  }
  if ("logo" in brut) c.logo = cheminSur(brut.logo);
  if ("piedDePageLien" in brut) c.piedDePageLien = lienSur(brut.piedDePageLien);
  return c;
}

export async function chargerConfig() {
  try {
    const rep = await fetch("config.json", { cache: "no-cache" });
    if (!rep.ok) throw new Error("absent");
    const brut = await rep.json();
    return { config: fusionner(brut), source: "config.json" };
  } catch (e) {
    return { config: { ...DEFAUTS }, source: "defauts" };
  }
}

function hexVersRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contraste(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Assombrit une couleur jusqu'à un contraste suffisant sur blanc (texte, liens).
function versionLisible(rgb, cible = 4.5) {
  let [r, g, b] = rgb;
  let i = 0;
  while (contraste([r, g, b], [255, 255, 255]) < cible && i < 40) {
    r *= 0.94; g *= 0.94; b *= 0.94; i++;
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function appliquerConfig(c) {
  const racine = document.documentElement.style;
  const p = hexVersRgb(c.couleurPrincipale);
  const s = hexVersRgb(c.couleurSecondaire);
  const cl = hexVersRgb(c.couleurClaire);
  const a = hexVersRgb(c.couleurAccent);
  racine.setProperty("--principale", c.couleurPrincipale);
  racine.setProperty("--principale-rgb", p.join(","));
  racine.setProperty("--principale-texte", versionLisible(p));
  // Texte posé sur la couleur principale : blanc s'il atteint 4,5:1, sinon la couleur secondaire
  // (pour #00A19A : blanc 3,2:1, #1D1D1B 5,3:1), sinon la plus contrastée des deux.
  const blanc = contraste(p, [255, 255, 255]);
  const fonce = contraste(p, s);
  racine.setProperty("--sur-principale", blanc >= 4.5 ? "#ffffff" : fonce >= 4.5 ? c.couleurSecondaire : blanc >= fonce ? "#ffffff" : c.couleurSecondaire);
  racine.setProperty("--secondaire", c.couleurSecondaire);
  racine.setProperty("--secondaire-rgb", s.join(","));
  racine.setProperty("--claire", c.couleurClaire);
  racine.setProperty("--claire-rgb", cl.join(","));
  racine.setProperty("--accent", c.couleurAccent);
  racine.setProperty("--accent-rgb", a.join(","));

  let titres = c.policeTitres;
  let texte = c.policeTexte;
  let css = "";
  if (c.fichierPoliceTitres) {
    css += `@font-face{font-family:"PoliceTitresClient";src:url("${c.fichierPoliceTitres}");font-display:swap;font-weight:400 800;}`;
    titres = `"PoliceTitresClient", ${titres}`;
  }
  if (c.fichierPoliceTexte) {
    css += `@font-face{font-family:"PoliceTexteClient";src:url("${c.fichierPoliceTexte}");font-display:swap;}`;
    texte = `"PoliceTexteClient", ${texte}`;
  }
  if (css) {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }
  racine.setProperty("--police-titres", titres);
  racine.setProperty("--police-texte", texte);

  document.title = c.nomStructure ? `${c.nomOutil} | ${c.nomStructure}` : c.nomOutil;

  // Icône d'onglet aux couleurs de la structure.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="2" width="22" height="28" rx="3" fill="${c.couleurPrincipale}"/><rect x="9" y="9" width="14" height="4" rx="1" fill="#fff"/><rect x="9" y="16" width="14" height="4" rx="1" fill="#fff"/><rect x="9" y="23" width="5" height="4" rx="1" fill="#fff"/></svg>`;
  let icone = document.querySelector('link[rel="icon"]');
  if (!icone) {
    icone = document.createElement("link");
    icone.rel = "icon";
    document.head.appendChild(icone);
  }
  icone.href = "data:image/svg+xml," + encodeURIComponent(svg);

  // Bandeau : logo ou nom en texte.
  document.querySelectorAll("[data-nom-outil]").forEach((el) => (el.textContent = c.nomOutil));
  const marque = document.getElementById("marque");
  if (marque) {
    marque.textContent = "";
    if (c.logo) {
      const img = document.createElement("img");
      img.src = c.logo;
      img.alt = c.logoTexteAlternatif || c.nomStructure || "";
      img.className = "marque-logo";
      img.addEventListener("error", () => {
        img.remove();
        marque.textContent = c.nomStructure;
      });
      marque.appendChild(img);
    } else {
      marque.textContent = c.nomStructure;
    }
  }
  const pied = document.getElementById("pied-texte");
  if (pied) {
    pied.textContent = "";
    if (c.piedDePageTexte) {
      if (c.piedDePageLien) {
        const lien = document.createElement("a");
        lien.href = c.piedDePageLien;
        lien.textContent = c.piedDePageTexte;
        lien.rel = "noopener";
        pied.appendChild(lien);
      } else {
        pied.textContent = c.piedDePageTexte;
      }
    }
  }
}
