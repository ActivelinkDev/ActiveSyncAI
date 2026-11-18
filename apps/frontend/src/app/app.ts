import { Component, OnInit, inject } from '@angular/core';
import { WindowsShellComponent } from './ui/windows-shell/windows-shell';
import { LoginComponent } from './auth/login';
import { AuthService } from './auth/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [WindowsShellComponent, LoginComponent],
  template: `
    <div class="app-bg" aria-hidden="true"><i></i><i></i><i></i></div>
    @switch (auth.state()) {
      @case ('in') { <app-windows-shell></app-windows-shell> }
      @case ('out') { <app-login></app-login> }
    }
  `,
})
export class AppComponent implements OnInit {
  readonly auth = inject(AuthService);
  ngOnInit(): void { this.auth.check(); }
}
