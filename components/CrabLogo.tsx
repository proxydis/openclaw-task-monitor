// Logo du monitor : le crabe OpenClaw devant un écran.
// Inline plutôt qu'un fichier de `public/` : le bundle standalone ne recopie
// pas systématiquement les assets statiques (voir le script `postbuild`).
// Même dessin que `app/icon.svg` (la favicon) : toute retouche ici doit y être
// reportée. Les ids de gradient sont préfixés `ocm-` parce qu'ils vivent dans le
// DOM de la page, partagé avec tout autre SVG inline présent ou futur.
// Décoratif : le titre « OpenClaw Monitor » suit immédiatement dans le <h1>,
// d'où `aria-hidden` plutôt qu'un `aria-label` qui le ferait annoncer deux fois.
export default function CrabLogo({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="ocm-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fb923c" />
          <stop offset="1" stopColor="#e0453c" />
        </linearGradient>
        <linearGradient id="ocm-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity=".22" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity=".10" />
        </linearGradient>
      </defs>

      {/* écran */}
      <rect x="6" y="4.5" width="52" height="34" rx="5.5" fill="#131a25" stroke="#38bdf8" strokeWidth="3" />
      <rect x="10" y="8.5" width="44" height="26" rx="3" fill="url(#ocm-glass)" />
      <polyline
        points="14,28 21,20.5 27,25 34,13.5 41,19 50,10.5"
        fill="none"
        stroke="#34d399"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="10.5" r="2.6" fill="#34d399" />

      {/* pinces et pattes */}
      <g stroke="#ea580c" strokeLinecap="round" fill="none">
        <path d="M23 49.5 L14.5 45.5" strokeWidth="4" />
        <path d="M41 49.5 L49.5 45.5" strokeWidth="4" />
        <path d="M24.5 55 L18 58.5" strokeWidth="3" />
        <path d="M23 51.5 L15.5 53" strokeWidth="3" />
        <path d="M39.5 55 L46 58.5" strokeWidth="3" />
        <path d="M41 51.5 L48.5 53" strokeWidth="3" />
      </g>
      <g stroke="#f97316" strokeWidth="4.5" strokeLinecap="round" fill="none">
        <path d="M10 40.5 A 6.5 6.5 0 1 1 10 49.5" />
        <path d="M54 40.5 A 6.5 6.5 0 1 0 54 49.5" />
      </g>

      {/* yeux sur pédoncules, tournés vers l'écran */}
      <g stroke="#ea580c" strokeWidth="3" strokeLinecap="round">
        <path d="M27 43 L27 37.5" />
        <path d="M37 43 L37 37.5" />
      </g>
      <circle cx="27" cy="35.8" r="3.6" fill="#f8fafc" />
      <circle cx="37" cy="35.8" r="3.6" fill="#f8fafc" />
      <circle cx="27" cy="34.9" r="1.7" fill="#0a0d13" />
      <circle cx="37" cy="34.9" r="1.7" fill="#0a0d13" />

      {/* carapace */}
      <ellipse cx="32" cy="50" rx="12" ry="9" fill="url(#ocm-shell)" />
      <path d="M23.5 46.5 q8.5 -4.5 17 0" fill="none" stroke="#ffffff" strokeOpacity=".28" strokeWidth="2" strokeLinecap="round" />
      <path d="M28 53 q4 3 8 0" fill="none" stroke="#7f1d1d" strokeOpacity=".55" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
