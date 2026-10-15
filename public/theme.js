/* Theme switcher: Auto -> Light -> Dark -> Auto.
   "Auto" means no attribute, so the CSS media query follows the OS. */
(function () {
  var KEY = 'mw-theme';
  var ORDER = ['auto', 'light', 'dark'];
  var LABEL = { auto: 'Theme: follows your system', light: 'Theme: light', dark: 'Theme: dark' };

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return ORDER.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) {
      return 'auto';                       // private window, blocked storage
    }
  }

  function apply(mode) {
    var el = document.documentElement;
    if (mode === 'auto') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', mode);

    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.title = LABEL[mode] + ' (click to change)';
    btn.setAttribute('aria-label', LABEL[mode]);
    var icons = btn.querySelectorAll('[data-mode]');
    for (var i = 0; i < icons.length; i++) {
      icons[i].hidden = icons[i].getAttribute('data-mode') !== mode;
    }
  }

  function init() {
    apply(read());
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, next); } catch (e) { /* not fatal */ }
      apply(next);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
