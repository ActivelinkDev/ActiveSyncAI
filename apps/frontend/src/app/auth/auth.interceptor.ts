import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Pedidos HttpClient: um 401 da API termina a sessão na interface. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !/\/api\/auth\//.test(req.url)) {
        auth.sessionLost();
      }
      return throwError(() => err);
    }),
  );
};
