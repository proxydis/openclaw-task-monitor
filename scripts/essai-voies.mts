/**
 * Essai hors serveur des voies d'un lot (`run-lot.sh`) et des passes de preuves en réel (`run-reel.sh`) :
 *   node scripts/essai-voies.mts
 *
 * Journaux rejoués (`scripts/essai-voies/`, chemins de l'utilisateur neutralisés) :
 * - `neo-103r6-impl-chain.log`, `neo-103r7-impl-chain.log` : vrais lots, FIN à une file (un seul dépôt) ;
 * - `essai-100-impl-chain.log` : produit par `tests/essai-run-lot.sh` du cycle de lot (FIN en deux files
 *   parallèles, partie mécanique rouge puis verte après une passe de correction, CI des deux PR) ;
 *   `essai-100r1-impl-chain.log` : sa reprise sans partie mécanique (`MECA=""`), FIN à une file ;
 * - `factice-fin-files-*.log` : écrits d'après les `note` de run-lot.sh, pour ce que l'essai ne produit pas
 *   (attente de l'autre file, `CI :` de `ci_pause` dans une file FIN, échec de la partie mécanique) ;
 * - `neo-103r{6,7}-reel-chain.log` : vrais journaux de `run-reel.sh` ; `factice-reel-chain.log` : échec,
 *   abandon, puis un lancement en cours.
 * Si les journaux vivants de Neo sont présents (`~/.openclaw/workspace-neo/logs`), ils sont rejoués aussi.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciLaneView, parseCiChain } from '../lib/ci-local.ts';
import {
  baseStep,
  ciLaneOf,
  laneOfStep,
  mecaArgs,
  parseLaneLines,
  parseReelChain,
  reelArgs,
  reelName,
  stepOfLog,
  stepOfMecaDir,
  type LaneChain,
} from '../lib/lot-chain.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'essai-voies');
let ok = 0;
const check = (name: string, fn: () => void) => {
  fn();
  ok++;
  console.log(`ok  ${name}`);
};
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const subKey = (m: unknown) => (typeof m === 'string' ? m : (m as { k: string }).k);

type Step = { phase: string; repo: string; card: string };
const steps = (f: string): Map<string, Step> => {
  const out = new Map<string, Step>();
  for (const l of read(f).split('\n')) {
    const x = l.trim().split(/\s+/);
    if (!l.trim() || l.trim().startsWith('#') || x.length < 6) continue;
    out.set(x[0], { phase: x[1], repo: x[2], card: x[3] });
  }
  return out;
};
/** comme `readLot` : le texte depuis le dernier `##### <PREFIX> impl lancée` */
const lastRun = (text: string, prefix: string) => {
  const i = text.lastIndexOf(`##### ${prefix} impl lancée`);
  return i >= 0 ? text.slice(i) : text;
};
/** texte jusqu'à la première ligne qui contient `marker`, incluse (état du journal à cet instant) */
const until = (text: string, marker: string, nth = 1) => {
  let i = -1;
  for (let k = 0; k < nth; k++) i = text.indexOf(marker, i + 1);
  assert.ok(i >= 0, `repère absent : ${marker}`);
  return text.slice(0, text.indexOf('\n', i) + 1);
};
const lane = (c: LaneChain, ph: string) => {
  const x = c.lanes.get(ph);
  assert.ok(x, `voie ${ph} absente (voies : ${[...c.lanes.keys()].join(', ')})`);
  return x;
};

// ------------------------------------------------------------------ outils

check('étape d’un journal, des journaux de la partie mécanique, d’une passe de correction', () => {
  assert.equal(stepOfLog('/l/neo-103r7-FINB.log', 'neo-103r7'), 'FINB');
  assert.equal(stepOfLog('/l/essai-100-FINB-c1.log', 'essai-100'), 'FINB-c1');
  assert.equal(stepOfLog('/l/essai-100r1-FINB.log', 'essai-100'), null, 'préfixe voisin');
  assert.equal(stepOfMecaDir('/l/neo-103r7-FINB-meca', 'neo-103r7'), 'FINB');
  assert.equal(stepOfMecaDir('/l/neo-103r7-FINB-meca/', 'neo-103r7'), 'FINB');
  const st = steps('essai-100-etapes.txt');
  assert.equal(baseStep('FINB-c2', st), 'FINB');
  assert.equal(baseStep('FINB', st), 'FINB');
  assert.equal(baseStep('X-c1', st), 'X-c1', 'étape inconnue : inchangée');
  assert.deepEqual(
    mecaArgs('/bin/bash /home/user/phenix-lot/fin-mecanique.sh back /home/user/app-back origin/release/1.0.3 /home/user/logs/neo-103r7-FINB-meca /lot/fin-mecanique-back.txt'),
    { repo: 'back', dir: '/home/user/logs/neo-103r7-FINB-meca' },
  );
  assert.equal(mecaArgs('pytest -n 4'), null);
});

