import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Search Compare",
  description: "Side-by-side comparison UI for the Search Engine for LLMs."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
