import { Router, Request, Response } from "express";
import {
  getTagGroups, getTagGroupById, createTagGroup, updateTagGroup, deleteTagGroup,
  getTagValues, addTagValue, deleteTagValue,
  getMenuNodeTagGroupIds, setMenuNodeTagGroups, resolveTagGroupsForNode,
  getProductTagValues, upsertProductTagValue, deleteProductTagValue,
  clearAllProductTagValues, clearPopulateDone,
} from "../repositories/tags";
import {
  getAllNodes, getMenuWithProductCounts, getAncestors, getProductsForMenuNode,
  rebuildProductNodeIds, invalidateMenuIndex,
} from "../services/menu-resolver";
import { getMssql } from "../../db/mssql";
import { sql } from "kysely";
import { getProductBySku } from "../../repositories/suprides-cache";
import { applyRule } from "../../utils/normalize-rules";

const router = Router();

// ─────────────────────────────────────────────────────────────
// Tag Groups CRUD
// ─────────────────────────────────────────────────────────────

router.get("/groups", async (_req: Request, res: Response) => {
  try {
    res.json(await getTagGroups());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/groups", async (req: Request, res: Response) => {
  const nome      = String(req.body.nome      || "").trim();
  const descricao = String(req.body.descricao || "").trim() || undefined;
  const unidade   = String(req.body.unidade   || "").trim() || undefined;

  if (!nome) { res.status(400).json({ error: "nome é obrigatório" }); return; }

  try {
    const id = await createTagGroup(nome, descricao, unidade);
    res.json(await getTagGroupById(id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/groups/:id", async (req: Request, res: Response) => {
  const id        = Number(req.params.id);
  const nome      = String(req.body.nome      || "").trim();
  const descricao = String(req.body.descricao || "").trim() || undefined;
  const unidade   = String(req.body.unidade   || "").trim() || undefined;

  if (!nome) { res.status(400).json({ error: "nome é obrigatório" }); return; }

  try {
    await updateTagGroup(id, nome, descricao, unidade);
    res.json(await getTagGroupById(id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/groups/:id", async (req: Request, res: Response) => {
  try {
    await deleteTagGroup(Number(req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Tag Values
// ─────────────────────────────────────────────────────────────

router.get("/groups/:id/values", async (req: Request, res: Response) => {
  try {
    res.json(await getTagValues(Number(req.params.id)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/groups/:id/values", async (req: Request, res: Response) => {
  const id  = Number(req.params.id);
  const val = String(req.body.value || "").trim();
  if (!val) { res.status(400).json({ error: "value é obrigatório" }); return; }

  try {
    const newId = await addTagValue(id, val);
    if (!newId) { res.status(409).json({ error: "Valor já existe" }); return; }
    res.json({ id: newId, value: val });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/values/:id", async (req: Request, res: Response) => {
  try {
    await deleteTagValue(Number(req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Menu tree — árvore do menu público com contadores de produtos
// ─────────────────────────────────────────────────────────────

router.get("/menu/tree", async (_req: Request, res: Response) => {
  try {
    res.json(await getMenuWithProductCounts());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Menu node tag group assignments
// ─────────────────────────────────────────────────────────────

router.get("/menu/:shopifyId/groups", async (req: Request, res: Response) => {
  try {
    const ids = await getMenuNodeTagGroupIds(req.params.shopifyId);
    res.json(ids.map(id => ({ id })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/menu/:shopifyId/groups", async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body.tag_group_ids)
    ? req.body.tag_group_ids.map(Number).filter((n: number) => !isNaN(n))
    : [];
  try {
    await setMenuNodeTagGroups(req.params.shopifyId, ids);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Devolve os tag_group_ids efectivos para um nó (com herança).
 * O frontend usa isto para saber que tags mostrar nos produtos do nó.
 */
router.get("/menu/:shopifyId/effective-groups", async (req: Request, res: Response) => {
  try {
    const ids = await resolveTagGroupsForNode(req.params.shopifyId);
    res.json(ids.map(id => ({ id })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Devolve os ancestrais de um nó (para breadcrumb / herança visual).
 */
router.get("/menu/:shopifyId/ancestors", async (req: Request, res: Response) => {
  try {
    const nodes = await getAllNodes();
    const byId  = new Map(nodes.map(n => [n.shopifyId, n]));
    const chain = (await getAncestors(req.params.shopifyId)).map(id => byId.get(id)).filter(Boolean);
    res.json(chain);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Rebuild shopify_node_id para todos os produtos
// ─────────────────────────────────────────────────────────────

router.post("/menu/rebuild-node-ids", async (_req: Request, res: Response) => {
  try {
    const result = await rebuildProductNodeIds();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Invalida o índice de menu em memória (usar após recarregar menu ou mapping).
 */
router.post("/menu/invalidate-index", async (_req: Request, res: Response) => {
  invalidateMenuIndex();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Product tag values — leitura e edição manual
// ─────────────────────────────────────────────────────────────

router.get("/product/:sku/tag-values", async (req: Request, res: Response) => {
  try {
    const product = await getProductBySku(req.params.sku);

    const effectiveIds = await resolveTagGroupsForNode(product?.shopify_node_id ?? null);
    const saved        = await getProductTagValues(req.params.sku);

    // Enriquecer com normalized_value da tabela de normalização
    const normRows = await getMssql().selectFrom("product_tags_normalized").select(["tag_group_id", "normalized_value"])
      .where("sku", "=", req.params.sku).execute();
    const normMap = new Map(normRows.map(r => [r.tag_group_id, r.normalized_value]));

    const values = saved.map(v => ({
      ...v,
      normalized_value: normMap.get(v.tag_group_id) ?? null,
    }));

    res.json({ effectiveTagGroupIds: effectiveIds, values });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/product/:sku/tag-values", async (req: Request, res: Response) => {
  const { tag_group_id, value } = req.body;
  if (!tag_group_id || value == null) {
    res.status(400).json({ error: "tag_group_id e value são obrigatórios" }); return;
  }
  try {
    const saved = await upsertProductTagValue(req.params.sku, Number(tag_group_id), String(value));
    if (!saved) { res.status(404).json({ error: "Produto não encontrado" }); return; }
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/product/:sku/tag-values/:tagGroupId", async (req: Request, res: Response) => {
  try {
    await deleteProductTagValue(req.params.sku, Number(req.params.tagGroupId));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/product-tag-values", async (_req: Request, res: Response) => {
  try {
    const deleted = await clearAllProductTagValues();
    res.json({ deleted });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Lista produtos de um nó de menu (inclui descendentes).
 * Devolve sku + name para o dialog de produtos.
 */
router.get("/menu/:shopifyId/products", async (req: Request, res: Response) => {
  try {
    const directOnly = req.query.directOnly === 'true';
    const products = await getProductsForMenuNode(req.params.shopifyId, directOnly);
    res.json(products.map(p => ({ ref: p.sku, design: p.name })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Product info (EAN)
// ─────────────────────────────────────────────────────────────

router.get("/product/:sku/info", async (req: Request, res: Response) => {
  try {
    const row = await getProductBySku(req.params.sku);
    res.json({ ean: row?.ean ?? '', id_produto: '' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Product search (para o tab Produtos na dialog de tags)
// ─────────────────────────────────────────────────────────────

router.get("/products/search", async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) { res.json([]); return; }
  try {
    const like = `%${q}%`;
    const { rows } = await sql<{ ref: string; design: string }>`
      SELECT TOP(100) sku AS ref, COALESCE(name, sku) AS design FROM products
      WHERE (sku LIKE ${like} OR name LIKE ${like}) ORDER BY name, sku`.execute(getMssql());
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Reset populate progress
// ─────────────────────────────────────────────────────────────

router.delete("/populate-tags-progress", async (_req: Request, res: Response) => {
  try {
    const deleted = await clearPopulateDone();
    res.json({ deleted });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// Normalização de tags — lê product_tags + tag_groups,
// aplica regras e actualiza value no próprio registo.
// ─────────────────────────────────────────────────────────────

router.post("/normalize", async (_req: Request, res: Response) => {
  try {
    const totals = await getMssql().transaction().execute(async trx => {
      const { rows } = await sql<{ sku: string; tag_group_id: number; value: string; tag_nome: string }>`
        SELECT pt.sku, pt.tag_group_id, pt.value, tg.name AS tag_nome
        FROM product_tags pt WITH (UPDLOCK, HOLDLOCK)
        JOIN products p ON p.sku = pt.sku
        JOIN tag_groups tg ON tg.id = pt.tag_group_id WHERE TRIM(pt.value) <> ''`.execute(trx);
      const values = rows.flatMap(row => {
        const value = applyRule(row.tag_nome, row.value);
        return value === null ? [] : [{ sku: row.sku, tag_group_id: row.tag_group_id, value }];
      });
      for (let i = 0; i < values.length; i += 1000) {
        await sql`MERGE product_tags_normalized WITH (HOLDLOCK) AS target
          USING OPENJSON(${JSON.stringify(values.slice(i, i + 1000))})
            WITH (sku nvarchar(64), tag_group_id int, value nvarchar(max)) AS src
          ON target.sku = src.sku AND target.tag_group_id = src.tag_group_id
          WHEN MATCHED THEN UPDATE SET normalized_value = src.value, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (sku, tag_group_id, normalized_value)
            VALUES (src.sku, src.tag_group_id, src.value);`.execute(trx);
      }
      return { total: rows.length, saved: values.length, ignored: rows.length - values.length };
    });
    res.json(totals);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
