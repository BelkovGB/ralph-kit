import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createTerminal, terminalSnapshot } from './ralph-terminal.mjs';

let raw;
let snapshotPath;
const readSnapshot = () => {
  // При одновременной записи оставляем последний целый снимок до следующего кадра.
  try { raw = JSON.parse(readFileSync(snapshotPath, 'utf8')); } catch { /* Повтор на следующем кадре. */ }
  return terminalSnapshot(raw?.store, raw?.metrics, raw?.startedMs ?? Date.now(), Date.now(), raw?.live);
};
let terminal;
let stopping = false;
const lifecycle = new EventEmitter();
lifecycle.pid = process.pid;
lifecycle.kill = () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write('Остановка запрошена; ожидаем завершения операции.\n');
  if (process.connected) process.send({ type: 'interrupt' });
};
const close = () => { terminal?.close(); process.exit(0); };
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('SIGINT', () => lifecycle.emit('SIGINT'));
process.on('exit', () => lifecycle.emit('exit'));
process.on('message', message => {
  if (message.type === 'close') { close(); return; }
  if (stopping) return;
  if (message.type === 'init') {
    snapshotPath = message.snapshotPath;
    try {
      terminal = createTerminal({ lifecycle,
        snapshot: readSnapshot,
      });
      if (!terminal) throw new Error('Дочерний процесс не получил терминал.');
      process.send({ type: 'ready' });
    } catch (error) {
      process.send({ type: 'error', message: error.message });
      terminal?.close();
      process.disconnect();
    }
  } else if (message.type === 'snapshot') terminal?.refresh();
  else if (message.type === 'log') terminal?.log(message.level, message.text);
  else if (message.type === 'detail') terminal?.detail(message.level, message.text);
});
