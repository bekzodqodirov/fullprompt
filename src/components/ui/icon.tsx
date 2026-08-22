/**
 * The icon set.
 *
 * Hand-drawn 24×24 stroke paths rather than an icon package: the whole set
 * below is smaller than the dependency would be, it ships no runtime, and
 * every glyph renders identically on the Chinese Android phones where an
 * emoji font is a lottery — 🧰 and 🚛 are what the app used before, and they
 * came out as different shapes, different weights and sometimes as a box.
 *
 * One visual rule: 1.75 stroke, round caps, currentColor. Nothing filled, so
 * icons sit next to text without shouting.
 */

export type IconName =
  | 'home'
  | 'inbox'
  | 'box'
  | 'boxes'
  | 'crate'
  | 'truck'
  | 'scan'
  | 'handshake'
  | 'clipboard'
  | 'map'
  | 'search'
  | 'chart'
  | 'report'
  | 'wallet'
  | 'briefcase'
  | 'users'
  | 'user'
  | 'phone'
  | 'target'
  | 'sleep'
  | 'settings'
  | 'plus'
  | 'check'
  | 'x'
  | 'alert'
  | 'clock'
  | 'calendar'
  | 'download'
  | 'chevronLeft'
  | 'chevronRight'
  | 'logout'
  | 'globe'
  | 'menu'
  | 'shield'
  | 'exchange'
  | 'maximize'
  | 'chat'
  | 'doc'
  | 'sparkle';

const PATHS: Record<IconName, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5M9.5 20v-6h5v6" />,
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M4.5 13 6 5h12l1.5 8V19H4.5z" />
    </>
  ),
  box: (
    <>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </>
  ),
  boxes: (
    <>
      <path d="M3 8.5 8 6l5 2.5v5L8 16l-5-2.5z" />
      <path d="M11 15.5 16 13l5 2.5v5L16 23l-5-2.5z" />
      <path d="M11 3.5 16 1l5 2.5v5L16 11l-5-2.5z" />
    </>
  ),
  crate: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M3.5 10h17M3.5 14h17M9 5.5v13M15 5.5v13" />
    </>
  ),
  truck: (
    <>
      <path d="M3 6.5h10v9H3zM13 9.5h4l3 3v3h-7z" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M4 12h16" />
    </>
  ),
  handshake: (
    <>
      <path d="m8 12 2.5-2.5a2 2 0 0 1 2.8 0L16 12" />
      <path d="m3 10 4-4 3 1M21 10l-4-4-3 1" />
      <path d="m8.5 13.5 2 2M11 12l2.5 2.5M13.5 10.5 16 13" />
    </>
  ),
  clipboard: (
    <>
      <path d="M9 4.5h6v2H9z" />
      <path d="M9 5.5H6.5v14h11v-14H15" />
      <path d="M9 11h6M9 15h4" />
    </>
  ),
  map: (
    <>
      <path d="m3 6.5 6-2 6 2 6-2v13l-6 2-6-2-6 2z" />
      <path d="M9 4.5v13M15 6.5v13" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  chart: <path d="M4 20V4M4 20h16M8 17v-5M12.5 17V8M17 17v-7" />,
  report: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M9 12h6M9 16h4" />
    </>
  ),
  wallet: (
    <>
      <path d="M3.5 7.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-14z" />
      <path d="M3.5 7.5v9M16 13h1.5" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="11" rx="2" />
      <path d="M9 7.5v-2h6v2M3.5 12h17" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 6.5a3 3 0 0 1 0 5.5M17 14.5c2 .7 3.5 2.4 3.5 4.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </>
  ),
  phone: (
    <path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5z" />
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  // A speech bubble with a tail, for the client conversations screen.
  chat: <path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-4.4A7.5 7.5 0 0 1 12.5 5 7.5 7.5 0 0 1 20 12.5z" />,
  sleep: <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  // Fullscreen: four corners pulling outwards.
  maximize: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
  alert: (
    <>
      <path d="M12 4.5 21 19H3z" />
      <path d="M12 10v4M12 16.5v.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </>
  ),
  download: <path d="M12 4v11m0 0 4-4m-4 4-4-4M4.5 19h15" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  logout: <path d="M15 8V5.5h-10v13h10V16M10 12h10m0 0-3-3m3 3-3 3" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a13 13 0 0 1 0 16A13 13 0 0 1 12 4z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  shield: <path d="M12 3.5 5 6.2v5.4c0 4 2.8 7.5 7 9 4.2-1.5 7-5 7-9V6.2l-7-2.7z" />,
  exchange: <path d="M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3" />,
  doc: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.8 9 19.5 11 13.8 13 12 18.5 10.2 13 4.5 11 10.2 9z" />
      <path d="M18.5 16.5v4M16.5 18.5h4" />
    </>
  ),
};

export function Icon({
  name,
  className = 'h-5 w-5',
  strokeWidth = 1.75,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
