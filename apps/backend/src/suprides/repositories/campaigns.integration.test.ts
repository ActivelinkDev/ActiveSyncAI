/**
 * Ciclo de vida das campanhas na base de TESTE (ActiveSyncAI_Test), com uma loja simulada em memória.
 * Saltado sem apps/backend/.env.test (ver test-support/test-db.ts). Nunca toca na loja real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDbAvailable, getTestDb } from '../../test-support/test-db';

const skip = !testDbAvailable();
const DAY = 86_400_000;

test('campanhas: do rascunho ao fim, com a loja simulada', { skip }, async () => {
  const db = await getTestDb();
  // Importar só depois de ler o .env.test (o pool do SQL Server lê o ambiente na 1.ª ligação).
  const c = await import('./campaigns');
  const { runCampaignTick } = await import('../../services/campaign-ticker');
  const { closeMssql } = await import('../../db/mssql');

  try {
    // Base de teste limpa (só tabelas de campanhas/preços e produtos de teste).
    await db.deleteFrom('campaign_products').execute();
    await db.deleteFrom('campaigns').execute();
    await db.deleteFrom('price_history').execute();
    await db.deleteFrom('price_current').execute();
    await db.deleteFrom('products').where('sku', 'like', 'TST-%').execute();

    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const prod = (sku: string, n: number, cost: number, base: number | null) =>
      ({ sku, cost, base_price: base, shopify_product_id: n, shopify_variant_id: n * 10, name: sku });
    await db.insertInto('products').values([
      prod('TST-A', 1, 50, 100),   // entra
      prod('TST-B', 2, 80, 100),   // 90 € < 98,40 (custo + IVA) → PREJUIZO
      prod('TST-C', 3, 50, 100),   // esteve a 85 € há 10 dias → SEM_DESCONTO
      prod('TST-D', 4, 50, null),  // o sync não gere o preço → SEM_PRECO
      prod('TST-E', 5, 50, 100),   // só 3 dias de histórico → entra com aviso
    ]).execute();
    const hist = (sku: string, price: number, at: Date, source = 'SYNC') =>
      ({ sku, new_price: price, source, changed_at: at, status: 'ACTIVE' });
    await db.insertInto('price_history').values([
      hist('TST-A', 100, ago(40), 'INITIAL'), hist('TST-B', 100, ago(40), 'INITIAL'),
      hist('TST-C', 100, ago(40), 'INITIAL'), hist('TST-C', 85, ago(10)), hist('TST-C', 100, ago(5)),
      hist('TST-E', 100, ago(3), 'INITIAL'),
    ]).execute();
    await db.insertInto('price_current').values(['TST-A', 'TST-B', 'TST-C', 'TST-E'].map((sku, i) =>
      ({ sku, shopify_product_id: i + 1, price: 100, compare_at_price: null, status: 'ACTIVE', updated_at: ago(3) }))).execute();

    // Loja simulada
    const shop = new Map<number, { sku: string; variantId: number; price: string; compareAtPrice: string | null }>(
      [1, 2, 3, 4, 5].map(n => [n, { sku: `TST-${'ABCDE'[n - 1]}`, variantId: n * 10, price: '100.00', compareAtPrice: null }]));
    const writes: string[] = [];
    const writer = {
      async setPrice(productId: number, variantId: number, price: string, compareAtPrice: string | null) {
        const p = shop.get(productId)!;
        assert.equal(p.variantId, variantId);
        Object.assign(p, { price, compareAtPrice });
        writes.push(`${p.sku}=${price}/${compareAtPrice}`);
      },
      async readBySkus(skus: string[]) {
        return [...shop].filter(([, p]) => skus.includes(p.sku)).map(([productId, p]) =>
          ({ productId, sku: p.sku, price: p.price, compareAtPrice: p.compareAtPrice, status: 'ACTIVE' } as any));
      },
    };

    // Rascunho
    const id = await c.createCampaign({
      name: 'Teste', discountType: 'PERCENT', discountValue: 10,
      startsAt: new Date(now.getTime() - 60_000), endsAt: new Date(now.getTime() + 3600_000),
    });
    const set = await c.setCampaignProducts(id, ['TST-A', 'TST-B', 'TST-C', 'TST-D', 'TST-E', 'TST-NAO-EXISTE']);
    assert.deepEqual(set, { count: 5, unknown: ['TST-NAO-EXISTE'] });

    const preview = new Map((await c.previewCampaign(id, now)).map(e => [e.sku, e]));
    assert.equal(preview.get('TST-A')!.state, 'INCLUIDO');
    assert.equal(preview.get('TST-A')!.promo, 90);
    assert.equal(preview.get('TST-B')!.blockReason, 'PREJUIZO');
    assert.equal(preview.get('TST-C')!.blockReason, 'SEM_DESCONTO');
    assert.equal(preview.get('TST-C')!.reference, 85);
    assert.equal(preview.get('TST-D')!.blockReason, 'SEM_PRECO');
    assert.equal(preview.get('TST-E')!.warning, 'HISTORICO_CURTO');
    assert.equal(preview.get('TST-E')!.state, 'INCLUIDO');

    // Exceção: TST-C com 20 % já fica abaixo da referência (80 < 85) e acima do custo (61,50)
    await c.setProductOverride(id, 'TST-C', { type: 'PERCENT', value: 20 });

    // Agendar; uma 2.ª campanha com o mesmo produto nas mesmas datas é recusada
    await c.scheduleCampaign(id, now);
    const other = await c.createCampaign({
      name: 'Sobreposta', discountType: 'AMOUNT', discountValue: 5,
      startsAt: new Date(now.getTime() + 600_000), endsAt: new Date(now.getTime() + 7200_000),
    });
    await c.setCampaignProducts(other, ['TST-A']);
    await assert.rejects(c.scheduleCampaign(other, now), (e: any) => e.code === 'CONFLICT');
    await assert.rejects(c.updateCampaign(id, { name: 'x', discountType: 'PERCENT', discountValue: 5, startsAt: now, endsAt: new Date(now.getTime() + DAY) }),
      (e: any) => e.code === 'INVALID');

    // 1.ª passagem: inicia, envia A, C e E
    const t1 = await runCampaignTick(now, writer);
    assert.deepEqual(t1.started, [{ id, included: 3, blocked: 2 }]);
    assert.equal(t1.applied, 3);
    assert.deepEqual(t1.errors, []);
    assert.deepEqual(writes.sort(), ['TST-A=90.00/100.00', 'TST-C=80.00/85.00', 'TST-E=90.00/100.00']);
    assert.equal((await c.getCampaign(id)).status, 'ATIVA');
    const h1 = await db.selectFrom('price_history').select(['sku', 'new_price', 'new_compare_at_price', 'source', 'campaign_id'])
      .where('source', '=', 'CAMPAIGN').orderBy('sku').execute();
    assert.deepEqual(h1.map(r => [r.sku, Number(r.new_price), Number(r.new_compare_at_price), r.campaign_id]),
      [['TST-A', 90, 100, id], ['TST-C', 80, 85, id], ['TST-E', 90, 100, id]]);
    assert.equal((await c.loadLivePromotions()).size, 3);

    // 2.ª passagem: nada a fazer (idempotente)
    writes.length = 0;
    const t2 = await runCampaignTick(new Date(now.getTime() + 60_000), writer);
    assert.equal(t2.applied + t2.reverted, 0);
    assert.deepEqual(writes, []);

    // O custo de A sobe (importação): 90 € passa a dar prejuízo → retirado e reposto o base
    await db.updateTable('products').set({ cost: 75 }).where('sku', '=', 'TST-A').execute();
    assert.deepEqual(await c.withdrawLossMakers(now), [{ campaignId: id, sku: 'TST-A' }]);
    const t3 = await runCampaignTick(new Date(now.getTime() + 120_000), writer);
    assert.equal(t3.reverted, 1);
    assert.deepEqual(writes, ['TST-A=100.00/null']);
    const end = await db.selectFrom('price_history').select(['sku', 'campaign_id']).where('source', '=', 'CAMPAIGN_END').execute();
    assert.deepEqual(end.map(r => [r.sku, r.campaign_id]), [['TST-A', id]]);

    // Cancelar: repõe C e E
    writes.length = 0;
    await c.cancelCampaign(id, now);
    const t4 = await runCampaignTick(new Date(now.getTime() + 180_000), writer);
    assert.equal(t4.reverted, 2);
    assert.deepEqual(writes.sort(), ['TST-C=100.00/null', 'TST-E=100.00/null']);
    assert.equal((await c.loadLivePromotions()).size, 0);
    assert.equal((await c.getCampaign(id)).status, 'CANCELADA');

    // Agora a 2.ª campanha já pode ser agendada (A já não está em promoção nas mesmas datas)
    await c.scheduleCampaign(other, now);
    await assert.rejects(c.deleteCampaign(other), (e: any) => e.code === 'INVALID');
  } finally {
    await closeMssql();
  }
});
