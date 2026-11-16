// apps/frontend/src/app/pages/tags/pill-selector/pill-selector.ts
import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { TagGroup } from '../../../services/tags.service';

@Component({
  selector: 'app-pill-selector',
  standalone: true,
  imports: [],
  templateUrl: './pill-selector.html',
  styleUrls: ['./pill-selector.scss']
})
export class PillSelectorComponent implements OnChanges {
  /** All available tag groups */
  @Input() groups: TagGroup[] = [];
  /** IDs of currently active groups */
  @Input() selected: number[] = [];
  /** Emits the updated selected IDs after each toggle */
  @Output() selectionChange = new EventEmitter<number[]>();

  activeIds = new Set<number>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selected']) {
      this.activeIds = new Set(this.selected ?? []);
    }
  }

  toggle(groupId: number): void {
    if (this.activeIds.has(groupId)) {
      this.activeIds.delete(groupId);
    } else {
      this.activeIds.add(groupId);
    }
    this.selectionChange.emit(Array.from(this.activeIds));
  }

  isActive(groupId: number): boolean {
    return this.activeIds.has(groupId);
  }
}
