// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { el, highlight } from './dom.js';

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

describe('putting text on the page', () => {
  it('renders markup in a title as the characters it is', () => {
    const node = el('h1', {}, HOSTILE);
    expect(node.textContent).toBe(HOSTILE);
    expect(node.querySelector('img, script')).toBeNull();
  });

  it('highlights a match with marks built from text, whatever the line or the query holds', () => {
    const fragment = highlight(`before ${HOSTILE} after`, '<script>');
    const holder = el('p', {}, fragment);
    expect(holder.querySelector('img, script')).toBeNull();
    expect([...holder.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      '<script>',
    ]);
    expect(holder.textContent).toBe(`before ${HOSTILE} after`);
  });

  it('marks every occurrence, ignoring case, and leaves a blank query alone', () => {
    const holder = el('p', {}, highlight('Credits, credits, CREDITS.', 'credits'));
    expect(holder.querySelectorAll('mark')).toHaveLength(3);
    expect(el('p', {}, highlight('nothing', '  ')).querySelectorAll('mark')).toHaveLength(0);
  });

  it('is the only way the app writes to the page: no source parses markup', () => {
    // A publisher's text arrives unfenced (ADR-0036); one innerHTML would undo all of the above.
    // Resolved from the suite's root: under happy-dom, import.meta.url is not a file URL.
    const dir = path.join(process.cwd(), 'ui');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/,
      );
    }
  });
});
