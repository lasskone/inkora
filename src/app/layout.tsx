import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Inkora",
  description: "E-Commerce Opportunity Intelligence",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <SiteNav />
        <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-12">
          {children}
        </main>
        <footer className="border-t border-border bg-surface">
          <div className="w-full max-w-5xl mx-auto px-6 py-6 text-sm text-muted">
            Inkora — E-Commerce Opportunity Intelligence
          </div>
        </footer>
      </body>
    </html>
  );
}
