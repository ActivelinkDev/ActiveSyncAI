/**
 * API das campanhas (/api/campanhas). Atrás da sessão e do controlo de Origin (index.ts);
 * agendar, desagendar e cancelar ficam no registo de segurança (security/middleware.ts).
 *
 * Nada aqui escreve na loja: é o temporizador das campanhas que envia os preços.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  CampaignError, listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  setCampaignProducts, setProductOverride, previewCampaign, scheduleCampaign, unscheduleCampaign, cancelCampaign,
  searchProducts, productFilterOptions, productInfo, historyStartedAt, previewDraft, saveCampaignItems,
  type DraftItem,
  type CampaignInput,
} from '../suprides/repositories/campaigns';
import type { Discount } from '../suprides/services/campaign-calc';
import { campaignTickerEnabled } from '../services/campaign-ticker';

const router = Router();
const DAY_MS = 86_400_000;

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(e => {
    if (e instanceof CampaignError) {
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : 400;
      res.status(status).json({ error: e.message, details: e.details });
      return;
    }
    next(e);
  });
};

const bad = (msg: string) => new CampaignError(msg, 'INVALID');

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Campanha inválida.');
  return id;
}

function parseDate(v: unknown, label: string): Date {
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw bad(`${label}: data inválida.`);
  return d;
}

function parseDiscount(type: unknown, value: unknown): Discount {
  if (type !== 'PERCENT' && type !== 'AMOUNT') throw bad('Tipo de desconto inválido.');
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw bad('Valor do desconto inválido.');
  return { type, value: n };
}

function parseCampaignInput(b: any): CampaignInput {
  if (!b || typeof b !== 'object') throw bad('Pedido inválido.');
  const d = parseDiscount(b.discountType, b.discountValue);
  return {
    name: String(b.name ?? ''), discountType: d.type, discountValue: d.value,
    startsAt: parseDate(b.startsAt, 'Início'), endsAt: parseDate(b.endsAt, 'Fim'),
    notes: b.notes == null ? null : String(b.notes),
  };
}

function parseSkus(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

// Estado geral: temporizador e data a partir da qual as campanhas cumprem os 30 dias.
router.get('/status', route(async (_req, res) => {
  const since = await historyStartedAt();
  res.json({
    tickerEnabled: campaignTickerEnabled(),
    historySince: since?.toISOString() ?? null,
    validFrom: since ? new Date(since.getTime() + 30 * DAY_MS).toISOString() : null,
  });
}));

router.get('/filtros', route(async (_req, res) => { res.json(await productFilterOptions()); }));

router.post('/selecao', route(async (req, res) => {
  const b = req.body ?? {};
  res.json(await searchProducts({
    brand: str(b.brand), productLine: str(b.productLine), family: str(b.family), subFamily: str(b.subFamily), stockStatus: str(b.stockStatus),
    text: str(b.text), skus: parseSkus(b.skus), onlyManaged: b.onlyManaged !== false,
  }));
}));

function parseItems(v: unknown): DraftItem[] {
  if (!Array.isArray(v)) throw bad('Lista de produtos inválida.');
  return v.map((it: any) => ({
    sku: String(it?.sku ?? ''),
    override: it?.override?.type == null ? null : parseDiscount(it.override.type, it.override.value),
  }));
}

// Pré-visualização de um rascunho ainda não gravado (nada é escrito).
router.post('/previsao', route(async (req, res) => {
  const b = req.body ?? {};
  const d = parseDiscount(b.discountType, b.discountValue);
  const items = await previewDraft({ discountType: d.type, discountValue: d.value, startsAt: parseDate(b.startsAt, 'Início') }, parseItems(b.items));
  const info = await productInfo(items.map(i => i.sku));
  res.json(items.map(e => ({ ...e, product: info.get(e.sku) ?? null })));
}));

router.get('/', route(async (_req, res) => { res.json(await listCampaigns()); }));

router.post('/', route(async (req, res) => {
  const id = await createCampaign(parseCampaignInput(req.body));
  res.status(201).json({ id });
}));

router.get('/:id', route(async (req, res) => {
  const c = await getCampaign(idParam(req));
  const info = await productInfo(c.products.map(p => p.sku));
  res.json({ ...c, products: c.products.map(p => ({ ...p, product: info.get(p.sku) ?? null })) });
}));

router.put('/:id', route(async (req, res) => {
  await updateCampaign(idParam(req), parseCampaignInput(req.body));
  res.json({ ok: true });
}));

router.delete('/:id', route(async (req, res) => {
  await deleteCampaign(idParam(req));
  res.json({ ok: true });
}));

router.put('/:id/produtos', route(async (req, res) => {
  const skus = parseSkus(req.body?.skus);
  if (skus.length > 20000) throw bad('No máximo 20 000 produtos por campanha.');
  res.json(await setCampaignProducts(idParam(req), skus));
}));

// Produtos + exceções de um rascunho, de uma vez (Guardar rascunho).
router.put('/:id/itens', route(async (req, res) => {
  res.json(await saveCampaignItems(idParam(req), parseItems(req.body?.items)));
}));

router.put('/:id/produtos/:sku/excecao', route(async (req, res) => {
  const b = req.body ?? {};
  const override = b.type == null ? null : parseDiscount(b.type, b.value);
  await setProductOverride(idParam(req), String(req.params.sku), override);
  res.json({ ok: true });
}));

router.get('/:id/previsao', route(async (req, res) => {
  const id = idParam(req);
  const [items, c] = [await previewCampaign(id), await getCampaign(id)];
  const info = await productInfo(c.products.map(p => p.sku));
  res.json(items.map(e => ({ ...e, product: info.get(e.sku) ?? null })));
}));

router.post('/:id/agendar', route(async (req, res) => {
  await scheduleCampaign(idParam(req));
  res.json({ ok: true });
}));

router.post('/:id/desagendar', route(async (req, res) => {
  await unscheduleCampaign(idParam(req));
  res.json({ ok: true });
}));

router.post('/:id/cancelar', route(async (req, res) => {
  await cancelCampaign(idParam(req));
  res.json({ ok: true });
}));

export default router;
