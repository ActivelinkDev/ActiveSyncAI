import { Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard';
import { Errors } from './pages/errors/errors';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'erros', component: Errors },
  { path: 'config', redirectTo: 'dashboard', pathMatch: 'full' }
];