check('voie d’une étape : FIN-<dépôt> en files parallèles, FIN en une file', () => {
  const st = steps('essai-100-etapes.txt');
  const par = ['A', 'B', 'C', 'FIN-back', 'FIN-front'];
  assert.equal(laneOfStep('A1', st, par), 'A');
  assert.equal(laneOfStep('C1', st, par), 'C');
  assert.equal(laneOfStep('FINB', st, par), 'FIN-back');
  assert.equal(laneOfStep('FINB-c1', st, par), 'FIN-back');
  assert.equal(laneOfStep('FUSIONC', st, par), 'FIN-back');
  assert.equal(laneOfStep('R3', st, par), 'FIN-back');
  assert.equal(laneOfStep('FINF', st, par), 'FIN-front');
  // une file FIN-front connue seule (FIN-back pas encore écrite) : FINB va quand même dans FIN-back
  assert.equal(laneOfStep('FINB', st, ['A', 'FIN-front']), 'FIN-back');
  assert.equal(laneOfStep('FINB', st, ['A', 'B', 'FIN']), 'FIN');
  assert.equal(laneOfStep('FINB', st, ['A', 'B']), 'FIN', 'aucune voie FIN encore écrite : une file');
  assert.equal(laneOfStep('ZZ', st, par), null);
  assert.equal(ciLaneOf('phenix-back', ['FIN-back', 'FIN-front']), 'FIN-back');
  assert.equal(ciLaneOf('front', ['FIN-back', 'FIN-front']), 'FIN-front');
  assert.equal(ciLaneOf('autre', ['FIN-back', 'FIN-front']), 'FIN-back', 'dépôt inconnu : première voie FIN');
  assert.equal(ciLaneOf('phenix-back', ['FIN']), 'FIN');
});

// ------------------------------------------------------------------ FIN à une file (vrais lots)

check('r7 : voies A, B, FIN ; la fin d’appli compte une étape, pas deux', () => {
  const st = steps('neo-103r7-etapes.txt');
  const text = lastRun(read('neo-103r7-impl-chain.log'), 'neo-103r7');
  const c = parseLaneLines(text, st);
  assert.deepEqual([...c.lanes.keys()].sort(), ['A', 'B', 'FIN']);
  assert.equal(c.finFiles, null);
  assert.equal(c.finEnd, null);
  const fin = lane(c, 'FIN');
  assert.ok(fin.finished && !fin.failed);
  assert.equal(fin.okCount, 1);
  assert.equal(fin.step, 'FINB');
  assert.equal(fin.mode, 'meca');
  assert.equal(fin.mecaPass, 1);
  assert.equal(fin.mecaDir, '/home/user/.openclaw/workspace-neo/logs/neo-103r7-FINB-meca');
  assert.equal(lane(c, 'A').okCount, 1);
  assert.equal(lane(c, 'B').okCount, 0);
  // pendant la relecture, puis pendant la partie mécanique, puis à sa fin verte (avant la ligne de phase)
  const relu = parseLaneLines(until(text, 'OK étape FINB : back'), st);
  assert.equal(lane(relu, 'FIN').okCount, 1);
  assert.equal(lane(relu, 'FIN').mode, 'claude');
  assert.equal(lane(relu, 'FIN').log, '/home/user/.openclaw/workspace-neo/logs/neo-103r7-FINB.log');
  const meca = parseLaneLines(until(text, 'partie mécanique sans Claude'), st);
  const m = lane(meca, 'FIN');
  assert.ok(!m.finished);
  assert.equal(m.mode, 'meca');
  assert.equal(m.okCount, 0, 'la fin d’appli n’est faite qu’à la partie mécanique verte');
  assert.equal(m.slot, 1);
  const vert = parseLaneLines(until(text, 'partie mécanique verte'), st);
  assert.equal(lane(vert, 'FIN').okCount, 1, 'passe Claude + partie mécanique = une étape');
  const ci = parseCiChain(text, 'neo-103r7');
  assert.ok(ci && ci.prs.length === 1 && ci.prs[0].n === 312 && ci.end?.rc === 0);
  assert.equal(ciLaneOf(ci.prs[0].dir, ['FIN']), 'FIN');
});

