-- 075 — Accès effectif : provenance des décisions de modules, modules exclus par plan.
--
-- Additive et idempotente. Aucune ligne supprimée, aucun module réactivé.
--
-- 1. company_modules.source : qui a posé la décision.
--    Sans cette colonne, une ligne « activé » écrite automatiquement à
--    l'inscription était indiscernable d'un choix délibéré du super-admin.
--    Or seul le second doit résister aux recalculs, et primer sur le plan.
--      super_admin  décision du super-admin — prioritaire, jamais recalculée
--      inscription  posée à l'inscription (ancien comportement : tout activé)
--      societe      réglage de l'administrateur de l'entreprise (sous-modules)
--      profil       posée par l'outil d'alignement sur le profil métier
--      ''           ancienne ligne de provenance inconnue
--
-- 2. subscription_plans.excluded_modules : modules que l'offre n'inclut pas.
--    Une société sur cette offre ne les voit pas, sauf si le super-admin les
--    lui accorde (company_modules.source = 'super_admin'). L'offre elle-même
--    n'est jamais modifiée par une dérogation.

BEGIN;

ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT '';

COMMENT ON COLUMN company_modules.source IS
  'Provenance de la décision : super_admin (prioritaire, prime sur le plan) | inscription | societe | profil | '''' (inconnue).';

-- Décisions déjà prises par un super-admin : on les reconnaît à leur auteur.
UPDATE company_modules cm
   SET source = 'super_admin'
  FROM users u
 WHERE cm.updated_by = u.id
   AND (u.is_super_admin = TRUE OR LOWER(COALESCE(u.role, '')) = 'super_admin')
   AND cm.source = '';

-- Lignes écrites par un membre de la société elle-même : à l'inscription pour
-- les modules principaux (un administrateur d'entreprise ne peut pas les
-- modifier), par réglage pour les sous-modules.
UPDATE company_modules cm
   SET source = CASE WHEN cm.module_key LIKE '%.%' THEN 'societe' ELSE 'inscription' END
  FROM users u
 WHERE cm.updated_by = u.id
   AND u.company_id = cm.company_id
   AND COALESCE(u.is_super_admin, FALSE) = FALSE
   AND cm.source = '';

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS excluded_modules TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN subscription_plans.excluded_modules IS
  'Modules non inclus dans l''offre. Une dérogation super-admin par société (company_modules.source = super_admin) prime.';

-- L'offre d'entrée n'inclut ni caméras ni marketing. On ne touche qu'à une
-- offre dont la liste est encore vide : un réglage déjà fait est respecté.
UPDATE subscription_plans
   SET excluded_modules = ARRAY['cameras', 'marketing']
 WHERE LOWER(TRIM(name)) IN ('essentiel', 'starter')
   AND excluded_modules = '{}';

CREATE INDEX IF NOT EXISTS idx_company_modules_company ON company_modules (company_id);

-- ── Contrôle ─────────────────────────────────────────────────────────
DO $$
DECLARE
  sa INTEGER; ins INTEGER; inconnues INTEGER;
BEGIN
  SELECT COUNT(*) FILTER (WHERE source = 'super_admin'),
         COUNT(*) FILTER (WHERE source = 'inscription'),
         COUNT(*) FILTER (WHERE source = '')
    INTO sa, ins, inconnues
    FROM company_modules;
  RAISE NOTICE '075 : provenance — % décision(s) super-admin, % d''inscription, % inconnue(s).', sa, ins, inconnues;
END $$;

COMMIT;
