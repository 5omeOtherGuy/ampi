import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const ABOVE_EDITOR_DASHBOARD_WIDGET_ID = "pi-mmr-above-editor-dashboard";

export type AboveEditorDashboardSlot = "left" | "right";

export interface AboveEditorDashboardTheme {
  fg(name: string, value: string): string;
  bold(value: string): string;
}

export interface AboveEditorDashboardTui {
  requestRender?(force?: boolean): void;
}

export type AboveEditorDashboardComponent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

export type AboveEditorDashboardFactory = (
  tui: AboveEditorDashboardTui,
  theme: AboveEditorDashboardTheme,
) => AboveEditorDashboardComponent;

export type AboveEditorDashboardValue = readonly string[] | AboveEditorDashboardFactory;

interface WidgetUILike {
  setWidget(
    id: string,
    value: AboveEditorDashboardValue | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

interface WidgetCtxLike {
  ui?: WidgetUILike;
}

interface SlotState {
  id: string;
  value: AboveEditorDashboardValue;
}

const slots: Partial<Record<AboveEditorDashboardSlot, SlotState>> = {};
let showingCombined = false;

function instantiate(
  value: AboveEditorDashboardValue,
  tui: AboveEditorDashboardTui,
  theme: AboveEditorDashboardTheme,
): AboveEditorDashboardComponent {
  if (typeof value === "function") return value(tui, theme);
  return {
    render: () => [...value],
    invalidate: () => {},
  };
}

function padVisibleEnd(value: string, width: number): string {
  const current = visibleWidth(value);
  if (current >= width) return value;
  return `${value}${" ".repeat(width - current)}`;
}

function combineLines(left: readonly string[], right: readonly string[], width: number): string[] {
  if (!Number.isFinite(width)) return [...left, ...right];
  if (width <= 0) return [];

  const separator = " │ ";
  const separatorWidth = visibleWidth(separator);
  if (width < 80) {
    return [...left, ...right].map((line) => truncateToWidth(line, width));
  }

  const leftWidth = Math.min(48, Math.max(28, Math.floor(width * 0.42)));
  const rightWidth = Math.max(0, width - leftWidth - separatorWidth);
  const rowCount = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const leftCell = padVisibleEnd(truncateToWidth(left[i] ?? "", leftWidth), leftWidth);
    const rightCell = truncateToWidth(right[i] ?? "", rightWidth);
    rows.push(`${leftCell}${separator}${rightCell}`);
  }
  return rows;
}

function columnWidths(width: number): { left: number; right: number } {
  if (!Number.isFinite(width)) return { left: Number.POSITIVE_INFINITY, right: Number.POSITIVE_INFINITY };
  const left = Math.min(48, Math.max(28, Math.floor(width * 0.42)));
  return { left, right: Math.max(0, width - left - 3) };
}

function makeCombinedWidget(left: SlotState, right: SlotState): AboveEditorDashboardFactory {
  return (tui, theme) => {
    const leftComponent = instantiate(left.value, tui, theme);
    const rightComponent = instantiate(right.value, tui, theme);
    return {
      render: (width) => {
        const columns = columnWidths(width);
        return combineLines(
          leftComponent.render(columns.left),
          rightComponent.render(columns.right),
          width,
        );
      },
      invalidate: () => {
        leftComponent.invalidate();
        rightComponent.invalidate();
      },
      dispose: () => {
        leftComponent.dispose?.();
        rightComponent.dispose?.();
      },
    };
  };
}

export function updateAboveEditorDashboardSlot(
  ctx: WidgetCtxLike | undefined,
  slot: AboveEditorDashboardSlot,
  id: string,
  value: AboveEditorDashboardValue | undefined,
): void {
  const ui = ctx?.ui;
  if (!ui) return;

  if (value === undefined) delete slots[slot];
  else slots[slot] = { id, value };

  const left = slots.left;
  const right = slots.right;
  if (left && right) {
    if (!showingCombined) {
      ui.setWidget(left.id, undefined, { placement: "aboveEditor" });
      ui.setWidget(right.id, undefined, { placement: "aboveEditor" });
    }
    showingCombined = true;
    ui.setWidget(ABOVE_EDITOR_DASHBOARD_WIDGET_ID, makeCombinedWidget(left, right), { placement: "aboveEditor" });
    return;
  }

  const active = left ?? right;
  if (showingCombined) {
    ui.setWidget(ABOVE_EDITOR_DASHBOARD_WIDGET_ID, undefined, { placement: "aboveEditor" });
    showingCombined = false;
    if (active) {
      ui.setWidget(active.id, active.value, { placement: "aboveEditor" });
      return;
    }
  }
  ui.setWidget(id, active && active.id === id ? active.value : undefined, { placement: "aboveEditor" });
}

export function resetAboveEditorDashboardForTest(): void {
  delete slots.left;
  delete slots.right;
  showingCombined = false;
}
