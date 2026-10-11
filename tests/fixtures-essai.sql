-- Comptes d'essai référencés par identifiant fixe dans les tests
-- (999001 Super Admin, 999002 client) : de vrais comptes, rattachés à
-- l'espace malilink comme un compte inscrit. Sans eux, le serveur refuse
-- (à juste titre) un jeton dont le compte n'existe pas ou n'a pas d'espace.
INSERT INTO users (id, fullname, email, password, role, is_super_admin, is_active, account_tenant_id, account_tenant_source)
VALUES (999001, 'Super Admin (essai)', 'sa-essai-999001@essai.test', 'x', 'super_admin', true, true, 'malilink', 'inscription'),
       (999002, 'Client (essai)', 'client-essai-999002@essai.test', 'x', 'customer', false, true, 'malilink', 'inscription')
ON CONFLICT (id) DO NOTHING;
