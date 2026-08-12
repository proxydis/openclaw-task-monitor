import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenClaw Monitor',
  description: 'Real-time dashboard for OpenClaw agents, subagents and tasks',
};

export const viewport: Viewport = {
  themeColor: '#0a0d13',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // langue par défaut ; <LangProvider> l'ajuste selon la préférence enregistrée
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
