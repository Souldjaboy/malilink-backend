"use strict";

/**
 * Tests automatiques du moteur grand livre Wallet (node:test natif).
 * Utilise un client PostgreSQL SIMULÉ (mock) : rapide, déterministe,
 * sans base de données. Couvre les invariants critiques du moteur.
 *
 *   Lancer : npm test   (ou : node --test services/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const ledger = require("./wallet-ledger");

/* Client PG simulé : mémorise les écritures et rejoue currentBalance
   à partir des wallet_entries insérées. */
function makeMockClient(initialBalances = {}) {
  const balances = { ...initialBalances };
  const walletEntries = [];
  const walletTransactions = [];
  const accountingEntries = [];
  let txSeq = 0;

  async function query(text, params = []) {
    if (/INSERT INTO wallet_transactions/i.test(text)) {
      txSeq += 1;
      walletTransactions.push({ id: txSeq, text, params });
      return { rows: [{ id: txSeq }] };
    }
    if (/SELECT balance_after FROM wallet_entries/i.test(text)) {
      const walletId = params[0];
      return { rows: balances[walletId] != null ? [{ balance_after: balances[walletId] }] : [] };
    }
    if (/INSERT INTO wallet_entries/i.test(text)) {
      const [transaction_id, wallet_id, direction, amount, balance_after] = params;
      walletEntries.push({ transaction_id, wallet_id, direction, amount, balance_after });
      balances[wallet_id] = balance_after; // met à jour le solde simulé
      return { rows: [] };
    }
    if (/INSERT INTO accounting_transactions/i.test(text)) {
      const [company_id, kind, amount, direction, category, financial_operation_id] = params;
      accountingEntries.push({ company_id, kind, amount, direction, category, financial_operation_id });
      return { rows: [] };
    }
    if (/FROM wallets WHERE owner_type='platform'/i.test(text)) {
      return { rows: [{ id: 999 }] };
    }
    return { rows: [] };
  }

  return { query, walletEntries, walletTransactions, accountingEntries, balances };
}

test("référence et financial_operation_id ont le bon format", () => {
  assert.match(ledger.newReference(), /^MLW-\d+-[0-9A-F]{6}$/);
  assert.match(ledger.newFinancialOperationId(), /^FINOP-[0-9A-F]{16}$/);
});

test("currentBalance retourne 0 pour un wallet sans écriture", async () => {
  const client = makeMockClient({});
  assert.equal(await ledger.currentBalance(client, 1), 0);
});

test("transfert équilibré : débite l'expéditeur, crédite le destinataire", async () => {
  const client = makeMockClient({ 1: 5000, 2: 0 });
  const result = await ledger.postLedgerTransaction(client, {
    kind: "transfer",
    legs: [
      { walletId: 1, direction: "debit", amount: 2000 },
      { walletId: 2, direction: "credit", amount: 2000 }
    ]
  });
  assert.ok(result.reference && result.financial_operation_id);
  assert.equal(client.balances[1], 3000); // 5000 - 2000
  assert.equal(client.balances[2], 2000); // 0 + 2000
  assert.equal(client.walletEntries.length, 2);
});

test("opération DÉSÉQUILIBRÉE est rejetée (débit ≠ crédit)", async () => {
  const client = makeMockClient({ 1: 5000, 2: 0 });
  await assert.rejects(
    () =>
      ledger.postLedgerTransaction(client, {
        kind: "transfer",
        legs: [
          { walletId: 1, direction: "debit", amount: 2000 },
          { walletId: 2, direction: "credit", amount: 1500 }
        ]
      }),
    /déséquilibrée/i
  );
});

test("paiement marketplace : acheteur débité, vendeur net + commission plateforme", async () => {
  const client = makeMockClient({ 1: 4000, 2: 0, 999: 0 });
  await ledger.postLedgerTransaction(client, {
    kind: "payment",
    relatedModule: "marketplace",
    commission: 200,
    legs: [
      { walletId: 1, direction: "debit", amount: 4000, companyId: null },
      { walletId: 2, direction: "credit", amount: 3800, companyId: 10 },
      { walletId: 999, direction: "credit", amount: 200, companyId: null }
    ]
  });
  assert.equal(client.balances[1], 0); // acheteur payé
  assert.equal(client.balances[2], 3800); // vendeur net
  assert.equal(client.balances[999], 200); // commission plateforme
});

test("écriture comptable AUTO créée pour une jambe rattachée à une entreprise", async () => {
  const client = makeMockClient({ 1: 4000, 2: 0 });
  await ledger.postLedgerTransaction(client, {
    kind: "payment",
    relatedModule: "marketplace",
    legs: [
      { walletId: 1, direction: "debit", amount: 4000, companyId: null }, // user : pas de compta
      { walletId: 2, direction: "credit", amount: 4000, companyId: 10 } // entreprise : compta auto
    ]
  });
  assert.equal(client.accountingEntries.length, 1);
  const entry = client.accountingEntries[0];
  assert.equal(entry.company_id, 10);
  assert.equal(entry.direction, "entree"); // crédit → entrée
  assert.equal(Number(entry.amount), 4000);
});

test("financial_operation_id est PARTAGÉ entre wallet et comptabilité", async () => {
  const client = makeMockClient({ 1: 1000, 2: 0 });
  const result = await ledger.postLedgerTransaction(client, {
    kind: "payment",
    legs: [
      { walletId: 1, direction: "debit", amount: 1000, companyId: 5 },
      { walletId: 2, direction: "credit", amount: 1000, companyId: 5 }
    ]
  });
  for (const entry of client.accountingEntries) {
    assert.equal(entry.financial_operation_id, result.financial_operation_id);
  }
});

test("montants décimaux : tolérance d'arrondi au centime respectée", async () => {
  const client = makeMockClient({ 1: 100.5, 2: 0 });
  await ledger.postLedgerTransaction(client, {
    kind: "transfer",
    legs: [
      { walletId: 1, direction: "debit", amount: 33.33 },
      { walletId: 2, direction: "credit", amount: 33.33 }
    ]
  });
  assert.equal(Number(client.balances[1].toFixed(2)), 67.17);
});
