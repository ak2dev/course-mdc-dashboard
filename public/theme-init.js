// Runs before first paint so the saved theme never flashes. Light is the default.
(function () {
  var theme;
  try { theme = localStorage.getItem('mdc-theme'); } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
})();
