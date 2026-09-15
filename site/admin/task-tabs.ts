export type TaskTab = "outputs" | "discovery" | "scans";

/** Switch visibility only: live list nodes and dialog form state stay intact. */
export function mountTaskTabs(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-task-tab]")];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-task-panel]")];
  const storageKey = "assets-admin-task-tab";
  // Dialogs can be opened from another panel (e.g. a discovery review from outputs).
  // They must not inherit display:none from the tab that originally contained them.
  panels.forEach(panel => panel.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => root.append(dialog)));
  let current: TaskTab = "outputs";
  function select(value: TaskTab, reveal = false): void {
    current = value;
    tabs.forEach(tab => {
      const selected = tab.dataset.taskTab === value;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.taskPanel !== value; });
    sessionStorage.setItem(storageKey, value);
    if (reveal) panels.find(panel => panel.dataset.taskPanel === value)?.scrollIntoView({ block: "start", behavior: "auto" });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.taskTab as TaskTab, true));
    tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = tabs[next]!;
      select(target.dataset.taskTab as TaskTab, true);
      target.focus();
    });
  });
  const saved = sessionStorage.getItem(storageKey);
  select(saved === "discovery" || saved === "scans" ? saved : "outputs");
  return { select, get current() { return current; } };
}
