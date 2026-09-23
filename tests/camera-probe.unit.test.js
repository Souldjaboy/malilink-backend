"use strict";
/* Tests unitaires de la sonde de joignabilité (gardes anti-SSRF + TCP réel). */
const assert = require("assert");
const net = require("net");
const sonde = require("../services/camera-probe");

let passes = 0;
async function test(nom, fn) {
  await fn();
  passes += 1;
  console.log("  ✓ " + nom);
}

(async () => {
  console.log("Adresses interdites");

  await test("boucle locale, privées, lien local, CGNAT, métadonnées cloud : refusées", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.255", "192.168.1.10",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"]) {
      assert.strictEqual(sonde.adresseInterdite(ip), true, ip);
    }
  });

  await test("adresses publiques : autorisées", async () => {
    for (const ip of ["8.8.8.8", "41.73.105.2", "172.32.0.1", "2a00:1450:4001::1"]) {
      assert.strictEqual(sonde.adresseInterdite(ip), false, ip);
    }
  });

  console.log("Vérification de la cible");
  const public_ = async () => [{ address: "41.73.105.2" }];

  await test("adresse IP privée : refus ADRESSE_PRIVEE, sans connexion", async () => {
    const r = await sonde.verifierCible("192.168.1.64", 554);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "ADRESSE_PRIVEE");
  });

  await test("nom résolu vers une adresse privée : refus (localhost)", async () => {
    const r = await sonde.verifierCible("cam.exemple.ml", 554, { resoudre: async () => [{ address: "127.0.0.1" }] });
    assert.strictEqual(r.code, "ADRESSE_PRIVEE");
  });

  await test("rebinding : UNE des adresses résolues est privée → refus", async () => {
    const r = await sonde.verifierCible("cam.exemple.ml", 554, {
      resoudre: async () => [{ address: "41.73.105.2" }, { address: "10.0.0.1" }],
    });
    assert.strictEqual(r.code, "ADRESSE_PRIVEE");
  });

  await test("port hors de la liste des ports caméra : refus (5432, 22, 6379)", async () => {
    for (const p of [5432, 22, 6379, 0, 70000]) {
      const r = await sonde.verifierCible("cam.exemple.ml", p, { resoudre: public_ });
      assert.strictEqual(r.code, "PORT_NON_AUTORISE", String(p));
    }
  });

  await test("adresse mal formée : refus", async () => {
    for (const h of ["", "cam..ml", "http://cam.ml", "cam ml", "a".repeat(300)]) {
      const r = await sonde.verifierCible(h, 554, { resoudre: public_ });
      assert.strictEqual(r.code, "ADRESSE_INVALIDE", h);
    }
  });

  await test("cible publique et port caméra : acceptée, adresse figée pour la connexion", async () => {
    const r = await sonde.verifierCible("cam.exemple.ml", 554, { resoudre: public_ });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.adresse, "41.73.105.2");
  });

  console.log("Connexion TCP");

  await test("port ouvert : joignable", async () => {
    const serveur = net.createServer((s) => s.end());
    await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
    const r = await sonde.connexionTcp("127.0.0.1", serveur.address().port, 2000);
    serveur.close();
    assert.strictEqual(r.joignable, true);
  });

  await test("port fermé : injoignable, avec la cause", async () => {
    const serveur = net.createServer();
    await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
    const portLibre = serveur.address().port;
    await new Promise((ok) => serveur.close(ok));
    const r = await sonde.connexionTcp("127.0.0.1", portLibre, 2000);
    assert.strictEqual(r.joignable, false);
    assert.ok(r.erreur.length > 0);
  });

  console.log("Débit");
  await test("au-delà de 30 tests en 10 min pour une société : refus", async () => {
    const societe = `essai-${Date.now()}`;
    for (let i = 0; i < 30; i += 1) assert.strictEqual(sonde.debitAutorise(societe), true);
    assert.strictEqual(sonde.debitAutorise(societe), false);
    assert.strictEqual(sonde.debitAutorise(`${societe}-autre`), true);
  });

  console.log(`\n✅ ${passes} tests de la sonde passés.`);
})().catch((e) => {
  console.error("❌ ", e.message);
  process.exit(1);
});
