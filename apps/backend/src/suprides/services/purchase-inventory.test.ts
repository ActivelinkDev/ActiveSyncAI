import assert from 'node:assert/strict';
import test from 'node:test';
import { blocksPurchase, newPurchaseInventory, planPurchaseInventory, type PurchaseInventoryState } from './purchase-inventory';

const untracked: PurchaseInventoryState = { tracked: false, policy: 'DENY', onlineQuantity: 0, previous: null };

test('identifica os dois estados de compra bloqueada', () => {
  for (const label of ['Brevemente', ' Sob Encomenda ', 'sob_encomenda']) assert.equal(blocksPurchase(label), true);
  for (const label of ['Disponível', 'Sem Stock', null]) assert.equal(blocksPurchase(label), false);
});

test('ativa o inventário sem vender a zero e guarda a configuração anterior', () => {
  assert.deepEqual(planPurchaseInventory(true, untracked), newPurchaseInventory(true));
  const gate = planPurchaseInventory(true, { ...untracked, policy: 'CONTINUE' })!;
  assert.equal(gate.inventoryPolicy, 'DENY');
  assert.equal(gate.inventoryItem.tracked, true);
  assert.equal(gate.metafields[0].value, 'untracked_continue');
  assert.equal(planPurchaseInventory(true, { ...untracked, tracked: true, previous: gate.metafields[0].value }), null);
});

test('repõe apenas o inventário alterado pelo integrador', () => {
  const gate = planPurchaseInventory(false, { ...untracked, tracked: true, previous: 'untracked_continue' })!;
  assert.equal(gate.inventoryItem.tracked, false);
  assert.equal(gate.inventoryPolicy, 'CONTINUE');
  assert.equal(gate.metafields[0].value, 'restored');
  assert.equal(planPurchaseInventory(false, { ...untracked, tracked: true }), null);
  assert.equal(planPurchaseInventory(false, { ...untracked, previous: 'restored' }), null);
});

test('recusa alterar variantes com unidades vendáveis', () => {
  assert.throws(() => planPurchaseInventory(true, { ...untracked, onlineQuantity: 1 }), /unidades vendáveis/);
});
