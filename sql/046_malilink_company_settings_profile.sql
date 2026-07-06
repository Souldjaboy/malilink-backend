-- 046 — Paramètres entreprise MaliLink (identité complète)
-- Migration idempotente : uniquement des ajouts, aucune suppression.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Mali';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS business_sector TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'FCFA';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'fr';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS opening_hours TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS facebook_url TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS whatsapp_number TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS instagram_url TEXT DEFAULT '';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_company_settings_company ON company_settings (company_id);
