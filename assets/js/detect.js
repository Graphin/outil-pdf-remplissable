// Détection des zones à remplir sur une page PDF.
// Principe : la page est rendue en image (2 pixels par point), puis analysée :
//   1. cadres vides (zones claires fermées, sans texte dedans) : textes, multilignes, cases, peignes ;
//   2. lignes de saisie (traits, soulignés, pointillés) avec de la place au-dessus ;
//   3. peignes ouverts (trait avec petites graduations verticales) ;
//   4. le texte de la page sert à nommer chaque champ et à repérer les groupes de choix.
// Toutes les coordonnées rendues sont en points PDF, origine en haut à gauche de la page affichée.

const S = 2; // pixels par point pour l'analyse

const REGLAGES = {
  1: { seuil: 175, remplissage: 0.975, bords: 0.93, ligneMin: 40, trou: 2.5 },
  2: { seuil: 188, remplissage: 0.96, bords: 0.9, ligneMin: 28, trou: 3 },
  3: { seuil: 200, remplissage: 0.945, bords: 0.86, ligneMin: 20, trou: 3 },
  4: { seuil: 212, remplissage: 0.925, bords: 0.8, ligneMin: 15, trou: 3.5 },
  5: { seuil: 225, remplissage: 0.9, bords: 0.75, ligneMin: 11, trou: 4 },
};

