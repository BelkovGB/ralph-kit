import { mkdtempSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Git writes the patch directly to disk. Never buffer an unbounded patch on stdout.
// Four UTF-8 bytes per character cover the bounded prefix, including Unicode text.
export function boundedGitPatch(execute, args, characterBudget, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-review-diff-'));
  const output = path.join(directory, 'patch.diff');
  try {
    const result = execute('git', [args[0], `--output=${output}`, ...args.slice(1)], options);
    if (result.status !== 0) return result;
    const fd = openSync(output, 'r');
    try {
      const buffer = Buffer.alloc((characterBudget + 1) * 4);
      let used = 0;
      while (used < buffer.length) {
        const count = readSync(fd, buffer, used, buffer.length - used, null);
        if (!count) break;
        used += count;
      }
      return {...result, stdout: buffer.subarray(0, used).toString('utf8').slice(0, characterBudget + 1)};
    } finally { closeSync(fd); }
  } finally { rmSync(directory, {recursive: true, force: true}); }
}
