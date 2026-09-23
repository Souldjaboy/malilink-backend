"use strict";

/**
 * P4 — Profil public MaliLink et annuaire /entreprises.
 *
 * Opt-in strict, aucune donnée privée publiée d'office, liens de réseaux
 * vérifiés, isolation entre entreprises, droits, annuaire limité aux profils
 * publics ET listés, sitemap, et plus aucune fuite d'un profil non publié sur
 * les fiches produit.
 */

const { q, appel, jeton, jetonSuperAdmin, verifier, section, creerSociete, terminer } = require("./_outils");

const PROFIL_A = {
  slug: "ada-service-essai",
  description: "Boutique de téléphonie et d'accessoires à Bamako, réparation et conseils.",
  city: "Bamako",
  quartier: "ACI 2000",
  country: "Mali",
  address_line: "Rue 300",
  opening_hours: "Lun–Sam 8h–19h",
  public_phone: "+223 70 00 00 01",
  public_email: "contact@ada-essai.test",
  website: "https://ada-essai.test",
  social_links: { facebook: "https://www.facebook.com/ada.essai", whatsapp: "https://wa.me/22370000001" },
  services: [{ name: "Réparation de téléphones", description: "Écrans, batteries." }, { name: "Accessoires" }],
};

async function produitPublie(companyId, titre) {
  return (await q(
    `INSERT INTO marketplace_products (company_id, title, price, status, is_published, category)
     VALUES ($1, $2, 15000, 'published', true, 'Accessoires') RETURNING id`, [companyId, titre]))[0].id;
}