const CARACTERES_CASE = /[☐□❏❐❑❒▢■◻◽⬜]/;
const ADMIN = /r[ée]serv[ée]e?s?\s+(?:à|a)\s+l['’]\s*administration|cadre\s+r[ée]serv|partie\s+r[ée]serv|r[ée]serv[ée]e?\s+au\s+service|ne\s+rien\s+(?:inscrire|[ée]crire)|ne\s+pas\s+(?:remplir|[ée]crire)|usage\s+interne/i;
const MENEUR = /(\.{3,}|…{2,}|_{2,}|-{4,}|(?:\.\s){3,}|[☐□❏❐❑❒▢■◻◽⬜])/g;

const pause = () => new Promise((r) => setTimeout(r, 0));

let ctxMesure = null;
function largeurTexte(t) {
  if (!ctxMesure) {
    ctxMesure = document.createElement("canvas").getContext("2d");
    ctxMesure.font = "100px Helvetica, Arial, sans-serif";
  }
  return ctxMesure.measureText(t).width;
}

// ---------------------------------------------------------------------------
// Texte de la page

export async function extraireTextes(page, vp1) {
  let contenu;
  try {
    contenu = await page.getTextContent();
  } catch (e) {
    return [];
  }
  const segments = [];
  for (const it of contenu.items) {
    if (!it || typeof it.str !== "string" || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const na = Math.hypot(a, b) || 1;
    const nc = Math.hypot(c, d) || na;
    const taille = nc;
    const largeur = it.width || largeurTexte(it.str) * taille / 100;
    const hauteur = it.height || taille;
    const ux = a / na, uy = b / na; // sens de lecture
    const vx = c / nc, vy = d / nc; // vers le haut de la lettre
    const p0 = [e - vx * hauteur * 0.22, f - vy * hauteur * 0.22];
    const coins = [
      p0,
      [p0[0] + ux * largeur, p0[1] + uy * largeur],
      [p0[0] + vx * hauteur * 1.22, p0[1] + vy * hauteur * 1.22],
      [p0[0] + ux * largeur + vx * hauteur * 1.22, p0[1] + uy * largeur + vy * hauteur * 1.22],
    ].map(([x, y]) => vp1.convertToViewportPoint(x, y));
    const xs = coins.map((p) => p[0]), ys = coins.map((p) => p[1]);
    const debut = vp1.convertToViewportPoint(e, f);
    const fin = vp1.convertToViewportPoint(e + ux * largeur, f + uy * largeur);
    const dx = fin[0] - debut[0], dy = fin[1] - debut[1];
    const horizontal = Math.abs(dy) <= Math.abs(dx) * 0.2 + 0.01;
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const tailleAff = horizontal ? by1 - by0 : bx1 - bx0;
    if (!horizontal) {
      segments.push({ x0: bx0, x1: bx1, y0: by0, y1: by1, texte: it.str, taille: tailleAff / 1.22, horizontal: false, meneur: false, cy: (by0 + by1) / 2 });
      continue;
    }
    // Découpe autour des suites de points ou de soulignés, avec une position estimée.
    const str = it.str;
    const total = largeurTexte(str) || 1;
    const sensDroite = dx >= 0;
    const morceaux = [];
    let dernier = 0;
    MENEUR.lastIndex = 0;
    let m;
    while ((m = MENEUR.exec(str))) {
      if (m.index > dernier) morceaux.push([dernier, m.index, false]);
      morceaux.push([m.index, m.index + m[0].length, true]);
      dernier = m.index + m[0].length;
    }
    if (dernier < str.length) morceaux.push([dernier, str.length, false]);
    const lg = bx1 - bx0;
    for (const [i0, i1, estMeneur] of morceaux) {
      const t = str.slice(i0, i1);
      if (!t.trim()) continue;
      const r0 = largeurTexte(str.slice(0, i0)) / total;
      const r1 = largeurTexte(str.slice(0, i1)) / total;
      const x0 = sensDroite ? bx0 + lg * r0 : bx1 - lg * r1;
      const x1 = sensDroite ? bx0 + lg * r1 : bx1 - lg * r0;
      segments.push({ x0, x1, y0: by0, y1: by1, texte: t, taille: tailleAff / 1.22, horizontal: true, meneur: estMeneur, cy: (by0 + by1) / 2 });
    }
  }
  return segments;
}

function construirePhrases(segments) {
  const s = segments.filter((x) => x.horizontal && !x.meneur && x.texte.trim()).sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const phrases = [];
  for (const seg of s) {
    let cible = null;
    for (let i = phrases.length - 1; i >= 0 && i >= phrases.length - 40; i--) {
      const p = phrases[i];
      const t = Math.min(p.taille, seg.taille);
      if (Math.abs(p.cy - seg.cy) < 0.35 * t && seg.x0 - p.x1 < 0.6 * t && seg.x0 - p.x1 > -1.5 * t && seg.x0 > p.x0) {
        cible = p;
        break;
      }
    }
    if (cible) {
      const ecart = seg.x0 - cible.x1;
      cible.texte += (ecart > 0.15 * seg.taille ? " " : "") + seg.texte;
      cible.x1 = Math.max(cible.x1, seg.x1);
      cible.y0 = Math.min(cible.y0, seg.y0);
      cible.y1 = Math.max(cible.y1, seg.y1);
    } else {
      phrases.push({ ...seg });
    }
  }
  for (const p of phrases) {
    p.texte = p.texte.replace(/\s+/g, " ").trim();
    p.cy = (p.y0 + p.y1) / 2;
  }
  return phrases.filter((p) => p.texte);
}

// ---------------------------------------------------------------------------
// Zones claires fermées

function composantes(encre, W, H, R, avecLibelles = true) {
  const etiq = new Int32Array(W * H);
  const pile = new Int32Array(W * H);
  const stats = [null];
  let id = 0;
  const aireMax = 0.35 * W * H;
  for (let depart = 0; depart < W * H; depart++) {
    if (encre[depart] || etiq[depart]) continue;
    id++;
    let n = 0, minx = W, maxx = 0, miny = H, maxy = 0, bord = false;
    let sp = 0;
    pile[sp++] = depart;
    etiq[depart] = id;
    while (sp) {
      const p = pile[--sp];
      const y = (p / W) | 0, x = p - y * W;
      n++;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) bord = true;
      if (x > 0) { const q = p - 1; if (!encre[q] && !etiq[q]) { etiq[q] = id; pile[sp++] = q; } }
      if (x < W - 1) { const q = p + 1; if (!encre[q] && !etiq[q]) { etiq[q] = id; pile[sp++] = q; } }
      if (y > 0) { const q = p - W; if (!encre[q] && !etiq[q]) { etiq[q] = id; pile[sp++] = q; } }
      if (y < H - 1) { const q = p + W; if (!encre[q] && !etiq[q]) { etiq[q] = id; pile[sp++] = q; } }
    }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    if (bord || w < 3.5 * S || h < 3.5 * S || w * h > aireMax || w > 0.97 * W) {
      stats.push(null);
      continue;
    }
    stats.push({ id, n, minx, maxx, miny, maxy, w, h, remplissage: n / (w * h), trous: w * h - n });
  }

  const boites = [];
  for (let i = 1; i < stats.length; i++) {
    const c = stats[i];
    if (!c || c.remplissage < 0.5) continue;
    const wPt0 = c.w / S, hPt0 = c.h / S;
    // Petit rond (bouton radio dessiné) : disque presque parfait.
    if (wPt0 >= 5 && wPt0 <= 14 && hPt0 >= 5 && hPt0 <= 14 && c.w / c.h >= 0.88 && c.w / c.h <= 1.14 && c.remplissage >= 0.68 && c.remplissage <= 0.88) {
      const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2, rx = c.w / 2, ry = c.h / 2;
      let accord = 0;
      for (let y = c.miny; y <= c.maxy; y++) {
        for (let x = c.minx; x <= c.maxx; x++) {
          const dedans = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
          if (dedans === (etiq[y * W + x] === c.id)) accord++;
        }
      }
      if (accord / (c.w * c.h) >= 0.9) {
        boites.push({ ...c, vide: true, rond: true });
        continue;
      }
    }
    // Bords droits : chaque côté de la zone claire doit être presque entièrement couvert.
    // Sur les grands cadres, on ignore les coins (cadres à coins arrondis).
    const grand = wPt0 >= 20 && hPt0 >= 10;
    const mx = grand ? Math.min(12, Math.floor(c.w * 0.25)) : 0;
    const my = grand ? Math.min(12, Math.floor(c.h * 0.3)) : 0;
    let haut = 0, bas = 0, gauche = 0, droite = 0;
    for (let x = c.minx + mx; x <= c.maxx - mx; x++) {
      if (etiq[c.miny * W + x] === c.id) haut++;
      if (etiq[c.maxy * W + x] === c.id) bas++;
    }
    for (let y = c.miny + my; y <= c.maxy - my; y++) {
      if (etiq[y * W + c.minx] === c.id) gauche++;
      if (etiq[y * W + c.maxx] === c.id) droite++;
    }
    const couv = Math.min(haut / (c.w - 2 * mx), bas / (c.w - 2 * mx), gauche / (c.h - 2 * my), droite / (c.h - 2 * my));
    if (couv < R.bords) continue;
    // Vide : presque aucun pixel d'encre à l'intérieur (coins exclus sur les grands cadres).
    let trous = c.w * c.h - c.n;
    if (grand) {
      trous = 0;
      const m = Math.min(mx, my);
      for (let y = c.miny + m; y <= c.maxy - m; y++) {
        for (let x = c.minx + m; x <= c.maxx - m; x++) if (etiq[y * W + x] !== c.id) trous++;
      }
    }
    if (trous <= Math.max(6, 0.002 * c.w * c.h)) {
      // Case vide en coin de tableau (texte à sa droite et en dessous) : ce n'est pas une zone à remplir.
      const droite = voisine(stats, c, "droite"), dessous = voisine(stats, c, "dessous");
      if (droite && dessous && droite.trous > 0.01 * droite.w * droite.h && dessous.trous > 0.01 * dessous.w * dessous.h) continue;
      boites.push({ ...c, vide: true });
      continue;
    }
    if (!avecLibelles) continue;
    // Cadre avec un libellé dedans : on garde la partie libre si le libellé est à gauche ou en haut.
    const wPt = c.w / S, hPt = c.h / S;
    if (wPt < 40 || hPt < 9) {
      // Petite case : on tolère un léger défaut de tracé, pas du texte.
      if (c.remplissage >= R.remplissage && wPt <= 16 && hPt <= 16) boites.push({ ...c, vide: true });
      continue;
    }
    let xf = -1, xl = -1;
    for (let x = c.minx; x <= c.maxx; x++) {
      let occ = false;
      for (let y = c.miny; y <= c.maxy; y++) {
        if (etiq[y * W + x] !== c.id) { occ = true; break; }
      }
      if (occ) { if (xf < 0) xf = x; xl = x; }
    }
    if (xf < 0) continue;
    let yf = -1, yl = -1;
    for (let y = c.miny; y <= c.maxy; y++) {
      let occ = false;
      for (let x = c.minx; x <= c.maxx; x++) {
        if (etiq[y * W + x] !== c.id) { occ = true; break; }
      }
      if (occ) { if (yf < 0) yf = y; yl = y; }
    }
    const libelleHaut = hPt >= 22 && yf - c.miny <= 0.3 * c.h && c.maxy - yl >= 0.5 * c.h;
    const libelleGauche = xf - c.minx <= 0.25 * c.w && c.maxx - xl >= 0.45 * c.w;
    if (libelleHaut && (hPt >= 26 || !libelleGauche)) {
      const y0 = yl + 2 * S;
      boites.push({ ...c, vide: false, partiel: "haut", miny: y0, h: c.maxy - y0 + 1, cadre: { ...c } });
    } else if (libelleGauche && !voisine(stats, c, "droite")) {
      const x0 = xl + 3 * S;
      boites.push({ ...c, vide: false, partiel: "gauche", minx: x0, w: c.maxx - x0 + 1, cadre: { ...c } });
    }
  }
  return boites;
}

// Cellule voisine collée (à droite, même hauteur ; ou dessous, même largeur).
// Une case avec un libellé et une cellule collée à sa droite est un libellé de tableau.
function voisine(stats, c, sens) {
  for (let i = 1; i < stats.length; i++) {
    const d = stats[i];
    if (!d || d.id === c.id) continue;
    if (sens === "droite") {
      if (d.minx > c.maxx && d.minx - c.maxx <= 3 * S && Math.abs(d.miny - c.miny) <= 3 && Math.abs(d.maxy - c.maxy) <= 3) return d;
    } else if (d.miny > c.maxy && d.miny - c.maxy <= 3 * S && Math.abs(d.minx - c.minx) <= 3 && Math.abs(d.maxx - c.maxx) <= 3) return d;
  }
  return null;
}

function recouvrementPx(a, b) {
  const ix = Math.max(0, Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx));
  const iy = Math.max(0, Math.min(a.maxy, b.maxy) - Math.max(a.miny, b.miny));
  return (ix * iy) / (Math.min(a.w * a.h, b.w * b.h) || 1);
}

// ---------------------------------------------------------------------------
// Lignes de saisie

