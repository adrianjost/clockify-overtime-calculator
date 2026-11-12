// Applies a forced light or dark theme before the page is drawn, so it doesn't flash.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
