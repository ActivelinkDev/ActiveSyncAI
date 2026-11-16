import {
  Component, Input, Output, EventEmitter,
  ElementRef, HostListener, OnDestroy, inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-tag-multi-select',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
  templateUrl: './tag-multi-select.component.html',
  styleUrls: ['./tag-multi-select.component.scss']
})
export class TagMultiSelectComponent implements OnDestroy {
  private elRef = inject(ElementRef);

  private _options: string[] = [];
  private _value: string[] = [];
  private _query = '';

  @Input() set options(v: string[]) { this._options = v ?? []; this._rebuild(); }
  get options(): string[] { return this._options; }

  @Input() set value(v: string[]) { this._value = v ?? []; this._rebuild(); }
  get value(): string[] { return this._value; }

  @Input() placeholder = 'Adicionar…';
  @Output() valueChange = new EventEmitter<string[]>();
  @Output() tryAddItem  = new EventEmitter<string>();

  get query(): string { return this._query; }
  set query(v: string) { this._query = v; this._rebuild(); }

  isOpen = false;
  panelTop = 0;
  panelLeft = 0;
  panelWidth = 0;

  // Precomputed — never computed inside template bindings
  filteredOptions: string[] = [];

  private static _norm(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private _rebuild(): void {
    const q = TagMultiSelectComponent._norm(this._query.trim());
    const selected = new Set(this._value);
    this.filteredOptions = this._options.filter(o =>
      !selected.has(o) && (!q || TagMultiSelectComponent._norm(o).includes(q))
    );
  }

  private _scrollHandler = (e: Event) => {
    if (this.elRef.nativeElement.contains(e.target as Node)) return;
    this.close();
  };

  open(fieldEl: HTMLElement): void {
    const r = fieldEl.getBoundingClientRect();
    this.panelTop   = r.bottom + 2;
    this.panelLeft  = r.left;
    this.panelWidth = Math.max(r.width, 220);
    this._query = '';
    this._rebuild();
    this.isOpen = true;
    window.addEventListener('scroll', this._scrollHandler, true);
    setTimeout(() => {
      (this.elRef.nativeElement.querySelector('.tms-input') as HTMLInputElement | null)?.focus();
    }, 50);
  }

  close(): void {
    this.isOpen = false;
    this._query = '';
    window.removeEventListener('scroll', this._scrollHandler, true);
  }

  toggle(fieldEl: HTMLElement): void {
    this.isOpen ? this.close() : this.open(fieldEl);
  }

  add(opt: string, e: MouseEvent): void {
    e.stopPropagation();
    const next = [...this._value, opt];
    this._value = next;
    this._rebuild();
    this.valueChange.emit(next);
    setTimeout(() => {
      (this.elRef.nativeElement.querySelector('.tms-input') as HTMLInputElement | null)?.focus();
    });
  }

  remove(tag: string, e: MouseEvent): void {
    e.stopPropagation();
    const next = this._value.filter(v => v !== tag);
    this._value = next;
    this._rebuild();
    this.valueChange.emit(next);
  }

  onEnter(e: Event): void {
    e.preventDefault();
    const q = this._query.trim();
    if (!q) return;
    if (this.filteredOptions.length > 0) {
      // Exact match — add it
      const exact = this.filteredOptions.find(o => TagMultiSelectComponent._norm(o) === TagMultiSelectComponent._norm(q));
      if (exact) { this.add(exact, new MouseEvent('click')); return; }
      this.add(this.filteredOptions[0], new MouseEvent('click'));
      return;
    }
    // Query text not in available options — ask parent to handle (may be a duplicate)
    this.tryAddItem.emit(q);
  }

  addExternal(item: string): void {
    if (this._value.includes(item)) return;
    const next = [...this._value, item];
    this._value = next;
    this._rebuild();
    this.valueChange.emit(next);
  }

  clearAll(e: MouseEvent): void {
    e.stopPropagation();
    this._value = [];
    this._rebuild();
    this.valueChange.emit([]);
    if (this.isOpen) this.close();
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