function lignes(encre, W, H, R) {
  const G = Math.round(R.trou * S);
  const minLen = Math.round(R.ligneMin * S);
  let actives = [];
  const finies = [];
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const runs = [];
    let x = 0;
    while (x < W) {
      if (!encre[row + x]) { x++; continue; }
      const debut = x;
      let fin = x;
      let k = x + 1;
      while (k < W && k - fin <= G) {
        if (encre[row + k]) fin = k;
        k++;
      }
      if (fin - debut + 1 >= minLen) runs.push([debut, fin]);
      x = k;
    }
    const suivantes = [];
    const prises = new Set();
    for (const [a, b] of runs) {
      let lien = null;
      for (const l of actives) {
        if (prises.has(l)) continue;
        const rec = Math.min(b, l.x1) - Math.max(a, l.x0);
        if (rec >= 0.7 * Math.max(b - a, l.x1 - l.x0)) { lien = l; break; }
      }
      if (lien) {
        prises.add(lien);
        lien.x0 = Math.min(lien.x0, a);
        lien.x1 = Math.max(lien.x1, b);
        lien.y1 = y;
        suivantes.push(lien);
      } else {
        suivantes.push({ x0: a, x1: b, y0: y, y1: y });
      }
    }
    for (const l of actives) if (!prises.has(l)) finies.push(l);
    actives = suivantes;
  }
  finies.push(...actives);
  return finies.filter((l) => l.y1 - l.y0 + 1 <= 3 * S);
}

// Côté vertical (plein ou en tirets) qui part de la ligne, vers le haut (sens -1) ou le bas (sens 1).
function coteTirete(encre, W, H, x, yDepart, sens) {
  let n = 0, tot = 0;
  for (let k = 0; k < 6 * S; k++) {
    const y = yDepart + k * sens;
    if (y < 0 || y >= H) break;
    tot++;
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < W && encre[y * W + xx]) { n++; break; }
    }
  }
  return tot >= 4 * S && n / tot >= 0.4;
}

// Remonte le long du côté gauche jusqu'au bord haut ; vérifie le côté droit et le bord haut.
function hautDeCadre(encre, W, L) {
  const encreAutour = (x, y) => {
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < W && encre[y * W + xx]) return true;
    }
    return false;
  };
  let y = L.y0 - 1, dernier = y, trou = 0;
  while (y > 0 && trou <= 8) {
    if (encreAutour(L.x0, y)) { dernier = y; trou = 0; } else trou++;
    y--;
  }
  const h = L.y0 - dernier;
  if (h < 10 * S) return null;
  // Côté droit présent sur la même hauteur (au moins 40 % d'encre, tirets compris).
  let d = 0;
  for (let yy = dernier; yy < L.y0; yy++) if (encreAutour(L.x1, yy)) d++;
  if (d / h < 0.4) return null;
  // Bord haut : de l'encre sur la plupart des colonnes, à 2 pixels près.
  let couvert = 0;
  for (let x = L.x0; x <= L.x1; x++) {
    let ok = false;
    for (let yy = dernier - 2; yy <= dernier + 2 && !ok; yy++) if (yy >= 0 && encre[yy * W + x]) ok = true;
    if (ok) couvert++;
  }
  if (couvert / (L.x1 - L.x0 + 1) < 0.45) return null;
  // L'intérieur d'un cadre est clair : une bande sombre (bandeau, titre en réserve) n'en est pas un.
  let encreDedans = 0, total = 0;
  for (let yy = dernier + 3; yy < L.y0 - 3; yy += 2) {
    for (let x = L.x0 + 3; x < L.x1 - 3; x += 2) { total++; if (encre[yy * W + x]) encreDedans++; }
  }
  return total && encreDedans / total < 0.15 ? dernier : null;
}

function colonneEncre(encre, W, x, y0, y1) {
  for (let y = Math.max(0, y0); y <= y1; y++) if (encre[y * W + x]) return true;
  return false;
}

function longueurVerticale(encre, W, H, x, yDepart, sens) {
  let n = 0, y = yDepart, trous = 0;
  while (y >= 0 && y < H) {
    if (encre[y * W + x]) { n += 1 + trous; trous = 0; }
    else if (++trous > 1) break;
    y += sens;
  }
  return n;
}

function traits(encre, W, H, x0, x1, yRef, sens, minPx) {
  // Traits verticaux accrochés à la ligne (vers le haut si sens = -1, vers le bas si sens = 1).
  const res = [];
  let cur = null;
  for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) {
    const L = longueurVerticale(encre, W, H, x, yRef, sens);
    if (L >= minPx) {
      if (cur && x === cur.xb + 1) { cur.xb = x; cur.len = Math.max(cur.len, L); }
      else { cur = { xa: x, xb: x, len: L }; res.push(cur); }
    } else cur = null;
  }
  return res.map((t) => ({ ...t, xc: (t.xa + t.xb) / 2, larg: t.xb - t.xa + 1 }));
}

// ---------------------------------------------------------------------------

function rectPt(o) {
  return { x: o.minx / S, y: o.miny / S, w: o.w / S, h: o.h / S };
}

function recouvrement(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const plusPetit = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / plusPetit;
}

function centreDans(a, b, marge = 0) {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  return cx >= b.x - marge && cx <= b.x + b.w + marge && cy >= b.y - marge && cy <= b.y + b.h + marge;
}

export function nettoyerLibelle(t) {
  if (!t) return "";
  const net = t
    .replace(/[._…]{2,}/g, " ")
    .replace(new RegExp(CARACTERES_CASE.source, "g"), " ")
    .replace(/\(\s*\*\s*\)/g, " ")
    .replace(/^\s*(?:[-–•*]|\d+[.)]\s)\s*/, "")
    .replace(/^[\s,;:.]+/, "")
    .replace(/\s*[:*]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim()
    // Numéro de rubrique devant un titre en capitales (« 5 OBSERVATIONS »).
    .replace(/^\d{1,2}\s+(?=\p{Lu}{2})/u, "");
  // Titre tout en capitales : on le remet en minuscules, sauf la première lettre.
  const lettres = net.replace(/[^\p{L}]/gu, "");
  if (lettres.length >= 4 && lettres === lettres.toUpperCase() && lettres !== lettres.toLowerCase()) {
    return net.charAt(0) + net.slice(1).toLowerCase();
  }
  return net;
}

function tailleTexte(h) {
  return Math.max(6, Math.min(11, Math.round(h * 0.62)));
}

// ---------------------------------------------------------------------------

