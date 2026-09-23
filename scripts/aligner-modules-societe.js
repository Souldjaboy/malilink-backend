"use strict";

/**
 * Aligne les modules d'une société existante sur son profil métier.
 *
 *   node scripts/aligner-modules-societe.js --societe="ADA SERVICE" --preview
 *   node scripts/aligner-modules-societe.js --societe="ADA SERVICE" --apply \
 *        --motif="Alignement ADA sur le profil Commerce" \
 *        --confirmer="OUI J'ALIGNE ADA SERVICE"
 *
 * Pourquoi : jusqu'ici, l'inscription activait tout module non mentionné et
 * le formulaire cochait tout par défaut. Une boutique comme ADA SERVICE s'est
 * retrouvée avec Restaurant, Éducation, Laboratoire, Immobilier…
 *
 * Ce que fait l'outil :
 *  - retrouve la société PAR SON NOM (elle existe déjà : il n'en crée jamais) ;
 *  - calcule la cible = profil métier ∩ offre ;
 *  - conserve TOUTE décision déjà prise par un super-admin, même contraire ;
 *  - affiche AVANT / APRÈS, module par module ;
 *  - n'écrit qu'avec --apply, un motif et la phrase de confirmation exacte.
 *
 * Ce qu'il ne fait jamais : supprimer une donnée métier. Désactiver un module
 * le masque et en interdit l'usage ; ses données restent en base, intactes,
 * et réapparaissent si le module est réactivé.
 */

const path = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const access = require("../access-control");

