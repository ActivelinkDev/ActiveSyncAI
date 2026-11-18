import { HttpInterceptorFn } from '@angular/common/http';

/**
 * A interface é servida pelo próprio backend: todos os pedidos vão para a mesma origem
 * (o cookie de sessão segue automaticamente). URLs absolutas não são alteradas.
 */
export const apiBaseInterceptor: HttpInterceptorFn = (req, next) => {
  if (/^https?:\/\//i.test(req.url) || req.url.startsWith('/')) return next(req);
  return next(req.clone({ url: '/' + req.url }));
};
