"use strict";

/**
 * TESTS DE LA SURFACE PUBLIQUE — SÉCURITÉ ET SEO.
 *
 * Lance un backend éphémère sur des données de test, interroge les routes
 * publiques comme le ferait un visiteur anonyme, puis vérifie deux choses :
 *
 *   1. aucune donnée interne (emplacement, entrepôt, niveau de stock) ne sort
 *      des réponses publiques, quel que soit le chemin emprunté ;
 *   2. le sitemap ne contient que ce qui est réellement indexable.
 *
 * Les données de test sont créées puis supprimées ; rien d'autre n'est touché.
 *
 *   node scripts/test-seo-public.js
 */

require("dotenv").config();
const { Pool } = require("pg");
const catalogue = require("../services/public-catalog");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CIE = 9902;
const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;

let reussis = 0;
let echoues = 0;

function verifier(nom, condition, detail = "") {
  if (condition) {
    reussis += 1;
    console.log(`  ✓ ${nom}`);
  } else {
    echoues += 1;
    console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Cherche récursivement une clé interdite, à n'importe quelle profondeur. */
function cleInterditeTrouvee(valeur, interdites, chemin = "") {
  if (Array.isArray(valeur)) {
    for (let i = 0; i < valeur.length; i += 1) {
      const t = cleInterditeTrouvee(valeur[i], interdites, `${chemin}[${i}]`);
      if (t) return t;
    }
    return null;
  }
  if (valeur && typeof valeur === "object") {
    for (const [cle, v] of Object.entries(valeur)) {
      if (interdites.includes(cle)) return `${chemin}.${cle}`;
      const t = cleInterditeTrouvee(v, interdites, `${chemin}.${cle}`);
      if (t) return t;
    }
  }
  return null;
}

async function jeuDeDonnees() {
  await pool.query(
    `INSERT INTO companies (id,name,business_type,status,subscription_status)
     VALUES ($1,'VITRINE TEST','commerce','active','active') ON CONFLICT (id) DO NOTHING`,
    [CIE]
  );
  await pool.query(
    `INSERT INTO company_public_profile
       (company_id,slug,description,country,region,city,quartier,address_line,
        public_phone,public_email,is_public,show_phone,show_email,show_products)
     VALUES ($1,'vitrine-test','Quincaillerie de test.','Mali','District de Bamako',
             'Bamako','Sotuba','Rue 123','+22300000000','vitrine@test.local',true,true,false,true)
     ON CONFLICT (company_id) DO NOTHING`,
    [CIE]
  );
  /* Deux produits internes : un vendable, un désactivé. */
  await pool.query(
    `INSERT INTO products (id,company_id,name,reference,stock,minimum_stock,unit,is_active,is_sellable,location_code,warehouse)
     VALUES (99801,$1,'CIMENT CIMAF 42.5','CIM425',250,20,'SAC',TRUE,TRUE,'W-EM2S-A-A-A1-L1-BIN7','ENTREPOT PRINCIPAL'),
            (99802,$1,'PRODUIT RETIRE','RET01',10,0,'EACH',FALSE,TRUE,'W-EM2S-A-A-A1-L1-BIN8','ENTREPOT PRINCIPAL')
     ON CONFLICT (id) DO NOTHING`,
    [CIE]
  );
  await pool.query(
    `INSERT INTO marketplace_products
       (id,company_id,product_id,title,description,category,price,image_url,status,is_published,available_quantity,updated_at)
     VALUES (99811,$1,99801,'Ciment CIMAF 42.5','Sac de 50 kg, qualité construction.','Matériaux',7500,'/uploads/ciment.jpg','published',true,200,now()),
            (99812,$1,99802,'Produit retiré','Ne doit pas être indexé.','Matériaux',1000,NULL,'published',true,5,now()),
            (99813,$1,99801,'Brouillon non publié','Ne doit pas sortir.','Matériaux',2000,NULL,'draft',false,5,now())
     ON CONFLICT (id) DO NOTHING`,
    [CIE]
  );
}

async function nettoyer() {
  await pool.query(`DELETE FROM marketplace_products WHERE company_id=$1`, [CIE]);
  await pool.query(`DELETE FROM products WHERE company_id=$1`, [CIE]);
  await pool.query(`DELETE FROM company_public_profile WHERE company_id=$1`, [CIE]);
  await pool.query(`DELETE FROM companies WHERE id=$1`, [CIE]);
}

const lire = async (chemin) => {
  const r = await fetch(`${BASE}${chemin}`);
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
};

async function main() {
  await nettoyer();
  await jeuDeDonnees();

  const interdites = catalogue.CHAMPS_INTERNES_INTERDITS;

  console.log("\nSÉCURITÉ — aucune donnée interne dans les réponses publiques");
  for (const chemin of [
    "/marketplace/products/99811",
    "/marketplace/products?q=Ciment",
    "/public/products/99811",
    "/public/companies/vitrine-test",
  ]) {
    const { corps } = await lire(chemin);
    const fuite = cleInterditeTrouvee(corps, interdites);
    verifier(`${chemin} ne renvoie aucun champ interne`, !fuite, `champ exposé : ${fuite}`);

    const brut = JSON.stringify(corps);
    verifier(`${chemin} ne contient aucun code d'emplacement`, !brut.includes("BIN7"));
    verifier(`${chemin} ne nomme aucun entrepôt`, !brut.includes("ENTREPOT PRINCIPAL"));
  }

  console.log("\nCONTENU PUBLIC — ce qui doit sortir sort bien");
  {
    const { corps } = await lire("/public/products/99811");
    const p = corps.product || {};
    verifier("titre présent", p.title === "Ciment CIMAF 42.5");
    verifier("prix présent", Number(p.price) === 7500);
    verifier("devise XOF", p.currency === "XOF");
    verifier("disponibilité en stock", p.availability === "InStock");
    verifier("URL canonique avec slug et id", p.url === "/produit/ciment-cimaf-42-5-99811", p.url);
    verifier("vendeur nommé", p.vendor?.name === "VITRINE TEST");
    verifier("ville du vendeur exposée", p.vendor?.city === "Bamako");
  }

  console.log("\nVITRINE ENTREPRISE");
  {
    const { corps } = await lire("/public/companies/vitrine-test");
    const e = corps.company || {};
    verifier("profil public accessible sans authentification", e.name === "VITRINE TEST");
    verifier("quartier réel exposé", e.quartier === "Sotuba");
    verifier("téléphone visible car autorisé", e.phone === "+22300000000");
    verifier("email masqué car non autorisé", e.email === "");
    verifier("URL de vitrine, pas /partenaires", e.url === "/boutique/vitrine-test", e.url);
    verifier("seul le produit actif est listé", (corps.products || []).length === 1);

    // Les produits ne s'affichent sur la vitrine que si l'entreprise l'a choisi.
    await pool.query(`UPDATE company_public_profile SET show_products=false WHERE company_id=$1`, [CIE]);
    const sans = await lire("/public/companies/vitrine-test");
    verifier("produits masqués quand l'entreprise ne les montre pas", (sans.corps.products || []).length === 0);
    await pool.query(`UPDATE company_public_profile SET show_products=true WHERE company_id=$1`, [CIE]);
  }

  console.log("\nINDEXABILITÉ — le sitemap ne contient que du publiable");
  {
    const { corps } = await lire("/public/sitemap");
    const chemins = (corps.products || []).map((x) => x.path);
    verifier("produit publié présent", chemins.includes("/produit/ciment-cimaf-42-5-99811"));
    verifier("produit inactif absent", !chemins.some((c) => c.includes("99812")));
    verifier("brouillon absent", !chemins.some((c) => c.includes("99813")));
    verifier(
      "lastmod fourni pour le produit",
      Boolean((corps.products || []).find((x) => x.path.includes("99811"))?.lastmod)
    );
    verifier(
      "vitrine présente",
      (corps.companies || []).some((c) => c.path === "/boutique/vitrine-test")
    );
    const tout = JSON.stringify(corps);
    for (const prive of ["/login", "/register", "/dashboard", "/parametres", "/super-admin"]) {
      verifier(`${prive} absent du sitemap`, !tout.includes(prive));
    }
  }

  console.log("\nPRODUIT NON PUBLIABLE");
  {
    const inactif = await lire("/public/products/99812");
    verifier("produit inactif : 404", inactif.statut === 404, `statut ${inactif.statut}`);
    const brouillon = await lire("/public/products/99813");
    verifier("brouillon : 404", brouillon.statut === 404, `statut ${brouillon.statut}`);
  }

  await nettoyer();
  await pool.end();

  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  await nettoyer().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
