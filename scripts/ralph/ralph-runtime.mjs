import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { format } from 'node:util';

function waitSync(milliseconds) {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function isTransientFailure(error) {
  const text = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (
    error?.code === 'RALPH_COMMAND_TIMEOUT' ||
    ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH'].includes(error?.code)
  ) {
    return true;
  }
  return /(?:\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|timed?\s*out|connection reset|could not resolve host|temporary failure|tls handshake|secondary rate limit|\beof\b|remote end hung up)/i.test(
    text,
  );
}

function retryTransientOperation(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const wait = options.wait ?? waitSync;
  const transient = options.isTransient ?? isTransientFailure;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === attempts) throw error;
      const delay = retryDelayMs(baseDelayMs, attempt);
      options.onRetry?.(error, attempt, delay);
      wait(delay);
    }
  }
  throw lastError;
}

export function retryDelayMs(baseDelayMs, attempt) {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireRunLock(lockPath, metadata = {}, dependencies = {}) {
  const alive = dependencies.isProcessAlive ?? isProcessAlive;
  const token = dependencies.token ?? randomUUID();
  const record = {
    ...metadata,
    pid: dependencies.pid ?? process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let createdByCurrentProcess = false;
    try {
      descriptor = openSync(lockPath, 'wx');
      createdByCurrentProcess = true;
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (createdByCurrentProcess) {
        removeFileIfExists(lockPath);
      }
      if (error.code !== 'EEXIST') throw error;

      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        throw new Error(
          `Lock Ralph повреждён или ещё создаётся: ${lockPath}. Проверьте активные процессы и удалите файл вручную только если Ralph не запущен.`,
        );
      }
      if (alive(existing.pid)) {
        throw new Error(
          `Ralph Loop уже запущен (PID ${existing.pid}, с ${existing.startedAt ?? 'неизвестно'}).`,
          { cause: error },
        );
      }
      unlinkSync(lockPath);
    }
  }

  if (!existsSync(lockPath)) {
    throw new Error(`Не удалось создать lock Ralph: ${lockPath}`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.token === token) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

// Сколько прошлых прогонов остаётся рядом с текущим.
const retainedRunLogs = 5;

/**
 * `run.log` всегда содержит один прогон.
 *
 * Раньше файл дописывался бесконечно и дорос до 40 МБ за несколько дней: в него
 * идёт весь вывод агента и всех команд. Открыть такой файл после падения нельзя,
 * а он единственный след AFK-прогона. Предыдущие логи не удаляются, а
 * переименовываются по времени старта, и хранится последние `retainedRunLogs`.
 */
// Ширины хватает с запасом: номер отсчитывается заново для каждой метки
// времени, то есть считает ротации внутри одной миллисекунды.
const rotationSequenceDigits = 4;

// Номер выводится из уже лежащих рядом архивов, а не из счётчика в памяти:
// ротации одной миллисекунды могут прийти из разных процессов, и общего
// счётчика у них нет.
function nextRotationSequence(directory, namePrefix) {
  let next = 0;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(namePrefix) || !name.endsWith('.log')) continue;
    const sequence = Number.parseInt(
      name.slice(namePrefix.length, namePrefix.length + rotationSequenceDigits),
      10,
    );
    if (Number.isInteger(sequence) && sequence >= next) next = sequence + 1;
  }
  return String(next).padStart(rotationSequenceDigits, '0');
}

function rotatePersistentLog(logPath, startedAt, uniqueSuffix = randomUUID().slice(0, 8)) {
  if (!existsSync(logPath)) return;

  const directory = path.dirname(logPath);
  const prefix = `${path.basename(logPath, '.log')}-`;
  // Метка времени делает имя сортируемым и читаемым, но идентичностью не
  // является: её разрешение — миллисекунда, и две ротации внутри одной
  // миллисекунды получали одно имя, а renameSync молча затирал первый архив.
  // Суффикс делает имя уникальным по построению, а не по надежде, что часы
  // успели тикнуть.
  //
  // Одной уникальности мало. Retention ниже сортирует имена, и при совпавшей
  // метке порядок задавал случайный суффикс — то есть удалялись произвольные
  // архивы, а не самые старые: восемь ротаций с одной меткой оставляли прогоны
  // 5, 6, 3, 8 и 2. На диске Windows восемь ротаций в миллисекунду не
  // укладываются, а на tmpfs контейнера укладываются, поэтому расходились
  // только результаты валидации. Порядковый номер делает имя не просто
  // уникальным, а сортируемым по построению.
  const stamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
  const namePrefix = `${prefix}${stamp}-`;
  const sequence = nextRotationSequence(directory, namePrefix);
  renameSync(logPath, path.join(directory, `${namePrefix}${sequence}-${uniqueSuffix}.log`));

  const archived = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
    .sort();
  for (const name of archived.slice(0, -retainedRunLogs)) {
    removeFileIfExists(path.join(directory, name));
  }
}

