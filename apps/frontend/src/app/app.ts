import { Component } from '@angular/core';
import { WindowsShellComponent } from './ui/windows-shell/windows-shell';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [WindowsShellComponent],
  template: `<app-windows-shell></app-windows-shell>`
})
export class AppComponent {}
