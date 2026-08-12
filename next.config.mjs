import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Ancre le bundle standalone sur le dépôt : sans ça, Next remonte à la racine des
  // lockfiles trouvés et recrée toute l'arborescence absolue dans .next/standalone.
  outputFileTracingRoot: here,
  reactStrictMode: false,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
};

export default nextConfig;
