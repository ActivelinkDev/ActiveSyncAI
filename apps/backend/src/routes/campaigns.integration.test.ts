/**
 * API das campanhas na base de TESTE (ActiveSyncAI_Test). Saltado sem .env.test.
 * Monta só o router (sem sessão), num servidor local numa porta livre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import { testDbAvailable, getTestDb } from '../test-support/test-db';

const skip = !testDbAvailable();

test('API /api/campanhas: criar, produtos, pré-visualizar, agendar, conflito, cancelar', { skip }, async () => {
  const db = await getTestDb();
  const express = (await import('express')).default;
  const router = (await import('./campaigns')).default;
  const { closeMssql } = await import('../db/mssql');

  const app = express();
  app.use(express.json());
  app.use('/api/campanhas', router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: 'Erro interno', detail: String(err?.message) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/campanhas`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  try {
    await db.deleteFrom('campaign_products').execute();
    await db.deleteFrom('campaigns').execute();
    await db.deleteFrom('price_history').execute();
    await db.deleteFrom('price_current').execute();
    await db.deleteFrom('products').where('sku', 'like', 'TST-%').execute();
    const now = Date.now();
    await db.insertInto('products').values([
      { sku: 'TST-API1', name: 'Rato API', brand: 'MarcaX', family: 'Ratos', cost: 10, base_price: 20, shopify_product_id: 11, shopify_variant_id: 110, stock_status: 'disponivel' },
      { sku: 'TST-API2', name: 'Teclado API', brand: 'MarcaY', family: 'Teclados', cost: 10, base_price: 20, shopify_product_id: 12, shopify_variant_id: 120, stock_status: 'disponivel' },
      { sku: 'TST-API3', name: 'Sem preço', brand: 'MarcaX', cost: null, base_price: null },
    ]).execute();
    await db.insertInto('price_history').values(['TST-API1', 'TST-API2'].map(sku =>
      ({ sku, new_price: 20, source: 'INITIAL', changed_at: new Date(now - 40 * 86_400_000), status: 'ACTIVE' }))).execute();

    // Estado e filtros
    const st = await call('GET', '/status');
    assert.equal(st.status, 200);
    assert.equal(st.body.tickerEnabled, false);
    assert.ok(st.body.validFrom);
    const f = await call('GET', '/filtros');
    assert.ok(f.body.brands.includes('MarcaX'));

    // Seleção: por marca (só geridos) e por SKUs colados
    const sel = await call('POST', '/selecao', { brand: 'MarcaX' });
    assert.deepEqual(sel.body.products.map((p: any) => p.sku), ['TST-API1']);
    const pasted = await call('POST', '/selecao', { skus: 'TST-API1, TST-API2\nTST-API3', onlyManaged: false });
    assert.equal(pasted.body.products.length, 3);

    // Validação
    const invalid = await call('POST', '/', { name: '', discountType: 'PERCENT', discountValue: 10, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3600_000).toISOString() });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /nome/i);
    const badDates = await call('POST', '/', { name: 'x', discountType: 'PERCENT', discountValue: 10, startsAt: 'ontem', endsAt: 'amanhã' });
    assert.equal(badDates.status, 400);

    // Criar + produtos + exceção + pré-visualização
    const body = { name: 'Black Friday', discountType: 'PERCENT', discountValue: 10, startsAt: new Date(now + 3600_000).toISOString(), endsAt: new Date(now + 7200_000).toISOString() };
    const created = await call('POST', '/', body);
    assert.equal(created.status, 201);
    const id = created.body.id;
    const prods = await call('PUT', `/${id}/produtos`, { skus: ['TST-API1', 'TST-API2', 'NAO-EXISTE'] });
    assert.deepEqual(prods.body, { count: 2, unknown: ['NAO-EXISTE'] });
    assert.equal((await call('PUT', `/${id}/produtos/TST-API2/excecao`, { type: 'AMOUNT', value: 3 })).status, 200);
    assert.equal((await call('PUT', `/${id}/produtos/NAO-EXISTE/excecao`, { type: 'AMOUNT', value: 3 })).status, 404);
    const prev = await call('GET', `/${id}/previsao`);
    const bySku = new Map(prev.body.map((e: any) => [e.sku, e]));
    assert.equal((bySku.get('TST-API1') as any).promo, 18);
    assert.equal((bySku.get('TST-API2') as any).promo, 17);
    assert.equal((bySku.get('TST-API1') as any).product.name, 'Rato API');

    const detail = await call('GET', `/${id}`);
    assert.equal(detail.body.status, 'RASCUNHO');
    assert.equal(detail.body.products.length, 2);
    assert.deepEqual(detail.body.products.find((p: any) => p.sku === 'TST-API2').override, { type: 'AMOUNT', value: 3 });

    // Agendar; outra campanha com o mesmo produto nas mesmas datas → 409
    assert.equal((await call('POST', `/${id}/agendar`)).status, 200);
    assert.equal((await call('PUT', `/${id}`, body)).status, 400); // agendada não se edita
    const other = (await call('POST', '/', { ...body, name: 'Sobreposta' })).body.id;
    await call('PUT', `/${other}/produtos`, { skus: ['TST-API1'] });
    const conflict = await call('POST', `/${other}/agendar`);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.details[0].sku, 'TST-API1');

    // Lista com contagens; desagendar, cancelar, apagar rascunho
    const list = await call('GET', '/');
    assert.equal(list.body.length, 2);
    assert.equal((await call('POST', `/${id}/desagendar`)).status, 200);
    assert.equal((await call('POST', `/${id}/cancelar`)).status, 200);
    assert.equal((await call('DELETE', `/${id}`)).status, 400);    // cancelada não se apaga
    assert.equal((await call('DELETE', `/${other}`)).status, 200); // rascunho sim
    assert.equal((await call('GET', `/${other}`)).status, 404);
    assert.equal((await call('GET', '/abc')).status, 400);
  } finally {
    server.close();
    await closeMssql();
  }
});
