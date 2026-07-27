import Script from 'next/script';
import './cabinet.css';

/**
 * The client's Mini App shell — no staff chrome, no login.
 *
 * A sibling route group so the app's own header, sidebar and tab bar cannot
 * reach it: this is the only screen in the system a CUSTOMER sees, and it must
 * look like part of Telegram rather than like an employee's tool.
 *
 * The Telegram script has to come from telegram.org — it is what supplies
 * `initData`, the theme, and the viewport. `beforeInteractive` so the page
 * never renders a frame before it knows whether it is inside Telegram at all.
 */
export default function CabinetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      <div className="cabinet">{children}</div>
    </>
  );
}
