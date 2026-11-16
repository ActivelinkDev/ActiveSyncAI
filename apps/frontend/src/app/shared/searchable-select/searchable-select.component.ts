import {
  Component, Input, Output, EventEmitter,
  ElementRef, HostListener, OnDestroy, inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

export interface SelectGroup { label: string; options: string[]; }

interface RenderedPart { t: string; m: boolean; }
interface RenderedOption { text: string; parts: RenderedPart[]; }
interface RenderedGroup { label: string; options: RenderedOption[]; }

@Component({
  selector: 'app-searchable-select',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
  templateUrl: './searchable-select.component.html',
  styleUrls: ['./searchable-select.component.scss']
})
export class SearchableSelectComponent implements OnDestroy {
  private elRef = inject(ElementRef);
  private _value = '';
  private _groups: SelectGroup[] = [];
  private _query = '';

  @Input() set value(v: string) { this._value = v; }
  get value(): string { return this._value; }

  @Input() set groups(g: SelectGroup[]) {
    this._groups = g;
    this._rebuild();
  }

  @Input() placeholder = 'Escolher…';
  @Input() searchPlaceholder = 'Pesquisar…';
  @Input() disabled = false;
  @Output() valueChange = new EventEmitter<string>();

  // query via setter so _rebuild fires on every keystroke
  get query(): string { return this._query; }
  set query(v: string) { this._query = v; this._rebuild(); }

  isOpen = false;
  panelTop = 0;
  panelLeft = 0;
  panelWidth = 0;

  // Template only reads this — never computed inside a binding
  renderedGroups: RenderedGroup[] = [];
  totalResults = 0;

  private _rebuild(): void {
    const q = this._query.trim().toLowerCase();
    const filtered = !q
      ? this._groups
      : this._groups
          .map(g => ({ label: g.label, options: g.options.filter(o => o.toLowerCase().includes(q)) }))
          .filter(g => g.options.length > 0);

    this.renderedGroups = filtered.map(g => ({
      label: g.label,
      options: g.options.map(text => ({ text, parts: this._split(text, q) }))
    }));
    this.totalResults = this.renderedGroups.reduce((n, g) => n + g.options.length, 0);
  }

  private _split(text: string, q: string): RenderedPart[] {
    if (!q) return [{ t: text, m: false }];
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .split(new RegExp(`(${safe})`, 'gi'))
      .filter(p => p.length > 0)
      .map((p, i) => ({ t: p, m: i % 2 === 1 }));
  }

  private _scrollHandler = (e: Event) => {
    if (this.elRef.nativeElement.contains(e.target as Node)) return;
    this.close();
  };

  toggle(triggerEl: HTMLElement): void {
    if (this.disabled) return;
    this.isOpen ? this.close() : this.open(triggerEl);
  }

  open(triggerEl: HTMLElement): void {
    const r = triggerEl.getBoundingClientRect();
    this.panelTop  = r.bottom + 4;
    this.panelLeft = r.left;
    this.panelWidth = Math.max(r.width, 240);
    this._query = '';
    this._rebuild();
    this.isOpen = true;
    window.addEventListener('scroll', this._scrollHandler, true);
    setTimeout(() => {
      (this.elRef.nativeElement.querySelector('.ss-search-input') as HTMLInputElement | null)?.focus();
    }, 50);
  }

  close(): void {
    this.isOpen = false;
    this._query = '';
    window.removeEventListener('scroll', this._scrollHandler, true);
  }

  select(opt: string): void {
    this._value = opt;
    this.valueChange.emit(opt);
    this.close();
  }

  clear(e: MouseEvent): void {
    e.stopPropagation();
    this._value = '';
    this.valueChange.emit('');
    if (this.isOpen) this.close();
  }

  clearSearch(e: MouseEvent): void {
    e.stopPropagation();
    this.query = '';
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    if (this.isOpen && !this.elRef.nativeElement.contains(e.target as Node)) {
      this.close();
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('scroll', this._scrollHandler, true);
  }
}
