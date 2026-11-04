/**
 * Vérification hors serveur de la lecture du cycle de lot (`lib/cycle-lot.ts`) :
 *
 *   node scripts/verif-cycle-lot.mts
 *
 * Node 26 exécute ce fichier tel quel (suppression de types native). Rien n'est écrit, rien
 * n'est lancé : les états sont fabriqués au format de `cycles/<version>/etat.json` écrit par
 * `cycle-lot` (dépôt agentic-dev), étape par étape, et le script vérifie ce que la
 * vue Graph en tire. Il vérifie aussi que les lignes Trello ajoutées au journal de chaîne de
 * `run-lot.sh` par le cycle de lot ne changent rien à l'analyse de l'étape CI.
 */
import assert from 'node:assert/strict';
import { cycleView, relayView } from '../lib/cycle-lot.ts';
import { parseCiChain } from '../lib/ci-local.ts';

let ok = 0;
const check = (name: string, fn: () => void) => {
  fn();
  ok++;
  console.log(`ok  ${name}`);
};
const key = (m: unknown) => (typeof m === 'string' ? m : (m as { k: string }).k);
const params = (m: unknown) => (typeof m === 'string' ? {} : ((m as { p?: Record<string, unknown> }).p ?? {}));
const fact = (v: { facts: { k: string; v: string }[] }, k: string) => v.facts.filter((f) => f.k === k).map((f) => f.v);

const NOW = Date.parse('2026-11-05T10:00:00+01:00');
const base = {
  version: '1.0.0',
  prefixe: '100',
  release: 'release/1.0.0',
  fil: { canal: 'C000TEST', ts: '1700000000.000100' },
  dossier_lot: '/srv/lots/1.0.0',
  depuis: '2026-11-05T09:30:00+01:00',
  aller_retours: 0,
  max_aller_retours: 3,
  prs_lot: [
    { depot: 'back', num: 301, branche: 'feat/1.0.0-lot', sha: 'a'.repeat(40), url: 'https://github.com/proxydis/app-back/pull/301' },
    { depot: 'front', num: 401, branche: 'feat/1.0.0-lot', sha: 'b'.repeat(40), url: 'https://github.com/proxydis/app-front/pull/401' },
  ],
  prs_livraison: [],
  attente: null,
  arret: null,
  relances: { nb: 0, alerte: false },
  reveils: [],
  a_reveiller: null,
  dernier_message: { de: 'neo', heure: '2026-11-05T09:30:00+01:00', texte: 'lot fini, arbitrages A1-A3 pris\nsuite' },
};

check('étape dev : main à Neo, nœud en cours, PR du lot en liens', () => {
  const v = cycleView({ ...base, etape: 'dev', tour: 'neo' }, NOW)!;
  assert.equal(v.state, 'running');
  assert.equal(key(v.label), 'graph.cycle.lot');
  assert.deepEqual(params(v.label), { v: '1.0.0' });
  assert.equal(key(v.sub), 'graph.cycle.subHand');
  assert.deepEqual(params(v.sub), { step: 'dev', hand: 'Neo' });
  assert.equal(v.activity, 'lot fini, arbitrages A1-A3 pris');
  assert.deepEqual(fact(v, 'graph.f.cyclePr'), base.prs_lot.map((p) => p.url));
  assert.deepEqual(fact(v, 'graph.f.cycleRounds'), ['0/3']);
  assert.equal(v.runs.length, 0);
  assert.equal(v.note, null);
});

check('déploiement de revue : le relais attend, run du back suivi avec son lien', () => {
  const v = cycleView(
    {
      ...base,
      etape: 'deploiement-revue',
      tour: 'veille',
      attente: {
        deploiement: {
          branche: 'feat/1.0.0-lot',
          lance: '2026-11-05T09:31:00+01:00',
          run: 9001,
          verdict: 'en cours',
          resume: 'run 9001 in_progress',
          url: 'https://github.com/proxydis/app-back/actions/runs/9001',
        },
      },
    },
    NOW,
  )!;
  assert.equal(v.state, 'running');
  assert.equal(key(v.sub), 'graph.cycle.subWait');
  assert.equal(v.runs.length, 1);
  const [r] = v.runs;
  assert.equal(key(r.label), 'graph.cycle.runDeploy');
  assert.equal(r.state, 'running');
  assert.equal(r.startedAt, Date.parse('2026-11-05T09:31:00+01:00'));
  assert.deepEqual(fact(r, 'graph.f.runUrl'), ['https://github.com/proxydis/app-back/actions/runs/9001']);
  assert.match(v.activity, /back : run 9001 in_progress/);
});