export async function analyserPage(page, lib, options = {}) {
  const R = REGLAGES[options.sensibilite || 3] || REGLAGES[3];
  const existants = options.zonesExistantes || [];
  const vp = page.getViewport({ scale: S });
  const vp1 = page.getViewport({ scale: 1 });
  const W = Math.floor(vp.width), H = Math.floor(vp.height);
  const pageW = vp1.width, pageH = vp1.height;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport: vp,
    annotationMode: lib.AnnotationMode.ENABLE_FORMS,
    background: "rgb(255,255,255)",
  }).promise;
  const px = ctx.getImageData(0, 0, W, H).data;
  canvas.width = canvas.height = 1;
  const lum = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    lum[i] = (299 * px[j] + 587 * px[j + 1] + 114 * px[j + 2]) / 1000;
  }
  const encre = new Uint8Array(W * H);
  for (let i = 0; i < lum.length; i++) encre[i] = lum[i] < R.seuil ? 1 : 0;
  await pause();

  const segments = await extraireTextes(page, vp1);
  const phrases = construirePhrases(segments);
  const segTexte = segments.filter((s) => !s.meneur);
  await pause();

  // 1. Cadres, en trois passes :
  //    a. zones claires entourées de traits ;
  //    b. zones blanches posées sur un fond teinté (encadré grisé de cerfa) ;
  //    c. zones teintées sans bordure posées sur fond blanc (vides seulement).
  const boites = composantes(encre, W, H, R);
  await pause();
  const masque = new Uint8Array(W * H);
  for (let i = 0; i < lum.length; i++) masque[i] = lum[i] < 248 ? 1 : 0;
  const passeB = composantes(masque, W, H, R);
  await pause();
  for (let i = 0; i < lum.length; i++) masque[i] = lum[i] < R.seuil || lum[i] >= 248 ? 1 : 0;
  const passeC = composantes(masque, W, H, R, false);
  for (const b of [...passeB, ...passeC]) {
    if (!boites.some((a) => recouvrementPx(a, b) > 0.5 && (a.vide || !b.vide))) boites.push(b);
  }
  // Bandeau teinté avec un titre à gauche (rubrique) : pas une zone à remplir. Une zone de saisie
  // avec libellé dedans est blanche.
  for (let i = boites.length - 1; i >= 0; i--) {
    const b = boites[i];
    if (b.vide) continue;
    let somme = 0, n = 0;
    for (let y = b.miny; y <= b.maxy; y += 2) for (let x = b.minx; x <= b.maxx; x += 2) { somme += lum[y * W + x]; n++; }
    if (n && somme / n < 235) boites.splice(i, 1);
  }
  // Un cadre « avec libellé » qui contient d'autres cadres est un encadré de section, pas un champ.
  for (let i = boites.length - 1; i >= 0; i--) {
    const p = boites[i];
    if (p.vide) continue;
    const c = p.cadre;
    const contient = boites.some((q) => q !== p && q.vide && (q.minx + q.maxx) / 2 > c.minx && (q.minx + q.maxx) / 2 < c.maxx && (q.miny + q.maxy) / 2 > c.miny && (q.miny + q.maxy) / 2 < c.maxy);
    if (contient) boites.splice(i, 1);
  }
  await pause();

  const libres = [];
  for (const b of boites) {
    const r = rectPt(b);
    // Intérieur d'une lettre (o, e, a...) : on l'écarte, sauf caractère « case ».
    if (r.w <= 16 && r.h <= 16) {
      const dansTexte = segTexte.find((s) => r.x >= s.x0 - 0.5 && r.x + r.w <= s.x1 + 0.5 && r.y >= s.y0 - 1 && r.y + r.h <= s.y1 + 1);
      if (dansTexte && !CARACTERES_CASE.test(dansTexte.texte)) continue;
    }
    libres.push({ ...b, r });
  }
  // Cellule d'en-tête de tableau : un cadre avec texte au-dessus d'une cellule vide de même largeur.
  const vides = libres.filter((b) => b.vide);
  const retenues = libres.filter((b) => {
    // Zone déjà couverte par un champ d'origine du PDF : on n'y pose rien.
    if (existants.some((z) => recouvrement(b.r, z) > 0.3 || centreDans(b.r, z))) return false;
    if (b.vide) return true;
    const c = b.cadre;
    return !vides.some((v) => Math.abs(v.minx - c.minx) <= 4 && Math.abs(v.maxx - c.maxx) <= 4 && v.miny > c.maxy && v.miny - c.maxy <= 5 * S);
  });

  const champs = [];
  const utilises = new Set();

  // Peignes : suite de petites cases de même taille, alignées et jointives.
  const petites = retenues
    .filter((b) => b.vide && b.r.w <= 24 && b.r.h >= 6 && b.r.h <= 30 && b.r.w / b.r.h >= 0.35 && b.r.w / b.r.h <= 1.6)
    .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
  for (const b of petites) {
    if (utilises.has(b)) continue;
    const chaine = [b];
    let cur = b;
    for (;;) {
      const suivante = petites.find((d) => {
        if (utilises.has(d) || chaine.includes(d)) return false;
        const ecart = d.r.x - (cur.r.x + cur.r.w);
        return (
          Math.abs(d.r.y - cur.r.y) <= 1.5 &&
          Math.abs(d.r.h - cur.r.h) <= 1.5 &&
          Math.abs(d.r.w - b.r.w) <= 0.3 * b.r.w &&
          ecart >= -0.5 &&
          ecart <= Math.max(3, 0.3 * cur.r.w)
        );
      });
      if (!suivante) break;
      chaine.push(suivante);
      cur = suivante;
    }
    if (chaine.length < 2) continue;
    if (chaine.length === 2) {
      const ec = chaine[1].r.x - (chaine[0].r.x + chaine[0].r.w);
      if (chaine[0].r.h < 9 || ec > 2.5) continue;
    }
    chaine.forEach((c) => utilises.add(c));
    const ecarts = [];
    for (let i = 1; i < chaine.length; i++) ecarts.push(chaine[i].r.x - (chaine[i - 1].r.x + chaine[i - 1].r.w));
    ecarts.sort((a, c) => a - c);
    const g = ecarts[Math.floor(ecarts.length / 2)];
    const prem = chaine[0].r, der = chaine[chaine.length - 1].r;
    const x = prem.x - g / 2;
    const y = Math.min(...chaine.map((c) => c.r.y));
    const h = Math.max(...chaine.map((c) => c.r.y + c.r.h)) - y;
    const w = der.x + der.w + g / 2 - x;
    const cellW = w / chaine.length;
    champs.push({
      type: "comb", x, y, w, h, cells: chaine.length,
      fontSize: Math.max(6, Math.min(14, Math.round(Math.min(h * 0.7, cellW * 1.05)))),
      priorite: 5,
    });
  }

  // Case seule collée à un peigne, de même hauteur et de même largeur de case : peigne d'une case.
  let ajout = true;
  while (ajout) {
    ajout = false;
    for (const b of petites) {
      if (utilises.has(b)) continue;
      const voisin = champs.find((c) => {
        if (c.type !== "comb") return false;
        const cellW = c.w / c.cells;
        const ecart = b.r.x > c.x ? b.r.x - (c.x + c.w) : c.x - (b.r.x + b.r.w);
        return Math.abs(c.y - b.r.y) <= 2 && Math.abs(c.h - b.r.h) <= 2 && ecart >= -0.5 && ecart <= Math.max(8, 0.8 * cellW) && Math.abs(cellW - b.r.w) <= 0.4 * cellW;
      });
      if (!voisin) continue;
      utilises.add(b);
      ajout = true;
      const g = 0.6;
      champs.push({
        type: "comb", x: b.r.x - g / 2, y: b.r.y, w: b.r.w + g, h: b.r.h, cells: 1,
        fontSize: voisin.fontSize, priorite: 5,
      });
    }
  }

  for (const b of retenues) {
    if (utilises.has(b)) continue;
    const { x, y, w, h } = b.r;
    const ratio = w / h;
    if (b.vide && w >= 3.5 && h >= 3.5 && w <= 16 && h <= 16 && ratio >= 0.75 && ratio <= 1.33) {
      champs.push({ type: "checkbox", x, y, w, h, fontSize: 0, priorite: 4, rond: Boolean(b.rond) });
      continue;
    }
    if (h < 7 || w < 14) continue;
    const multi = h >= 30 && w >= 60;
    champs.push({
      type: multi ? "multiline" : "text", x, y, w, h,
      fontSize: multi ? 10 : tailleTexte(h),
      priorite: b.vide ? 3 : 2,
    });
  }

  await pause();

  // 2. Lignes
  const candidats = lignes(encre, W, H, R);
  const cadresTires = [];
  const boitesPx = libres.map((b) => b.cadre || b);
  const champsLignes = [];
  for (const L of candidats) {
    const longueur = L.x1 - L.x0 + 1;
    // Bord d'un cadre déjà vu ?
    const bordDeCadre = boitesPx.some((b) => {
      const rec = Math.min(L.x1, b.maxx) - Math.max(L.x0, b.minx);
      if (rec < 0.5 * Math.min(longueur, b.w)) return false;
      return (L.y1 >= b.miny - 4 * S && L.y1 <= b.miny + 1) || (L.y0 >= b.maxy - 1 && L.y0 <= b.maxy + 4 * S);
    });
    if (bordDeCadre) continue;

    // Bas d'un cadre en tirets : des côtés tiretés montent aux deux bouts jusqu'à un bord haut
    // de même largeur. Le cadre est mis de côté et traité plus loin.
    if (longueur >= 30 * S && coteTirete(encre, W, H, L.x0, L.y0 - 1, -1) && coteTirete(encre, W, H, L.x1, L.y0 - 1, -1)) {
      const haut = hautDeCadre(encre, W, L);
      if (haut !== null) {
        cadresTires.push({ x: L.x0 / S, y: haut / S, w: (L.x1 - L.x0) / S, h: (L.y0 - haut) / S });
        continue;
      }
    }

    // Un vrai trait a du blanc juste en dessous ; le haut d'une ligne de texte, non.
    let dessousL = 0;
    for (let x = L.x0; x <= L.x1; x++) if (colonneEncre(encre, W, x, L.y1 + 2, Math.min(H - 1, L.y1 + Math.round(2 * S)))) dessousL++;
    if (dessousL > 0.25 * longueur) continue;

    const bas = traits(encre, W, H, L.x0, L.x1, L.y1 + 1, 1, 4 * S);
    if (bas.length) continue; // trait de tableau ou de cadre
    // Haut d'un cadre en tirets : des côtés tiretés descendent aux deux bouts.
    if (coteTirete(encre, W, H, L.x0, L.y1 + 1, 1) && coteTirete(encre, W, H, L.x1, L.y1 + 1, 1)) continue;

    const haut = traits(encre, W, H, L.x0, L.x1, L.y0 - 1, -1, 2 * S);
    const fins = haut.filter((t) => t.larg <= 2.5 * S && t.len <= 16 * S);
    if (fins.length >= 4 && fins.length === haut.length) {
      // Peigne ouvert |_|_|_|
      const pas = [];
      for (let i = 1; i < fins.length; i++) pas.push(fins[i].xc - fins[i - 1].xc);
      const moy = pas.reduce((s, v) => s + v, 0) / pas.length;
      const regulier = pas.every((p) => Math.abs(p - moy) <= 0.2 * moy);
      const auxBouts = Math.abs(fins[0].xc - L.x0) <= 3 * S && Math.abs(fins[fins.length - 1].xc - L.x1) <= 3 * S;
      if (regulier && auxBouts && moy >= 5 * S && moy <= 30 * S) {
        const tick = Math.max(...fins.map((t) => t.len)) / S;
        const pasPt = moy / S;
        const h = Math.min(20, Math.max(tick, pasPt * 1.25));
        const x = fins[0].xc / S, x1 = fins[fins.length - 1].xc / S;
        const cells = fins.length - 1;
        champsLignes.push({
          type: "comb", x, y: L.y0 / S - h, w: x1 - x, h, cells,
          fontSize: Math.max(6, Math.min(14, Math.round(Math.min(h * 0.7, pasPt * 1.05)))),
          priorite: 5,
        });
        continue;
      }
    }
    const montants = haut.filter((t) => t.len >= 6 * S);
    if (montants.length >= 2 && montants.some((t) => Math.abs(t.xc - L.x0) <= 3 * S) && montants.some((t) => Math.abs(t.xc - L.x1) <= 3 * S)) continue;

    // Découpe là où du texte touche la ligne par-dessus (« le », « à »...).
    // On laisse 3 pixels au-dessus de la ligne : le haut des points de suspension y déborde.
    const bande0 = L.y0 - Math.round(4 * S), bande1 = L.y0 - 3;
    let debut = -1;
    const morceaux = [];
    for (let x = L.x0; x <= L.x1 + 1; x++) {
      const bloque = x > L.x1 || colonneEncre(encre, W, x, bande0, bande1);
      if (!bloque && debut < 0) debut = x;
      if (bloque && debut >= 0) {
        morceaux.push([debut, x - 1]);
        debut = -1;
      }
    }
    for (let [a, b] of morceaux) {
      // Recaler sur l'encre réelle de la ligne.
      while (a < b && !colonneEncre(encre, W, a, L.y0, L.y1)) a++;
      while (b > a && !colonneEncre(encre, W, b, L.y0, L.y1)) b--;
      if (b - a + 1 < R.ligneMin * S) continue;
      // Un vrai trait a du blanc juste en dessous ; le haut ou le bas d'une ligne de texte, non.
      let dessous = 0;
      const yb0 = L.y1 + 2, yb1 = Math.min(H - 1, L.y1 + Math.round(2 * S));
      for (let x = a; x <= b; x++) if (colonneEncre(encre, W, x, yb0, yb1)) dessous++;
      if (dessous > 0.12 * (b - a + 1)) continue;
      let plein = 0;
      for (let x = a; x <= b; x++) if (colonneEncre(encre, W, x, L.y0, L.y1)) plein++;
      // Place libre au-dessus.
      let libre = 2;
      const seuilLigne = Math.max(2, 0.02 * (b - a));
      for (let y = L.y0 - 3; y >= Math.max(0, L.y0 - 22 * S); y--) {
        let n = 0;
        for (let x = a; x <= b; x++) if (encre[y * W + x]) n++;
        if (n > seuilLigne) break;
        libre++;
      }
      if (libre < 6 * S) continue;
      // Hauteur et position calées pour que le texte saisi repose juste au-dessus du trait.
      const h = Math.min(libre / S - 1, 14);
      const taille = Math.max(6, Math.min(10, Math.round((h - 2) / 0.9)));
      const decalage = Math.max(0, (h - 0.72 * taille) / 2 - 2);
      const x = a / S, w = (b - a + 1) / S;
      champsLignes.push({
        type: "text", x, y: L.y0 / S - h + decalage, w, h, fontSize: taille, priorite: 1,
        ligne: { plein: plein / (b - a + 1), x0: x, x1: x + w, y: L.y0 / S },
      });
    }
  }

  // Les champs posés sur une ligne ne doivent pas doubler un cadre ou une zone existante.
  for (const c of champsLignes) {
    if (existants.some((z) => recouvrement(c, z) > 0.3)) continue;
    if (champs.some((d) => recouvrement(c, d) > 0.3)) continue;
    champs.push(c);
  }

  // Cadres en tirets : vides, ils deviennent un champ ; s'ils contiennent du texte, on n'y touche pas.
  for (const z of cadresTires) {
    const texteDedans = phrases.some((p) => (p.x0 + p.x1) / 2 > z.x && (p.x0 + p.x1) / 2 < z.x + z.w && p.cy > z.y && p.cy < z.y + z.h);
    if (texteDedans) continue;
    const r = { x: z.x + 1.5, y: z.y + 1.5, w: z.w - 3, h: z.h - 3 };
    if (r.h < 7 || r.w < 14) continue;
    if (existants.some((e) => recouvrement(r, e) > 0.3) || champs.some((d) => recouvrement(r, d) > 0.3)) continue;
    const multi = r.h >= 30 && r.w >= 60;
    champs.push({ type: multi ? "multiline" : "text", ...r, fontSize: multi ? 10 : tailleTexte(r.h), priorite: 2 });
  }

  // Zones réservées à l'administration : aucun champ dedans.
  const zonesCadres = [...libres.map((b) => rectPt(b.cadre || b)), ...cadresTires];
  const reservees = zonesCadres.filter((z) => phrases.some((p) => {
    if (!ADMIN.test(p.texte)) return false;
    const cx = (p.x0 + p.x1) / 2;
    const dedans = cx > z.x && cx < z.x + z.w && p.cy > z.y && p.cy < z.y + z.h;
    const juste = p.y1 <= z.y + 2 && z.y - p.y1 <= 16 && p.x1 > z.x && p.x0 < z.x + z.w;
    return dedans || juste;
  }));
  for (let i = champs.length - 1; i >= 0; i--) {
    if (reservees.some((z) => centreDans(champs[i], z, -1))) champs.splice(i, 1);
  }

  // Cellule vide d'une ligne d'en-tête (coin haut gauche d'une grille) : les autres cellules de la
  // ligne portent toutes un intitulé court et aucun autre champ n'est sur la ligne.
  for (let i = champs.length - 1; i >= 0; i--) {
    const f = champs[i];
    if (f.type !== "text" || f.priorite !== 3) continue;
    const dansLaBande = (cy) => cy > f.y && cy < f.y + f.h;
    const intitules = phrases.filter((p) => dansLaBande(p.cy) && p.x0 >= f.x + f.w - 2 && p.texte.length <= 25 && SIGNIFIANT.test(p.texte));
    if (intitules.length < 2) continue;
    if (champs.some((g) => g !== f && dansLaBande(g.y + g.h / 2))) continue;
    champs.splice(i, 1);
  }

  // Dédoublonnage final par priorité.
  champs.sort((a, b) => b.priorite - a.priorite);
  const finaux = [];
  for (const c of champs) {
    if (finaux.some((d) => recouvrement(c, d) > 0.5)) continue;
    finaux.push(c);
  }

  // 3. Noms, séparateurs, groupes de choix
  const resultat = nommer(finaux, phrases, pageW);
  return { champs: resultat, phrases };
}

