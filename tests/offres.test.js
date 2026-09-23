"use strict";

/**
 * P1 — offres Starter / Business / Pro, frais d'installation, abonnements
 * existants préservés. Vrai serveur, base neuve (scripts/test-integration.sh).
 */

const { q, appel, jeton, jetonSuperAdmin, verifier, section, terminer } = require("./_outils");

async function main() {
  const tSuper = jetonSuperAdmin();

  section("OFFRES PUBLIQUES");
  const publiques = await appel("GET", "/public/plans", null);
  {
    const noms = (publiques.data || []).map((p) => p.display_name);
    verifier("exactement Starter, Business, Pro, dans cet ordre", JSON.stringify(noms) === JSON.stringify(["Starter", "Business", "Pro"]), JSON.stringify(noms));
    const par = Object.fromEntries((publiques.data || []).map((p) => [p.commercial_code, p]));
    verifier("Starter : 15 000 F / mois + 75 000 F d'installation",
      Number(par.starter?.price_monthly) === 15000 && Number(par.starter?.installation_fee) === 75000);
    verifier("Business : 50 000 F / mois + 250 000 F d'installation",
      Number(par.business?.price_monthly) === 50000 && Number(par.business?.installation_fee) === 250000);
    verifier("Pro : 100 000 F / mois + 400 000 F d'installation",
      Number(par.pro?.price_monthly) === 100000 && Number(par.pro?.installation_fee) === 400000);
    verifier("Business porte le badge « recommandé », et lui seul",
      par.business?.is_recommended === true && par.starter?.is_recommended === false && par.pro?.is_recommended === false);
    verifier("chaque offre porte ses arguments commerciaux",
      ["starter", "business", "pro"].every((c) => Array.isArray(par[c]?.highlights) && par[c].highlights.length >= 4));
    verifier("Starter n'inclut ni caméras ni marketing ; Business et Pro oui",
      par.starter?.excluded_modules.includes("cameras") && par.starter?.excluded_modules.includes("marketing")
      && par.business?.excluded_modules.length === 0 && par.pro?.excluded_modules.length === 0);
    verifier("le plan interne à 0 F n'est pas proposé", !(publiques.data || []).some((p) => Number(p.price_monthly) === 0));
  }

  section("ANCIENNES OFFRES — ABONNÉS PRÉSERVÉS");
  {
    const anciennes = await q(`SELECT name, price_monthly::int AS prix, is_public FROM subscription_plans
                                WHERE LOWER(name) IN ('standard','premium') ORDER BY name`);
    verifier("Standard et Premium existent toujours", anciennes.length === 2);
    verifier("leurs prix n'ont pas changé (30 000 / 60 000)",
      anciennes.find((p) => p.name === "Standard")?.prix === 30000 && anciennes.find((p) => p.name === "Premium")?.prix === 60000);
    verifier("elles ne sont plus proposées à l'inscription", anciennes.every((p) => p.is_public === false));
    const starter = (await q(`SELECT id, name FROM subscription_plans WHERE commercial_code='starter'`))[0];
    verifier("Starter réutilise l'ancien plan Essentiel (même identifiant, même prix)", starter?.name === "Essentiel");

    // Un abonné existant de Standard (comme ADA) reste sur Standard, au même prix.
    const standard = (await q(`SELECT id FROM subscription_plans WHERE LOWER(name)='standard'`))[0];
    const ancienne = (await q(`INSERT INTO companies (name, business_type, plan_id, tenant_id) VALUES ('Client historique','commerce',$1,'malilink') RETURNING id`, [standard.id]))[0];
    await q(`INSERT INTO subscriptions (company_id, plan_id, status, payment_status) VALUES ($1,$2,'active','paid')`, [ancienne.id, standard.id]);
    const relu = (await q(`SELECT p.name, p.price_monthly::int AS prix FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.company_id=$1`, [ancienne.id]))[0];
    verifier("un abonné Standard garde son offre et son prix", relu?.name === "Standard" && relu?.prix === 30000);
  }

  section("INSCRIPTION");
  let tel = 71000000 + Math.floor(Math.random() * 900000);
  const inscrire = (nom, planId) => appel("POST", "/register-saas", null, {
    company_name: nom, business_type: "commerce", responsible_name: "Responsable",
    phone: String(tel++), password: "Essai2026x", plan_id: planId, selected_modules: {},
  });
  {
    const standard = (await q(`SELECT id FROM subscription_plans WHERE LOWER(name)='standard'`))[0];
    const refus = await inscrire("Société sur ancienne offre", standard.id);
    verifier("s'inscrire sur une ancienne offre est refusé (400 PLAN_NOT_OFFERED)",
      refus.status === 400 && refus.data?.code === "PLAN_NOT_OFFERED", `statut ${refus.status} ${refus.data?.code || ""}`);

    const business = (await q(`SELECT id FROM subscription_plans WHERE commercial_code='business'`))[0];
    const ok = await inscrire("Société Business", business.id);
    verifier("s'inscrire sur Business fonctionne", ok.status === 201, `statut ${ok.status} ${ok.data?.error || ""}`);
    const abo = (await q(`SELECT installation_fee::int AS installation FROM subscriptions WHERE company_id=$1`, [ok.data.company.id]))[0];
    verifier("le montant d'installation annoncé est figé sur l'abonnement (250 000 F)", abo?.installation === 250000, JSON.stringify(abo));

    // Le tarif change ensuite : l'abonnement garde ce qui a été annoncé.
    await q(`UPDATE subscription_plans SET installation_fee = 300000 WHERE id=$1`, [business.id]);
    const apres = (await q(`SELECT installation_fee::int AS installation FROM subscriptions WHERE company_id=$1`, [ok.data.company.id]))[0];
    verifier("un changement de tarif ne réécrit pas l'abonnement déjà souscrit", apres?.installation === 250000);
    await q(`UPDATE subscription_plans SET installation_fee = 250000 WHERE id=$1`, [business.id]);
  }

  section("SUPER-ADMIN — PLANS SAAS");
  {
    const liste = await appel("GET", "/super-admin/plans", tSuper);
    const business = (liste.data || []).find((p) => p.commercial_code === "business");
    verifier("la liste des plans expose installation_fee", business && Number(business.installation_fee) === 250000);

    const maj = await appel("PUT", `/super-admin/plans/${business.id}`, tSuper, { ...business, installation_fee: 275000 });
    verifier("le super-admin modifie les frais d'installation", maj.status === 200 && Number(maj.data?.installation_fee) === 275000,
      `statut ${maj.status} ${maj.data?.installation_fee}`);

    // Un écran qui n'envoie pas les nouveaux champs ne doit pas les effacer.
    const { installation_fee, commercial_name, is_public, is_recommended, excluded_modules, highlights, ...ancienFormat } = maj.data;
    void installation_fee; void commercial_name; void is_public; void is_recommended; void excluded_modules; void highlights;
    const ancienEcran = await appel("PUT", `/super-admin/plans/${business.id}`, tSuper, { ...ancienFormat, price_monthly: 50000 });
    const relu = (await q(`SELECT installation_fee::int AS i, commercial_name, is_public, is_recommended, jsonb_array_length(highlights) AS n FROM subscription_plans WHERE id=$1`, [business.id]))[0];
    verifier("un envoi sans les champs commerciaux ne les efface pas",
      ancienEcran.status === 200 && relu.i === 275000 && relu.commercial_name === "Business" && relu.is_public === true && relu.is_recommended === true && relu.n === 5,
      JSON.stringify(relu));

    const exclus = await appel("PUT", `/super-admin/plans/${business.id}`, tSuper, { ...maj.data, excluded_modules: "cameras, Marketing, inconnu" });
    verifier("les modules exclus saisis en texte sont normalisés et filtrés",
      JSON.stringify(exclus.data?.excluded_modules) === JSON.stringify(["cameras", "marketing"]), JSON.stringify(exclus.data?.excluded_modules));
    await appel("PUT", `/super-admin/plans/${business.id}`, tSuper, { ...maj.data, excluded_modules: [], installation_fee: 250000 });

    const creation = await appel("POST", "/super-admin/plans", tSuper, { name: "Offre test", price_monthly: 1000, installation_fee: 5000 });
    verifier("un plan créé n'est PAS public par défaut", creation.status === 201 && creation.data?.is_public === false,
      `statut ${creation.status} public=${creation.data?.is_public}`);
    const publiquesApres = await appel("GET", "/public/plans", null);
    verifier("… donc absent de la page d'inscription", !(publiquesApres.data || []).some((p) => p.name === "Offre test"));

    const nonSuper = await appel("PUT", `/super-admin/plans/${business.id}`, jeton({ id: 1, role: "admin", company_id: 1 }), { installation_fee: 1 });
    verifier("un non super-admin ne modifie pas les plans", nonSuper.status === 403 || nonSuper.status === 401, `statut ${nonSuper.status}`);
  }

  await terminer();
}

main().catch(async (e) => {
  console.error(e);
  const { bilan } = require("./_outils");
  bilan.echoues += 1;
  await terminer();
});
