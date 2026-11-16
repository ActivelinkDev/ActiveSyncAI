export interface SupridesProduct {
  sku: string;
  name: string;
  ean?: string;
  brand?: string;
  product_line?: string;
  family?: string;
  sub_family?: string;
  price?: string;
  pvpr?: string;
  stock?: string;
  stock_status?: string;
  images?: string[];
  description?: string;
  short_description?: string;
  cor?: string;
  weight?: string | number;
  part_number?: string;
  manufacturer?: string;
}

export interface FamiliaTree {
  product_line: string;
  familias: { family: string; subfamilias: string[] }[];
}

export type PriceMode = 'percentage' | 'fixed';

export interface PricingRule {
  mode: PriceMode;
  marginValue: number;
}

export interface LinePricingRule extends PricingRule {
  product_line: string;
}

export interface FamilyPricingRule extends PricingRule {
  family: string;
}

export interface SubfamiliaPricingRule extends PricingRule {
  subfamilia: string;
}

export interface Margins {
  linePricingRules: LinePricingRule[];
  familyPricingRules: FamilyPricingRule[];
  pricingRules: SubfamiliaPricingRule[];
}

export interface Rounding {
  aboveUnitTo999: boolean;
  belowUnitTo499: boolean;
}

export interface AdminSettings {
  ivaRate: number;
  rounding: Rounding;
  autoPublishPublicMenu?: boolean;
  /** Criar na Shopify produtos que ainda lá não existem. Por omissão false: o sync só atualiza. */
  createNewProducts?: boolean;
}

export interface ConnectionSettings {
  shopifyStore?: string;
  shopifyToken?: string;
  shopifyLocationId?: string;
  supridesUrl?: string;
  supridesUser?: string;
  supridesPass?: string;
  supridesToken?: string;
  openaiApiKey?: string;
}

export interface LineMapping {
  product_line: string;
  active: boolean;
  menuItem?: string;
}

export interface FamilyMapping {
  product_line: string;
  family: string;
  active: boolean;
  shopifyLevel2?: string;
  shopifyLevel3?: string;
}

export interface Mappings {
  suprides?: LineMapping[];
  lineToMenu?: Record<string, string>;
  familyMappings?: FamilyMapping[];
}

export interface ShopifyCollectionMapping {
  menu:       Record<string, string[]>;
  familia:    Record<string, string[]>;
  subfamilia: Record<string, string[]>;
  hidden?:    Record<string, boolean>;
}

export interface MenuNode {
  title: string;
  shopifyId?: string;
  children: MenuNode[];
}

export interface MenuItemsFile {
  nodes: MenuNode[];
}

export interface SyncStats {
  api: string;
  lastSyncAt: string | null;
  totals: { requested: number; synced: number; created: number; updated: number; errors: number };
  history: {
    timestamp: string;
    requested: number;
    synced: number;
    created: number;
    updated: number;
    errors: number;
  }[];
  latestProducts: { sku: string; title: string; action: string; syncedAt: string }[];
}

export interface CollectionMarginRule {
  mode: PriceMode;
  marginValue: number;
  _title?: string; // título da coleção — usado para remapear IDs após sync do Shopify
}

export interface CollectionMargins {
  rules: { [collectionId: string]: CollectionMarginRule };
}

export interface PublicMenuStats {
  generatedAt: string;
  sourceNodes: number;
  publicNodes: number;
  hiddenNodes: number;
  activeCollectionIds: string[];
}

export interface PublicMenuFile {
  nodes: MenuNode[];
  stats: PublicMenuStats;
}


