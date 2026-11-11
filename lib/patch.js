/**
 * Minimal unified-hunk application for remote files.
 *
 * The local backend applies hunks through its own patch machinery. Remote
 * writes cannot reuse that instance directly (it is bound to the host
 * filesystem), so this module implements the same observable contract for the
 * routed backend: apply ordered hunks to LF-normalized text, report
 * `FS_PATCH_MISMATCH` when a hunk's context or removed lines do not match.
 *
 * @module dsh-fs-route/patch
 */
import { FsError } from '@deepseek-ai/dsh-fs';

/**
 * Normalize text to LF so hunk offsets are stable across platforms.
 * @param {string} text - raw text.
 * @returns {string} LF-normalized text.
 */
function toLf(text) {
  return text.replaceAll('\r\n', '\n');
}

/**
 * Apply ordered hunks to text.
 *
 * A hunk's `lines` carry a leading marker: `' '` context, `'-'` removal,
 * `'+'` addition, `'\\'` the no-newline sentinel. Hunks are matched against the
 * current text in order, searching forward from the previous hunk's end so an
 * earlier hunk's line-count change cannot shift a later one.
 * @param {string} text - the file's current text.
 * @param {readonly object[]} hunks - ordered hunks from the patch parser.
 * @returns {string} the patched text.
 * @throws {FsError} `FS_PATCH_MISMATCH` when a hunk does not apply.
 */
export function applyPatch(text, hunks) {
  const source = toLf(text).split('\n');
  const out = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const lines = hunk.lines ?? [];
    const context = [];
    const removed = [];
    const added = [];
    for (const raw of lines) {
      const marker = raw.slice(0, 1);
      const body = raw.slice(1);
      if (marker === ' ') {
        context.push(body);
        removed.push(body);
      } else if (marker === '-') {
        removed.push(body);
      } else if (marker === '+') {
        added.push(body);
      }
      // '\\' (no newline at end of file) carries no line content.
    }

    const at = findSequence(source, removed.length > 0 ? removed : context, cursor);
    if (at < 0) throw new FsError('Patch hunk does not match the file contents', 'FS_PATCH_MISMATCH');

    // Copy everything before the hunk, then emit the hunk's result.
    while (cursor < at) out.push(source[cursor++]);
    for (const line of context) out.push(line);
    // Replace the non-context removals with the additions in order.
    let removedSeen = 0;
    for (const line of removed) {
      if (context.includes(line)) continue;
      removedSeen++;
      void line;
    }
    for (const line of added) out.push(line);
    cursor = at + removed.length;
    void removedSeen;
  }
  while (cursor < source.length) out.push(source[cursor++]);
  return out.join('\n');
}

/**
 * Find the first occurrence of a line sequence at or after `from`.
 * @param {string[]} source - the file's lines.
 * @param {string[]} needle - lines to find; an empty needle matches at `from`.
 * @param {number} from - first index to consider.
 * @returns {number} the index, or -1 when absent.
 */
function findSequence(source, needle, from) {
  if (needle.length === 0) return Math.min(from, source.length);
  for (let at = from; at + needle.length <= source.length; at++) {
    let ok = true;
    for (let i = 0; i < needle.length; i++) {
      if (source[at + i] !== needle[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return at;
  }
  return -1;
}
