-- 076 — Offres commerciales Starter / Business / Pro et frais d'installation.
--
-- Additive et idempotente. Aucun plan supprimé ni renommé, aucun abonnement
-- modifié, aucun prix existant changé.
--
-- Deux contraintes du schéma réel ont dicté la forme de cette migration :
--
--  1. ensureDefaultSubscriptionPlans() (server.js) RECRÉE « Essentiel »,
--     « Standard » et « Premium » dès que leur nom disparaît. Renommer ces
--     plans ferait réapparaître les anciens en double sur la page publique.
--     → Le nom interne (name) ne change pas ; le nom affiché vit dans
--       commercial_name.
--
--  2. subscriptions ne mémorise aucun montant, seulement plan_id : le prix
--     d'un renouvellement est lu sur le plan. Passer Standard de 30 000 à
--     50 000 augmenterait le prix de TOUS ses abonnés actuels.
--     → Starter réutilise l'actuel Essentiel (même prix : 15 000 F, aucun
--       effet sur ses abonnés). Business et Pro sont de NOUVEAUX plans.
--       Standard et Premium restent intacts pour leurs abonnés, simplement
--       retirés de l'offre publique (is_public = FALSE).

BEGIN;

-- ── Colonnes ──────────────────────────────────────────────────────────
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS installation_fee NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS commercial_name VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS commercial_code VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_recommended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS highlights JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 100;

COMMENT ON COLUMN subscription_plans.installation_fee IS
  'Frais d''installation : montant PONCTUEL, distinct de l''abonnement mensuel.';
COMMENT ON COLUMN subscription_plans.commercial_name IS
  'Nom affiché au client. Le champ name reste l''identifiant interne (ensureDefaultSubscriptionPlans s''appuie dessus).';
COMMENT ON COLUMN subscription_plans.is_public IS
  'Proposé à l''inscription. FALSE par défaut : un plan créé ou hérité n''apparaît publiquement que sur décision.';

-- Un code commercial au plus par plan, et un plan au plus par code.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_subscription_plans_commercial_code
  ON subscription_plans (commercial_code) WHERE commercial_code <> '';

-- Montant d'installation convenu, figé sur l'abonnement : un changement de
-- tarif ultérieur ne réécrit pas ce qui a été annoncé au client.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS installation_fee NUMERIC(14,2);
COMMENT ON COLUMN subscriptions.installation_fee IS
  'Frais d''installation annoncés à la souscription (instantané). NULL pour les abonnements antérieurs à la 076.';

-- ── Starter = l'actuel « Essentiel » (même prix, aucun abonné touché) ───
DO $$
DECLARE
  cible INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM subscription_plans WHERE commercial_code = 'starter') THEN
    RETURN;
  END IF;
  SELECT id INTO cible FROM subscription_plans WHERE LOWER(TRIM(name)) = 'essentiel' ORDER BY id LIMIT 1;
  IF cible IS NULL THEN
    SELECT id INTO cible FROM subscription_plans WHERE LOWER(TRIM(name)) = 'starter' ORDER BY id LIMIT 1;
  END IF;
  IF cible IS NULL THEN
    RAISE WARNING '076 : aucun plan Essentiel/Starter trouvé — Starter non posé.';
    RETURN;
  END IF;
  UPDATE subscription_plans SET
    commercial_code = 'starter',
    commercial_name = 'Starter',
    installation_fee = 75000,
    is_public = TRUE,
    display_order = 10,
    highlights = '["1 point de vente", "Caisse et stock", "Ventes et reçus", "Support de base"]'::jsonb
  WHERE id = cible;
  RAISE NOTICE '076 : Starter = plan % (prix inchangé).', cible;
END $$;

