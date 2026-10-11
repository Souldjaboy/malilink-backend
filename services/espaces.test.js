"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const espaces = require("./espaces");

/* Base factice : sociétés et comptes en mémoire. */
function base({ societes = {}, comptes = {} } = {}) {
  return {
    async query(sql, p) {
      if (/FROM companies WHERE id=\$1/.test(sql)) return { rows: p[0] in societes ? [{ tenant_id: societes[p[0]] }] : [] };
      if (/FROM users WHERE id=\$1/.test(sql)) return { rows: comptes[p[0]] ? [{ ...comptes[p[0]] }] : [] };
      throw new Error(`requête inattendue : ${sql}`);
    },
  };
}
const requete = (host, entetes = {}, query = {}) => ({ headers: { host, ...entetes }, query });
function avecDeploiement(valeur, fn) {
  const avant = process.env.DEFAULT_TENANT_ID;
  try {
    if (valeur === undefined) delete process.env.DEFAULT_TENANT_ID; else process.env.DEFAULT_TENANT_ID = valeur;
    return fn();
  } finally {
    if (avant === undefined) delete process.env.DEFAULT_TENANT_ID; else process.env.DEFAULT_TENANT_ID = avant;
  }
}

test("domaines : liste exacte, frontières de sous-domaine respectées (jamais par inclusion)", () => avecDeploiement(undefined, () => {
  const t = (h) => espaces.espaceServeur(requete(h));
  assert.deepEqual(t("malilinkglobal.com"), { tenant: "malilink", source: "domaine" });
  assert.deepEqual(t("www.malilinkglobal.com:443"), { tenant: "malilink", source: "domaine" });
  assert.deepEqual(t("MALILINKGLOBAL.COM."), { tenant: "malilink", source: "domaine" });
  assert.deepEqual(t("hafiyalab.com"), { tenant: "hafiya", source: "domaine" });
  assert.deepEqual(t("malilink.trianglewmspro.com"), { tenant: "malilink", source: "domaine" });
  for (const piege of ["evil-malilinkglobal.com", "malilinkglobal.com.evil.net", "notmalilinkglobal.com", "xmalilink.trianglewmspro.com",
    "hafiyalab.com.attaquant.io", "afia.trianglewmspro.com-x.net", "malilinkglobal.co"]) {
    assert.deepEqual(t(piege), { tenant: "triangle", source: "defaut" }, piege);
  }
}));

test("X-Forwarded-Host et autres en-têtes de proxy ne fixent jamais l'espace", () => avecDeploiement(undefined, () => {
  const r = requete("127.0.0.1:5050", { "x-forwarded-host": "malilinkglobal.com", forwarded: "host=malilinkglobal.com" });
  assert.deepEqual(espaces.espaceServeur(r), { tenant: "triangle", source: "defaut" });
}));

test("un en-tête ou paramètre client ne remplace jamais l'espace du domaine ou du déploiement", () => {
  avecDeploiement(undefined, () => {
    assert.equal(espaces.espaceDeRequete(requete("malilinkglobal.com", { "x-tenant-id": "hafiya" })).tenant, "__invalid__");
    assert.equal(espaces.espaceDeRequete(requete("malilinkglobal.com", {}, { tenant_id: "hafiya" })).tenant, "__invalid__");
    assert.equal(espaces.espaceDeRequete(requete("malilinkglobal.com", { "x-app-product": "triangle" })).tenant, "__invalid__");
    assert.deepEqual(espaces.espaceDeRequete(requete("malilinkglobal.com", { "x-tenant-id": "malilink" })), { tenant: "malilink", source: "domaine" });
    // Rien d'établi (hôte inconnu, déploiement non fixé) : l'en-tête est retenu.
    assert.deepEqual(espaces.espaceDeRequete(requete("127.0.0.1", { "x-tenant-id": "hafiya" })), { tenant: "hafiya", source: "entete" });
  });
  avecDeploiement("malilink", () => {
    assert.equal(espaces.espaceDeRequete(requete("127.0.0.1", { "x-tenant-id": "hafiya" })).tenant, "__invalid__");
    assert.deepEqual(espaces.espaceDeRequete(requete("127.0.0.1")), { tenant: "malilink", source: "deploiement" });
    // Un domaine reconnu prime sur le déploiement.
    assert.deepEqual(espaces.espaceDeRequete(requete("hafiyalab.com")), { tenant: "hafiya", source: "domaine" });
    assert.equal(espaces.espaceDeRequete(requete("127.0.0.1", { "x-tenant-id": "pirate" })).tenant, "__invalid__");
  });
});