check('r6 : premier lancement (voie C en échec, attentes de créneau), puis relance', () => {
  const st = steps('neo-103r6-etapes.txt');
  const all = read('neo-103r6-impl-chain.log');
  const first = all.slice(0, all.lastIndexOf('##### neo-103r6 impl lancée'));
  const c = parseLaneLines(first, st);
  assert.deepEqual([...c.lanes.keys()].sort(), ['A', 'B', 'C', 'FIN']);
  assert.equal(lane(c, 'A').okCount, 3);
  assert.equal(lane(c, 'C').failed, 'R22f');
  assert.match(lane(c, 'C').error ?? '', /^ÉCHEC préparation R22f/);
  assert.equal(lane(c, 'FIN').okCount, 1);
  const attente = parseLaneLines(until(first, 'attente mémoire : 2516'), st);
  assert.ok(lane(attente, 'A').waiting && lane(attente, 'C').waiting);
  const pris = parseLaneLines(until(first, '[voie A] créneau 1 pris'), st);
  assert.ok(!lane(pris, 'A').waiting && lane(pris, 'C').waiting);
  const relance = parseLaneLines(lastRun(all, 'neo-103r6'), st);
  assert.ok(lane(relance, 'FIN').finished);
  assert.equal(lane(relance, 'FIN').okCount, 0);
  const ci = parseCiChain(lastRun(all, 'neo-103r6'), 'neo-103r6');
  assert.ok(ci && ci.prs[0].verdict === 'success');
  assert.equal(parseCiChain(first, 'neo-103r6'), null, 'ci_reprise : pas d’étape CI');
});

check('essai r1 (sans partie mécanique) : FIN à une file, CI des deux PR sous FIN', () => {
  const st = steps('essai-100r1-etapes.txt');
  const text = lastRun(read('essai-100r1-impl-chain.log'), 'essai-100r1');
  const c = parseLaneLines(text, st);
  assert.ok(c.lanes.has('FIN') && ![...c.lanes.keys()].some((k) => k.startsWith('FIN-')));
  assert.equal(lane(c, 'FIN').okCount, 1);
  const ci = parseCiChain(text, 'essai-100r1')!;
  assert.equal(ci.prs.length, 2);
  assert.ok(ci.prs.every((p) => ciLaneOf(p.dir, ['FIN']) === 'FIN'));
});

// ------------------------------------------------------------------ FIN en deux files parallèles

check('essai : deux files FIN-back et FIN-front, fin globale, compteurs', () => {
  const st = steps('essai-100-etapes.txt');
  const text = lastRun(read('essai-100-impl-chain.log'), 'essai-100');
  const c = parseLaneLines(text, st);
  assert.deepEqual([...c.lanes.keys()].sort(), ['A', 'B', 'C', 'FIN-back', 'FIN-front']);
  assert.deepEqual(c.finFiles, ['back', 'front']);
  assert.deepEqual(c.finEnd?.rc, 0);
  const back = lane(c, 'FIN-back');
  const front = lane(c, 'FIN-front');
  assert.ok(back.finished && !back.failed && back.okCount === 3);
  assert.ok(front.finished && !front.failed && front.okCount === 1);
  assert.equal(back.red, null, 'rouge effacé par la partie mécanique verte');
  assert.ok(back.mecaLight && back.mecaPass === 2);
  assert.equal(front.mode, 'meca');
  assert.equal(front.mecaDir, '/tmp/essai-run-lot/logs/essai-100-FINF-meca');
});

check('essai : partie mécanique rouge, passe de correction, passage allégé vert', () => {
  const st = steps('essai-100-etapes.txt');
  const text = lastRun(read('essai-100-impl-chain.log'), 'essai-100');
  const rouge = lane(parseLaneLines(until(text, 'partie mécanique ROUGE'), st), 'FIN-back');
  assert.ok(!rouge.finished && !rouge.failed);
  assert.deepEqual(rouge.red, {
    step: 'FINB',
    pass: 1,
    verdict: '1 commande(s) sur 4 : correction.',
    report: '/tmp/essai-run-lot/logs/essai-100-FINB-meca-1.md',
  });
  assert.equal(rouge.okCount, 2, 'FUSIONC et R3 ; FINB pas encore');
  const corr = lane(parseLaneLines(until(text, 'étape FINB-c1 : run Claude Code'), st), 'FIN-back');
  assert.equal(corr.mode, 'claude');
  assert.equal(corr.step, 'FINB-c1');
  assert.equal(corr.correction, 1);
  assert.ok(corr.red, 'le rouge reste visible pendant la correction');
  const corrOk = lane(parseLaneLines(until(text, 'OK étape FINB-c1'), st), 'FIN-back');
  assert.equal(corrOk.okCount, 2, 'la correction poussée ne fait pas l’étape');
  const allege = lane(parseLaneLines(until(text, 'passage 2, allégé'), st), 'FIN-back');
  assert.ok(allege.mode === 'meca' && allege.mecaLight && allege.mecaPass === 2 && allege.correction === null);
  const vert = lane(parseLaneLines(until(text, 'OK étape FINB : partie mécanique verte'), st), 'FIN-back');
  assert.equal(vert.okCount, 3);
  assert.equal(vert.red, null);
});

