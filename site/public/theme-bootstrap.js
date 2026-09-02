(() => {
  try {
    const saved = localStorage.getItem("asa-theme");
    const system = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = saved === "light" || saved === "dark" ? saved : system;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
