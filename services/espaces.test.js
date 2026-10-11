"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const espaces = require("./espaces");

/* Base factice : sociétés et comptes en mémoire, UPDATE de rattachement tracés. */
function base({ societes = {}, comptes = {} } = {}) {
  const ecritures = [];
  return {
    ecritures,
    async query(sql, p) {
      if (/FROM companies WHERE id=\$1/.test(sql)) return { rows: p[0] in societes ? [{ tenant_id: societes[p[0]] }] : [] };
      if (/^\s*UPDATE users SET account_tenant_id/.test(sql)) {
        ecritures.push(p);
        const c = comptes[p[0]];
        if (c && !c.company_id && !c.account_tenant_id) { c.account_tenant_id = p[1]; c.account_tenant_source = p[2]; return { rows: [{ id: p[0] }] }; }
        return { rows: [] };
      }
      if (/FROM users WHERE id=\$1/.test(sql)) return { rows: comptes[p[0]] ? [{ ...comptes[p[0]] }] : [] };
      throw new Error(`requête inattendue : ${sql}`);
    },
  };
}
const requete = (host, entetes = {}) => ({ headers: { host, ...entetes }, query: {} });

test("espace du serveur : domaine, déploiement, sinon « défaut » (jamais retenu pour rattacher)", () => {
  const avant = process.env.DEFAULT_TENANT_ID;
  try {
    delete process.env.DEFAULT_TENANT_ID;
    assert.deepEqual(espaces.espaceServeur(requete("malilinkglobal.com")), { tenant: "malilink", source: "domaine" });
    assert.deepEqual(espaces.espaceServeur(requete("www.hafiyalab.com")), { tenant: "hafiya", source: "domaine" });
    assert.deepEqual(espaces.espaceServeur(requete("127.0.0.1:5050")), { tenant: "triangle", source: "defaut" });
    process.env.DEFAULT_TENANT_ID = "malilink";
    assert.deepEqual(espaces.espaceServeur(requete("127.0.0.1:5050")), { tenant: "malilink", source: "deploiement" });
    assert.deepEqual(espaces.espaceDeRequete(requete("malilinkglobal.com", { "x-tenant-id": "hafiya" })), { tenant: "hafiya", source: "entete" });
    assert.equal(espaces.espaceDeRequete(requete("malilinkglobal.com", { "x-tenant-id": "pirate" })).tenant, "__invalid__");
  } finally {
    if (avant === undefined) delete process.env.DEFAULT_TENANT_ID; else process.env.DEFAULT_TENANT_ID = avant;
  }
});

test("compte d'une société : l'espace de la société, qui doit être celui de la requête", async () => {
  const db = base({ societes: { 8: "malilink", 9: null } });
  const ok = await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com"), { id: 1, company_id: 8 });
  assert.equal(ok.tenant, "malilink");
  const autre = await espaces.etablirEspaceConnexion(db, requete("hafiyalab.com"), { id: 1, company_id: 8 });
  assert.equal(autre.code, "AUTRE_ESPACE");
  const indefini = await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com"), { id: 2, company_id: 9 });
  assert.equal(indefini.code, "ESPACE_SOCIETE_INDEFINI");
});

test("ancien compte sans société : rattaché uniquement sur un espace établi par le serveur", async () => {
  const avant = process.env.DEFAULT_TENANT_ID;
  try {
    delete process.env.DEFAULT_TENANT_ID;
    const comptes = { 5: { id: 5, company_id: null, account_tenant_id: null } };
    const db = base({ comptes });
    const parDefaut = await espaces.etablirEspaceConnexion(db, requete("127.0.0.1"), comptes[5]);
    assert.equal(parDefaut.code, "ESPACE_A_CONFIRMER", "aucun rattachement sur l'espace « défaut »");
    const parEntete = await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com", { "x-tenant-id": "hafiya" }), comptes[5]);
    assert.equal(parEntete.code, "ESPACE_A_CONFIRMER", "un en-tête contraire au domaine ne rattache pas");
    assert.equal(db.ecritures.length, 0);
    const ok = await espaces.etablirEspaceConnexion(db, requete("malilinkglobal.com"), { id: 5, company_id: null, account_tenant_id: null });
    assert.deepEqual({ tenant: ok.tenant, rattache: ok.rattache }, { tenant: "malilink", rattache: true });
    const ensuite = await espaces.etablirEspaceConnexion(db, requete("hafiyalab.com"), comptes[5]);
    assert.equal(ensuite.code, "AUTRE_ESPACE", "un compte rattaché ne change plus d'espace");
  } finally {
    if (avant === undefined) delete process.env.DEFAULT_TENANT_ID; else process.env.DEFAULT_TENANT_ID = avant;
  }
});

test("appartenance d'un utilisateur ou d'une société à un espace", async () => {
  const db = base({ societes: { 8: "malilink", 20: "hafiya" }, comptes: {
    1: { id: 1, company_id: 8, account_tenant_id: null }, 2: { id: 2, company_id: 20, account_tenant_id: null },
    3: { id: 3, company_id: null, account_tenant_id: null }, 4: { id: 4, company_id: null, account_tenant_id: "hafiya" } } });
  assert.equal(await espaces.utilisateurDansEspace(db, 1, "malilink"), "oui");
  assert.equal(await espaces.utilisateurDansEspace(db, 2, "malilink"), "non");
  assert.equal(await espaces.utilisateurDansEspace(db, 3, "malilink"), "non_rattache");
  assert.equal(await espaces.utilisateurDansEspace(db, 4, "malilink"), "non");
  assert.equal(await espaces.utilisateurDansEspace(db, 99, "malilink"), "introuvable");
  assert.equal(await espaces.societeDansEspace(db, 8, "malilink"), true);
  assert.equal(await espaces.societeDansEspace(db, 20, "malilink"), false);
  assert.equal(await espaces.societeDansEspace(db, 77, "malilink"), false);
});
