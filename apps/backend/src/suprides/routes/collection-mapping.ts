import { Router } from 'express';
import { loadShopifyCollectionMapping, saveShopifyCollectionMapping } from '../repositories/store';
import { loadSupridesTaxonomy, normTaxonomyValue } from '../services/taxonomy';

const router = Router();

type MappingSection = 'menu' | 'familia' | 'subfamilia';
type MappingValueStatus = 'ok' | 'ambiguous' | 'probablyWrongLevel' | 'unknown';

interface MappingValueValidation {
  collId: string;
  value: string;
  expected: 'product_line' | 'family';
  matches: {
    product_line: boolean;
    family: boolean;
    sub_family: boolean;
  };
  matchedKinds: ('product_line' | 'family' | 'sub_family')[];
  status: MappingValueStatus;
}

function classifyMappingValue(
  value: string,
  expected: 'product_line' | 'family',
  sets: { productLines: Set<string>; families: Set<string>; subFamilies: Set<string> }
): Omit<MappingValueValidation, 'collId' | 'value' | 'expected'> {
  const matches = {
    product_line: sets.productLines.has(value),
    family: sets.families.has(value),
    sub_family: sets.subFamilies.has(value),
  };
  const matchedKinds = (Object.entries(matches) as ['product_line' | 'family' | 'sub_family', boolean][])
    .filter(([, matched]) => matched)
    .map(([kind]) => kind);
  const matchCount = matchedKinds.length;

  let status: MappingValueStatus;
  if (matchCount === 0) status = 'unknown';
  else if (matchCount > 1) status = 'ambiguous';
  else if ((expected === 'product_line' && matches.product_line) || (expected === 'family' && matches.family)) status = 'ok';
  else status = 'probablyWrongLevel';

  return { matches, matchedKinds, status };
}

router.get('/validate', async (_req, res) => {
  try {
    const mapping = await loadShopifyCollectionMapping();
    const taxonomy = await loadSupridesTaxonomy();
    const sets = {
      productLines: taxonomy.productLines,
      families: taxonomy.families,
      subFamilies: taxonomy.subFamilies,
    };

    const validateSection = (
      section: MappingSection,
      expected: 'product_line' | 'family'
    ): MappingValueValidation[] => {
      const entries = mapping[section] || {};
      const out: MappingValueValidation[] = [];
      for (const [collId, values] of Object.entries(entries)) {
        for (const raw of values || []) {
          const value = normTaxonomyValue(raw);
          if (!value) continue;
          out.push({
            collId,
            value,
            expected,
            ...classifyMappingValue(value, expected, sets),
          });
        }
      }
      return out;
    };

    const sections = {
      menu: validateSection('menu', 'product_line'),
      familia: validateSection('familia', 'product_line'),
      subfamilia: validateSection('subfamilia', 'family'),
    };

    const summarize = (items: MappingValueValidation[]) =>
      items.reduce<Record<MappingValueStatus, number>>((acc, item) => {
        acc[item.status]++;
        return acc;
      }, { ok: 0, ambiguous: 0, probablyWrongLevel: 0, unknown: 0 });

    res.json({
      model: {
        menu: 'Shopify L1 -> Suprides product_line',
        familia: 'Shopify L2 -> Suprides product_line',
        subfamilia: 'Shopify L3 -> Suprides family',
      },
      source: {
        products: taxonomy.products.length,
        productLines: taxonomy.productLines.size,
        families: taxonomy.families.size,
        subFamilies: taxonomy.subFamilies.size,
        warnings: taxonomy.warnings,
      },
      summary: {
        menu: summarize(sections.menu),
        familia: summarize(sections.familia),
        subfamilia: summarize(sections.subfamilia),
      },
      sections,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erro ao validar mapping', detail: e.message });
  }
});

router.get('/', async (_req, res) => {
  res.json(await loadShopifyCollectionMapping());
});

function mappingValueCount(mapping: Awaited<ReturnType<typeof loadShopifyCollectionMapping>>): number {
  const countSection = (section?: Record<string, string[]>) =>
    Object.values(section || {}).reduce((total, values) => total + (Array.isArray(values) ? values.length : 0), 0);
  return countSection(mapping.menu) + countSection(mapping.familia) + countSection(mapping.subfamilia);
}

function normalizeSection(section: unknown): Record<string, string[]> {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, rawValues] of Object.entries(section as Record<string, unknown>)) {
    if (!Array.isArray(rawValues)) continue;
    const values = rawValues.map(v => normTaxonomyValue(v)).filter(Boolean);
    if (values.length) out[key] = values;
  }
  return out;
}

router.put('/', async (req, res) => {
  const current = await loadShopifyCollectionMapping();
  const incoming = {
    menu: normalizeSection(req.body?.menu),
    familia: normalizeSection(req.body?.familia),
    subfamilia: normalizeSection(req.body?.subfamilia),
    hidden: req.body?.hidden && typeof req.body.hidden === 'object' && !Array.isArray(req.body.hidden)
      ? req.body.hidden
      : undefined,
  };

  if (mappingValueCount(current) > 0 && mappingValueCount(incoming) === 0 && req.query.force !== 'true') {
    return res.status(400).json({
      error: 'Recusado para proteger mapeamentos existentes',
      detail: 'O payload recebido não tem nenhum mapeamento. Usa ?force=true apenas se quiseres limpar tudo de propósito.',
    });
  }

  if (incoming.hidden && !Object.keys(incoming.hidden).length) delete incoming.hidden;
  await saveShopifyCollectionMapping(incoming);
  res.json(incoming);
});

export default router;
