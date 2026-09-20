export type TaskTab = "outputs" | "discovery" | "scans";

/** Switch visibility only: live list nodes and dialog form state stay intact. */
export function mountRecordTabs<T extends string>(root: HTMLElement, prefix: string, values: readonly T[], storageKey: string) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>(`[data-${prefix}-tab]`)];
  const panels = [...root.querySelectorAll<HTMLElement>(`[data-${prefix}-panel]`)];
  // Dialogs can be opened from another panel (e.g. a discovery review from outputs).
  // They must not inherit display:none from the tab that originally contained them.
  panels.forEach(panel => panel.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => root.append(dialog)));
  let current: T = values[0]!;
  function select(value: T, reveal = false): void {
    current = value;
    tabs.forEach(tab => {
      const selected = tab.getAttribute(`data-${prefix}-tab`) === value;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.getAttribute(`data-${prefix}-panel`) !== value; });
    sessionStorage.setItem(storageKey, value);
    if (reveal) panels.find(panel => panel.getAttribute(`data-${prefix}-panel`) === value)?.scrollIntoView({ block: "start", behavior: "auto" });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.getAttribute(`data-${prefix}-tab`) as T, true));
    tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = tabs[next]!;
      select(target.getAttribute(`data-${prefix}-tab`) as T, true);
      target.focus();
    });
  });
  const saved = sessionStorage.getItem(storageKey);
  select(values.find(value => value === saved) ?? values[0]!);
  return { select, get current() { return current; } };
}

export function mountTaskTabs(root: HTMLElement) {
  return mountRecordTabs<TaskTab>(root, "task", ["outputs", "discovery", "scans"], "assets-admin-task-tab");
}
