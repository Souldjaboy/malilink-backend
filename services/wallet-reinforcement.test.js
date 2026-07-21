"use strict";

/**
 * Tests des services de renfort du moteur Wallet (#2..#7) :
 * fraude (score + jamais de blocage), limites (plafonds), devises
 * (conversion lecture seule), réconciliation (équilibre + Wallet↔compta),
 * webhooks (signature HMAC). Client PG SIMULÉ, aucune base réelle.
 *
 *   Lancer : npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const fraud = require("./wallet-fraud");
const limits = require("./wallet-limits");
const currency = require("./wallet-currency");
const reconciliation = require("./wallet-reconciliation");
const webhooks = require("./wallet-webhooks");

/* ───────────────────────────── #6 Fraude ───────────────────────────── */

test("fraude : opération normale → risque faible, aucune raison", () => {
  const v = fraud.scoreOperation({ amount: 1000, avgAmount: 1200, maxAmount: 5000, recentCount: 1 });
  assert.equal(v.level, "low");
  assert.equal(v.score, 0);
});

test("fraude : montant très supérieur à la moyenne → risque élevé", () => {
  const v = fraud.scoreOperation({
    amount: 100000, avgAmount: 1000, maxAmount: 2000,
    recentCount: 12, failedCount: 3
  });
  assert.ok(v.score >= fraud.HIGH, `score ${v.score} attendu >= ${fraud.HIGH}`);
  assert.equal(v.level, "high");
  assert.ok(v.reasons.includes("montant_tres_superieur_a_la_moyenne"));
  assert.ok(v.reasons.includes("transactions_rapides_en_rafale"));
});

test("fraude : wallet destinataire suspect/bloqué → signal enregistré", () => {
  const v = fraud.scoreOperation({ amount: 500, avgAmount: 400, recipientBlocked: true });
  assert.ok(v.reasons.includes("wallet_destinataire_suspect"));
});

test("fraude : le score est toujours borné à 100", () => {
  const v = fraud.scoreOperation({
    amount: 1e9, avgAmount: 1, maxAmount: 1, recentCount: 100,
    failedCount: 100, recipientAgeDays: 0, recipientBlocked: true
  });
  assert.ok(v.score <= 100);
});

/* ───────────────────────────── #4 Limites ──────────────────────────── */

