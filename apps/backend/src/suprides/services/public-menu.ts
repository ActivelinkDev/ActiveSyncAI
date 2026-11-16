import { loadMenuItems, loadPublicMenu, savePublicMenu } from '../repositories/store';
import { publishMenuNodes } from '../api/shopify-api';
import type { MenuNode, PublicMenuFile, PublicMenuStats } from '../types';

/**
 * Conta o número total de nós numa árvore de menu (recursivo).
 */
function countNodes(nodes: MenuNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children || []), 0);
}

/**
 * Filtra a árvore de menu para conter apenas categorias cujo shopifyId está no
 * conjunto activeIds, ou que têm pelo menos um descendente visível.
 * Retorna null se o nó não deve aparecer no menu público.
 */
function filterNode(node: MenuNode, activeIds: Set<string>): MenuNode | null {
  const filteredChildren = (node.children || [])
    .map(c => filterNode(c, activeIds))
    .filter((c): c is MenuNode => c !== null);

  const selfActive = !!node.shopifyId && activeIds.has(node.shopifyId);
  if (selfActive || filteredChildren.length > 0) {
    return { title: node.title, shopifyId: node.shopifyId, children: filteredChildren };
  }
  return null;
}

/**
 * Constrói a árvore de menu público a partir dos IDs de coleções com produtos ativos,
 * guarda em public-menu-items.json e devolve o ficheiro gerado.
 */
export function buildPublicMenuTree(activeCollectionIds: string[]): PublicMenuFile {
  const activeIds = new Set(activeCollectionIds);
  const sourceNodes = loadMenuItems();
  const sourceCount = countNodes(sourceNodes);

  const publicNodes = sourceNodes
    .map(n => filterNode(n, activeIds))
    .filter((n): n is MenuNode => n !== null);

  const publicCount = countNodes(publicNodes);

  const stats: PublicMenuStats = {
    generatedAt: new Date().toISOString(),
    sourceNodes: sourceCount,
    publicNodes: publicCount,
    hiddenNodes: sourceCount - publicCount,
    activeCollectionIds,
  };

  const file: PublicMenuFile = { nodes: publicNodes, stats };
  savePublicMenu(file);
  return file;
}

/**
 * Publica o menu público atual no Shopify.
 * Não lança erro — devolve { ok, errors, warnings }.
 */
export async function publishPublicMenu(
  handle = 'menu-publico',
  title = 'Menu Público'
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const file = loadPublicMenu();

  if (!file.nodes || file.nodes.length === 0) {
    warnings.push('Nenhum nó público gerado ainda. Execute buildPublicMenuTree primeiro.');
    return { ok: false, errors: [], warnings };
  }

  try {
    const result = await publishMenuNodes(handle, title, file.nodes);
    return { ok: result.ok, errors: result.errors, warnings };
  } catch (e: any) {
    return { ok: false, errors: [e?.message || String(e)], warnings };
  }
}
