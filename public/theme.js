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

  /* Mobile navigation drawer.

     Open state lives in one class on the header, so the CSS decides whether a
     drawer exists at all - above the breakpoint the rules never match and this
     code is inert even if the class is somehow set. */
  function initNav() {
    var bar = document.getElementById('topbar');
    var btn = document.getElementById('nav-toggle');
    var backdrop = document.getElementById('nav-backdrop');
    if (!bar || !btn) return;

    function set(open) {
      bar.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // The page behind the drawer must not scroll under the thumb.
      document.body.style.overflow = open ? 'hidden' : '';
    }

    btn.addEventListener('click', function () {
      set(!bar.classList.contains('nav-open'));
    });
    if (backdrop) backdrop.addEventListener('click', function () { set(false); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && bar.classList.contains('nav-open')) {
        set(false);
        btn.focus();
      }
    });

    // Rotating a phone can cross the breakpoint, which hides the drawer by
    // CSS alone - without this the body would stay locked at desktop width.
    window.addEventListener('resize', function () {
      if (bar.classList.contains('nav-open') && getComputedStyle(btn).display === 'none') set(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); initNav(); });
  } else {
    init();
    initNav();
  }
}());
