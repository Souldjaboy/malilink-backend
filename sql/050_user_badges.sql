-- 050 — Module Badges professionnel MaliLink.
-- Un badge est un OBJET géré (cycle de vie, jeton QR sécurisé, audit),
-- pas une simple image. Idempotent, aucune suppression.

CREATE TABLE IF NOT EXISTS user_badges (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_type TEXT NOT NULL DEFAULT 'employe',
    -- etudiant | enseignant | employe | magasinier | responsable | directeur
    -- administrateur | livreur | chauffeur | laboratoire | restaurant
  template TEXT NOT NULL DEFAULT 'standard',
  matricule TEXT NOT NULL DEFAULT '',
  barcode_value TEXT NOT NULL DEFAULT '',
  qr_token TEXT NOT NULL,                      -- jeton opaque, jamais de données en clair
  department TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'actif',
    -- actif | expire | suspendu | perdu | remplace | revoque
  valid_until DATE,
  printed_at TIMESTAMPTZ,
  print_count INTEGER NOT NULL DEFAULT 0,
  replaced_by_id INTEGER REFERENCES user_badges(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (qr_token)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_company ON user_badges (company_id, status);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges (user_id, status);

CREATE TABLE IF NOT EXISTS badge_audit_logs (
  id SERIAL PRIMARY KEY,
  badge_id INTEGER NOT NULL REFERENCES user_badges(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                        -- created | printed | status_changed | replaced | verified
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_badge_audit_badge ON badge_audit_logs (badge_id, created_at);
