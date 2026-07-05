-- Triangle WMS Pro - Permissions PostgreSQL production
-- Script SPÉCIFIQUE à la base triangle_wms et au rôle triangle_user.
-- Sur toute autre base (malilink_global, hafiya...), il s'ignore proprement
-- au lieu de faire échouer le runner de migrations avec
-- « role "triangle_user" does not exist ».
--
-- Exécution manuelle côté Triangle :
-- sudo -u postgres psql -d triangle_wms -f sql/000_permissions_triangle_user.sql

DO $$
BEGIN
  IF current_database() <> 'triangle_wms' THEN
    RAISE NOTICE 'Base % : script permissions triangle_user ignoré (réservé à triangle_wms).', current_database();
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triangle_user') THEN
    RAISE NOTICE 'Rôle triangle_user absent : script permissions ignoré.';
    RETURN;
  END IF;

  EXECUTE 'ALTER SCHEMA public OWNER TO triangle_user';
  EXECUTE 'GRANT CONNECT ON DATABASE triangle_wms TO triangle_user';
  EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO triangle_user';
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO triangle_user';
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO triangle_user';
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO triangle_user';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO triangle_user';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO triangle_user';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO triangle_user';
END $$;

-- Note : « ALTER DATABASE triangle_wms OWNER TO triangle_user » reste une
-- opération manuelle exécutée par postgres sur la base triangle_wms uniquement.
