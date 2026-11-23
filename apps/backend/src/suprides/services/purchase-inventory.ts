import type { SnapshotProduct } from '../api/shopify-read';

const NAMESPACE = 'activesync';
const KEY = 'purchase_inventory_before_block';
type Policy = 'DENY' | 'CONTINUE';

export interface PurchaseInventoryState {
  tracked: boolean;
  policy: Policy;
  onlineQuantity: number;
  previous: string | null;
}

export interface VariantRow {
  id: string;
  inventoryPolicy: Policy;
  sellableOnlineQuantity: number;
  inventoryItem: { id: string; tracked: boolean };
  purchaseInventoryBeforeBlock: { value: string } | null;
}

export const purchaseInventoryFields = [
  'inventoryPolicy sellableOnlineQuantity',
  'purchaseInventoryBeforeBlock: metafield(namespace: "' + NAMESPACE + '", key: "' + KEY + '") { value }',
].join('\n');

export function blocksPurchase(label: string | null | undefined): boolean {
  const status = label?.trim().toLowerCase().replace(/_/g, ' ');
  return status === 'brevemente' || status === 'sob encomenda';
}

export function readPurchaseInventory(variant: VariantRow): PurchaseInventoryState {
  return {
    tracked: variant.inventoryItem.tracked,
    policy: variant.inventoryPolicy,
    onlineQuantity: variant.sellableOnlineQuantity,
    previous: variant.purchaseInventoryBeforeBlock?.value ?? null,
  };
}

function priorSettings(value: string | null): { tracked: boolean; policy: Policy } | null {
  if (value === 'untracked_deny') return { tracked: false, policy: 'DENY' };
  if (value === 'untracked_continue') return { tracked: false, policy: 'CONTINUE' };
  if (value === 'tracked_continue') return { tracked: true, policy: 'CONTINUE' };
  return null;
}

function inventoryInput(tracked: boolean, policy: Policy, previous: string) {
  return {
    inventoryPolicy: policy,
    inventoryItem: { tracked },
    metafields: [{ namespace: NAMESPACE, key: KEY, type: 'single_line_text_field', value: previous }],
  };
}

export function newPurchaseInventory(blocked: boolean) {
  return blocked ? inventoryInput(true, 'DENY', 'untracked_deny') : null;
}

export function planPurchaseInventory(blocked: boolean, state: PurchaseInventoryState) {
  const previous = priorSettings(state.previous);
  if (!blocked) return previous ? inventoryInput(previous.tracked, previous.policy, 'restored') : null;
  if (state.onlineQuantity > 0) throw new Error('Há unidades vendáveis na Shopify. O bloqueio de compra não pode alterar essas quantidades.');
  if (state.tracked && state.policy === 'DENY') return null;
  const before = (previous && state.previous) || (state.tracked ? 'tracked_' : 'untracked_') + state.policy.toLowerCase();
  return inventoryInput(true, 'DENY', before);
}

export function needsPurchaseInventorySync(product: SnapshotProduct, blocked: boolean): boolean {
  if (product.variantsCount > 1) return true;
  const state = product.purchaseInventory;
  if (!blocked) return !!priorSettings(state?.previous ?? null);
  return !state || !state.tracked || state.policy !== 'DENY' || state.onlineQuantity > 0;
}
