import { Router } from "express";
import { getSqlite } from "../db/sqlite";
import { loadStats } from "../suprides/repositories/store";

const router = Router();

router.get("/summary", (_req, res) => {
  try {
    const db = getSqlite();

    const { total } = db.prepare(
      "SELECT COUNT(*) as total FROM suprides_products"
    ).get() as { total: number };

    const { synced } = db.prepare(
      "SELECT COUNT(*) as synced FROM suprides_products WHERE shopify_product_id IS NOT NULL"
    ).get() as { synced: number };

    const { withTags } = db.prepare(
      "SELECT COUNT(DISTINCT sku) as withTags FROM sp_product_tag_values"
    ).get() as { withTags: number };

    const tagCoverage = total > 0 ? Math.round((withTags / total) * 100) : 0;

    const byProductLine = db.prepare(
      `SELECT COALESCE(product_line, 'Sem linha') as name, COUNT(*) as count
       FROM suprides_products GROUP BY product_line ORDER BY count DESC LIMIT 12`
    ).all() as { name: string; count: number }[];

    const byFamily = db.prepare(
      `SELECT COALESCE(family, 'Sem família') as name, COUNT(*) as count
       FROM suprides_products GROUP BY family ORDER BY count DESC LIMIT 10`
    ).all() as { name: string; count: number }[];

    const stats = loadStats();
    const lastSync = stats.lastSyncAt;
    let lastSyncStatus: 'ok' | 'error' | null = null;
    if (lastSync && stats.history.length > 0) {
      const last = stats.history[stats.history.length - 1];
      lastSyncStatus = last.synced > 0 ? 'ok' : 'error';
    }

    res.json({
      totalProducts:   total,
      syncedProducts:  synced,
      productsWithTags: withTags,
      tagCoverage,
      lastSync,
      lastSyncStatus,
      byProductLine,
      byFamily,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
