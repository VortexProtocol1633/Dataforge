/**
 * App-wide themes — light/dark plus full colour palettes (“Cyberpunk Neon”,
 * “Deep Space Cobalt”, “Volcanic Basalt & Amber”, …). The chosen theme id is
 * stored as `df_theme` in localStorage and applied to <html data-theme=…>;
 * each id maps to a full CSS variable block in css/main.css.
 */
import { icon } from './icons.js';

export const THEMES = [
  {
    id: 'light', name: 'Glass Daylight', dark: false, bg: '#eef1ff',
    colors: ['#6366f1', '#8b5cf6', '#2dd4bf'],
    desc: 'Airy glassmorphism on a soft, bright canvas.',
  },
  {
    id: 'dark', name: 'Midnight Indigo', dark: true, bg: '#0b1026',
    colors: ['#6366f1', '#8b5cf6', '#2dd4bf'],
    desc: 'The classic deep-space dark theme.',
  },
  {
    id: 'cyberpunk', name: 'Cyberpunk Neon', dark: true, bg: '#09090e',
    colors: ['#3b82f6', '#a855f7', '#ec4899'],
    desc: 'Pure black with neon purple, high-octane pink & electric blue.',
  },
  {
    id: 'cobalt', name: 'Deep Space Cobalt', dark: true, bg: '#030712',
    colors: ['#2563eb', '#7c3aed', '#38bdf8'],
    desc: 'Void black, cobalt blue and a violet accent.',
  },
  {
    id: 'volcanic', name: 'Volcanic Basalt & Amber', dark: true, bg: '#121212',
    colors: ['#f59e0b', '#b45309', '#fbbf24'],
    desc: 'Basalt black with glowing amber and burnt rust.',
  },
  {
    id: 'emerald', name: 'Emerald Terminal', dark: true, bg: '#04140c',
    colors: ['#10b981', '#34d399', '#6ee7b7'],
    desc: 'Deep forest black-green with neon emerald glows.',
  },
  {
    id: 'stealth', name: 'Stealth Matte Charcoal', dark: true, bg: '#0d0d0d',
    colors: ['#4A5568', '#64748B', '#94A3B8'],
    desc: 'Pitch-black matte with gunmetal surfaces and crisp silver accents.',
  },
  {
    id: 'prism', name: 'Prism Pastel', dark: false, bg: '#ffffff',
    colors: ['#FDA4AF', '#FDE68A', '#A7F3D0'],
    desc: 'Pure-canvas light mode tinted with coral, butter, mint and sky pastels.',
  },
  {
    id: 'arcade', name: 'Arcade Odyssey', dark: true, bg: '#120824',
    colors: ['#00F5D4', '#9D4EDD', '#FF007F'],
    desc: '80s neon retro — nightclub black with cyan, electric violet and hotline pink.',
  },
];

const IDS = new Set(THEMES.map((t) => t.id));

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || null;
}

/** Current theme id (always one of THEMES; falls back to 'light'). */
export function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme') || '';
  return IDS.has(attr) ? attr : 'light';
}

/** Whether a theme id renders dark surfaces (used by canvas exports etc.). */
export function isDarkTheme(id = currentTheme()) {
  const t = themeById(id);
  return !t || t.dark;
}

/** Apply + persist a theme. Unknown ids are ignored. */
export function setTheme(id) {
  if (!IDS.has(id)) return;
  document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('df_theme', id); } catch { /* ignore */ }
}

/** Inline SVG for the current theme (sun for light, moon for dark, palette for custom palettes). */
export function themeIcon() {
  const id = currentTheme();
  if (id === 'light') return icon('sun', 17);
  if (id === 'dark') return icon('moon', 17);
  return icon('palette', 17);
}
