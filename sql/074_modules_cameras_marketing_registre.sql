-- 074 — Enregistrement des deux modules génériques et fermeture par défaut.
--
-- Le moteur de permissions AUTORISE par défaut : sans ligne explicite à
-- false, « cameras » et « marketing » apparaîtraient immédiatement
-- chez Triangle WMS et HAFIYA, qui partagent ce dépôt. On pose donc une
-- ligne explicitement désactivée pour chaque société existante. Chaque
-- société pourra être ouverte ensuite, une par une.
--
-- Additive et idempotente. Ne réactive ni ne désactive jamais une société
-- dont le choix a déjà été posé à la main (updated_by non nul).

BEGIN;

-- ── Registre des modules ─────────────────────────────────────────────
INSERT INTO modules (module_key, module_name, description)
SELECT 'cameras', 'Caméras & Sécurité',
       'Inventaire et organisation des caméras de surveillance, par site.'
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE module_key = 'cameras');

INSERT INTO modules (module_key, module_name, description)
SELECT 'marketing', 'Marketing & Réseaux sociaux',
       'Comptes professionnels, publications, calendrier éditorial et campagnes de l''entreprise. Distinct de MaliLink Social.'
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE module_key = 'marketing');

-- ── Fermeture par défaut pour toutes les sociétés existantes ─────────
INSERT INTO company_modules (company_id, module_key, is_enabled, enabled)
SELECT c.id, m.cle, FALSE, FALSE
  FROM companies c
 CROSS JOIN (VALUES ('cameras'), ('marketing')) AS m(cle)
 WHERE NOT EXISTS (
   SELECT 1 FROM company_modules cm
    WHERE cm.company_id = c.id AND cm.module_key = m.cle
 );

-- ── Contrôle ─────────────────────────────────────────────────────────
DO $$
DECLARE
  societes INTEGER;
  fermees  INTEGER;
BEGIN
  SELECT COUNT(*) INTO societes FROM companies;
  SELECT COUNT(*) INTO fermees
    FROM company_modules
   WHERE module_key IN ('cameras', 'marketing')
     AND COALESCE(is_enabled, enabled, TRUE) = FALSE;

  RAISE NOTICE '074 : % société(s), % fermeture(s) posée(s) sur les deux nouveaux modules.',
    societes, fermees;

  IF societes > 0 AND fermees = 0 THEN
    RAISE WARNING '074 : aucune fermeture posée — vérifier que les nouveaux modules ne fuitent pas chez les autres produits.';
  END IF;
END $$;

COMMIT;
