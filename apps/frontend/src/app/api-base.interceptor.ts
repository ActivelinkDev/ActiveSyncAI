import { HttpInterceptorFn } from '@angular/common/http';

// muda aqui se um dia quiseres apontar para outro endpoint
const API_BASE: string = (window as any).ENV_API_BASE?.replace(/\/+$/, '') || 'http://localhost:3000';

export const apiBaseInterceptor: HttpInterceptorFn = (req, next) => {
  // se a URL já é absoluta (http/https), não mexe
  if (/^https?:\/\//i.test(req.url)) return next(req);

  // prepend da base para URLs relativas: "/api/..."
  const url = API_BASE.replace(/\/+$/, '') + '/' + req.url.replace(/^\/+/, '');
  return next(req.clone({ url }));
};
