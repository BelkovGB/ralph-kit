import { fork as forkProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workerPath = fileURLToPath(new URL('./ralph-terminal-worker.mjs', import.meta.url));

// Только отображение вынесено из процесса цикла: spawnSync не останавливает
// часы и клавиатуру, а управляющие решения по-прежнему принимает цикл.
export async function createTerminalHost({ snapshot, output = process.stdout, errorOutput = process.stderr,
  input = process.stdin, lifecycle = process, term = process.env.TERM, fork = forkProcess } = {}) {
  if (!output.isTTY || !errorOutput.isTTY || term === 'dumb') return null;
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-screen-'));
  const snapshotPath = path.join(directory, 'snapshot.json');
  let child;
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot()));
    child = fork(workerPath, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true, execArgv: [] });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let ready = false;
  let ended = false;
  let closing = false;
  let closePromise;
  let pending = 0;
  let omitted = false;
  const wasRaw = input.isRaw ?? false;
  let resolveReady;
  let rejectReady;
  let resolveExit;
  const startup = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const restore = () => {
    if (input.isTTY && input.setRawMode) input.setRawMode(wasRaw);
    output.write('\x1b[?25h\x1b[?1049l');
  };
  const send = (message) => {
    if (ended || !child.connected) return;
    pending += 1;
    try {
      child.send(message, () => { pending -= 1; });
    } catch {
      pending -= 1;
    }
  };
  const onExit = () => {
    if (ended) return;
    ended = true;
    rmSync(directory, { recursive: true, force: true });
    resolveExit();
    rejectReady(new Error('Процесс экрана завершился до готовности.'));
    if (ready && !closing) {
      restore();
      output.write('Экран завершился. Ralph продолжает работу; подробности в run.log.\n');
    }
  };
  child.once('exit', onExit);
  child.once('error', error => { rejectReady(error); onExit(); });
  const parentExit = () => {
    rmSync(directory, { recursive: true, force: true });
    if (child.connected) child.disconnect?.();
  };
  const stop = async (signal) => {
    await close();
    lifecycle.kill(lifecycle.pid, signal);
  };
  const interrupt = () => { void stop('SIGINT'); };
  const terminate = () => { void stop('SIGTERM'); };
  child.on('message', message => {
    if (message?.type === 'ready') { ready = true; resolveReady(); }
    if (message?.type === 'interrupt') interrupt();
    if (message?.type === 'error') rejectReady(new Error(message.message));
  });
  lifecycle.on('exit', parentExit);
  lifecycle.on('SIGINT', interrupt);
  lifecycle.on('SIGTERM', terminate);
  // Состояние не стоит за подробным логом в очереди IPC. Экран читает его
  // своим таймером, даже если основной процесс сразу входит в spawnSync.
  const refresh = () => {
    if (!closing && !ended) writeFileSync(snapshotPath, JSON.stringify(snapshot()));
  };
  const timer = setInterval(refresh, 1000);
  timer.unref();
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(timer);
    lifecycle.off('exit', parentExit);
    lifecycle.off('SIGINT', interrupt);
    lifecycle.off('SIGTERM', terminate);
    closePromise = (async () => {
      if (ended) return;
      send({ type: 'close' });
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
      if (!ended) { child.kill(); restore(); }
    })();
    return closePromise;
  }
  let startupTimeout;
  try {
    send({ type: 'init', snapshotPath });
    await Promise.race([startup, new Promise((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error('Экран Ralph не запустился за 10 секунд.')), 10000);
    })]);
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startupTimeout);
  }
  const log = (type, level, text) => {
    if (ended) {
      if (type === 'log') output.write(`${text}\n`);
      return;
    }
    if (closing) return;
    refresh();
    // Лог на диске уже записан. Ограничиваем только очередь отображения,
    // чтобы медленный терминал не удерживал произвольный объём вывода агента.
    if (type === 'detail' && pending >= 32) { omitted = true; return; }
    if (omitted) {
      omitted = false;
      send({ type: 'detail', level: 'INFO', text: 'Часть вывода пропущена экраном; см. run.log.' });
    }
    send({ type, level, text: String(text).slice(0, 200000) });
  };
  return { refresh, close, log: (level, text) => log('log', level, text), detail: (level, text) => log('detail', level, text) };
}