// ---------------------------------------------------------------------------
// Libellés

const SIGNIFIANT = /[\p{L}\p{N}]/u;
const MENTION_LEGALE = /\bloi\s+n|rgpd|informatique\s+et\s+(?:aux\s+)?libert|donn[ée]es\s+personnelles|\barticle\s+[lr]\.?\s*\d/i;

// Un texte peut servir de libellé : il a des lettres, il est court et ce n'est pas une mention légale.
function utilisable(p, o = {}) {
  if (!SIGNIFIANT.test(p.texte)) return false;
  if (p.texte.length > (o.max || 70) || MENTION_LEGALE.test(p.texte)) return false;
  if (o.exclues && o.exclues.has(p)) return false;
  return true;
}

// Un autre champ s'intercale-t-il entre le texte et le champ, sur la même ligne ?
function champEntre(p, f, champs) {
  if (!champs) return false;
  return champs.some((g) => g !== f && g.y < f.y + f.h && g.y + g.h > f.y && g.x >= p.x1 - 1 && g.x + g.w <= f.x + 1);
}

// Gouttière de colonnes : texte lointain alors que d'autres lignes commencent pile au bord du champ.
function gouttiere(p, f, phrases) {
  if (f.x - p.x1 <= 60) return false;
  return phrases.filter((q) => q !== p && Math.abs(q.x0 - f.x) <= 12 && Math.abs(q.cy - f.y) <= 200).length >= 2;
}

