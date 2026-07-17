-- 048 — MaliLink Social devient une communauté professionnelle et sociale
-- (type Facebook/LinkedIn). Le mode rencontres et la vidéo aléatoire sont
-- retirés du produit : flags désactivés définitivement, visibilité rencontre
-- coupée pour tous les profils existants. Idempotent, aucune suppression
-- de table ni de colonne (les colonnes dating_* restent mais ne sont plus
-- jamais utilisées par le code).

UPDATE social_feature_flags SET enabled=false, updated_at=NOW()
WHERE flag_key IN ('social_dating_enabled', 'social_random_video_enabled');

UPDATE social_profiles SET dating_opt_in=false, updated_at=NOW()
WHERE dating_opt_in=true;

UPDATE social_privacy_settings SET dating_enabled=false, random_video_enabled=false, updated_at=NOW()
WHERE dating_enabled=true OR random_video_enabled=true;

-- Retirer l'objectif "rencontres" des profils existants (JSONB)
UPDATE social_profiles
SET goals = COALESCE(goals, '[]'::jsonb) - 'rencontres', updated_at=NOW()
WHERE goals ? 'rencontres';
