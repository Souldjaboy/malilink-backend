"use strict";

/**
 * Assistant IA MaliLink — OpenRouter
 * Router Express monté sur /ai dans server.js (même pattern factory que
 * routes/delivery.js et routes/education.js).
 *
 * Sécurité :
 * - identité (id, rôle, company_id, tenant) lue UNIQUEMENT depuis le JWT
 *   (req.user), jamais depuis le body de la requête
 * - chaque espace charge un contexte strictement scopé :
 *   un client ne voit que ses commandes, un livreur que ses missions,
 *   un professeur que ses classes, un parent que ses enfants,
 *   une entreprise que ses propres données
 * - la clé OpenRouter n'apparaît jamais dans les réponses ni les logs
 */

const express = require("express");
const { createRateLimiter } = require("../middleware/rateLimit");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 30000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 8;
const AI_UNAVAILABLE_MESSAGE =
  "L’assistant IA est temporairement indisponible. Réessayez dans quelques instants.";

// Rôles staff éducation (alignés sur routes/education.js)
const EDUCATION_STAFF_ROLES = ["super_admin", "school_admin", "director", "secretary", "supervisor"];
// Rôles staff entreprise généraux
const BUSINESS_STAFF_ROLES = [
  "super_admin",
  "admin",
  "direction",
  "directeur",
  "comptable",
  "caissier",
  "vendeur",
  "responsable_entrepot",
  "chef_entrepot"
];

const KNOWN_SPACES = [
  "business_dashboard",
  "marketplace_client",
  "delivery_driver",
  "delivery_client",
  "education",
  "education_admin",
  "education_teacher",
  "education_parent",
  "education_student",
  "support"
];

function isSuperAdminUser(user) {
  return (
    user?.is_super_admin === true ||
    user?.is_super_admin === "true" ||
    user?.is_super_admin === 1 ||
    String(user?.role || "").toLowerCase() === "super_admin"
  );
}

function normalizeRole(user) {
  return String(user?.role || "").toLowerCase();
}

/**
 * Résout l'espace effectif à partir de l'espace demandé et du rôle réel.
 * Le rôle du JWT a toujours le dernier mot : un client qui demande
 * business_dashboard est ramené à marketplace_client.
 */
function resolveSpace(requestedSpace, user) {
  const space = KNOWN_SPACES.includes(requestedSpace) ? requestedSpace : "support";
  const role = normalizeRole(user);
  const isClient = role === "customer" || role === "client";

  if (space === "education" || space.startsWith("education_")) {
    if (EDUCATION_STAFF_ROLES.includes(role)) return "education_admin";
    if (role === "teacher") return "education_teacher";
    if (role === "parent") return "education_parent";
    if (role === "student") return "education_student";
    return "support";
  }

  if (space === "business_dashboard") {
    if (isClient) return "marketplace_client";
    if (BUSINESS_STAFF_ROLES.includes(role) || isSuperAdminUser(user)) return "business_dashboard";
    return "support";
  }

  // delivery_driver / delivery_client / marketplace_client / support :
  // toujours autorisés car scopés à l'utilisateur lui-même.
  return space;
}

