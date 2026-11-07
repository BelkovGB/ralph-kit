import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTerminal } from './ralph-terminal.mjs';

const base = {
  headline: 'Задача #42 · Исправления', subject: '#42 Экран CLI', issue: '#42 Экран CLI',
  phase: '2/3', runTime: '0:42:18',
  counterGroups: { run: ['Итерации: 7/60'], checks: [], session: [] },
  process: { current: 'fixing', completed: [], failed: 'review', correctionSource: 'review',
    errorStage: null, partial: false, reviewEnabled: true, reviewRound: 2,
    reviews: [{ round: 1, verdict: 'fail', findings: 4 }, { round: 2, verdict: 'fail', findings: 1 }] },
};
const mapLines = (snapshot = base) => renderTerminal(snapshot, [], 160, 40).split('\n')
  .slice(0, renderTerminal(snapshot, [], 160, 40).split('\n').findIndex(line => line.includes('ПРОГРЕСС И КАЧЕСТВО')));

test('the current correction and its review number live inside the active node', () => {
  const lines = mapLines();
  const fixing = lines.findIndex(line => line.includes('[>] Исправления #2'));
  assert.ok(fixing > 0);
  assert.match(lines[fixing - 1], /╔[═↓]+╗/);
  assert.match(lines[fixing], /[║╣].*\[>\] Исправления #2.*║/);
  assert.match(lines[fixing + 1], /╚/);
  const primary = lines.find(line => line.includes('Реализация'));
  assert.match(primary, /Проверки.*Ревью #2.*Готово/);
  assert.doesNotMatch(primary, /Исправления/);
  assert.match(lines.join('\n'), /1 замечание/);
  assert.match(lines.join('\n'), /↑/);
  assert.doesNotMatch(lines.join('\n'), /Сейчас:|СЕЙЧАС:|Круг ревью:|Возврат:|Ревью 2: FAIL/);
});

test('a new review moves the current marker and the round into the review node', () => {
  const lines = mapLines({ ...base, process: { ...base.process, current: 'review', reviewRound: 3,
    failed: null, completed: ['implementation', 'fixing', 'validation'] } });
  const review = lines.findIndex(line => line.includes('[>] Ревью #3'));
  assert.ok(review > 0);
  assert.match(lines[review - 1], /╔═+╗/);
  assert.doesNotMatch(lines.join('\n'), /Исправления/);
});

test('requested changes and a technical review failure have different nodes and routes', () => {
  assert.match(mapLines().join('\n'), /\[~\] Ревью #2/);
  const technical = mapLines({ ...base, process: { ...base.process, current: 'review', errorStage: 'review',
    correctionSource: null, reviews: [], reviewRound: 1 } }).join('\n');
  assert.match(technical, /\[!\] Ревью #1 ERROR/);
  assert.doesNotMatch(technical, /Исправления|замечание/);
});

test('a failed correction stays in the correction node instead of the initial implementation', () => {
  const lines = mapLines({ ...base, process: { ...base.process, current: 'implementation',
    failed: 'implementation', errorStage: 'implementation' } });
  assert.match(lines.join('\n'), /\[!\] Исправления #2 ERROR/);
  const initial = lines.find(line => line.includes('Реализация'));
  assert.doesNotMatch(initial, /\[!\] Реализация|Реализация ERROR/);
});

test('an infrastructure error during repeated validation does not announce a new correction', () => {
  const lines = mapLines({ ...base, process: { ...base.process, current: 'validation',
    completed: ['implementation', 'fixing'], failed: 'validation', errorStage: 'validation' } });
  assert.match(lines.join('\n'), /\[!\] Проверки ERROR/);
  assert.doesNotMatch(lines.join('\n'), /Исправления| FAIL/);
});

test('unvisited paths stay dotted and disabled review is bypassed', () => {
  const initial = mapLines({ ...base, process: { ...base.process, current: 'implementation', failed: null,
    correctionSource: null, reviews: [], reviewRound: null } }).join('\n');
  assert.match(initial, /┄┄→/);
  const disabled = mapLines({ ...base, process: { ...base.process, current: 'validation', failed: null,
    correctionSource: null, reviews: [], reviewRound: null, reviewEnabled: false } }).join('\n');
  assert.match(disabled, /\[x\] Ревью/);
  assert.match(disabled, /× выключено/);
  assert.doesNotMatch(disabled, /\[\+\] Ревью/);
});

test('Git actions and Lisa appear as actual current operations instead of a guessed future stage', () => {
  const publishing = mapLines({ ...base, process: { ...base.process, current: 'publishing', operation: 'closing',
    correctionSource: null, failed: null } }).join('\n');
  assert.match(publishing, /\[>\] Закрытие задачи/);
  const lisa = mapLines({ ...base, actor: 'Lisa', repairStatus: 'checking' }).join('\n');
  assert.match(lisa, /\[>\] Lisa: проверка/);
  assert.doesNotMatch(lisa, /\[>\] Исправления/);
});