check('essai : étape CI après les files, une PR par file, voie en cours tant que la CI attend', () => {
  const text = lastRun(read('essai-100-impl-chain.log'), 'essai-100');
  const lanes = ['FIN-back', 'FIN-front'];
  const ci = parseCiChain(text, 'essai-100')!;
  assert.equal(ci.prs.length, 2);
  assert.equal(ci.end?.rc, 0);
  const of = (ph: string) => ci.prs.filter((p) => ciLaneOf(p.dir, lanes) === ph);
  assert.deepEqual(of('FIN-back').map((p) => p.n), [2]);
  assert.deepEqual(of('FIN-front').map((p) => p.n), [1]);
  // pendant l'attente des verdicts
  const attente = parseCiChain(until(text, 'CI : PR 1 (front) rouverte'), 'essai-100')!;
  const vBack = ciLaneView({ ...attente, prs: attente.prs.filter((p) => ciLaneOf(p.dir, lanes) === 'FIN-back') });
  assert.equal(vBack.state, 'running');
  assert.equal(subKey(vBack.sub), 'graph.lane.ci');
  const fin = ciLaneView({ ...ci, prs: of('FIN-front') });
  assert.equal(fin.state, 'done');
  // la fin globale « (files parallèles) » délimite l'étape CI : rien avant elle n'en fait partie
  const sale = text.replace(
    /^(\S+) ##### phase FIN terminée \(files parallèles\)/m,
    '$1 [voie FIN-front] CI : PR 1 (front) : failure, run 5\n$1 ##### phase FIN terminée (files parallèles)',
  );
  assert.deepEqual(parseCiChain(sale, 'essai-100'), ci);
});

check('factice en cours : attente de l’autre file, rouge en note, CI de ci_pause exclue', () => {
  const st = steps('factice-etapes.txt');
  const text = read('factice-fin-files-en-cours.log');
  const c = parseLaneLines(text, st);
  assert.deepEqual(c.finFiles, ['back', 'front']);
  assert.equal(c.finEnd, null);
  const back = lane(c, 'FIN-back');
  assert.ok(back.mecaWait && back.step === 'FINB' && !back.finished);
  assert.equal(back.okCount, 1, 'FUSIONC seule : FINB attend sa partie mécanique');
  assert.equal(back.red?.verdict, '1 commande(s) sur 6 : pytest.');
  const front = lane(c, 'FIN-front');
  assert.ok(!front.mecaWait && front.mode === 'meca' && front.mecaPass === 1 && front.slot === 2);
  assert.equal(front.okCount, 0);
  // l'attente du front, avant que la partie mécanique du back ne rende le verrou
  const avant = lane(parseLaneLines(until(text, 'FINF : partie mécanique en attente'), st), 'FIN-front');
  assert.ok(avant.mecaWait && avant.step === 'FINF');
  // lignes `CI :` de ci_pause dans les files (et en voie A) : pas d'étape CI
  assert.equal(parseCiChain(text, 'fx-104'), null);
  const pause = `${text}2026-11-21T09:40:00+01:00 [voie FIN-back] CI : PR 12 (app-back) rouverte sans ci-en-pause, run attendu\n`;
  assert.equal(parseCiChain(pause, 'fx-104'), null);
});

check('factice en échec : file front rouge jusqu’au bout, phase FIN rc=1, pas de CI', () => {
  const st = steps('factice-etapes.txt');
  const text = read('factice-fin-files-echec.log');
  const c = parseLaneLines(text, st);
  assert.equal(c.finEnd?.rc, 1);
  const back = lane(c, 'FIN-back');
  assert.ok(back.finished && !back.failed && back.okCount === 2 && back.red === null);
  const front = lane(c, 'FIN-front');
  assert.ok(front.finished && front.failed === 'FINF' && front.okCount === 0);
  assert.match(front.error ?? '', /^ÉCHEC étape FINF : partie mécanique encore rouge/);
  assert.equal(front.red?.pass, 2);
  const corr = lane(parseLaneLines(until(text, 'étape FINF-c1 : run Claude Code'), st), 'FIN-front');
  assert.ok(corr.correction === 1 && corr.step === 'FINF-c1' && !corr.mecaWait);
  assert.equal(parseCiChain(text, 'fx-104'), null);
});