-- ── Business et Pro : NOUVEAUX plans, limites reprises de Standard/Premium ──
INSERT INTO subscription_plans (
  name, commercial_code, commercial_name, price_monthly, monthly_price, installation_fee,
  currency, duration_days, billing_cycle, trial_days, is_active, is_public, is_recommended,
  display_order, highlights, max_users, max_warehouses, max_products, max_cash_registers,
  max_sales_per_month, max_movements_monthly, max_stock_movements_per_month,
  max_modules_allowed, modules, excluded_modules
)
SELECT 'Business', 'business', 'Business', 50000, 50000, 250000,
       'FCFA', 30, 'monthly', COALESCE(s.trial_days, 15), TRUE, TRUE, TRUE,
       20, '["Multi-utilisateurs", "Stock, caisse et clients", "Rapports et tableau de bord", "Sauvegardes et mises à jour", "Formation initiale incluse"]'::jsonb,
       COALESCE(s.max_users, 20), COALESCE(s.max_warehouses, 3), COALESCE(s.max_products, 3000),
       COALESCE(s.max_cash_registers, 0), COALESCE(s.max_sales_per_month, 0),
       COALESCE(s.max_movements_monthly, 0), COALESCE(s.max_stock_movements_per_month, 0),
       COALESCE(NULLIF(s.max_modules_allowed, 0), 12), COALESCE(s.modules, 'all'), '{}'
  FROM (SELECT 1) AS un
  LEFT JOIN LATERAL (SELECT * FROM subscription_plans WHERE LOWER(TRIM(name)) = 'standard' ORDER BY id LIMIT 1) s ON TRUE
 WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE commercial_code = 'business');

INSERT INTO subscription_plans (
  name, commercial_code, commercial_name, price_monthly, monthly_price, installation_fee,
  currency, duration_days, billing_cycle, trial_days, is_active, is_public, is_recommended,
  display_order, highlights, max_users, max_warehouses, max_products, max_cash_registers,
  max_sales_per_month, max_movements_monthly, max_stock_movements_per_month,
  max_modules_allowed, modules, excluded_modules
)
SELECT 'Pro', 'pro', 'Pro', 100000, 100000, 400000,
       'FCFA', 30, 'monthly', COALESCE(p.trial_days, 15), TRUE, TRUE, FALSE,
       30, '["Plusieurs sites", "Fonctions avancées", "Support prioritaire", "Personnalisation renforcée"]'::jsonb,
       COALESCE(p.max_users, 30), COALESCE(p.max_warehouses, 10), COALESCE(p.max_products, 10000),
       COALESCE(p.max_cash_registers, 0), COALESCE(p.max_sales_per_month, 0),
       COALESCE(p.max_movements_monthly, 0), COALESCE(p.max_stock_movements_per_month, 0),
       COALESCE(NULLIF(p.max_modules_allowed, 0), 999), COALESCE(p.modules, 'all'), '{}'
  FROM (SELECT 1) AS un
  LEFT JOIN LATERAL (SELECT * FROM subscription_plans WHERE LOWER(TRIM(name)) = 'premium' ORDER BY id LIMIT 1) p ON TRUE
 WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE commercial_code = 'pro');

-- ── Anciennes offres : conservées pour leurs abonnés, hors offre publique ──
-- is_public naît à FALSE : rien à retirer. On ne touche jamais à is_public
-- ici, pour qu'un rejeu ne dé-publie pas un plan rendu public depuis.
UPDATE subscription_plans
   SET commercial_name = name || CASE WHEN COALESCE(price_monthly, 0) = 0 THEN ' (interne)' ELSE ' (ancienne offre)' END
 WHERE commercial_code = '' AND commercial_name = '';

-- ── Contrôle ─────────────────────────────────────────────────────────
DO $$
DECLARE
  publics TEXT;
  abonnes_standard INTEGER;
BEGIN
  SELECT string_agg(commercial_name || ' ' || price_monthly::int || ' F + ' || installation_fee::int || ' F', ' | ' ORDER BY display_order)
    INTO publics FROM subscription_plans WHERE is_public;
  RAISE NOTICE '076 : offres publiques — %', publics;
  SELECT COUNT(*) INTO abonnes_standard
    FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
   WHERE LOWER(p.name) IN ('standard', 'premium');
  RAISE NOTICE '076 : % abonnement(s) sur Standard/Premium, inchangé(s).', abonnes_standard;
END $$;

COMMIT;
