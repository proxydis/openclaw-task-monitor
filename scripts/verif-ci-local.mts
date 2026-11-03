/**
 * Vérification hors serveur de l'analyse de la CI locale (`lib/ci-local.ts`) :
 *
 *   node scripts/verif-ci-local.mts [chemin du journal d'essai]
 *
 * Node 26 exécute ce fichier tel quel (suppression de types native). Rien n'est écrit, rien
 * n'est lancé : le script lit le journal d'essai du lanceur (par défaut
 * `~/work/ci-local/essai-lanceur/chain.log`), fabrique des fiches d'état (attente, en cours,
 * terminé, refusé, interrompu) et vérifie ce que la vue Graph en tirerait.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ciLaneView,
  ciPrView,
  parseCiChain,
  parseCiJob,
  splitRunnerPids,
  type CiJob,
  type CiRunnerLite,
  type ProcLite,
} from '../lib/ci-local.ts';

let ok = 0;
const check = (name: string, fn: () => void) => {
  fn();
  ok++;
  console.log(`ok  ${name}`);
};
const subKey = (m: unknown) => (typeof m === 'string' ? m : (m as { k: string }).k);
const S = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ------------------------------------------------------------------ journal réel de l'essai
const essai = process.argv[2] ?? path.join(os.homedir(), 'work/ci-local/essai-lanceur/chain.log');
const real = fs.readFileSync(essai, 'utf8');
const step = parseCiChain(real);

check('journal réel : deux PR, deux verdicts success', () => {
  assert.ok(step);
  assert.equal(step.prs.length, 2);
  const [b, f] = step.prs;
  assert.deepEqual([b.n, b.dir, b.status, b.verdict, b.runId], [275, 'app-back', 'verdict', 'success', 41588573807]);
  assert.deepEqual([f.n, f.dir, f.status, f.verdict, f.runId], [294, 'app-front', 'verdict', 'success', 41588582610]);
  assert.equal(step.startTs, Date.parse('2026-11-03T07:13:49+01:00'));
  assert.equal(step.end, null);
});

check('journal réel : voie FIN en cours tant que la ligne de fin manque', () => {
  const v = ciLaneView(step!);
  assert.equal(v.state, 'running');
  assert.deepEqual(v.sub, { k: 'graph.lane.ci', p: { done: 2, n: 2 } });
});

check('journal réel : PR vertes, liens du run tirés du verdict sans fichier d\'état', () => {
  const v = ciPrView(step!.prs[0], step!, [], Date.now());
  assert.equal(v.state, 'done');
  assert.equal(v.sub, 'success');
  assert.equal(v.repo, 'proxydis/app-back');
  assert.equal(v.short, 'back');
  const links = Object.fromEntries(v.facts.map((f) => [f.k, f.v]));
  assert.equal(links['graph.f.runUrl'], 'https://github.com/proxydis/app-back/actions/runs/41588573807');
  assert.equal(links['graph.f.prUrl'], 'https://github.com/proxydis/app-back/pull/275');
  assert.equal(links['graph.f.checksUrl'], 'https://github.com/proxydis/app-back/pull/275/checks');
});

// ------------------------------------------------------------------ étape CI d'un lot, journal fabriqué
const lot = [
  '2026-11-03T20:10:00+01:00 [voie A] CI : run 41000000001 de la PR 276 annulé (lot en cours)',
  '2026-11-03T21:30:00+01:00 [voie FIN] ##### phase FIN terminée : 3 étapes OK, en échec : aucune',
  '2026-11-03T21:30:05+01:00 CI : PR 276 (app-back) rouverte sans ci-en-pause, run attendu',
  '2026-11-03T21:30:09+01:00 CI : PR 295 (app-front) rouverte sans ci-en-pause, run attendu',
  '2026-11-03T21:30:10+01:00 [voie FIN] CI : PR 297 (app-front) rouverte sans ci-en-pause, run attendu',
  '2026-11-03T21:30:12+01:00 CI : réouverture de la PR 298 impossible (/home/x/app-front)',
].join('\n');
const t0 = Date.parse('2026-11-03T21:30:05+01:00');
const st = parseCiChain(lot, 'neo-0991')!;

check('lot : seules les lignes après « phase FIN terminée » comptent (ci_pause ignoré)', () => {
  assert.deepEqual(st.prs.map((p) => [p.n, p.status]), [[276, 'expected'], [295, 'expected'], [297, 'expected'], [298, 'reopenFail']]);
  assert.equal(st.prs[3].dir, 'app-front');
  assert.deepEqual(ciLaneView(st).sub, { k: 'graph.lane.ci', p: { done: 1, n: 4 } });
});

const job = (o: Record<string, unknown>): CiJob =>
  parseCiJob({
    runner: 'runner-back',
    repo: 'proxydis/app-back',
    workflow: 'back',
    job: 'quality',
    event: 'pull_request',
    ref: 'refs/pull/276/merge',
    pr: 276,
    head_ref: 'feat/0.9.9.1-lot',
    base_ref: 'release/0.9.9.1',
    run_id: 41600000000,
    run_attempt: 1,
    run_url: 'https://github.com/proxydis/app-back/actions/runs/41600000000',
    job_url: null,
    pr_url: 'https://github.com/proxydis/app-back/pull/276',
    state: 'attente',
    wait: 'ci_locale',
    slot: null,
    note: null,
    queued_at: S('2026-11-03T21:31:00+01:00'),
    started_at: null,
    ended_at: null,
    updated_at: S('2026-11-03T21:31:00+01:00'),
    ...o,
  })!;
const runner = (state: CiJob | null, workerAlive: boolean, history: CiJob[] = []): CiRunnerLite => ({
  name: 'runner-back',
  repo: 'proxydis/app-back',
  state,
  history,
  workerAlive,
});
const now = t0 + 10 * 60_000;
const back = st.prs[0];

check('attente : un autre job de CI occupe le mini PC', () => {
  const v = ciPrView(back, st, [runner(job({}), true)], now);
  assert.equal(v.state, 'running');
  assert.deepEqual(v.sub, { k: 'graph.ci.job.waitCi', p: { job: 'quality', runner: 'runner-back' } });
  assert.equal(v.attached, 'runner-back');
  assert.ok(v.facts.some((f) => f.k === 'graph.f.waited' && f.fmt === 'dur' && Number(f.v) > 0));
});

check('attente de créneau, puis de mémoire', () => {
  assert.equal(subKey(ciPrView(back, st, [runner(job({ wait: 'creneau' }), true)], now).sub), 'graph.ci.job.waitSlot');
  assert.equal(subKey(ciPrView(back, st, [runner(job({ wait: 'memoire' }), true)], now).sub), 'graph.ci.job.waitMem');
});

const running = job({
  state: 'en_cours',
  wait: null,
  slot: 2,
  started_at: S('2026-11-03T21:33:00+01:00'),
  updated_at: S('2026-11-03T21:33:00+01:00'),
  job_url: 'https://github.com/proxydis/app-back/actions/runs/41600000000/job/125800000000',
});

check('en cours : créneau, lien du job, process rattachés à la PR', () => {
  const v = ciPrView(back, st, [runner(running, true)], now);
  assert.equal(v.state, 'running');
  assert.deepEqual(v.sub, { k: 'graph.ci.job.run', p: { job: 'quality', runner: 'runner-back', slot: 2 } });
  assert.equal(v.attached, 'runner-back');
  const f = Object.fromEntries(v.facts.map((x) => [x.k, x.v]));
  assert.equal(f['graph.f.jobUrl'], 'https://github.com/proxydis/app-back/actions/runs/41600000000/job/125800000000');
  assert.equal(f['graph.f.runUrl'], 'https://github.com/proxydis/app-back/actions/runs/41600000000');
  assert.equal(f['graph.f.slot'], '2');
  assert.equal(f['graph.f.waited'], String(2 * 60_000));
  assert.equal(f['graph.f.branch'], 'feat/0.9.9.1-lot');
});

check('interrompu : fiche « en cours » sans Runner.Worker, ni vivant ni rattaché', () => {
  const v = ciPrView(back, st, [runner(running, false)], now);
  assert.equal(v.state, 'killed');
  assert.equal(subKey(v.sub), 'graph.ci.job.interrupted');
  assert.equal(v.attached, null);
  assert.equal(subKey(v.note), 'graph.ci.job.interruptedNote');
});

check('terminé sans verdict : la PR attend toujours le journal', () => {
  const done = job({ state: 'termine', wait: null, slot: 2, started_at: S('2026-11-03T21:33:00+01:00'), ended_at: S('2026-11-03T21:38:00+01:00'), updated_at: S('2026-11-03T21:38:00+01:00') });
  const v = ciPrView(back, st, [runner(done, false, [done])], now);
  assert.equal(v.state, 'running');
  assert.equal(subKey(v.sub), 'graph.ci.job.ended');
  assert.equal(v.attached, null);
  assert.ok(v.facts.some((f) => f.k === 'graph.f.jobsDone' && f.v === 'quality'));
  assert.ok(v.facts.some((f) => f.k === 'graph.f.ranFor' && f.v === String(5 * 60_000)));
});

check('refusé : échec, note du hook ; relance par ci_fin : la PR repart', () => {
  const ref = job({ state: 'refuse', wait: null, note: 'CI-LOCALE-RESSOURCES : ni créneau ni mémoire en 2400 s (2100 Mio)', ended_at: S('2026-11-03T21:35:00+01:00'), updated_at: S('2026-11-03T21:35:00+01:00') });
  const v = ciPrView(back, st, [runner(ref, false, [ref])], now);
  assert.equal(v.state, 'failed');
  assert.deepEqual(v.sub, { k: 'graph.ci.job.refused', p: { note: ref.note! } });
  const rerun = parseCiChain(`${lot}\n2026-11-03T21:36:00+01:00 CI : PR 276, rouge sans rapport avec le code (run 41600000000 : Sonar côté serveur ou ressources du mini PC), jobs rouges relancés une fois`)!;
  const v2 = ciPrView(rerun.prs[0], rerun, [runner(ref, false, [ref])], now);
  assert.equal(v2.state, 'running');
  assert.equal(subKey(v2.sub), 'graph.ci.pr.rerun');
});

check('job plus ancien de la même PR (refusé pendant les phases) : jamais rattaché', () => {
  const old = job({ state: 'refuse', note: 'CI-LOCALE-LOT-EN-COURS : branche d\'un lot en cours', queued_at: S('2026-11-03T20:10:00+01:00'), updated_at: S('2026-11-03T20:10:01+01:00') });
  const v = ciPrView(back, st, [runner(old, false, [old])], now);
  assert.equal(v.state, 'running');
  assert.equal(subKey(v.sub), 'graph.ci.pr.expected');
  assert.equal(v.job, null);
});

check('autre PR du même dépôt sur le runner : pas de rattachement', () => {
  const other = job({ pr: 999, state: 'en_cours', slot: 1 });
  const v = ciPrView(back, st, [runner(other, true)], now);
  assert.equal(v.attached, null);
  assert.equal(subKey(v.sub), 'graph.ci.pr.expected');
});

// ------------------------------------------------------------------ verdicts et fin d'étape
const fin = parseCiChain(
  [
    lot,
    '2026-11-03T21:50:00+01:00 CI : PR 276 (app-back) : failure, run 41600000000, jobs rouges : quality',
    '2026-11-03T21:51:00+01:00 CI : PR 295 (app-front) en conflit avec release/0.9.9.1, aucun run ne part : mettre feat/x à jour avec origin/release/0.9.9.1, puis relancer l\'étape CI (reprise du lot)',
    '2026-11-03T21:52:00+01:00 CI : PR 297 (app-front) : skipped, run 41600000002, jobs rouges : aucun, jobs sautés : la PR porte-t-elle encore ci-en-pause ?',
    '2026-11-03T21:53:00+01:00 ##### neo-0991 terminé : A rc=0, B rc=0, FIN rc=0, CI rc=1',
  ].join('\n'),
  'neo-0991',
)!;

check('verdicts : failure (jobs rouges), conflit, skipped, réouverture impossible', () => {
  const v = fin.prs.map((p) => ciPrView(p, fin, [], now));
  assert.deepEqual(v.map((x) => x.state), ['failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(v[0].sub, { k: 'graph.ci.pr.red', p: { v: 'failure', red: 'quality' } });
  assert.deepEqual(v[1].sub, { k: 'graph.ci.pr.conflict', p: { rel: 'release/0.9.9.1' } });
  assert.deepEqual(v[2].sub, { k: 'graph.ci.pr.skipped' });
  assert.deepEqual(v[3].sub, { k: 'graph.ci.pr.reopenFail' });
});

check('fin d\'étape : voie FIN failed avec la raison, done sur CI rc=0', () => {
  const v = ciLaneView(fin);
  assert.equal(v.state, 'failed');
  assert.deepEqual(v.note, { k: 'graph.lane.ciFailed', p: { prs: '#276, #295, #297, #298' } });
  assert.equal(v.endedAt, Date.parse('2026-11-03T21:53:00+01:00'));
  const green = parseCiChain(`${real}\n2026-11-03T07:35:20+01:00 ##### essai terminé : A rc=0, B rc=0, FIN rc=0, CI rc=0`)!;
  assert.equal(ciLaneView(green).state, 'done');
  assert.equal(ciLaneView(green).note, null);
});

check('pas de verdict en 3 h, aucune PR ouverte', () => {
  const to = parseCiChain(`${lot}\n2026-11-04T00:31:00+01:00 CI : pas de verdict en 3 h pour toutes les PR`)!;
  assert.equal(ciPrView(to.prs[0], to, [], now).state, 'failed');
  assert.equal(subKey(ciPrView(to.prs[0], to, [], now).sub), 'graph.ci.pr.noVerdict');
  const none = parseCiChain('2026-11-03T21:30:00+01:00 [voie FIN] ##### phase FIN terminée : 1 étapes OK, en échec : aucune\n2026-11-03T21:30:02+01:00 CI : aucune PR ouverte vers release/0.9.9.1 pour ce lot, rien à lancer')!;
  assert.equal(none.noPr, 'release/0.9.9.1');
  assert.equal(none.prs.length, 0);
});

check('étape CI pas commencée (ci_reprise, phases en cours) : null', () => {
  assert.equal(parseCiChain('2026-11-03T20:10:00+01:00 [voie A] CI : run 1 de la PR 2 annulé (lot en cours)'), null);
  assert.equal(parseCiChain('2026-11-03T20:10:00+01:00 CI : étiquette ci-en-pause retirée de la PR 276, sans relance\n2026-11-03T20:10:01+01:00 ##### x terminé : A rc=1, B rc=0, FIN rc=0, CI rc=1'), null);
});

// ------------------------------------------------------------------ fiches illisibles, process du runner
check('fiches d\'état : JSON cassé, champs manquants, lien non GitHub — jamais d\'exception', () => {
  assert.equal(parseCiJob('{"runner": "runner-b'), null);
  assert.equal(parseCiJob('null'), null);
  assert.equal(parseCiJob({ repo: 'x' }), null);
  const j = parseCiJob({ runner: 'runner-front', state: 'bizarre', run_url: 'javascript:alert(1)', pr: '12', queued_at: 'x' })!;
  assert.equal(j.state, 'inconnu');
  assert.equal(j.runUrl, null);
  assert.equal(j.pr, 12);
  assert.equal(j.queuedAt, null);
});

check('process : socle du runner séparé du job (Runner.Worker et sleep du créneau)', () => {
  const p = (pid: number, ppid: number, cmd: string): ProcLite => ({ pid, ppid, cmd, comm: cmd.split(' ')[0].split('/').pop()!, startedAt: pid });
  const procs = new Map<number, ProcLite>(
    [
      p(10, 1, '/home/u/ci-runner/back/runsvc.sh'),
      p(11, 10, '/home/u/ci-runner/back/externals/node20/bin/node ./bin/RunnerService.js'),
      p(12, 11, '/home/u/ci-runner/back/bin/Runner.Listener run --startuptype service'),
      p(13, 12, '/home/u/ci-runner/back/bin/Runner.Worker spawnclient 123 456'),
      p(14, 13, '/usr/bin/bash -e /home/u/ci-runner/back/_work/_temp/abc.sh'),
      p(15, 14, 'python -m pytest -n 3'),
      p(16, 2000, 'sleep 10800'),
    ].map((x) => [x.pid, x]),
  );
  const r = splitRunnerPids([10, 11, 12, 13, 14, 15, 16], procs);
  assert.deepEqual(r.base.sort(), [10, 11, 12]);
  assert.deepEqual(r.job.sort(), [13, 14, 15, 16]);
  assert.deepEqual(r.workers, [13]);
});

console.log(`\n${ok} vérifications passées`);