// ------------------------------------------------------------------ preuves en réel

check('run-reel : arguments, noms de passe', () => {
  assert.deepEqual(reelArgs('/bin/bash /h/phenix-lot/run-reel.sh /p/103r7/reel /p/103/reel.md'), { dir: '/p/103r7/reel', proofs: '/p/103/reel.md' });
  assert.deepEqual(reelArgs('bash run-reel.sh reel'), { dir: 'reel', proofs: null });
  assert.equal(reelArgs('bash run-lot.sh /x impl'), null);
  assert.equal(reelName('step-REEL-a-designations.md'), 'a-designations');
  assert.equal(reelName('/x/step-REEL.md'), '');
});

for (const v of ['r6', 'r7']) {
  check(`run-reel ${v} : deux passes OK, preuves ajoutées, rc=0`, () => {
    const run = parseReelChain(read(`neo-103${v}-reel-chain.log`))!;
    assert.deepEqual(run.passes.map((p) => [p.name, p.state]), [
      ['a-designations', 'done'],
      ['b-nuit', 'done'],
    ]);
    assert.equal(run.passes[0].log, `/home/user/.openclaw/workspace-neo/logs/neo-103${v}-reel/reel-a-designations.log`);
    assert.match(run.passes[1].section ?? '', /reel-sections\/reel-b-nuit\.md$/);
    assert.ok(run.passes.every((p) => p.endTs !== null && p.startTs !== null));
    assert.equal(run.proofs, '/home/user/.openclaw/workspace-neo/prompts/103/reel.md');
    assert.equal(run.end?.rc, 0);
    // en cours : après le lancement, avant les verdicts
    const enCours = parseReelChain(until(read(`neo-103${v}-reel-chain.log`), 'lancée', 2))!;
    assert.ok(enCours.passes.every((p) => p.state === 'running') && enCours.end === null);
  });
}

check('run-reel factice : échec d’une passe, abandon, puis lancement en cours', () => {
  const text = read('factice-reel-chain.log');
  const premier = parseReelChain(until(text, 'preuves en réel terminées'))!;
  assert.deepEqual(premier.passes.map((p) => p.state), ['done', 'failed']);
  assert.match(premier.passes[1].reason ?? '', /absente ou vide$/);
  assert.equal(premier.end?.rc, 1);
  const abandon = parseReelChain(until(text, 'ABANDON'))!;
  assert.ok(abandon.abort?.startsWith('fichier des preuves absent') && abandon.passes.length === 0);
  const run = parseReelChain(text)!;
  assert.equal(run.startTs, Date.parse('2026-11-21T11:30:00+01:00'));
  assert.deepEqual(run.passes.map((p) => [p.name, p.state]), [
    ['a-x', 'running'],
    ['b-y', 'done'],
  ]);
  assert.equal(run.end, null);
  assert.equal(run.abort, null);
  assert.equal(parseReelChain(''), null);
});

// ------------------------------------------------------------------ journaux vivants, s'ils sont là

const LIVE = path.join(os.homedir(), '.openclaw', 'workspace-neo');
for (const v of ['103r6', '103r7']) {
  const chain = path.join(LIVE, 'logs', `neo-${v}-impl-chain.log`);
  const etapes = path.join(LIVE, 'prompts', v, 'etapes.txt');
  if (!fs.existsSync(chain) || !fs.existsSync(etapes)) continue;
  check(`journal vivant neo-${v} : mêmes voies et compteurs que la copie`, () => {
    const st = steps(path.relative(DIR, etapes));
    const vivant = parseLaneLines(lastRun(fs.readFileSync(chain, 'utf8'), `neo-${v}`), st);
    const copie = parseLaneLines(lastRun(read(`neo-${v}-impl-chain.log`), `neo-${v}`), st);
    const resume = (c: LaneChain) => [...c.lanes.values()].map((x) => [x.phase, x.okCount, x.finished, x.failed]);
    assert.deepEqual(resume(vivant), resume(copie));
  });
  const reel = path.join(LIVE, 'logs', `neo-${v}-reel`, 'reel-chain.log');
  if (fs.existsSync(reel)) {
    check(`journal vivant neo-${v}-reel : passes finies`, () => {
      const run = parseReelChain(fs.readFileSync(reel, 'utf8'))!;
      assert.ok(run.passes.length >= 1 && run.passes.every((p) => p.state !== 'running') && run.end);
    });
  }
}

console.log(`\n${ok} vérifications passées`);
