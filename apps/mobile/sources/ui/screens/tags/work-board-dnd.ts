import type { WorkItemView } from '@beeline/api-contract/phone';

export type DropSectionKey = 'progress' | 'backlog' | 'done';
export type DropWorkState = 'in-progress' | 'backlog' | 'done';

export type SectionBounds = { readonly y: number; readonly height: number };

const SECTION_STATE: Record<DropSectionKey, DropWorkState> = {
  progress: 'in-progress',
  backlog: 'backlog',
  done: 'done',
};

export function sectionTargetState(section: DropSectionKey): DropWorkState {
  return SECTION_STATE[section];
}

export function itemColumnKey(item: Pick<WorkItemView, 'state'>): DropSectionKey {
  if (item.state === 'backlog') return 'backlog';
  if (item.state === 'done') return 'done';
  return 'progress';
}

export function canDragWorkItem(
  item: Pick<WorkItemView, 'roomArchived'>,
  hasMove: boolean,
): boolean {
  return hasMove && item.roomArchived !== true;
}

export function shouldMoveWorkItem(
  item: Pick<WorkItemView, 'state' | 'roomArchived'>,
  target: DropSectionKey,
): boolean {
  if (item.roomArchived === true) return false;
  return itemColumnKey(item) !== target;
}

export function resolveDropSectionAtY(
  layouts: Partial<Record<DropSectionKey, SectionBounds>>,
  y: number,
): DropSectionKey | null {
  for (const key of ['progress', 'backlog', 'done'] as const) {
    const box = layouts[key];
    if (box && y >= box.y && y <= box.y + box.height) return key;
  }
  return null;
}

type WebDragEvent = {
  preventDefault?: () => void;
  stopPropagation?: () => void;
  dataTransfer?: {
    effectAllowed?: string;
    dropEffect?: string;
    setData?: (format: string, data: string) => void;
    getData?: (format: string) => string;
  };
};

export function webDragSourceProps(
  enabled: boolean,
  itemId: string,
  onStart: () => void,
  onEnd: () => void,
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (event?: WebDragEvent) => {
      if (event?.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData?.('text/plain', itemId);
      }
      onStart();
    },
    onDragEnd: () => {
      onEnd();
    },
  };
}

export function webDropTargetProps(
  enabled: boolean,
  onOver: () => void,
  onLeave: () => void,
  onDrop: (transferredId?: string) => void,
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    onDragOver: (event?: WebDragEvent) => {
      event?.preventDefault?.();
      if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      onOver();
    },
    onDragLeave: () => {
      onLeave();
    },
    onDrop: (event?: WebDragEvent) => {
      event?.preventDefault?.();
      const transferred = event?.dataTransfer?.getData?.('text/plain')?.trim() || undefined;
      onDrop(transferred);
    },
  };
}