// Texte juste au-dessus du champ, bord gauche aligné à 10 pt près, sans autre champ entre les deux.
function libelleAligne(f, phrases, o = {}) {
  let best = null, bestD = Infinity;
  for (const p of phrases) {
    if (!utilisable(p, o)) continue;
    if (p.y1 > f.y + 2 || Math.abs(p.x0 - f.x) > 10) continue;
    const d = f.y - p.y1;
    if (d > 16 || d >= bestD) continue;
    if (o.champs && o.champs.some((g) => g !== f && g.y >= p.y1 - 1 && g.y + g.h <= f.y + 1 && g.x < f.x + f.w && g.x + g.w > f.x)) continue;
    best = p;
    bestD = d;
  }
  return best;
}

function libelleGauche(f, phrases, portee = 170, o = {}) {
  let best = null;
  for (const p of phrases) {
    if (!utilisable(p, o)) continue;
    if (p.x1 > f.x + 3) continue;
    if (f.x - p.x1 > portee) continue;
    if (champEntre(p, f, o.champs) || gouttiere(p, f, phrases)) continue;
    const bas = f.y + f.h;
    const okVertical = f.h > 26 ? p.cy >= f.y - 2 && p.cy <= f.y + Math.min(f.h, 20) : p.cy >= f.y - 3 && p.cy <= bas + 4;
    if (!okVertical) continue;
    if (!best || p.x1 > best.x1) best = p;
  }
  return best;
}