module.exports = function createAiRouter({ pool, authenticateToken }) {
  const router = express.Router();

  router.use(authenticateToken);

  const chatLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    message: "Trop de requêtes vers l’assistant IA. Patientez un instant."
  });

  /* ---------- Connaissance des modules (ai_module_knowledge) ---------- */

  let knowledgeActiveFilterCache = null;

  async function getKnowledgeActiveFilter() {
    if (knowledgeActiveFilterCache !== null) return knowledgeActiveFilterCache;
    try {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='ai_module_knowledge' AND column_name IN ('active','is_active')`
      );
      const names = rows.map((row) => row.column_name);
      knowledgeActiveFilterCache = names.includes("active")
        ? "active=true AND"
        : names.includes("is_active")
          ? "is_active=true AND"
          : "";
    } catch (error) {
      knowledgeActiveFilterCache = "";
    }
    return knowledgeActiveFilterCache;
  }

  async function getModuleKnowledge(message) {
    try {
      const activeFilter = await getKnowledgeActiveFilter();
      const search = `%${String(message || "").trim().slice(0, 80)}%`;
      const { rows } = await pool.query(
        `SELECT module_key, module_name, description, role_explanation, pages, examples
         FROM ai_module_knowledge
         WHERE ${activeFilter}
           (module_key ILIKE $1 OR module_name ILIKE $1
            OR description ILIKE $1 OR role_explanation ILIKE $1)
         ORDER BY module_name ASC
         LIMIT 5`,
        [search]
      );
      return rows;
    } catch (error) {
      return [];
    }
  }

  /* ---------- Contextes sécurisés par espace ---------- */

  async function safeQuery(text, values) {
    try {
      const { rows } = await pool.query(text, values);
      return rows;
    } catch (error) {
      // Table ou colonne absente selon l'installation : on ignore proprement.
      return null;
    }
  }

  async function buildBusinessContext(user) {
    const companyId = user?.company_id || null;
    if (!companyId) {
      return { note: "Aucune entreprise associée à ce compte (vue plateforme)." };
    }

    const [products, salesToday, marketplaceOrders, deliveries] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(stock),0)::int AS stock_total,
                COUNT(*) FILTER (WHERE stock <= minimum_stock)::int AS alertes_stock
         FROM products WHERE company_id=$1`,
        [companyId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS ventes, COALESCE(SUM(total_amount),0)::numeric AS total_fcfa
         FROM sales WHERE company_id=$1 AND DATE(created_at)=CURRENT_DATE`,
        [companyId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('pending_payment','pending','en_attente'))::int AS en_attente,
                COALESCE(SUM(total_amount),0)::numeric AS total_fcfa
         FROM marketplace_orders WHERE vendor_company_id=$1`,
        [companyId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='en_attente')::int AS en_attente,
                COUNT(*) FILTER (WHERE status IN ('acceptee','recuperee','en_route'))::int AS en_cours
         FROM delivery_missions WHERE company_id=$1`,
        [companyId]
      )
    ]);

    return {
      produits: products?.[0] || null,
      ventes_du_jour: salesToday?.[0] || null,
      commandes_marketplace: marketplaceOrders?.[0] || null,
      livraisons: deliveries?.[0] || null
    };
  }

  async function buildMarketplaceClientContext(user) {
    const [summary, lastOrders] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('pending_payment','pending','en_attente'))::int AS en_attente,
                COUNT(*) FILTER (WHERE status IN ('delivered','livree','completed','terminee'))::int AS livrees
         FROM marketplace_orders WHERE customer_user_id=$1`,
        [user.id]
      ),
      safeQuery(
        `SELECT order_number, status, payment_status, total_amount, created_at
         FROM marketplace_orders WHERE customer_user_id=$1
         ORDER BY id DESC LIMIT 5`,
        [user.id]
      )
    ]);

    return {
      resume_commandes: summary?.[0] || null,
      dernieres_commandes: lastOrders || []
    };
  }

  async function buildDeliveryDriverContext(user) {
    const drivers = await safeQuery(
      `SELECT id, driver_type, vehicle_type, is_available, is_verified, status,
              rating_avg, rating_count
       FROM delivery_drivers WHERE user_id=$1`,
      [user.id]
    );
    const driver = drivers?.[0];

    if (!driver) {
      return {
        note: "Cet utilisateur n'est pas encore inscrit comme livreur. Orienter vers /livreur/inscription."
      };
    }

    const [missions, lastMissions] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('acceptee','recuperee','en_route'))::int AS en_cours,
                COUNT(*) FILTER (WHERE status IN ('livree','terminee'))::int AS terminees,
                COALESCE(SUM(price_final) FILTER (WHERE status IN ('livree','terminee')),0)::numeric AS revenus_fcfa
         FROM delivery_missions WHERE driver_id=$1`,
        [driver.id]
      ),
      safeQuery(
        `SELECT mission_type, status, pickup_address, dropoff_address, price_final, created_at
         FROM delivery_missions WHERE driver_id=$1
         ORDER BY id DESC LIMIT 5`,
        [driver.id]
      )
    ]);

    return {
      profil_livreur: driver,
      resume_missions: missions?.[0] || null,
      dernieres_missions: lastMissions || []
    };
  }

  async function buildDeliveryClientContext(user) {
    const [summary, lastMissions] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='en_attente')::int AS en_attente,
                COUNT(*) FILTER (WHERE status IN ('acceptee','recuperee','en_route'))::int AS en_cours,
                COUNT(*) FILTER (WHERE status IN ('livree','terminee'))::int AS livrees
         FROM delivery_missions WHERE client_user_id=$1`,
        [user.id]
      ),
      safeQuery(
        `SELECT mission_type, status, pickup_address, dropoff_address,
                price_estimate, price_final, created_at
         FROM delivery_missions WHERE client_user_id=$1
         ORDER BY id DESC LIMIT 5`,
        [user.id]
      )
    ]);

    return {
      resume_livraisons: summary?.[0] || null,
      dernieres_livraisons: lastMissions || []
    };
  }

  async function buildEducationAdminContext(user) {
    const companyId = user?.company_id || null;
    if (!companyId) return { note: "Aucune école associée à ce compte." };

    const [students, classes, attendanceToday] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='actif')::int AS actifs
         FROM edu_students WHERE company_id=$1`,
        [companyId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS total FROM edu_classes WHERE company_id=$1`,
        [companyId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS pointages_du_jour
         FROM edu_attendance WHERE company_id=$1 AND DATE(created_at)=CURRENT_DATE`,
        [companyId]
      )
    ]);

    return {
      eleves: students?.[0] || null,
      classes: classes?.[0] || null,
      presences: attendanceToday?.[0] || null
    };
  }

  async function buildEducationTeacherContext(user) {
    const companyId = user?.company_id || null;
    const classes = await safeQuery(
      `SELECT DISTINCT c.id, c.name
       FROM edu_teacher_assignments a
       JOIN edu_classes c ON c.id=a.class_id
       WHERE a.teacher_user_id=$1 AND ($2::int IS NULL OR a.company_id=$2)
       ORDER BY c.name ASC LIMIT 20`,
      [user.id, companyId]
    );

    return {
      mes_classes: classes || [],
      note: classes?.length ? undefined : "Aucune classe assignée à ce professeur."
    };
  }

  async function buildEducationParentContext(user) {
    const children = await safeQuery(
      `SELECT s.first_name, s.last_name, s.status, c.name AS class_name
       FROM edu_student_parents sp
       JOIN edu_students s ON s.id=sp.student_id
       LEFT JOIN edu_classes c ON c.id=s.class_id
       WHERE sp.parent_user_id=$1
       ORDER BY s.last_name ASC LIMIT 20`,
      [user.id]
    );

    return {
      mes_enfants: children || [],
      note: children?.length ? undefined : "Aucun enfant relié à ce compte parent."
    };
  }

  async function buildEducationStudentContext(user) {
    const students = await safeQuery(
      `SELECT s.first_name, s.last_name, s.matricule, s.status, c.name AS class_name
       FROM edu_students s
       LEFT JOIN edu_classes c ON c.id=s.class_id
       WHERE s.user_id=$1 LIMIT 1`,
      [user.id]
    );

    return {
      mon_profil_eleve: students?.[0] || null,
      note: students?.length ? undefined : "Aucun profil élève relié à ce compte."
    };
  }

  async function buildContext(space, user) {
    switch (space) {
      case "business_dashboard":
        return buildBusinessContext(user);
      case "marketplace_client":
        return buildMarketplaceClientContext(user);
      case "delivery_driver":
        return buildDeliveryDriverContext(user);
      case "delivery_client":
        return buildDeliveryClientContext(user);
      case "education_admin":
        return buildEducationAdminContext(user);
      case "education_teacher":
        return buildEducationTeacherContext(user);
      case "education_parent":
        return buildEducationParentContext(user);
      case "education_student":
        return buildEducationStudentContext(user);
      default:
        return {};
    }
  }

  /* ---------- Prompt système ---------- */

  const SPACE_DESCRIPTIONS = {
    business_dashboard:
      "Espace entreprise : aide au pilotage (ventes, stocks, commandes marketplace, livraisons, modules MaliLink).",
    marketplace_client:
      "Espace client marketplace : aide sur ses propres commandes, le suivi, les paiements et l'utilisation de MaliLink.",
    delivery_driver:
      "Espace livreur/coursier/taxi : aide sur ses missions, revenus, disponibilité et fonctionnement de l'app livreur.",
    delivery_client:
      "Espace livraison client : aide pour demander une livraison, suivre ses colis et comprendre les frais.",
    education_admin:
      "Espace administration scolaire : aide sur la gestion des élèves, classes, présences, notes et paiements.",
    education_teacher: "Espace professeur : aide sur ses classes, présences et notes.",
    education_parent: "Espace parent : aide sur la scolarité de ses enfants uniquement.",
    education_student: "Espace élève : aide sur son propre parcours scolaire.",
    support: "Support général MaliLink : explique le fonctionnement de la plateforme et de ses modules."
  };

  function buildSystemPrompt(space, user, context, knowledge) {
    const role = normalizeRole(user) || "utilisateur";
    const knowledgeText = knowledge.length
      ? knowledge
          .map((k) => `- ${k.module_name} : ${k.role_explanation || k.description || ""}`)
          .join("\n")
      : "- (aucune fiche module correspondante)";

    return [
      "Tu es l'assistant IA officiel de MaliLink Global, la super-plateforme africaine (marketplace, livraison, éducation, restaurant, immobilier, automobile, POS, comptabilité).",
      "Tu réponds TOUJOURS en français, de façon simple, professionnelle et chaleureuse. Utilise le FCFA pour les montants.",
      `Espace actuel : ${space}. ${SPACE_DESCRIPTIONS[space] || ""}`,
      `Rôle de l'utilisateur : ${role}.`,
      "RÈGLES DE SÉCURITÉ ABSOLUES :",
      "- Les données ci-dessous sont déjà filtrées pour cet utilisateur : ne mentionne JAMAIS de données d'autres entreprises, clients, livreurs, élèves ou parents.",
      "- Si on te demande des données d'un autre utilisateur ou d'une autre entreprise, refuse poliment.",
      "- N'invente jamais de chiffres : si une donnée n'est pas fournie, dis-le et indique la page MaliLink où la trouver.",
      "- Ne révèle jamais de clés, mots de passe, tokens ou détails techniques internes.",
      "Connaissance des modules MaliLink :",
      knowledgeText,
      "Données réelles de l'utilisateur (déjà sécurisées) :",
      JSON.stringify(context || {}, null, 2)
    ].join("\n");
  }

  function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
      .filter(
        (item) =>
          item &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" &&
          item.content.trim() !== ""
      )
      .slice(-MAX_HISTORY_MESSAGES)
      .map((item) => ({
        role: item.role,
        content: String(item.content).slice(0, MAX_MESSAGE_LENGTH)
      }));
  }

  /* ---------- Endpoint principal ---------- */

  router.post("/chat", chatLimiter, async (req, res) => {
    try {
      const rawMessage = req.body?.message;

      if (!rawMessage || String(rawMessage).trim() === "") {
        return res.status(400).json({ error: "Message obligatoire" });
      }

      const message = String(rawMessage).trim();
      if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
          error: `Message trop long (maximum ${MAX_MESSAGE_LENGTH} caractères).`
        });
      }

      const space = resolveSpace(String(req.body?.space || "support"), req.user);
      const history = sanitizeHistory(req.body?.history);

      const [context, knowledge] = await Promise.all([
        buildContext(space, req.user),
        getModuleKnowledge(message)
      ]);

      if (!process.env.OPENROUTER_API_KEY) {
        return res.json({ answer: AI_UNAVAILABLE_MESSAGE, space, fallback: true });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

      let aiResponse;
      try {
        aiResponse = await fetch(OPENROUTER_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://malilinkglobal.com",
            "X-Title": "MaliLink Global"
          },
          body: JSON.stringify({
            model: "openrouter/auto",
            messages: [
              { role: "system", content: buildSystemPrompt(space, req.user, context, knowledge) },
              ...history,
              { role: "user", content: message }
            ]
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      const payload = await aiResponse.json().catch(() => ({}));

      if (!aiResponse.ok) {
        console.error("ERREUR AI CHAT — OpenRouter statut :", aiResponse.status);
        return res.json({ answer: AI_UNAVAILABLE_MESSAGE, space, fallback: true });
      }

      const answer = payload?.choices?.[0]?.message?.content;

      if (!answer) {
        return res.json({ answer: AI_UNAVAILABLE_MESSAGE, space, fallback: true });
      }

      res.json({ answer, space });
    } catch (error) {
      // Jamais de détails sensibles (clé API, payload) dans les logs.
      console.error("ERREUR AI CHAT :", error?.name === "AbortError" ? "timeout OpenRouter" : error?.message);
      res.json({ answer: AI_UNAVAILABLE_MESSAGE, fallback: true });
    }
  });

  return router;
};
