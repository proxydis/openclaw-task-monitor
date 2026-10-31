import type { Metadata, Viewport } from 'next';
import './globals.css';
import PwaRegister from '@/components/PwaRegister';

export const metadata: Metadata = {
  title: 'OpenClaw Monitor',
  description: 'Real-time dashboard for OpenClaw agents, subagents and tasks',
  appleWebApp: { capable: true, title: 'Monitor' },
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
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
