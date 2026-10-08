import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "plaid-sync-ledger",
  description: "Bank transaction sync that stays correct under failure.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