async function main() {
  const tSuper = jetonSuperAdmin();
  const a = await creerSociete({ nom: "ADA Essai", type: "Commerce/Boutique", planCode: "starter" });
  const b = await creerSociete({ nom: "Resto Essai", type: "restaurant", planCode: "business" });
  const c = await creerSociete({ nom: "Brouillon Essai", type: "commerce", planCode: "business" });
  await q(`UPDATE companies SET email = 'direction-privee@ada-essai.test' WHERE id = $1`, [a.id]);
  await q(`INSERT INTO company_settings (company_id, company_name, phone, email, city, description, facebook_url)
           VALUES ($1, 'ADA Essai', '+223 70 99 99 99', 'compta-privee@ada-essai.test', 'Bamako',
                   'Description saisie dans les paramètres.', 'https://www.facebook.com/ada.essai')`, [a.id]);
  const produitA = await produitPublie(a.id, "Coque renforcée");

  section("PAR DÉFAUT : RIEN N'EST PUBLIC");
  {
    const r = await appel("GET", "/company/public-profile", a.token);
    verifier("lecture du profil : 200", r.status === 200, `statut ${r.status}`);
    verifier("aucun profil existant, non public", r.data?.profile?.exists === false && r.data?.profile?.is_public === false);
    verifier("suggestions proposées depuis les paramètres (téléphone, ville, Facebook)",
      r.data?.suggestions?.public_phone === "+223 70 99 99 99" && r.data?.suggestions?.city === "Bamako"
      && r.data?.suggestions?.social_links?.facebook === "https://www.facebook.com/ada.essai");
    verifier("… mais rien n'est enregistré d'office",
      (await q(`SELECT 1 FROM company_public_profile WHERE company_id = $1`, [a.id])).length === 0);
    verifier("disponible sur l'offre Starter (pas une option payante)", r.status === 200);
    verifier("ce qu'il manque pour publier est annoncé", Array.isArray(r.data?.missing_to_publish) && r.data.missing_to_publish.length > 0);
    const p = await appel("GET", `/public/companies/${a.id}`);
    verifier("page publique par identifiant : 404", p.status === 404, `statut ${p.status}`);
  }

  section("BROUILLON : ENREGISTRÉ, TOUJOURS PRIVÉ");
  {
    const r = await appel("PUT", "/company/public-profile", a.token, { ...PROFIL_A, is_public: false });
    verifier("brouillon enregistré", r.status === 200 && r.data?.profile?.is_public === false, JSON.stringify(r.data));
    verifier("page publique : 404", (await appel("GET", `/public/companies/${PROFIL_A.slug}`)).status === 404);
    const annuaire = (await appel("GET", "/public/companies")).data;
    verifier("absent de l'annuaire", !annuaire.companies.some((e) => e.company_id === a.id));
    const plan = (await appel("GET", "/public/sitemap")).data;
    verifier("absent du sitemap", !plan.companies.some((e) => e.path.includes(PROFIL_A.slug)));
    const fiche = (await appel("GET", `/public/products/${produitA}`)).data?.product;
    verifier("fiche produit : ni slug, ni ville, ni quartier d'un profil non publié",
      fiche && fiche.vendor.slug === "" && fiche.vendor.city === "" && fiche.vendor.quartier === "", JSON.stringify(fiche?.vendor));
    const fiche2 = (await appel("GET", `/marketplace/products/${produitA}`)).data;
    verifier("idem sur /marketplace/products/:id", fiche2 && fiche2.vendor.slug === "" && fiche2.vendor.city === "", JSON.stringify(fiche2?.vendor));
    const liste = (await appel("GET", `/marketplace/products`)).data;
    const dansListe = Array.isArray(liste) ? liste.find((x) => x.id === produitA) : null;
    verifier("idem sur la liste marketplace", dansListe && dansListe.vendor.city === "", JSON.stringify(dansListe?.vendor));
  }

  section("VALIDATIONS");
  {
    const essai = async (titre, corps, code = "PROFIL_INVALIDE") => {
      const r = await appel("PUT", "/company/public-profile", a.token, { ...PROFIL_A, ...corps });
      verifier(titre, r.status === 400 && r.data?.code === code, `statut ${r.status} ${JSON.stringify(r.data)}`);
    };
    await essai("lien « Facebook » vers un autre domaine : refusé", { social_links: { facebook: "https://facebook.com.piege.io/x" } });
    await essai("lien de réseau en http : refusé", { social_links: { instagram: "http://instagram.com/ada" } });
    await essai("réseau inconnu : refusé", { social_links: { myspace: "https://myspace.com/ada" } });
    await essai("site web javascript: refusé", { website: "javascript:alert(1)" });
    await essai("logo hors https / uploads : refusé", { logo_url: "http://exemple.test/logo.png" });
    await essai("adresse de page purement numérique : refusée", { slug: "12345" });
    await essai("afficher un téléphone vide : refusé", { public_phone: "", show_phone: true });
    await essai("email public invalide : refusé", { public_email: "pas-un-email" });
    await essai("publier sans ville : refusé", { city: "", is_public: true }, "PROFIL_INCOMPLET");
    await essai("publier avec une description trop courte : refusé", { description: "Trop court", is_public: true }, "PROFIL_INCOMPLET");
    const r = (await q(`SELECT is_public FROM company_public_profile WHERE company_id = $1`, [a.id]))[0];
    verifier("aucun essai refusé n'a publié le profil", r.is_public === false);
  }

  section("DROITS ET ISOLATION");
  {
    const caissier = (await q(
      `INSERT INTO users (fullname, email, password, role, company_id)
       VALUES ('Caissier', 'caissier-${a.id}@essai.test', 'x', 'caissier', $1) RETURNING id, role, company_id`, [a.id]))[0];
    const r = await appel("PUT", "/company/public-profile", jeton(caissier), { ...PROFIL_A, is_public: true });
    verifier("caissier (sans « Modifier » sur Paramètres) : 403", r.status === 403 && r.data?.code === "PERMISSION_DENIED", `statut ${r.status} ${JSON.stringify(r.data)}`);
    verifier("… et le profil n'est pas publié",
      (await q(`SELECT is_public FROM company_public_profile WHERE company_id = $1`, [a.id]))[0].is_public === false);

    const rb = await appel("PUT", "/company/public-profile", b.token, { ...PROFIL_A, slug: "resto-essai", company_id: a.id, is_public: false });
    verifier("B enregistre son profil (company_id du corps ignoré)", rb.status === 200, JSON.stringify(rb.data));
    const lignes = await q(`SELECT company_id, slug FROM company_public_profile ORDER BY company_id`);
    verifier("le profil de A n'a pas été touché par B",
      lignes.find((l) => l.company_id === a.id)?.slug === PROFIL_A.slug && lignes.find((l) => l.company_id === b.id)?.slug === "resto-essai");
    const pris = await appel("PUT", "/company/public-profile", b.token, { ...PROFIL_A, slug: "ADA-Service-Essai" });
    verifier("adresse déjà prise (casse ignorée) : 409 SLUG_PRIS", pris.status === 409 && pris.data?.code === "SLUG_PRIS", `statut ${pris.status}`);
    const lu = await appel("GET", "/company/public-profile", b.token);
    verifier("B ne lit que son profil", lu.data?.profile?.slug === "resto-essai");

    const sansSociete = await appel("GET", "/company/public-profile", tSuper);
    verifier("super admin sans entreprise active : 400", sansSociete.status === 400 && sansSociete.data?.code === "SOCIETE_REQUISE");
    const avecSociete = await appel("GET", "/company/public-profile", tSuper, null, { "x-active-company-id": String(a.id) });
    verifier("super admin avec entreprise active : lit son profil", avecSociete.data?.profile?.slug === PROFIL_A.slug);
  }

  section("PUBLICATION");
  {
    const r = await appel("PUT", "/company/public-profile", a.token, { ...PROFIL_A, is_public: true });
    verifier("publication : 200", r.status === 200 && r.data?.profile?.is_public === true, JSON.stringify(r.data));
    verifier("le message ne promet pas Google", /moteurs de recherche dépend/.test(r.data?.message || "") && !/garanti/i.test(r.data?.message || ""));
    verifier("URL publique /boutique/<slug>", r.data?.profile?.public_url === `/boutique/${PROFIL_A.slug}`);
    const date = (await q(`SELECT published_at FROM company_public_profile WHERE company_id = $1`, [a.id]))[0].published_at;
    verifier("date de mise en ligne posée", Boolean(date));

    const p = await appel("GET", `/public/companies/${PROFIL_A.slug}`);
    const e = p.data?.company;
    verifier("page publique : 200", p.status === 200, `statut ${p.status}`);
    verifier("téléphone et email masqués tant que non cochés", e?.phone === "" && e?.email === "");
    verifier("réseaux vérifiés publiés", e?.social_links?.facebook === "https://www.facebook.com/ada.essai" && e?.social_links?.whatsapp === "https://wa.me/22370000001");
    verifier("services publiés", e?.services?.length === 2 && e.services[0].name === "Réparation de téléphones");
    verifier("type d'activité issu du registre (Commerce / Boutique)", e?.activity?.key === "commerce" && e?.activity?.label === "Commerce / Boutique");
    verifier("horaires publiés tels que saisis", e?.opening_hours === "Lun–Sam 8h–19h");
    verifier("produits non montrés tant que non cochés", p.data?.products?.length === 0 && e?.products_public === false);

    const brut = JSON.stringify(p.data);
    verifier("aucune donnée privée : ni email de direction, ni paramètres internes",
      !brut.includes("direction-privee@") && !brut.includes("compta-privee@") && !brut.includes("+223 70 99 99 99"));
    verifier("aucun champ interne (updated_by, tenant_id, show_*, public_*)",
      !/"(updated_by|tenant_id|show_phone|show_email|public_phone|public_email|listed_in_directory)"/.test(brut));

    await appel("PUT", "/company/public-profile", a.token, { ...PROFIL_A, is_public: true, show_phone: true, show_products: true });
    const p2 = (await appel("GET", `/public/companies/${PROFIL_A.slug}`)).data;
    verifier("téléphone affiché une fois coché, email toujours masqué", p2.company.phone === PROFIL_A.public_phone && p2.company.email === "");
    verifier("produits publiés affichés une fois coché", p2.products.some((x) => x.id === produitA));
    const date2 = (await q(`SELECT published_at FROM company_public_profile WHERE company_id = $1`, [a.id]))[0].published_at;
    verifier("la date de mise en ligne ne bouge pas à chaque modification", String(date2) === String(date));
    const fiche = (await appel("GET", `/public/products/${produitA}`)).data.product;
    verifier("fiche produit : vendeur relié à la page publique", fiche.vendor.slug === PROFIL_A.slug && fiche.vendor.city === "Bamako");
    const plan = (await appel("GET", "/public/sitemap")).data;
    verifier("présent dans le sitemap", plan.companies.some((x) => x.path === `/boutique/${PROFIL_A.slug}`));
  }

  section("ANNUAIRE");
  {
    await appel("PUT", "/company/public-profile", b.token, {
      slug: "resto-essai", city: "Kayes", is_public: true, listed_in_directory: false,
      description: "Restaurant de cuisine malienne, grillades et jus locaux à Kayes.",
    });
    await appel("PUT", "/company/public-profile", c.token, {
      slug: "brouillon-essai", city: "Bamako", is_public: false,
      description: "Entreprise en préparation, pas encore publiée sur MaliLink.",
    });
    const d = (await appel("GET", "/public/companies")).data;
    const ids = d.companies.map((x) => x.company_id);
    verifier("profil public et listé : présent", ids.includes(a.id));
    verifier("profil public mais hors annuaire : absent", !ids.includes(b.id));
    verifier("… sa page reste accessible par lien", (await appel("GET", "/public/companies/resto-essai")).status === 200);
    verifier("brouillon : absent", !ids.includes(c.id));
    const fa = d.companies.find((x) => x.company_id === a.id);
    verifier("fiche d'annuaire : activité, ville, téléphone coché, nombre de produits",
      fa?.activity?.label === "Commerce / Boutique" && fa.city === "Bamako" && fa.phone === PROFIL_A.public_phone && fa.products_count === 1,
      JSON.stringify(fa));
    verifier("facettes : uniquement ce qui existe", d.facets.cities.every((v) => v.total > 0) && !d.facets.cities.some((v) => v.name === "Kayes"));
    verifier("filtre ville", (await appel("GET", "/public/companies?ville=bamako")).data.companies.some((x) => x.company_id === a.id)
      && (await appel("GET", "/public/companies?ville=kayes")).data.total === 0);
    verifier("filtre activité", (await appel("GET", "/public/companies?activite=commerce")).data.total >= 1
      && (await appel("GET", "/public/companies?activite=restaurant")).data.total === 0);
    verifier("recherche dans les services", (await appel("GET", `/public/companies?q=${encodeURIComponent("réparation")}`)).data.companies.some((x) => x.company_id === a.id));
    const page = (await appel("GET", "/public/companies?limit=1&page=99")).data;
    verifier("pagination bornée", page.per_page === 1 && page.companies.length === 0 && page.pages >= 1);

    await q(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [a.id]);
    verifier("entreprise suspendue : page 404", (await appel("GET", `/public/companies/${PROFIL_A.slug}`)).status === 404);
    verifier("entreprise suspendue : hors annuaire", !(await appel("GET", "/public/companies")).data.companies.some((x) => x.company_id === a.id));
    await q(`UPDATE companies SET status = 'active' WHERE id = $1`, [a.id]);
  }

  section("RETRAIT");
  {
    const r = await appel("PUT", "/company/public-profile", a.token, { ...PROFIL_A, is_public: false });
    verifier("retrait : 200", r.status === 200 && r.data?.profile?.is_public === false);
    verifier("le message annonce le retrait et son délai", /retiré/.test(r.data?.message || "") && /sous une minute/.test(r.data?.message || ""), r.data?.message);
    verifier("page : 404", (await appel("GET", `/public/companies/${PROFIL_A.slug}`)).status === 404);
    verifier("annuaire : absent", !(await appel("GET", "/public/companies")).data.companies.some((x) => x.company_id === a.id));
    verifier("date de mise en ligne effacée",
      (await q(`SELECT published_at FROM company_public_profile WHERE company_id = $1`, [a.id]))[0].published_at === null);
    const journal = (await q(
      `SELECT action FROM audit_logs WHERE company_id = $1 AND entity_type = 'company_public_profile' ORDER BY id`, [a.id])).map((l) => l.action);
    verifier("journal : publication puis retrait tracés",
      journal.includes("profil_public_publie") && journal.at(-1) === "profil_public_retire", JSON.stringify(journal));
  }

  await terminer();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
