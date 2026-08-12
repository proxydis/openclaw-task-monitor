import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenClaw Monitor',
  description: 'Supervision temps réel des agents, sous-agents et tâches OpenClaw',
};

export const viewport: Viewport = {
  themeColor: '#0a0d13',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