check('CI de la release : un vert, un rouge relancé, un run pas encore créé', () => {
  const v = cycleView(
    {
      ...base,
      etape: 'ci-release',
      tour: 'veille',
      attente: {
        depots: ['back', 'front'],
        suivi: [
          { depot: 'back', branche: 'release/1.0.0', sha: 'c'.repeat(40), event: 'push', run: 50, url: 'https://github.com/proxydis/app-back/actions/runs/50', verdict: 'vert', resume: 'run 50 vert', debut: '2026-11-05T09:40:00Z' },
          { depot: 'front', branche: 'release/1.0.0', sha: 'd'.repeat(40), event: 'push', run: 51, url: 'https://github.com/proxydis/app-front/actions/runs/51', verdict: 'en cours', resume: 'run 51 failure (relancé une fois : sans rapport avec le code)', debut: '2026-11-05T09:40:05Z' },
        ],
      },
    },
    NOW,
  )!;
  assert.deepEqual(
    v.runs.map((r) => [key(r.label), params(r.label).branch, r.state]),
    [
      ['graph.cycle.runPush', 'release/1.0.0', 'done'],
      ['graph.cycle.runPush', 'release/1.0.0', 'running'],
    ],
  );
  assert.notEqual(v.runs[0].key, v.runs[1].key);
  assert.match(v.runs[1].note, /relancé/);
  const absent = cycleView(
    { ...base, etape: 'ci-release', tour: 'veille', attente: { suivi: [{ depot: 'back', branche: 'release/1.0.0', sha: 'c'.repeat(40), event: 'push', run: null, url: null, verdict: 'absent', resume: 'aucun run' }] } },
    NOW,
  )!;
  assert.equal(absent.runs[0].state, 'scheduled');
  assert.deepEqual(fact(absent.runs[0], 'graph.f.runUrl'), []);
});

check('CI de livraison : la PR vers master est retrouvée par son commit', () => {
  const v = cycleView(
    {
      ...base,
      etape: 'ci-livraison',
      tour: 'veille',
      prs_livraison: [
        { depot: 'back', num: 500, base: 'develop', sha: 'e'.repeat(40), url: 'https://github.com/proxydis/app-back/pull/500' },
        { depot: 'back', num: 501, base: 'master', sha: 'e'.repeat(40), url: 'https://github.com/proxydis/app-back/pull/501' },
      ],
      attente: { suivi: [{ depot: 'back', branche: null, sha: 'e'.repeat(40), event: 'pull_request', run: 60, url: 'https://github.com/proxydis/app-back/actions/runs/60', verdict: 'rouge', resume: 'run 60 failure, jobs rouges : env-parity' }] },
    },
    NOW,
  )!;
  const [r] = v.runs;
  assert.equal(key(r.label), 'graph.cycle.runPr');
  assert.deepEqual(params(r.label), { repo: 'back', n: 501, base: 'master' });
  assert.equal(r.state, 'failed');
  assert.deepEqual(fact(r, 'graph.f.prUrl'), ['https://github.com/proxydis/app-back/pull/501']);
  assert.equal(fact(v, 'graph.f.cycleDelivery').length, 2);
});

check('arrêt : nœud en pause, motif et message en note d’erreur', () => {
  const v = cycleView(
    { ...base, etape: 'arret', tour: 'humain', aller_retours: 3, arret: { motif: 'aller-retours', message: '3e verdict À REPRENDRE', par: 'ada' } },
    NOW,
  )!;
  assert.equal(v.state, 'paused');
  assert.equal(key(v.sub), 'graph.cycle.subStop');
  assert.equal(key(v.note), 'graph.cycle.stopNote');
  assert.equal(v.noteIsError, true);
  assert.deepEqual(fact(v, 'graph.f.cycleRounds'), ['3/3']);
});

check('réveil en échec répété et agent muet : signalés en erreur', () => {
  const w = cycleView({ ...base, etape: 'revue', tour: 'ada', a_reveiller: { agent: 'ada', motif: 'revue', essais: 3 } }, NOW)!;
  assert.equal(key(w.note), 'graph.cycle.wakeFailing');
  assert.deepEqual(params(w.note), { agent: 'Ada', n: 3 });
  const s = cycleView({ ...base, etape: 'correction', tour: 'neo', relances: { nb: 2, alerte: true } }, NOW)!;
  assert.equal(key(s.note), 'graph.cycle.silent');
  assert.equal(s.noteIsError, true);
  const r = cycleView(
    { ...base, etape: 'revue', tour: 'ada', reveils: [{ n: 1, heure: '2026-11-05T09:32:00+01:00', agent: 'ada', motif: 'revue', ok: true }] },
    NOW,
  )!;
  assert.deepEqual(fact(r, 'graph.f.cycleLastWake'), ['Ada · revue · accepté']);
  assert.equal(r.note, null);
});

