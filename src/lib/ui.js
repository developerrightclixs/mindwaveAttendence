'use strict';
/**
 * View helpers: inline SVG icons and initial-avatars.
 *
 * These live in a module rather than an EJS partial because `include`
 * compiles a partial in its own scope - anything it declares is invisible to
 * the template that included it. Exposing them through res.locals makes them
 * available everywhere, partials included.
 *
 * Icons are inline SVG on purpose: no icon font and no CDN, because this runs
 * on an office LAN box with no guaranteed internet.
 */

const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  users: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.5"/><path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4"/><path d="M15.5 4.2a3.5 3.5 0 0 1 0 6.6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 9.5v4M12 16.8v.2"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.1 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M3 5h18M6.5 12h11M10 19h4"/>',
  chevronL: '<path d="m14.5 5-7 7 7 7"/>',
  chevronR: '<path d="m9.5 5 7 7-7 7"/>',
  chevronD: '<path d="m6 9.5 6 6 6-6"/>',
  upDown: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  logout: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 20h16"/>',
  check: '<path d="m4 12.5 5 5 11-11"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.1 7.9 7.5 9 4.4-1.1 7.5-4.5 7.5-9V6L12 3Z"/>',
  upload: '<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M4 20h16"/>',
  note: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  // Half-filled circle: the conventional mark for "follow the system".
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 7.5 3 3"/>',
};

/** Inline SVG for `name`, sized `size` px. Unknown names render nothing. */
function icon(name, size) {
  const d = ICON_PATHS[name];
  if (!d) return '';
  const s = size || 17;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" `
    + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
    + `stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

// Picked to stay legible with white text on top.
const AVATAR_COLOURS = [
  '#c2333b', '#0b7f5e', '#2457c5', '#b06a06', '#6d41c7',
  '#07697f', '#b32068', '#4f7c12', '#c04a0c', '#3e39bd',
];

/** Same person, same colour, every time. */
function avatarColour(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

// "Sabih Ul Ebad" should read SE, not SU - the same particle rule the employee
// importer uses when generating codes.
const PARTICLES = new Set(['ul', 'ur', 'us', 'ud', 'al', 'el', 'bin', 'ibn', 'bint', 'van', 'von', 'de', 'da', 'di', 'le', 'la']);

function initials(name) {
  const words = String(name || '').trim().split(/\s+/)
    .filter((w) => w && !PARTICLES.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  return words.map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '')
    .toUpperCase().slice(0, 2) || '?';
}

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Initial-avatar span. `seed` keeps the colour stable across name edits. */
function avatar(name, seed, cls) {
  return `<span class="avatar ${cls || ''}" style="background:${avatarColour(seed || name)}" `
    + `title="${escapeHtml(name)}">${escapeHtml(initials(name))}</span>`;
}

module.exports = { icon, avatar, initials, avatarColour, ICON_PATHS };