function libelleDessus(f, phrases, portee = 22, o = {}) {
  let best = null, bestD = Infinity;
  for (const p of phrases) {
    if (!utilisable(p, o)) continue;
    if (p.y1 > f.y + 2) continue;
    const d = f.y - p.y1;
    if (d > portee) continue;
    const recouvre = Math.min(p.x1, f.x + f.w) - Math.max(p.x0, f.x) > 0;
    const prochGauche = Math.abs(p.x0 - f.x) <= 30;
    if (!recouvre && !prochGauche) continue;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function enTeteColonne(f, phrases, portee = 260) {
  let best = null, bestD = Infinity;
  const cx = f.x + f.w / 2;
  for (const p of phrases) {
    if (!utilisable(p)) continue;
    if (p.y1 > f.y + 1) continue;
    const d = f.y - p.y1;
    if (d > portee) continue;
    const pcx = (p.x0 + p.x1) / 2;
    const dedans = pcx >= f.x - 2 && pcx <= f.x + f.w + 2;
    const tolerance = f.type === "checkbox" ? Math.abs(pcx - cx) <= Math.max(6, f.w) : dedans;
    if (!tolerance) continue;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function libelleDroite(f, phrases, portee = 30) {
  let best = null;
  const cy = f.y + f.h / 2;
  for (const p of phrases) {
    if (p.x0 < f.x + f.w - 1) continue;
    if (p.x0 - (f.x + f.w) > portee) continue;
    if (Math.abs(p.cy - cy) > Math.max(4, f.h * 0.7)) continue;
    if (!best || p.x0 < best.x0) best = p;
  }
  return best;
}

// Nom d'une question ou d'un titre : sans numéro de rubrique ni « (une seule réponse) ».
function nettoyerQuestion(t) {
  return nettoyerLibelle(
    (t || "")
      .replace(/\(\s*(?:une seule r[ée]ponse|un seul choix|plusieurs r[ée]ponses possibles?|facultatif)\s*\)/gi, " ")
      .replace(/^\s*\d{1,2}\s*[.)-]?\s+(?=\p{L})/u, "")
  ).replace(/\s*[?:]\s*$/, "").trim();
}

const UNE_SEULE = /une\s+seule\s+(?:r[ée]ponse|case|possibilit[ée])|un\s+seul\s+choix|cochez\s+une\s+(?:seule\s+)?case|une\s+r[ée]ponse\s+par\s+ligne/i;
const PLUSIEURS = /plusieurs\s+(?:r[ée]ponses|choix|cases)|cochez\s+(?:toutes|les\s+cases)|choix\s+multiples?|toutes\s+les\s+(?:cases|r[ée]ponses)\s+qui/i;
const LISTE_PIECES = /pi[èe]ces?|documents?|justificatifs?|joint|annexes?/i;
const EXCLUSIFS = /^(?:madame|monsieur|mademoiselle|mme|m\.?|mlle|homme|femme|oui|non|ne sait pas|nsp|sans avis|sans opinion)$/i;
const ECHELLE = /jamais|parfois|souvent|toujours|rarement|pas du tout|\bpeu\b|assez|tr[èe]s|tout [àa] fait|plut[ôo]t|d['’]accord|satisfait|insatisfait|mauvais|moyen|\bbon\b|excellent|faible|[ée]lev[ée]|\bnul\b/i;

function nommer(champs, phrases, pageW) {
  const res = [];
  // D'abord les cases : leurs libellés d'option ne doivent servir de libellé à rien d'autre.
  const phrasesOptions = new Set();
  for (const f of champs) {
    if (f.type !== "checkbox") continue;
    let d = libelleDroite(f, phrases);
    const g = libelleGauche(f, phrases, 30, { max: 120 });
    // Libellé collé à gauche (« Oui ☐ Non ☐ ») plus proche que celui de droite : on le prend.
    if (g && g.texte.length <= 40 && (!d || f.x - g.x1 < d.x0 - (f.x + f.w))) d = g;
    const col = enTeteColonne(f, phrases);
    let optionLib = "";
    if (d && d.texte.length <= 90) { optionLib = d.texte; phrasesOptions.add(d); }
    else if (col && col.texte.length <= 30) { optionLib = col.texte; f.enTete = true; }
    const p = d || g || col || libelleDessus(f, phrases, 22, { exclues: phrasesOptions });
    f.optionLibelle = nettoyerLibelle(optionLib);
    f.label = p ? nettoyerLibelle(p.texte) : "";
  }
  const o = { champs, exclues: phrasesOptions };
  for (const f of champs) {
    if (f.type !== "checkbox") {
      // Champ encadré ou peigne : le texte aligné juste au-dessus passe avant le texte à gauche.
      // Ligne de saisie : le libellé sur la même ligne de base passe d'abord.
      const aligne = libelleAligne(f, phrases, o);
      const gauche = libelleGauche(f, phrases, 170, o);
      let p = f.ligne ? gauche || aligne : aligne || gauche;
      f.libelleAligne = Boolean(p && p === aligne);
      p = p || libelleDessus(f, phrases, 22, o) || enTeteColonne(f, phrases);
      f.label = p ? nettoyerLibelle(p.texte) : "";
      f.phraseGauche = gauche;
    }
    res.push(f);
  }

  // Peignes à la suite sur une même ligne (date, numéro de sécurité sociale) : même libellé,
  // celui qui précède le premier bloc, sauf si un vrai libellé s'intercale (« clé »).
  const peignes = res.filter((f) => f.type === "comb").sort((a, b) => a.y - b.y || a.x - b.x);
  let suite = [];
  const fermerSuite = () => {
    if (suite.length > 1) {
      const lib = suite[0].label;
      suite.forEach((f, i) => { f.label = lib; f.partie = i + 1; f.parties = suite.length; });
    }
    suite = [];
  };
  for (const f of peignes) {
    const prec = suite[suite.length - 1];
    const memeLigne = prec && Math.abs(prec.y - f.y) <= 2 && Math.abs(prec.h - f.h) <= 3;
    const ecart = prec ? f.x - (prec.x + prec.w) : 0;
    const entre = prec ? phrases.filter((p) => p.x0 >= prec.x + prec.w - 1 && p.x1 <= f.x + 1 && p.cy > f.y - 2 && p.cy < f.y + f.h + 2) : [];
    const coupure = entre.some((p) => SIGNIFIANT.test(p.texte));
    const separateur = entre.some((p) => /^[\s/.\-–]+$/.test(p.texte));
    const celluleW = prec ? prec.w / prec.cells : 0;
    // Chaque bloc a son propre libellé au-dessus, ou bien grand écart sans « / » : deux champs distincts.
    const propreLibelle = prec && f.libelleAligne && f.label && f.label !== suite[0].label;
    const tropLoin = prec && ecart > 1.2 * celluleW && !separateur;
    if (!memeLigne || ecart > 40 || coupure || propreLibelle || tropLoin) fermerSuite();
    suite.push(f);
  }
  fermerSuite();

  // Lignes régulières empilées sous un même titre (commentaire libre) : un seul champ multiligne.
  const lignesSeules = res.filter((f) => f.ligne && f.type === "text").sort((a, b) => a.ligne.y - b.ligne.y);
  const fusionnees = new Set();
  for (let i = 0; i < lignesSeules.length; i++) {
    const a = lignesSeules[i];
    if (fusionnees.has(a)) continue;
    const pile = [a];
    let pas = null;
    for (let j = i + 1; j < lignesSeules.length; j++) {
      const b = lignesSeules[j];
      const der = pile[pile.length - 1];
      if (Math.abs(b.x - a.x) > 6 || Math.abs(b.x + b.w - a.x - a.w) > 6) continue;
      const d = b.ligne.y - der.ligne.y;
      if (d < 12 || d > 40) { if (d > 40) break; continue; }
      if (pas === null) pas = d;
      else if (Math.abs(d - pas) > 2.5) break;
      if (b.phraseGauche) break;
      pile.push(b);
    }
    if (pile.length < 3) continue;
    pile.forEach((f) => fusionnees.add(f));
    const premier = pile[0], dernier = pile[pile.length - 1];
    const multi = {
      type: "multiline",
      x: Math.min(...pile.map((f) => f.x)),
      y: premier.y,
      w: Math.max(...pile.map((f) => f.x + f.w)) - Math.min(...pile.map((f) => f.x)),
      h: dernier.ligne.y - premier.y + 1,
      fontSize: Math.max(8, Math.min(11, Math.round(pas * 0.5))),
      label: premier.phraseGauche ? premier.label : nettoyerQuestion(premier.label),
      lignesReglees: pile.length,
    };
    res.push(multi);
  }
  const apresFusion = res.filter((f) => !fusionnees.has(f));

  // Séparateurs : grand trait seul, sans libellé à gauche, qui n'est pas dans une pile de lignes.
  const garder = apresFusion.filter((f) => {
    if (!f.ligne) return true;
    if (f.w < 0.6 * pageW) return true;
    if (f.phraseGauche) return true;
    const pile = apresFusion.some((g) => g !== f && g.ligne && Math.abs(g.x - f.x) < 10 && Math.abs(g.x + g.w - f.x - f.w) < 10 && Math.abs(g.ligne.y - f.ligne.y) <= 40);
    if (pile) return true;
    if (f.ligne.plein < 0.85) return true; // pointillés
    const dessus = libelleDessus(f, phrases, 30);
    return dessus && /[:?]\s*$/.test(dessus.texte);
  });

  // Cases rangées en lignes.
  const cases = garder.filter((f) => f.type === "checkbox").sort((a, b) => a.y - b.y || a.x - b.x);
  const rangees = [];
  for (const c of cases) {
    const cy = c.y + c.h / 2;
    let r = rangees.find((rg) => Math.abs(rg.cy - cy) <= 3);
    if (!r) { r = { cy, cases: [] }; rangees.push(r); }
    r.cases.push(c);
  }
  const optionsDe = (liste) => new Set(liste.map((c) => (c.optionLibelle || "").toLowerCase()));
  // Question d'une rangée : libellé sur la même ligne avant la première case, sinon titre juste au-dessus.
  const questionDe = (liste) => {
    const premier = liste[0];
    const opts = optionsDe(liste);
    const oq = { champs: garder, exclues: phrasesOptions, max: 110 };
    const g = libelleGauche(premier, phrases, 320, oq);
    if (g && !opts.has(nettoyerLibelle(g.texte).toLowerCase())) return { texte: g.texte, surLaLigne: true };
    const dernier = liste[liste.length - 1];
    const zone = { x: premier.x - 40, y: premier.y, w: dernier.x + dernier.w - premier.x + 80, h: premier.h, type: "text" };
    const dessus = libelleDessus(zone, phrases, 30, oq);
    if (dessus && !opts.has(nettoyerLibelle(dessus.texte).toLowerCase())) return { texte: dessus.texte, surLaLigne: false };
    return null;
  };
  let numeroGroupe = 0;
  const grouper = (liste, nomPropose) => {
    numeroGroupe++;
    let nom = nettoyerQuestion(nomPropose || "");
    if (!nom) nom = `Choix ${numeroGroupe}`;
    liste.forEach((c, i) => {
      c.type = "radio";
      c.group = nom;
      c.option = c.optionLibelle || `Choix ${i + 1}`;
      c.label = nom;
    });
  };
  // Titre au-dessus d'un tableau : la phrase la plus proche au-dessus de la première rangée du tableau.
  const titreAuDessus = (c, portee = 140) => {
    let best = null, bestD = Infinity;
    for (const p of phrases) {
      if (p.y1 > c.y) continue;
      const d = c.y - p.y1;
      if (d < portee && d < bestD && (UNE_SEULE.test(p.texte) || PLUSIEURS.test(p.texte))) { best = p; bestD = d; }
    }
    return best ? best.texte : "";
  };

  for (const r of rangees) {
    r.cases.sort((a, b) => a.x - b.x);
    let courant = [];
    let genre = null;
    const fermer = () => {
      if (courant.length >= (genre === "chiffres" ? 3 : 2)) {
        const q = questionDe(courant);
        grouper(courant, q ? q.texte : "");
      }
      courant = [];
      genre = null;
    };
    // 1. Motifs sûrs : ronds, Oui / Non, échelle de chiffres.
    for (const c of r.cases) {
      const t = (c.optionLibelle || "").toLowerCase();
      if (c.rond) {
        const dernier = courant[courant.length - 1];
        const precedentRond = dernier && genre === "ronds" ? dernier : null;
        if (!precedentRond || c.x - (precedentRond.x + precedentRond.w) > 120) fermer();
        genre = "ronds";
        if (!c.optionLibelle) c.optionLibelle = `Choix ${courant.length + 1}`;
        courant.push(c);
        continue;
      }
      if (genre === "ronds") fermer();
      const ouiNon = /^(oui|non|ne sait pas|nsp|sans avis|sans opinion)$/.test(t);
      const chiffre = /^\d{1,2}$/.test(t) ? parseInt(t, 10) : null;
      const precedent = courant[courant.length - 1];
      if (ouiNon) {
        if (genre !== "ouinon" || t === "oui") fermer();
        genre = "ouinon";
        courant.push(c);
      } else if (chiffre !== null) {
        const prevChiffre = precedent && genre === "chiffres" ? parseInt(precedent.optionLibelle, 10) : null;
        const ecart = precedent ? c.x - (precedent.x + precedent.w) : 0;
        if (genre !== "chiffres" || prevChiffre === null || chiffre !== prevChiffre + 1 || ecart > 80) {
          fermer();
          if (chiffre > 1) continue;
        }
        genre = "chiffres";
        courant.push(c);
      } else {
        fermer();
      }
    }
    fermer();

    // 2. Cases restantes de la rangée : indices de « choix unique ».
    const restantes = r.cases.filter((c) => c.type === "checkbox");
    if (restantes.length < 2) {
      // Case seule : question seulement si elle est sur la même ligne (« Accepte : ☐ »).
      restantes.forEach((c) => { const q = questionDe([c]); if (q && q.surLaLigne) c.question = nettoyerQuestion(q.texte); });
      continue;
    }
    const q = questionDe(restantes);
    const texteQ = q ? q.texte : "";
    const titre = titreAuDessus(restantes[0]);
    const contexte = `${texteQ} ${titre}`;
    const opts = restantes.map((c) => c.optionLibelle || "");
    const toutesEnTete = restantes.every((c) => c.enTete);
    let unique = false;
    if (PLUSIEURS.test(contexte)) unique = false;
    else if (UNE_SEULE.test(contexte)) unique = true;
    else if (opts.every((o) => EXCLUSIFS.test(o.trim()))) unique = true;
    else if (toutesEnTete) unique = opts.filter((o) => ECHELLE.test(o)).length >= 2;
    else if (q && q.surLaLigne && /[:?]\s*$/.test(texteQ) && !LISTE_PIECES.test(texteQ) && restantes.length <= 8 && opts.every((o) => o && o.length <= 30)) unique = true;
    if (unique && opts.every((o) => o)) grouper(restantes, texteQ || titre);
    else restantes.forEach((c) => { if (texteQ || titre) c.question = nettoyerQuestion(texteQ || titre); });
  }

  // Cases restantes alignées en colonne sous un titre « une seule réponse » (et pas « plusieurs ») :
  // un seul choix possible.
  const libres = garder.filter((f) => f.type === "checkbox").sort((a, b) => a.x - b.x || a.y - b.y);
  const vuesCol = new Set();
  for (const c of libres) {
    if (vuesCol.has(c)) continue;
    const colonne = [c];
    vuesCol.add(c);
    for (;;) {
      const der = colonne[colonne.length - 1];
      const suivante = libres
        .filter((d) => !vuesCol.has(d) && Math.abs(d.x - c.x) <= 3 && d.y > der.y && d.y - der.y <= 30)
        .sort((a, b) => a.y - b.y)[0];
      if (!suivante) break;
      colonne.push(suivante);
      vuesCol.add(suivante);
    }
    if (colonne.length < 2 || !colonne.every((d) => d.optionLibelle)) continue;
    const titre = titreAuDessus(colonne[0], 60);
    if (titre && UNE_SEULE.test(titre) && !PLUSIEURS.test(titre)) grouper(colonne, titre);
  }

  // Case restée seule sans question : on note le titre de rubrique au-dessus, il servira de nom
  // par défaut si l'on groupe ces cases à la main.
  for (const c of garder) {
    if (c.type !== "checkbox" || c.question) continue;
    const zone = { x: c.x - 60, y: c.y, w: c.w + 360, h: c.h, type: "text" };
    const rub = libelleDessus(zone, phrases, 80, { exclues: phrasesOptions });
    if (rub) c.rubrique = nettoyerQuestion(rub.texte);
  }

  return garder.map((f) => {
    const sortie = {
      type: f.type,
      x: +f.x.toFixed(2), y: +f.y.toFixed(2), w: +f.w.toFixed(2), h: +f.h.toFixed(2),
      label: f.label || "",
      fontSize: f.fontSize || 0,
    };
    if (f.type === "comb") sortie.cells = f.cells;
    if (f.partie) { sortie.partie = f.partie; sortie.parties = f.parties; }
    if (f.type === "radio") { sortie.group = f.group; sortie.option = f.option; }
    if (f.type === "checkbox") {
      if (f.optionLibelle) sortie.label = f.optionLibelle || f.label;
      if (f.question) sortie.question = f.question;
      if (f.rubrique) sortie.rubrique = f.rubrique;
    }
    return sortie;
  });
}

// Accès aux étapes internes, pour le diagnostic.
export const _interne = { lignes, composantes, REGLAGES, S };
