// Inline SVG artwork for the UI (static markup, never mixed with user data).
import type { LitterKind, PowerUpKind } from '../core/types';

const line = (d: string, extra = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;

/** Monochrome line icons (currentColor). */
export const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8c.6-.4.6-1.2 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z"/></svg>',
  trophy: line('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 6h3v1.5A3.5 3.5 0 0 1 16.6 11M7 6H4v1.5A3.5 3.5 0 0 0 7.4 11"/>'),
  pencil: line('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  gear: line('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  book: line('<path d="M12 6.5C10.2 5 7.6 4.5 4 4.5v13c3.6 0 6.2.5 8 2 1.8-1.5 4.4-2 8-2v-13c-3.6 0-6.2.5-8 2zM12 6.5v13"/>'),
  heart: line('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>'),
  back: line('<path d="M15 5l-7 7 7 7"/>'),
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.4"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4"/></svg>',
  restart: line('<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4 4.5v4.2h4.2"/>'),
  home: line('<path d="M4 11l8-6.5 8 6.5M6.5 9.5V20h11V9.5"/><path d="M10 20v-5h4v5"/>'),
  clock: line('<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 2.8h5"/>'),
  bag: line('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
  bin: line('<path d="M5 7h14M9.5 7V5h5v2M6.5 7l1 13h9l1-13"/><path d="M10 11l2-1.6 2 1.6M12 9.6V16"/>'),
  // fennec head silhouette (ear radar)
  ears: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3.2 1.8c3.1 1.2 5.8 3.8 7.2 7-2.4.3-4.3 1.6-5.4 3.4C3.1 9 2.6 5.3 3.2 1.8zM20.8 1.8c-3.1 1.2-5.8 3.8-7.2 7 2.4.3 4.3 1.6 5.4 3.4 1.9-3.2 2.4-6.9 1.8-10.4z"/><path d="M12 9.6c3.9 0 6.6 2.7 6.6 5.9 0 3.3-3.1 6.2-6.6 7-3.5-.8-6.6-3.7-6.6-7 0-3.2 2.7-5.9 6.6-5.9z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2.8l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.8l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3 8.5l4.6 3.7L12 5l4.4 7.2L21 8.5 19.4 18H4.6z"/><rect x="4.6" y="19" width="14.8" height="2.2" rx="1"/></svg>',
  mouse: line('<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 7v3"/>'),
  swipe: line('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11l3.3.6a2 2 0 0 1 1.6 2.3L16 19H9.5L6 14.5a1.6 1.6 0 0 1 2.4-2.1L9 13"/><path d="M4 4h3M17 4h3M18.5 2.5 20 4l-1.5 1.5M5.5 2.5 4 4l1.5 1.5"/>'),
  joystick: line('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  phone: line('<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>'),
  warn: line('<path d="M12 4 2.8 20h18.4L12 4z"/><path d="M12 10v4.5M12 17.4v.1"/>'),
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2 21 20.5 12 16 3 20.5z"/></svg>',
  // game-over stat tiles
  flame: line('<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.4 2.6-5 3.4-8.4 2 1.2 3 3 3.2 4.6 1-1 1.6-2.3 1.6-3.8 2.3 1.8 3.8 4.4 3.8 7.4 0 3.4-2.4 5.8-6 5.8z"/>'),
  link: line('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  ball: line('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.2l3 2.2-1.1 3.5h-3.8L9 10.4z"/><path d="M12 3.5v4.7M15 10.4l4.2-1.5M13.9 13.9l2.6 3.7M10.1 13.9l-2.6 3.7M9 10.4 4.8 8.9"/>'),
  car: line('<path d="M5 17H3.5v-4.5L6 7h12l2.5 5.5V17H19M9 17h6M3.5 12.5h17"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>'),
} as const;

const JASMINE = [[24, 8], [16, 12], [32, 12], [12, 20], [36, 20], [19, 19], [29, 19], [24, 14], [17, 26], [31, 26], [24, 23]];

/** Colour illustrations for the four power-ups (48×48). */
export const POWERUP_ICON: Record<PowerUpKind, string> = {
  // Tunisian tea glass with mint sprig and steam
  tea: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <path d="M19 9c-2 2.5 2 4 0 6.5M25 7c-2 2.5 2 4 0 6.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 17h22l-3 23.5a3 3 0 0 1-3 2.5H19a3 3 0 0 1-3-2.5z" fill="#fff" fill-opacity=".28" stroke="#fff" stroke-width="1.6"/>
    <path d="M14.6 23h18.8l-2.2 17.2a2 2 0 0 1-2 1.8H18.8a2 2 0 0 1-2-1.8z" fill="#C9791C"/>
    <path d="M14.6 23h18.8l-.5 3.6H15.1z" fill="#F0B24A"/>
    <path d="M28 21c1-5 6-8 10-7-1 4.5-5 7.5-10 7z" fill="#39B35A"/><path d="M28 21c3-2 6-4 9.5-6.6" stroke="#1E7A38" stroke-width="1.2" fill="none"/>
    <path d="M27 20c-3.5-2.5-4-7-2-10 3.5 2 4.8 6 2 10z" fill="#4CC96D"/>
  </svg>`,
  // Bambalouni: sugared ring doughnut
  bambalouni: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <ellipse cx="24" cy="26" rx="18" ry="15" fill="#B86A26"/>
    <ellipse cx="24" cy="24" rx="18" ry="15" fill="#E7A24F"/>
    <ellipse cx="24" cy="23" rx="15" ry="12" fill="#F4C27A"/>
    <ellipse cx="24" cy="24" rx="6" ry="4.6" fill="#7A3E12"/>
    <ellipse cx="24" cy="23" rx="6" ry="4.4" fill="#2B1608" fill-opacity=".55"/>
    <g fill="#fff"><circle cx="14" cy="18" r="1.2"/><circle cx="19" cy="14" r="1"/><circle cx="29" cy="14.5" r="1.2"/><circle cx="34" cy="19" r="1"/><circle cx="35" cy="27" r="1.2"/><circle cx="13" cy="27" r="1"/><circle cx="18" cy="32" r="1.2"/><circle cx="29" cy="32.5" r="1"/><circle cx="24" cy="12.5" r=".9"/></g>
  </svg>`,
  // Mashmoum: jasmine bouquet on a bound stem cone
  mashmoum: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <path d="M17 24l7 20 7-20z" fill="#3E8E3A"/><path d="M20 28h8M21.5 32.5h5M22.8 37h2.4" stroke="#E70013" stroke-width="1.6"/>
    <circle cx="24" cy="18" r="13" fill="#2F6E2C"/>
    <g fill="#fff" stroke="#E9E2D0" stroke-width=".6">
      ${JASMINE.map(([x, y]) => `<g transform="translate(${x} ${y})"><circle r="2.6" cx="0" cy="-2.6"/><circle r="2.6" cx="2.5" cy="-.8"/><circle r="2.6" cx="1.5" cy="2.1"/><circle r="2.6" cx="-1.5" cy="2.1"/><circle r="2.6" cx="-2.5" cy="-.8"/></g>`).join('')}
    </g>
    <g fill="#F6D36B">${JASMINE.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1"/>`).join('')}</g>
  </svg>`,
  // Chéchia: red felt cap with black tassel
  chechia: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <path d="M10 36c0-12 3-24 14-24s14 12 14 24c-4 3-9 4-14 4s-10-1-14-4z" fill="#C4101E"/>
    <path d="M10 36c4 3 9 4 14 4s10-1 14-4l.4 3.5c-4.3 3-9.4 4.5-14.4 4.5S13.9 42.5 9.6 39.5z" fill="#8C0A14"/>
    <path d="M14 30c1-9 4-15 10-15" stroke="#fff" stroke-opacity=".3" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M24 12c3 0 5 1.5 5.5 4.5l1.8 9.5" stroke="#1A1A1A" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M29.6 24l-1 8.5h5.6L32.9 24z" fill="#1A1A1A"/>
    <circle cx="24" cy="12" r="2.2" fill="#1A1A1A"/>
  </svg>`,
};

/** Small colour icons for litter kinds (how-to-play). */
export const LITTER_ICON: Record<LitterKind, string> = {
  can: `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="5" width="14" height="23" rx="2.5" fill="#D9202E"/><rect x="9" y="5" width="14" height="3" rx="1.5" fill="#C9CED6"/><rect x="9" y="25" width="14" height="3" rx="1.5" fill="#AEB4BD"/><rect x="11.5" y="11" width="3" height="11" rx="1.5" fill="#fff" fill-opacity=".45"/></svg>`,
  bottle: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 3h6v4l3 4v16a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V11l3-4z" fill="#8FD3F4" fill-opacity=".9"/><rect x="13" y="2" width="6" height="3" rx="1" fill="#1D7FC4"/><rect x="10" y="15" width="12" height="6" fill="#1D7FC4"/><rect x="12" y="11" width="2" height="15" rx="1" fill="#fff" fill-opacity=".6"/></svg>`,
  chips: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 5h18l-1.5 3 1.5 3v12l-1.5 3 1.5 3H7l1.5-3L7 23V11l1.5-3z" fill="#F2B321"/><circle cx="16" cy="17" r="5" fill="#E70013"/><path d="M13.5 17.5l2 1.5 3-4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
  bag: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 10c0-3 1.5-5 3-5v3h10V5c1.5 0 3 2 3 5l1 16c0 1.5-1 3-3 3H10c-2 0-3-1.5-3-3z" fill="#EEF2F6" stroke="#9AA5B1" stroke-width="1"/><path d="M11 5c0 3 1 4 5 4s5-1 5-4" stroke="#9AA5B1" fill="none"/><path d="M4 14c2-1 3 1 5 0M23 20c2-1 3 1 5 0" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
  golden: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 3h6v4l3 4v16a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V11l3-4z" fill="#F7C531"/><rect x="13" y="2" width="6" height="3" rx="1" fill="#B8860B"/><rect x="12" y="11" width="2" height="15" rx="1" fill="#fff" fill-opacity=".7"/><path d="M25 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM6 18l.8 1.6 1.6.8-1.6.8L6 22.8l-.8-1.6-1.6-.8 1.6-.8z" fill="#FFE68A"/></svg>`,
};

/** Shared <defs> for LOGO: inserted once (never display:none, or Chrome drops the references). */
export const SVG_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="uiFur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7D6A0"/><stop offset=".55" stop-color="#E7AE68"/><stop offset="1" stop-color="#CF8A45"/></linearGradient>
  <linearGradient id="uiEarIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBC9BD"/><stop offset="1" stop-color="#E8857F"/></linearGradient>
  <radialGradient id="uiEye" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#6B3F1C"/><stop offset=".6" stop-color="#2A1608"/><stop offset="1" stop-color="#140A03"/></radialGradient>
  <path id="uiEarL" d="M56 112C38 86 18 46 12 6c32 12 64 38 84 72z"/>
  <path id="uiHead" d="M100 70c26 0 44 16 48 38l16 12-18 6c-8 20-26 36-46 44-20-8-38-24-46-44l-18-6 16-12c4-22 22-38 48-38z"/>
</defs></svg>`;

/** Game logo: a stylised fennec head, all ears (sticker style with a white outline). */
export const LOGO = `<svg class="ui-logo-mark" viewBox="0 0 200 184" role="img" aria-label="Labib the fennec">
  <g fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round">
    <use href="#uiEarL"/><use href="#uiEarL" transform="translate(200 0) scale(-1 1)"/><use href="#uiHead"/>
  </g>
  <g fill="url(#uiFur)">
    <use href="#uiEarL"/><use href="#uiEarL" transform="translate(200 0) scale(-1 1)"/><use href="#uiHead"/>
  </g>
  <path d="M62 102C47 80 30 48 25 20c24 11 47 31 63 58z" fill="url(#uiEarIn)"/>
  <path d="M138 102c15-22 32-54 37-82-24 11-47 31-63 58z" fill="url(#uiEarIn)"/>
  <path d="M66 94C58 80 51 64 47 48M134 94c8-14 15-30 19-46" stroke="#fff" stroke-opacity=".75" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M100 112c18 0 32 10 38 18-8 18-24 32-38 38-14-6-30-20-38-38 6-8 20-18 38-18z" fill="#FFF6E6"/>
  <ellipse cx="77" cy="91" rx="9" ry="4.5" transform="rotate(-14 77 91)" fill="#FFF1D8" fill-opacity=".85"/>
  <ellipse cx="123" cy="91" rx="9" ry="4.5" transform="rotate(14 123 91)" fill="#FFF1D8" fill-opacity=".85"/>
  <ellipse cx="80" cy="110" rx="10" ry="12.5" fill="url(#uiEye)"/><ellipse cx="120" cy="110" rx="10" ry="12.5" fill="url(#uiEye)"/>
  <circle cx="76.5" cy="105" r="3.8" fill="#fff"/><circle cx="116.5" cy="105" r="3.8" fill="#fff"/>
  <circle cx="83" cy="115" r="1.6" fill="#fff" fill-opacity=".8"/><circle cx="123" cy="115" r="1.6" fill="#fff" fill-opacity=".8"/>
  <path d="M90 141c0-5 5-7 10-7s10 2 10 7-6 10-10 10-10-5-10-10z" fill="#1E120A"/>
  <ellipse cx="96.5" cy="138.5" rx="3.2" ry="1.7" fill="#fff" fill-opacity=".5"/>
  <path d="M100 151v5M92 158c4 3.5 12 3.5 16 0" stroke="#1E120A" stroke-width="2.6" fill="none" stroke-linecap="round"/>
</svg>`;

/** 8-point zellige star tile (khatam), used as a faint background pattern. */
export const ZELLIGE = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><g fill='none' stroke='#fff' stroke-width='1.2'>` +
  `<rect x='18' y='18' width='28' height='28'/><rect x='18' y='18' width='28' height='28' transform='rotate(45 32 32)'/>` +
  `<circle cx='32' cy='32' r='6'/><path d='M0 0l12.2 12.2M64 0 51.8 12.2M0 64l12.2-12.2M64 64 51.8 51.8M32 0v12.2M32 64V51.8M0 32h12.2M64 32H51.8'/>` +
  `</g></svg>`)}")`;