check('lot livré : visible 24 h, puis plus du tout', () => {
  const v = cycleView({ ...base, etape: 'livre', tour: null, depuis: '2026-11-05T08:00:00+01:00' }, NOW)!;
  assert.equal(v.state, 'done');
  assert.equal(key(v.sub), 'graph.cycle.subDone');
  assert.equal(cycleView({ ...base, etape: 'livre', tour: null, depuis: '2026-11-03T08:00:00+01:00' }, NOW), null);
});

check('état illisible : ignoré', () => {
  assert.equal(cycleView(null, NOW), null);
  assert.equal(cycleView({ version: '1.0.0' }, NOW), null);
  assert.equal(cycleView('pas un objet', NOW), null);
});

check('relais : en cours si le pouls a moins de 6 min, en échec sinon, erreurs en note', () => {
  const frais = relayView({ derniere: '2026-11-05T09:58:30+01:00', duree_s: 0.4, lots: ['1.0.0'], erreurs: [] }, 1, NOW)!;
  assert.equal(frais.state, 'running');
  assert.equal(frais.note, null);
  assert.deepEqual(params(frais.sub), { n: 1 });
  const vieux = relayView({ derniere: '2026-11-05T09:40:00+01:00', erreurs: [] }, 1, NOW)!;
  assert.equal(vieux.state, 'failed');
  assert.equal(key(vieux.note), 'graph.cycle.relayStale');
  assert.deepEqual(params(vieux.note), { min: 20 });
  const err = relayView({ derniere: '2026-11-05T09:59:00+01:00', erreurs: ['1.0.0 : RuntimeError : gh run list'] }, 1, NOW)!;
  assert.equal(key(err.note), 'graph.cycle.relayErrors');
  assert.deepEqual(fact(err, 'graph.f.relayError'), ['1.0.0 : RuntimeError : gh run list']);
  assert.equal(relayView(null, 0, NOW), null);
});

check('journal de chaîne avec les lignes Trello du cycle : étape CI inchangée', () => {
  const lignes = [
    '2026-11-05T01:00:00+01:00 ##### 100 impl lancée',
    '2026-11-05T01:00:01+01:00 Trello : carte 01 (mKpL5LxH) en Work in progress',
    '2026-11-05T01:30:00+01:00 [voie A] OK étape a1 : back feat/1.0.0-lot poussée en abc1234 (1799s)',
    '2026-11-05T01:30:02+01:00 [voie A] Trello : carte 01 (mKpL5LxH) en Waiting for review',
    '2026-11-05T02:40:00+01:00 [voie FIN] ##### phase FIN terminée : 1 étapes OK, en échec : aucune',
    '2026-11-05T02:40:05+01:00 Trello : carte 02 (nZq8R2aB) en Waiting for review',
    '2026-11-05T02:40:06+01:00 Trello : échec du déplacement de la carte 03 en Waiting for review',
    '2026-11-05T02:41:00+01:00 CI : PR 301 (app-back) rouverte sans ci-en-pause, run attendu',
    '2026-11-05T02:41:01+01:00 CI : PR 401 (app-front) rouverte sans ci-en-pause, run attendu',
    '2026-11-05T03:05:00+01:00 CI : PR 301 (app-back) : success, run 41800000001',
    '2026-11-05T03:12:00+01:00 CI : PR 401 (app-front) : success, run 41800000002',
    '2026-11-05T03:12:05+01:00 ##### 100 terminé : A rc=0, B rc=0, FIN rc=0, CI rc=0',
  ];
  const sans = lignes.filter((l) => !/Trello/.test(l)).join('\n');
  const avec = lignes.join('\n');
  const a = parseCiChain(avec, '100');
  assert.ok(a);
  assert.deepEqual(a, parseCiChain(sans, '100'));
  assert.deepEqual(a.prs.map((p) => [p.n, p.status, p.verdict]), [
    [301, 'verdict', 'success'],
    [401, 'verdict', 'success'],
  ]);
  assert.equal(a.end?.rc, 0);
});

console.log(`\n${ok} vérifications passées`);
