-- 087 — MaliLink Éducation : bulletins professionnels et documents vérifiables.
--
-- Additive. Le bulletin garde la classe et les statistiques de la classe au
-- moment de sa génération (un élève qui change de classe ne fausse pas un
-- bulletin déjà émis). Chaque bulletin porte un jeton de vérification
-- (edu_document_verifications, doc_type = 'bulletin') et une référence.

BEGIN;

ALTER TABLE edu_report_cards
  ADD COLUMN IF NOT EXISTS class_id    INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS class_label TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS class_stats JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Un seul jeton valide par bulletin (il reste le même si le bulletin est régénéré).
CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_docverif_bulletin_valide
  ON edu_document_verifications (report_card_id)
  WHERE doc_type = 'bulletin' AND status = 'valide';

-- Numérotation des documents émis (bulletins…), par établissement et par an.
CREATE TABLE IF NOT EXISTS edu_document_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type   TEXT NOT NULL,
  year       INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type, year)
);

CREATE INDEX IF NOT EXISTS idx_edu_report_cards_classe ON edu_report_cards (company_id, class_id, term_id);

COMMIT;
