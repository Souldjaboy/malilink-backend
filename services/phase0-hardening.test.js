"use strict";

/**
 * Tests du durcissement Phase 0 :
 *  - secret-vault : chiffrement AES-256-GCM au repos + repli clair ;
 *  - env-guard    : détection des secrets sensibles absents/faibles/dupliqués ;
 *  - rate limiter : store enfichable (mémoire) + blocage au-delà du max ;
 *  - réconciliation incrémentale : curseur, deltas, détection d'écart.
 *
 *   Lancer : npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vault = require("./secret-vault");
const envGuard = require("../config/env-guard");
const { createRateLimiter, MemoryStore } = require("../middleware/rateLimit");
const reconciliation = require("./wallet-reconciliation");

/* ───────────────────────── secret-vault ───────────────────────── */

test("vault : sans clé → format 'plain' (repli contrôlé)", () => {
  delete process.env.WALLET_SECRET_ENC_KEY;
  const sealed = vault.encrypt("mon-secret");
  assert.equal(sealed.format, "plain");
  assert.equal(sealed.value, "mon-secret");
  assert.equal(vault.decrypt(sealed.value, sealed.format), "mon-secret");
});

test("vault : avec clé → chiffré puis déchiffré à l'identique", () => {
  process.env.WALLET_SECRET_ENC_KEY = "a".repeat(64); // 32 octets en hex
  try {
    const sealed = vault.encrypt("secret-webhook-123");
    assert.equal(sealed.format, "aes-256-gcm");
    assert.notEqual(sealed.value, "secret-webhook-123");
    assert.match(sealed.value, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.equal(vault.decrypt(sealed.value, sealed.format), "secret-webhook-123");
  } finally {
    delete process.env.WALLET_SECRET_ENC_KEY;
  }
});

test("vault : altération du ciphertext → déchiffrement rejeté (GCM)", () => {
  process.env.WALLET_SECRET_ENC_KEY = "b".repeat(64);
  try {
    const sealed = vault.encrypt("intègre");
    const [iv, tag, data] = sealed.value.split(":");
    const tampered = `${iv}:${tag}:${data.slice(0, -2)}00`;
    assert.throws(() => vault.decrypt(tampered, sealed.format));
  } finally {
    delete process.env.WALLET_SECRET_ENC_KEY;
  }
});

/* ───────────────────────── env-guard ───────────────────────── */

test("env-guard : production sans secrets critiques → refus (ok=false)", () => {
  const r = envGuard.checkEnv({ NODE_ENV: "production" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("JWT_SECRET")));
  assert.ok(r.errors.some((e) => e.includes("WALLET_RECEIPT_SECRET")));
});

test("env-guard : RECEIPT_SECRET identique à JWT_SECRET → erreur en prod", () => {
  const r = envGuard.checkEnv({
    NODE_ENV: "production",
    JWT_SECRET: "x".repeat(40),
    DATABASE_URL: "postgres://localhost/db",
    WALLET_RECEIPT_SECRET: "x".repeat(40)
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("distincts")));
});

test("env-guard : secrets forts et distincts → ok", () => {
  const r = envGuard.checkEnv({
    NODE_ENV: "production",
    JWT_SECRET: "j".repeat(40),
    DATABASE_URL: "postgres://localhost/db",
    WALLET_RECEIPT_SECRET: "r".repeat(40)
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test("env-guard : dev sans secrets → avertit sans bloquer", () => {
  const r = envGuard.checkEnv({ NODE_ENV: "development" });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length > 0);
});

/* ───────────────────────── rate limiter ───────────────────────── */

function fakeReqRes() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  const req = { headers: {}, path: "/login", ip: "1.2.3.4", socket: {} };
  return { req, res };
}

test("rate limiter : bloque au-delà du max avec le store mémoire", async () => {
  const store = new MemoryStore();
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, message: "stop", store });
  const run = () =>
    new Promise((resolve) => {
      const { req, res } = fakeReqRes();
      let nexted = false;
      limiter(req, res, () => { nexted = true; resolve({ nexted, res }); });
      // si 429, next n'est pas appelé → résoudre au tick suivant
      setImmediate(() => resolve({ nexted, res }));
    });
  const r1 = await run();
  const r2 = await run();
  const r3 = await run();
  assert.equal(r1.nexted, true);
  assert.equal(r2.nexted, true);
  assert.equal(r3.res.statusCode, 429);
  assert.equal(r3.res.body.error, "stop");
});

test("MemoryStore : le compteur s'incrémente puis se réinitialise après la fenêtre", async () => {
  const store = new MemoryStore();
  const a = await store.hit("k", 50);
  const b = await store.hit("k", 50);
  assert.equal(a.count, 1);
  assert.equal(b.count, 2);
  await new Promise((r) => setTimeout(r, 60));
  const c = await store.hit("k", 50);
  assert.equal(c.count, 1); // fenêtre expirée → repart à 1
});

/* ─────────────────── réconciliation incrémentale ─────────────────── */

function reconIncMock({ lastId = 0, runDebit = 0, runCredit = 0, deltaDebit, deltaCredit, maxId, n, linked = [] }) {
  const calls = { updateState: null, insertReport: null };
  return {
    calls,
    async query(text, params) {
      if (/BEGIN|COMMIT|ROLLBACK/i.test(text)) return { rows: [] };
      if (/FROM wallet_reconciliation_state/i.test(text)) {
        return { rows: [{ last_entry_id: lastId, running_debit_total: runDebit, running_credit_total: runCredit }] };
      }
      if (/FROM wallet_entries\s+WHERE id > \$1/i.test(text)) {
        return { rows: [{ debit: deltaDebit, credit: deltaCredit, max_id: maxId, n }] };
      }
      if (/w\.financial_operation_id AS finop/i.test(text)) {
        return { rows: linked };
      }
      if (/UPDATE wallet_reconciliation_state/i.test(text)) {
        calls.updateState = params; return { rows: [] };
      }
      if (/INSERT INTO wallet_reconciliation_reports/i.test(text)) {
        calls.insertReport = params; return { rows: [{ id: 7, created_at: new Date() }] };
      }
      return { rows: [] };
    }
  };
}

test("réconciliation incrémentale : équilibrée → ok, curseur avancé", async () => {
  const db = reconIncMock({ lastId: 100, runDebit: 5000, runCredit: 5000, deltaDebit: 2000, deltaCredit: 2000, maxId: 140, n: 4 });
  const r = await reconciliation.reconcileIncremental(db);
  assert.equal(r.status, "ok");
  assert.equal(r.from_entry_id, 100);
  assert.equal(r.to_entry_id, 140);
  assert.equal(r.processed, 4);
  assert.equal(r.ledger_debit_total, 7000);  // 5000 + 2000
  assert.equal(r.ledger_credit_total, 7000);
  assert.equal(db.calls.updateState[0], 140); // curseur persisté
});

test("réconciliation incrémentale : delta déséquilibré → mismatch", async () => {
  const db = reconIncMock({ lastId: 0, runDebit: 0, runCredit: 0, deltaDebit: 1000, deltaCredit: 900, maxId: 3, n: 2 });
  const r = await reconciliation.reconcileIncremental(db);
  assert.equal(r.status, "mismatch");
  assert.ok(r.details.some((d) => d.type === "ledger_imbalance"));
});

test("réconciliation incrémentale : aucune nouvelle écriture → curseur inchangé", async () => {
  const db = reconIncMock({ lastId: 200, runDebit: 9000, runCredit: 9000, deltaDebit: 0, deltaCredit: 0, maxId: 200, n: 0 });
  const r = await reconciliation.reconcileIncremental(db);
  assert.equal(r.processed, 0);
  assert.equal(r.to_entry_id, 200);
  assert.equal(r.status, "ok");
});
