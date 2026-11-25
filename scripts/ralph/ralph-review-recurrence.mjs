import { createHash } from 'node:crypto';
import { repoPath } from './ralph-validation-changes.mjs';

const normalizedText = value => typeof value === 'string'
  ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';

// The caller passes the severity-filtered review. Identify the reported defect
// across line moves, preserving differences in diagnoses and code expressions.
export function reviewFindingKeys(review) {
  if (review?.verdict !== 'fail' || !Array.isArray(review.findings) || review.findings.length > 50) return [];
  const locations = new Map();
  for (const finding of review.findings) {
    if (!finding || !/^P[0-3]$/u.test(finding.severity) || !Number.isSafeInteger(finding.line) ||
        finding.line < 0 || typeof finding.file !== 'string') continue;
    const file = finding.file.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
    const title = normalizedText(finding.title);
    const body = normalizedText(finding.body);
    if (!repoPath(file) || !title || !body) continue;
    const key = createHash('sha256').update(JSON.stringify([file, finding.severity, title, body])).digest('hex');
    // Identical wording on multiple lines of one file provides no unique target.
    if (!locations.has(key)) locations.set(key, finding.line);
    else if (locations.get(key) !== finding.line) locations.set(key, null);
  }
  return [...locations].filter(([, line]) => line !== null).map(([key]) => key).sort();
}
