import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Identifiant de ce build, injecté à l'identique dans le bundle navigateur et dans le serveur.
 * Un onglet resté ouvert pendant un déploiement garde l'ancien bundle mais reçoit les données du
 * nouveau serveur : une clé de traduction ou un champ qu'il ne connaît pas s'affichait tel quel
 * (« graph.lane »). Le serveur renvoie cet identifiant, le client recharge la page s'il diffère.
 */
const BUILD_ID = String(Date.now());

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Ancre le bundle standalone sur le dépôt : sans ça, Next remonte à la racine des
  // lockfiles trouvés et recrée toute l'arborescence absolue dans .next/standalone.
  outputFileTracingRoot: here,
  reactStrictMode: false,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
};

export default nextConfig;