test("compte d'une société : l'espace de la société, qui doit être celui de la requête", async () => {
  const db = base({ societes: { 8: "malilink", 9: null } });
  assert.equal((await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com"), { id: 1, company_id: 8 })).tenant, "malilink");
  assert.equal((await espaces.etablirEspaceConnexion(db, requete("hafiyalab.com"), { id: 1, company_id: 8 })).code, "AUTRE_ESPACE");
  assert.equal((await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com"), { id: 2, company_id: 9 })).code, "ESPACE_SOCIETE_INDEFINI");
});

test("ancien compte sans société : JAMAIS rattaché automatiquement, procédure expliquée", async () => {
  const comptes = { 5: { id: 5, company_id: null, account_tenant_id: null } };
  const db = base({ comptes });
  for (const r of [requete("malilinkglobal.com"), requete("127.0.0.1"), requete("hafiyalab.com")]) {
    const refus = await espaces.etablirEspaceConnexion(db, r, comptes[5]);
    assert.equal(refus.code, "ESPACE_NON_ETABLI");
    assert.match(refus.error, /administration MaliLink doit confirmer votre espace/);
  }
  assert.equal(comptes[5].account_tenant_id, null);
  const attribue = { id: 6, company_id: null, account_tenant_id: "malilink", account_tenant_source: "attribution_admin" };
  assert.equal((await espaces.etablirEspaceConnexion(base({ comptes: { 6: attribue } }), requete("malilinkglobal.com"), attribue)).tenant, "malilink");
  assert.equal((await espaces.etablirEspaceConnexion(base({ comptes: { 6: attribue } }), requete("hafiyalab.com"), attribue)).code, "AUTRE_ESPACE");
});

test("appartenance d'un utilisateur : seule une appartenance PROUVÉE vaut « oui »", async () => {
  const db = base({ societes: { 8: "malilink", 20: "hafiya" }, comptes: {
    1: { id: 1, company_id: 8, account_tenant_id: null }, 2: { id: 2, company_id: 20, account_tenant_id: null },
    3: { id: 3, company_id: null, account_tenant_id: null }, 4: { id: 4, company_id: null, account_tenant_id: "hafiya" },
    5: { id: 5, company_id: null, account_tenant_id: "malilink" } } });
  assert.equal(await espaces.utilisateurDansEspace(db, 1, "malilink"), "oui");
  assert.equal(await espaces.utilisateurDansEspace(db, 2, "malilink"), "non");
  assert.equal(await espaces.utilisateurDansEspace(db, 3, "malilink"), "non_etabli");
  assert.equal(await espaces.utilisateurDansEspace(db, 3, "hafiya"), "non_etabli");
  assert.equal(await espaces.utilisateurDansEspace(db, 4, "malilink"), "non");
  assert.equal(await espaces.utilisateurDansEspace(db, 5, "malilink"), "oui");
  assert.equal(await espaces.utilisateurDansEspace(db, 99, "malilink"), "introuvable");
  assert.equal(await espaces.societeDansEspace(db, 8, "malilink"), true);
  assert.equal(await espaces.societeDansEspace(db, 20, "malilink"), false);
});

test("attribution administrative : motif et espace exigés, journal écrit, refus d'un compte déjà rattaché ou d'une société", async () => {
  const ecritures = [];
  const ligne = { id: 7, company_id: null, account_tenant_id: null };
  const client = {
    async query(sql, p = []) {
      ecritures.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/SELECT id, company_id, account_tenant_id FROM users/.test(sql)) return { rows: p[0] === 7 ? [ligne] : p[0] === 8 ? [{ id: 8, company_id: 3, account_tenant_id: null }] : [] };
      if (/INSERT INTO account_tenant_assignments/.test(sql)) return { rows: [{ id: 41 }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  assert.deepEqual(await espaces.attribuer(pool, { userId: 7, tenant: "malilink", parId: 1, motif: "court" }), { ok: false, raison: "motif obligatoire (10 caractères au moins)" });
  assert.equal((await espaces.attribuer(pool, { userId: 7, tenant: "pirate", parId: 1, motif: "Base dédiée à MaliLink" })).ok, false);
  assert.deepEqual(await espaces.attribuer(pool, { userId: 7, tenant: "malilink", parId: 1, motif: "Base dédiée à MaliLink" }), { ok: true, assignmentId: 41 });
  assert.ok(ecritures.includes("UPDATE users SET") && ecritures.includes("INSERT INTO account_tenant_assignments") && ecritures.includes("INSERT INTO audit_logs"));
  assert.match((await espaces.attribuer(pool, { userId: 8, tenant: "malilink", parId: 1, motif: "Base dédiée à MaliLink" })).raison, /société/);
});
