import 'dotenv/config';
import { closeMssql } from '../db/mssql';
import { withCatalogueLock } from '../repositories/suprides-cache';
import { readAllProducts } from '../suprides/api/shopify-read';
import { syncPurchaseInventory } from '../suprides/api/shopify-purchase-inventory';
import { withConnectionSettings } from '../suprides/repositories/store';
import { blocksPurchase, needsPurchaseInventorySync } from '../suprides/services/purchase-inventory';

async function run(apply: boolean): Promise<void> {
  const products = await readAllProducts(undefined, 'status:active');
  const productArg = process.argv.find(arg => arg.startsWith('--product-id='));
  const productId = productArg && Number(productArg.slice('--product-id='.length));
  if (productArg && (!Number.isSafeInteger(productId) || !productId || productId < 1)) throw new Error('ID de produto inválido.');
  const candidates = products.filter(product => (!productId || product.productId === productId) &&
    blocksPurchase(product.stockStatus) && needsPurchaseInventorySync(product, true));
  console.log('Produtos ativos com bloqueio de inventário por aplicar: ' + candidates.length);
  if (!apply) return;

  let updated = 0;
  let errors = 0;
  const queue = candidates.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let product = queue.shift(); product; product = queue.shift()) {
      try {
        if (await syncPurchaseInventory(product.productId, true)) updated++;
      } catch (error) {
        errors++;
        console.error(product.handle + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }));
  console.log('Atualizados: ' + updated + '. Erros: ' + errors + '.');
  if (errors) process.exitCode = 1;
}

const apply = process.argv.includes('--apply');
withConnectionSettings(() => apply ? withCatalogueLock(() => run(true)) : run(false))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => closeMssql());
