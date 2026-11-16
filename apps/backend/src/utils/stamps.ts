export function generateStamp(): string {
  // PHC Stamp: 25 caracteres normalmente, mas pedido 24
  const base =
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).substring(2, 15).toUpperCase() +
    Math.random().toString(36).substring(2, 15).toUpperCase();
  
  // Cortar a 24 caracteres conforme pedido
  return base.substring(0, 24);
}