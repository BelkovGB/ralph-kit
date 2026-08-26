import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { configPath, prepareConfig } from './ralph-config.mjs';
import { describeOutcome, readRunState, readTaskSpend } from './ralph-gui-data.mjs';
import { fieldGroups } from './ralph-gui-fields.mjs';
import { renderPage } from './ralph-gui-page.mjs';

/**
 * Пульт Ralph: локальный HTTP-сервер, который показывает состояние прогона,
 * расходы по задачам и даёт править `.agents/ralph.config.json`.
 *
 * Сервер только читает `.git/ralph-loop`: единственный файл, который он пишет —
 * конфиг и его резервная копия. Запись в каталог прогона означала бы, что пульт
 * вмешивается в идущую итерацию, а он для этого не предназначен.
 */

// -----------------------------------------------------------------------------
// Адрес и разовый ключ
// -----------------------------------------------------------------------------

const firstPort = 4599;
const lastPort = 4698;
const maxBodyBytes = 1024 * 1024;

// Ключ новый на каждый запуск: старая вкладка после перезапуска пульта теряет
// доступ, и ключ не переживает процесс ни в каком файле.
const token = randomBytes(16).toString('hex');

function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(token, 'utf8'));
}

// -----------------------------------------------------------------------------
// Ответы
// -----------------------------------------------------------------------------

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('Тело запроса больше допустимого размера.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
// Защита: только петлевой адрес, свой Origin и разовый ключ
// -----------------------------------------------------------------------------

const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  // Порт отбрасывается, IPv6-скобки здесь появиться не могут: сервер слушает
  // только 127.0.0.1.
  const hostname = hostHeader.split(':')[0];
  return loopbackHosts.has(hostname);
}

function originAllowed(originHeader, port) {
  if (originHeader === undefined) return true;
  return [...loopbackHosts].some((host) => originHeader === `http://${host}:${port}`);
}

// -----------------------------------------------------------------------------
// Конфиг: чтение, неизвестные ключи, сохранение
// -----------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Пути полей из описаний. Собираются обходом всей структуры, а не по её
 * известной форме: описания полей пишутся отдельно от сервера, и лишний уровень
 * группировки в них не должен превращать все настройки в «неизвестные ключи».
 */
function describedPaths(source, collected = new Set()) {
  if (Array.isArray(source)) {
    for (const item of source) describedPaths(item, collected);
    return collected;
  }
  if (!isPlainObject(source)) return collected;
  for (const [key, value] of Object.entries(source)) {
    if ((key === 'key' || key === 'path') && typeof value === 'string' && value !== '') {
      collected.add(value);
    } else {
      describedPaths(value, collected);
    }
  }
  return collected;
}

function collectUnknownKeys(config, paths, prefix = '', unknown = []) {
  if (!isPlainObject(config)) return unknown;
  for (const [key, value] of Object.entries(config)) {
    const currentPath = prefix === '' ? key : `${prefix}.${key}`;
    if (paths.has(currentPath)) continue;
    const isContainer = [...paths].some((described) => described.startsWith(`${currentPath}.`));
    if (isContainer && isPlainObject(value)) {
      collectUnknownKeys(value, paths, currentPath, unknown);
      continue;
    }
    unknown.push(currentPath);
  }
  return unknown;
}

/**
 * Ключи, которых нет в описаниях полей, страница может не прислать обратно.
 * База — то, что лежит на диске: черновик перекрывает её значения, но ничего не
 * стирает, поэтому ручная правка файла не пропадает после сохранения из пульта.
 */
function mergePreservingUnknown(draft, stored) {
  if (!isPlainObject(draft) || !isPlainObject(stored)) return draft;
  const result = { ...draft };
  for (const [key, value] of Object.entries(stored)) {
    result[key] = key in result ? mergePreservingUnknown(result[key], value) : value;
  }
  return result;
}

function readConfigText() {
  return readFileSync(configPath, 'utf8');
}

/**
 * Запись через временный файл рядом: прерванный процесс оставляет прошлый
 * конфиг целым, а не его половину, которую следующий прогон не разберёт.
 */