// Ноль-байт из вывода команды ломает построчный журнал: редакторы и grep
// считают файл двоичным и перестают его показывать.
const nullCharacter = String.fromCharCode(0);

/**
 * С какой длины сообщение считается объёмным и проверяется на повтор.
 *
 * Один и тот же текст попадает в журнал несколько раз: вывод команды печатается
 * по завершении, затем он же уходит в сообщение об ошибке, затем в сводку для
 * агента, а при повторной попытке — ещё раз целиком. На упавшей validation это
 * давало мегабайты одинаковых строк, из-за которых журнал прогона нечитаем.
 * Короткие строки не проверяются: повтор «Команда git завершена» — это полезная
 * хронология, а не дубликат.
 */
const repeatedMessageThreshold = 500;

// Верхняя граница на число запомненных сообщений: журнал живёт весь AFK-прогон,
// и неограниченная таблица хэшей растёт вместе с ним.
const repeatedMessageMemory = 2_000;

function collapseRepeatedMessage(firstSeen, stamp, text) {
  if (text.length < repeatedMessageThreshold) return text;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const previous = firstSeen.get(digest);
  // Ссылка вместо текста: повтор остаётся видимым в хронологии и находится
  // поиском по тому же digest, но занимает строку вместо мегабайта.
  if (previous) return `<повтор сообщения ${digest} от ${previous}, ${text.length} символов>`;
  if (firstSeen.size >= repeatedMessageMemory) firstSeen.clear();
  firstSeen.set(digest, stamp);
  return `${text}\n<сообщение ${digest}>`;
}

// Куда писать подробности, минуя консоль. Ставится на время прогона: вне его
// (тесты, `--check`) единственный доступный вывод — консоль.
let detailAppend = null;

/**
 * Полный вывод команды: в журнал, но не в консоль.
 *
 * Контейнер валидации печатает десятки тысяч строк, и на их фоне в консоли не
 * видно, на каком шаге цикл. Оператору нужен ход прогона; разбор падения идёт
 * по `run.log`, куда вывод попадает целиком.
 */
export function logDetail(...args) {
  if (detailAppend) detailAppend('INFO', args);
  else console.log(...args);
}

export function logDetailError(...args) {
  if (detailAppend) detailAppend('ERROR', args);
  else console.error(...args);
}

function initializePersistentLog(logPath, metadata = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  rotatePersistentLog(logPath, new Date().toISOString());
  appendFileSync(
    logPath,
    `${new Date().toISOString()} INFO Ralph process started ${JSON.stringify({ pid: process.pid, ...metadata })}\n`,
    'utf8',
  );
  const original = { log: console.log, error: console.error };
  const firstSeen = new Map();
  const append = (level, args) => {
    const stamp = new Date().toISOString();
    const text = format(...args).replaceAll(nullCharacter, '');
    appendFileSync(
      logPath,
      `${stamp} ${level} ${collapseRepeatedMessage(firstSeen, stamp, text)}\n`,
      'utf8',
    );
  };
  detailAppend = append;
  console.log = (...args) => {
    original.log(...args);
    append('INFO', args);
  };
  console.error = (...args) => {
    original.error(...args);
    append('ERROR', args);
  };
  return () => {
    console.log = original.log;
    console.error = original.error;
    detailAppend = null;
  };
}

function readJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } catch (error) {
    removeFileIfExists(temporaryPath);
    throw error;
  }
}

function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function commandTimeoutError(name, args, timeoutMs, result) {
  const error = new Error(
    `Команда ${name} ${args.join(' ')} превысила wall-clock timeout ${timeoutMs} ms.`,
  );
  error.code = 'RALPH_COMMAND_TIMEOUT';
  error.timeoutMs = timeoutMs;
  error.stdout = result.stdout?.trim() ?? '';
  error.stderr = result.stderr?.trim() ?? '';
  return error;
}

function terminateProcessTreeByPid(pid, force = false) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Процесс уже завершился.
    }
  }
}

export {
  acquireRunLock,
  commandTimeoutError,
  initializePersistentLog,
  rotatePersistentLog,
  isProcessAlive,
  isTransientFailure,
  readJsonFile,
  removeFileIfExists,
  retryTransientOperation,
  terminateProcessTreeByPid,
  waitSync,
  writeJsonAtomic,
};