const args = process.argv.slice(2);
const arg = (nom) => {
  const t = args.find((x) => x.startsWith(`--${nom}=`));
  return t ? t.slice(nom.length + 3) : "";
};
const APPLIQUER = args.includes("--apply");
const NOM = arg("societe");
const ID = arg("id");
const MOTIF = arg("motif");
const CONFIRMATION = arg("confirmer");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", D = "\x1b[2m", Z = "\x1b[0m";
const dire = (t = "") => console.log(t);

const sansAccents = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

async function trouverSociete(pool) {
  if (ID) {
    const r = (await pool.query(`SELECT id, name, business_type, tenant_id, plan_id FROM companies WHERE id = $1`, [Number(ID)])).rows;
    return { trouvees: r };
  }
  const toutes = (await pool.query(`SELECT id, name, business_type, tenant_id, plan_id FROM companies ORDER BY id`)).rows;
  const cible = sansAccents(NOM);
  const exactes = toutes.filter((c) => sansAccents(c.name) === cible);
  if (exactes.length) return { trouvees: exactes };
  return { trouvees: toutes.filter((c) => sansAccents(c.name).includes(cible)) };
}

/* Ce que la société voit AUJOURD'HUI, selon l'ancienne règle encore en
   production : une ligne décide, et « pas de ligne » voulait dire « actif ». */
function etatAncien(lignes, cle) {
  const l = lignes.get(cle);
  return l ? l.enabled === true : true;
}

async function main() {
  if (!NOM && !ID) {
    dire(`${R}--societe="Nom de la société" (ou --id=N) est obligatoire.${Z}`);
    process.exit(1);
  }
  if (APPLIQUER) {
    if (!MOTIF || MOTIF.length < 10) {
      dire(`${R}--motif="…" est obligatoire avec --apply (au moins 10 caractères).${Z}`);
      process.exit(1);
    }
  }
  const url = process.env.DATABASE_URL || "";
  const pool = new Pool(url ? { connectionString: url } : {});

  try {
    const { trouvees } = await trouverSociete(pool);
    if (trouvees.length === 0) {
      dire(`${R}Aucune société ne correspond à « ${NOM || ID} ». Rien n'est créé : cet outil ne crée jamais de société.${Z}`);
      process.exitCode = 1;
      return;
    }
    if (trouvees.length > 1) {
      dire(`${R}${trouvees.length} sociétés correspondent — précisez avec --id= :${Z}`);
      for (const c of trouvees) dire(`   id ${c.id}  ${c.name}  (${c.business_type || "type non renseigné"}, tenant ${c.tenant_id || "?"})`);
      process.exitCode = 1;
      return;
    }
    const societe = trouvees[0];
    const attendue = `OUI J'ALIGNE ${String(societe.name).toUpperCase()}`;
    if (APPLIQUER && CONFIRMATION !== attendue) {
      dire(`${R}Confirmation exacte requise :${Z}\n  --confirmer="${attendue}"`);
      process.exitCode = 1;
      return;
    }

    const ctx = await access.loadAccessContext(pool, { companyId: societe.id });
    const plan = (await pool.query(
      `SELECT p.name, p.excluded_modules FROM subscription_plans p
        WHERE p.id = COALESCE(
          (SELECT s.plan_id FROM subscriptions s WHERE s.company_id = $1 AND s.plan_id IS NOT NULL ORDER BY s.id DESC LIMIT 1),
          $2)`, [societe.id, societe.plan_id])).rows[0] || null;
    const profil = access.profileModules(ctx.profileKey);

    dire(`${APPLIQUER ? "" : `${J}MODE APERÇU — aucune écriture.${Z}\n`}`);
    dire(`${G}SOCIÉTÉ${Z}  ${societe.name}  (id ${societe.id}, tenant ${societe.tenant_id || "?"})`);
    dire(`  type d'activité : « ${societe.business_type || "non renseigné"} » → profil ${G}${access.BUSINESS_PROFILES[ctx.profileKey].label}${Z}`);
    dire(`  offre           : ${plan ? plan.name : "aucune"}${plan && plan.excluded_modules?.length ? `  (n'inclut pas : ${plan.excluded_modules.join(", ")})` : ""}`);

    // ── Calcul module par module ────────────────────────────────────────
    const changements = [];
    const lignesTableau = [];
    for (const entree of access.MODULE_CATALOG) {
      if (entree.core) continue;
      const cle = entree.key;
      const ligne = ctx.companyRows.get(cle);
      const avant = etatAncien(ctx.companyRows, cle);

      let cible;
      let pourquoi;
      if (ligne && ligne.source === "super_admin") {
        cible = ligne.enabled === true;
        pourquoi = "décision super-admin conservée";
      } else {
        const dansProfil = profil.has(cle);
        const permisParOffre = access.planAllows(ctx.plan, cle);
        cible = dansProfil && permisParOffre;
        pourquoi = !dansProfil ? "hors profil" : !permisParOffre ? "hors offre" : "profil";
      }
      lignesTableau.push({ cle, libelle: entree.label, groupe: entree.group, avant, cible, pourquoi, superAdmin: ligne?.source === "super_admin" });
      const ligneAJour = ligne && ligne.enabled === cible && ligne.source !== "";
      if (!(ligne && ligne.source === "super_admin") && (!ligne || ligne.enabled !== cible || !ligneAJour)) {
        changements.push({ cle, cible });
      }
    }

    // ── AVANT / APRÈS ───────────────────────────────────────────────────
    const avantActifs = lignesTableau.filter((l) => l.avant);
    const apresActifs = lignesTableau.filter((l) => l.cible);
    dire(`\n${G}AVANT${Z} — ${avantActifs.length} module(s) visible(s) aujourd'hui`);
    dire(`  ${avantActifs.map((l) => l.cle).join(", ")}`);
    dire(`\n${G}APRÈS${Z} — ${apresActifs.length} module(s)`);
    dire(`  ${apresActifs.map((l) => l.cle).join(", ")}`);

    const retires = lignesTableau.filter((l) => l.avant && !l.cible);
    const ajoutes = lignesTableau.filter((l) => !l.avant && l.cible);
    dire(`\n${G}MASQUÉS${Z} (${retires.length}) — données conservées, simplement plus accessibles`);
    for (const l of retires) dire(`  ${R}−${Z} ${l.libelle.padEnd(28)} ${D}${l.pourquoi}${Z}`);
    dire(`\n${G}AJOUTÉS${Z} (${ajoutes.length})`);
    for (const l of ajoutes) dire(`  ${V}+${Z} ${l.libelle.padEnd(28)} ${D}${l.pourquoi}${Z}`);
    const conserves = lignesTableau.filter((l) => l.superAdmin);
    if (conserves.length) {
      dire(`\n${G}DÉCISIONS SUPER-ADMIN CONSERVÉES${Z} (${conserves.length})`);
      for (const l of conserves) dire(`  ${J}•${Z} ${l.libelle.padEnd(28)} ${l.cible ? "activé" : "désactivé"}`);
    }

    // ── Utilisateurs : ce que chacun verra ──────────────────────────────
    const utilisateurs = (await pool.query(
      `SELECT id, fullname, email, role FROM users WHERE company_id = $1 ORDER BY id`, [societe.id])).rows;
    if (utilisateurs.length) {
      dire(`\n${G}UTILISATEURS${Z} — modules visibles après alignement (droits individuels appliqués)`);
      const apresCtx = { ...ctx, companyRows: new Map(ctx.companyRows) };
      for (const c of changements) apresCtx.companyRows.set(c.cle, { enabled: c.cible, source: "profil" });
      for (const u of utilisateurs) {
        const uCtx = await access.loadAccessContext(pool, { companyId: societe.id, userId: u.id, role: u.role });
        uCtx.companyRows = apresCtx.companyRows;
        const visibles = access.MODULE_CATALOG.filter((m) => !m.core && access.effectiveAccess(uCtx, m.key, "view").allowed);
        const refus = [...uCtx.permRows.values()].filter((p) => p.can_view === false).map((p) => p.module_key);
        dire(`  ${String(u.fullname || u.email).padEnd(26)} ${D}${String(u.role).padEnd(20)}${Z} ${visibles.length} module(s)${refus.length ? `  ${J}« Voir » refusé sur : ${refus.join(", ")}${Z}` : ""}`);
      }
    }

    dire(`\n${changements.length} ligne(s) company_modules à écrire.`);

    if (!APPLIQUER) {
      dire(`\n${J}APERÇU TERMINÉ — aucune écriture n'a eu lieu.${Z}`);
      dire(`Pour appliquer :\n  --apply --motif="…" --confirmer="${attendue}"`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of changements) {
        await client.query(
          `INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, source)
           VALUES ($1,$2,$3,$3,'profil')
           ON CONFLICT (company_id, module_key) DO UPDATE SET
             is_enabled = EXCLUDED.is_enabled, enabled = EXCLUDED.enabled,
             source = 'profil', updated_at = CURRENT_TIMESTAMP
           WHERE company_modules.source IS DISTINCT FROM 'super_admin'`,
          [societe.id, c.cle, c.cible]);
      }
      /* Trace de l'opération. Colonnes présentes depuis la migration 005 :
         pas d'insertion conditionnelle, car une requête qui échoue dans une
         transaction PostgreSQL l'avorte entièrement — un .catch() JavaScript
         arriverait trop tard et le COMMIT échouerait. */
      await client.query(
        `INSERT INTO audit_logs (company_id, action, entity_type, entity_id, old_values, new_values)
         VALUES ($1, 'modules_alignes_profil', 'company', $2, $3, $4)`,
        [societe.id, String(societe.id),
         JSON.stringify({ actifs: avantActifs.map((l) => l.cle) }),
         JSON.stringify({ motif: MOTIF, profil: ctx.profileKey, actifs: apresActifs.map((l) => l.cle), changements })]);
      await client.query("COMMIT");
      dire(`\n${V}${G}APPLIQUÉ.${Z} ${changements.length} ligne(s) écrite(s) pour ${societe.name}. Aucune donnée métier supprimée.`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    dire(`\n${R}ÉCHEC : ${e.message}${Z}`);
    dire(`${R}Aucune écriture conservée.${Z}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