function limitsMock(config, dayTotal = 0, dayCount = 0, monthTotal = 0) {
  return {
    async query(text, params) {
      if (/FROM wallet_limits/i.test(text)) return { rows: [config] };
      if (/date_trunc\('day'/i.test(text)) return { rows: [{ total: dayTotal, cnt: dayCount }] };
      if (/date_trunc\('month'/i.test(text)) return { rows: [{ total: monthTotal }] };
      return { rows: [] };
    }
  };
}

test("limites : montant sous les plafonds → autorisé", async () => {
  const db = limitsMock({ max_per_transaction: 5000, daily_amount_cap: 10000, monthly_amount_cap: 100000, daily_count_cap: 10 });
  const v = await limits.checkOutgoing(db, 1, 2000);
  assert.equal(v.ok, true);
});

test("limites : dépasser le plafond par opération → refusé", async () => {
  const db = limitsMock({ max_per_transaction: 5000, daily_amount_cap: null, monthly_amount_cap: null, daily_count_cap: null });
  const v = await limits.checkOutgoing(db, 1, 6000);
  assert.equal(v.ok, false);
  assert.equal(v.limit, "max_per_transaction");
});

test("limites : plafond quotidien cumulé atteint → refusé", async () => {
  const db = limitsMock({ max_per_transaction: null, daily_amount_cap: 10000, monthly_amount_cap: null, daily_count_cap: null }, 9000);
  const v = await limits.checkOutgoing(db, 1, 2000); // 9000 + 2000 > 10000
  assert.equal(v.ok, false);
  assert.equal(v.limit, "daily_amount_cap");
});

test("limites : nombre d'opérations quotidien atteint → refusé", async () => {
  const db = limitsMock({ max_per_transaction: null, daily_amount_cap: 100000, monthly_amount_cap: null, daily_count_cap: 3 }, 0, 3);
  const v = await limits.checkOutgoing(db, 1, 100);
  assert.equal(v.ok, false);
  assert.equal(v.limit, "daily_count_cap");
});

/* ──────────────────────────── #5 Devises ───────────────────────────── */

function currencyMock() {
  const rows = {
    XOF: { code: "XOF", symbol: "FCFA", decimals: 0, rate_to_xof: 1 },
    EUR: { code: "EUR", symbol: "€", decimals: 2, rate_to_xof: 655.957 }
  };
  return {
    async query(_t, params) {
      return { rows: rows[String(params[0]).toUpperCase()] ? [rows[String(params[0]).toUpperCase()]] : [] };
    }
  };
}

test("devises : conversion EUR → XOF via la parité fixe", async () => {
  const db = currencyMock();
  const xof = await currency.convert(db, 1, "EUR", "XOF");
  assert.equal(xof, 656); // 655.957 arrondi à 0 décimale (XOF)
});

test("devises : conversion XOF → EUR (lecture seule, arrondi 2 décimales)", async () => {
  const db = currencyMock();
  const eur = await currency.convert(db, 655.957, "XOF", "EUR");
  assert.equal(eur, 1);
});

test("devises : devise inconnue → null (pas d'exception)", async () => {
  const db = currencyMock();
  assert.equal(await currency.convert(db, 100, "XOF", "GBP"), null);
});

/* ────────────────────────── #2 Réconciliation ──────────────────────── */

function reconMock(debit, credit, linkedRows = []) {
  return {
    async query(text) {
      if (/SUM\(amount\) FILTER/i.test(text)) return { rows: [{ debit, credit }] };
      if (/w\.financial_operation_id AS finop/i.test(text)) return { rows: linkedRows };
      if (/INSERT INTO wallet_reconciliation_reports/i.test(text)) {
        return { rows: [{ id: 1, created_at: new Date() }] };
      }
      return { rows: [] };
    }
  };
}

test("réconciliation : grand livre équilibré → statut ok", async () => {
  const r = await reconciliation.reconcile(reconMock(10000, 10000, [
    { finop: "FINOP-1", wallet_amount: 4000, acc_amount: 3800 }
  ]));
  assert.equal(r.status, "ok");
  assert.equal(r.mismatch, 0);
});

test("réconciliation : déséquilibre du grand livre → mismatch signalé", async () => {
  const r = await reconciliation.reconcile(reconMock(10000, 9000));
  assert.equal(r.status, "mismatch");
  assert.ok(r.details.some((d) => d.type === "ledger_imbalance"));
});

test("réconciliation : compta supérieure au Wallet → mismatch", async () => {
  const r = await reconciliation.reconcile(reconMock(5000, 5000, [
    { finop: "FINOP-X", wallet_amount: 1000, acc_amount: 2000 }
  ]));
  assert.equal(r.status, "mismatch");
  assert.ok(r.details.some((d) => d.type === "wallet_vs_accounting"));
});

/* ──────────────────────────── #7 Webhooks ──────────────────────────── */

test("webhooks : signature HMAC déterministe et vérifiable", () => {
  const payload = { event: "transaction.completed", data: { amount: 500 } };
  const a = webhooks.sign("secret123", payload);
  const b = webhooks.sign("secret123", payload);
  const c = webhooks.sign("autre-secret", payload);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("webhooks : désactivés globalement → rien n'est enfilé", async () => {
  const db = {
    async query(text) {
      if (/wallet_webhooks_enabled/i.test(text)) return { rows: [{ enabled: false }] };
      return { rows: [] };
    }
  };
  const r = await webhooks.enqueueEvent(db, "transaction.completed", { amount: 100 });
  assert.equal(r.queued, 0);
  assert.equal(r.reason, "webhooks_disabled");
});