function writeConfigAtomic(config) {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, configPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Маршруты
// -----------------------------------------------------------------------------

function handleState(response) {
  const state = readRunState();
  sendJson(response, 200, {
    running: Boolean(state.running),
    run: state.run ?? null,
    staleLock: Boolean(state.staleLock),
  });
}

function handleTasks(response) {
  const spend = readTaskSpend();
  const tasks = [...(spend.tasks ?? [])]
    .map((task) => ({
      ...task,
      lastReason: task.lastReason ?? describeOutcome(task.lastOutcome),
      runs: (task.runs ?? []).map((run) => ({
        ...run,
        reason: run.reason ?? describeOutcome(run.outcome),
      })),
    }))
    .sort((first, second) => (second.costUsd ?? 0) - (first.costUsd ?? 0));

  sendJson(response, 200, { totals: spend.totals, period: spend.period, tasks });
}

function handleConfigRead(response) {
  const text = readConfigText();
  const config = JSON.parse(text);
  const state = readRunState();
  sendJson(response, 200, {
    config,
    fields: fieldGroups,
    unknownKeys: collectUnknownKeys(config, describedPaths(fieldGroups)),
    locked: state.locked ?? Boolean(state.running),
    lockReason: state.lockReason ?? null,
    hash: hashOf(text),
  });
}

async function handleConfigWrite(request, response) {
  // Отказ первый: прогон идёт. Файл читается в начале каждой итерации, и правка
  // под ногами обрывает текущую задачу, поэтому запись не выполняется вовсе.
  const stateBefore = readRunState();
  if (stateBefore.running) {
    sendJson(response, 409, {
      error:
        'Прогон Ralph идёт прямо сейчас. Правка файла настроек во время прогона обрывает ' +
        'текущую задачу, поэтому изменения не сохранены. Дождитесь конца прогона или ' +
        'остановите его.',
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, { error: 'Тело запроса — не корректный JSON.' });
    return;
  }
  if (!isPlainObject(body) || !isPlainObject(body.config)) {
    sendJson(response, 400, { error: 'В теле запроса нет объекта config.' });
    return;
  }

  const storedText = readConfigText();
  const draft = mergePreservingUnknown(structuredClone(body.config), JSON.parse(storedText));

  // Отказ второй: черновик не проходит проверки Ralph. Текст ошибки отдаётся
  // как есть — своя формулировка разошлась бы с тем, что скажет сам прогон.
  try {
    prepareConfig(structuredClone(draft));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  // Отказ третий: файл изменился после того, как страница его прочитала. Это
  // видно при работе с двух устройств или после ручной правки файла. Отпечаток
  // необязателен: контракт запроса — `{ config }`, и клиент, приславший запрос
  // без отпечатка, просто остаётся без этой проверки.
  if (typeof body.hash === 'string' && body.hash !== hashOf(storedText)) {
    sendJson(response, 409, {
      error:
        'Файл настроек изменился после того, как страница его прочитала. ' +
        'Перечитайте страницу и внесите правки заново, иначе чужие изменения пропадут.',
    });
    return;
  }

  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`);
  writeConfigAtomic(draft);

  // Блокировка перечитывается после записи: прогон мог стартовать в те доли
  // секунды, что заняли проверки, и тогда он уже прочитал старый конфиг.
  const stateAfter = readRunState();
  if (stateAfter.running) {
    sendJson(response, 200, {
      ok: true,
      warning:
        'Настройки сохранены, но прогон Ralph успел начаться. Проверьте его: текущая ' +
        'итерация работает по прежним настройкам.',
    });
    return;
  }
  sendJson(response, 200, { ok: true });
}

// -----------------------------------------------------------------------------
// Сервер
// -----------------------------------------------------------------------------

function createGuiServer(getPort) {
  return createServer(async (request, response) => {
    try {
      const port = getPort();
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const isApi = url.pathname.startsWith('/api/');

      if (!hostAllowed(request.headers.host) || !originAllowed(request.headers.origin, port)) {
        sendText(response, 403, 'Запрос отклонён: пульт отвечает только своей странице.');
        return;
      }

      const presented = isApi ? request.headers['x-ralph-token'] : url.searchParams.get('t');
      if (!tokenMatches(presented)) {
        sendText(response, 403, 'Запрос отклонён: неверный ключ. Откройте адрес из терминала.');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response, renderPage({ token }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        handleState(response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        handleTasks(response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        handleConfigRead(response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        await handleConfigWrite(request, response);
        return;
      }

      if (isApi) sendJson(response, 404, { error: 'Нет такого маршрута.' });
      else sendText(response, 404, 'Нет такой страницы.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) response.end();
      else sendJson(response, 500, { error: message });
    }
  });
}

/**
 * Порт берётся первый свободный из диапазона: занятый порт — обычное дело,
 * когда рядом работает второй пульт или прошлый процесс ещё не отпустил сокет.
 */
function listenOnFreePort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('error', onError);
      if (error.code === 'EADDRINUSE' && port < lastPort) {
        resolve(listenOnFreePort(server, port + 1));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

// Не открылся браузер — это не отказ: адрес уже напечатан, его можно открыть
// руками.
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Сообщать не о чем: адрес выше.
  }
}

async function main() {
  let port = firstPort;
  const server = createGuiServer(() => port);
  port = await listenOnFreePort(server, firstPort);

  const address = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`Пульт Ralph: ${address}`);
  console.log('Ключ разовый и действует до остановки сервера. Ctrl+C — остановить.');
  openBrowser(address);

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    console.log('\nОстанавливаю пульт.');
    server.close(() => process.exit(0));
    // Открытая вкладка держит keep-alive соединение, из-за которого close ждёт
    // бесконечно.
    server.closeAllConnections?.();
  });
}

main().catch((error) => {
  console.error(`Пульт не запустился: ${error.message}`);
  process.exitCode = 1;
});
