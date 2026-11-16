import { Router, Request, Response } from "express";
import {
  getTagGroups, getTagGroupById, createTagGroup, updateTagGroup, deleteTagGroup,
  getTagValues, addTagValue, deleteTagValue,
  getMenuNodeTagGroupIds, setMenuNodeTagGroups, resolveTagGroupsForNode,
  getProductTagValues, upsertProductTagValue, deleteProductTagValue,
  clearAllProductTagValues, clearPopulateDone,
} from "../../suprides/repositories/tags";
import {
  getAllNodes, getProductCount, getDirectProductCount, getAncestors, getDescendants,
  rebuildProductNodeIds, invalidateMenuIndex,
} from "../services/menu-resolver";
import { getSqlite } from "../../db/sqlite";
import { applyRule } from "../../utils/normalize-rules";

const router = Router();
const SUPPLIER = "esprinet";

router.get("/groups", (_req: Request, res: Response) => {
  try { res.json(getTagGroups(SUPPLIER)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/groups", (req: Request, res: Response) => {
  const nome = String(req.body.nome || "").trim();
  const descricao = String(req.body.descricao || "").trim() || undefined;
  const unidade = String(req.body.unidade || "").trim() || undefined;
  if (!nome) { res.status(400).json({ error: "nome e obrigatorio" }); return; }
  try {
    const id = createTagGroup(nome, descricao, unidade, SUPPLIER);
    res.json(getTagGroupById(id));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/groups/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const nome = String(req.body.nome || "").trim();
  const descricao = String(req.body.descricao || "").trim() || undefined;
  const unidade = String(req.body.unidade || "").trim() || undefined;
  if (!nome) { res.status(400).json({ error: "nome e obrigatorio" }); return; }
  try {
    updateTagGroup(id, nome, descricao, unidade);
    res.json(getTagGroupById(id));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/groups/:id", (req: Request, res: Response) => {
  try { deleteTagGroup(Number(req.params.id)); res.json({ ok: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/groups/:id/values", (req: Request, res: Response) => {
  try { res.json(getTagValues(Number(req.params.id))); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/groups/:id/values", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const val = String(req.body.value || "").trim();
  if (!val) { res.status(400).json({ error: "value e obrigatorio" }); return; }
  try {
    const newId = addTagValue(id, val);
    if (!newId) { res.status(409).json({ error: "Valor ja existe" }); return; }
    res.json({ id: newId, value: val });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/values/:id", (req: Request, res: Response) => {
  try { deleteTagValue(Number(req.params.id)); res.json({ ok: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/menu/tree", (_req: Request, res: Response) => {
  try {
    const nodes = getAllNodes();
    res.json(nodes.map(n => ({
      shopifyId: n.shopifyId,
      title: n.title,
      level: n.level,
      parentId: n.parentId,
      grandParentId: n.grandParentId,
      productCount: getProductCount(n.shopifyId),
      directProductCount: getDirectProductCount(n.shopifyId),
    })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/menu/:shopifyId/groups", (req: Request, res: Response) => {
  try { res.json(getMenuNodeTagGroupIds(req.params.shopifyId, SUPPLIER).map(id => ({ id }))); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/menu/:shopifyId/groups", (req: Request, res: Response) => {
  const ids = Array.isArray(req.body.tag_group_ids)
    ? req.body.tag_group_ids.map(Number).filter((n: number) => !isNaN(n))
    : [];
  try { setMenuNodeTagGroups(req.params.shopifyId, ids, SUPPLIER); res.json({ ok: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/menu/:shopifyId/effective-groups", (req: Request, res: Response) => {
  try {
    const ancestors = getAncestors(req.params.shopifyId);
    const ids = resolveTagGroupsForNode(req.params.shopifyId, SUPPLIER, ancestors);
    res.json(ids.map(id => ({ id })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/menu/:shopifyId/ancestors", (req: Request, res: Response) => {
  try {
    const nodes = getAllNodes();
    const byId = new Map(nodes.map(n => [n.shopifyId, n]));
    res.json(getAncestors(req.params.shopifyId).map(id => byId.get(id)).filter(Boolean));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/menu/rebuild-node-ids", (_req: Request, res: Response) => {
  try { res.json(rebuildProductNodeIds()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/menu/invalidate-index", (_req: Request, res: Response) => {
  invalidateMenuIndex();
  res.json({ ok: true });
});

router.get("/product/:sku/tag-values", (req: Request, res: Response) => {
  try {
    const db = getSqlite();
    const product = db.prepare(
      "SELECT shopify_node_id FROM esprinet_products WHERE sku = ?"
    ).get(req.params.sku) as { shopify_node_id: string | null } | undefined;

    const ancestors = product?.shopify_node_id ? getAncestors(product.shopify_node_id) : undefined;
    const effectiveIds = resolveTagGroupsForNode(product?.shopify_node_id ?? null, SUPPLIER, ancestors);
    const effectiveSet = new Set(effectiveIds);
    const saved = getProductTagValues(req.params.sku).filter(v => effectiveSet.has(v.tag_group_id));
    const normRows = db.prepare(
      "SELECT tag_group_id, normalized_value FROM sp_product_tag_values_normalized WHERE product_ref = ?"
    ).all(req.params.sku) as { tag_group_id: number; normalized_value: string }[];
    const normMap = new Map(normRows.map(r => [r.tag_group_id, r.normalized_value]));
    res.json({
      effectiveTagGroupIds: effectiveIds,
      values: saved.map(v => ({ ...v, normalized_value: normMap.get(v.tag_group_id) ?? null })),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/product/:sku/tag-values", (req: Request, res: Response) => {
  const { tag_group_id, value } = req.body;
  if (!tag_group_id || value == null) {
    res.status(400).json({ error: "tag_group_id e value sao obrigatorios" }); return;
  }
  try { upsertProductTagValue(req.params.sku, Number(tag_group_id), String(value)); res.json({ ok: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/product/:sku/tag-values/:tagGroupId", (req: Request, res: Response) => {
  try { deleteProductTagValue(req.params.sku, Number(req.params.tagGroupId)); res.json({ ok: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/product-tag-values", (_req: Request, res: Response) => {
  try { res.json({ deleted: clearAllProductTagValues(SUPPLIER) }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/menu/:shopifyId/products", (req: Request, res: Response) => {
  try {
    const directOnly = req.query.directOnly === 'true';
    const db = getSqlite();
    let rows: { ref: string; design: string }[];
    if (directOnly) {
      rows = db.prepare(
        `SELECT sku as ref, COALESCE(name, sku) as design FROM esprinet_products
         WHERE shopify_node_id = ? ORDER BY name`
      ).all(req.params.shopifyId) as { ref: string; design: string }[];
    } else {
      const ids = getDescendants(req.params.shopifyId);
      if (!ids.length) { res.json([]); return; }
      const placeholders = ids.map(() => "?").join(",");
      rows = db.prepare(
        `SELECT sku as ref, COALESCE(name, sku) as design FROM esprinet_products
         WHERE shopify_node_id IN (${placeholders}) ORDER BY name`
      ).all(...ids) as { ref: string; design: string }[];
    }
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/product/:sku/info", (req: Request, res: Response) => {
  try {
    const row = getSqlite().prepare(
      "SELECT ean FROM esprinet_products WHERE sku = ?"
    ).get(req.params.sku) as { ean: string | null } | undefined;
    res.json({ ean: row?.ean ?? '', id_produto: '' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/products/search", (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) { res.json([]); return; }
  try {
    const like = `%${q}%`;
    const rows = getSqlite().prepare(
      `SELECT sku AS ref, COALESCE(name, sku) AS design
       FROM esprinet_products
       WHERE sku LIKE ? OR name LIKE ? OR ean LIKE ?
       ORDER BY name LIMIT 100`
    ).all(like, like, like) as { ref: string; design: string }[];
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/populate-tags-progress", (_req: Request, res: Response) => {
  try { res.json({ deleted: clearPopulateDone(SUPPLIER) }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/normalize", (_req: Request, res: Response) => {
  try {
    const db = getSqlite();
    const rows = db.prepare(`
      SELECT ptv.sku, ptv.tag_group_id, ptv.value, tg.nome AS tag_nome
      FROM sp_product_tag_values ptv
      JOIN sp_tag_groups tg ON tg.id = ptv.tag_group_id
      WHERE tg.supplier = ? AND ptv.value IS NOT NULL AND TRIM(ptv.value) <> ''
    `).all(SUPPLIER) as { sku: string; tag_group_id: number; value: string; tag_nome: string }[];
    const upsert = db.prepare(`
      INSERT INTO sp_product_tag_values_normalized (product_ref, tag_group_id, normalized_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(product_ref, tag_group_id) DO UPDATE SET
        normalized_value = excluded.normalized_value,
        updated_at = excluded.updated_at
    `);
    let saved = 0;
    let ignored = 0;
    db.transaction(() => {
      for (const row of rows) {
        const normalized = applyRule(row.tag_nome, row.value);
        if (normalized === null) { ignored++; continue; }
        upsert.run(row.sku, row.tag_group_id, normalized);
        saved++;
      }
    })();
    res.json({ total: rows.length, saved, ignored });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
