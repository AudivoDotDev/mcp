import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTPUT, buildAppHtml, moduleSource } from './build-ui.js';

describe('the app build', () => {
  it('matches what is committed: run `npm run build:ui` after changing ui/', async () => {
    const built = moduleSource(await buildAppHtml());
    expect(fs.readFileSync(new URL(`../${OUTPUT}`, import.meta.url), 'utf8')).toBe(built);
  }, 60_000);

  it('is one document that loads nothing from anywhere', async () => {
    const html = await buildAppHtml();
    expect(html).toMatch(/^<!doctype html>/);
    // No external script, stylesheet, image or frame: the app declares no domains.
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    expect(html.match(/<script/g)).toHaveLength(1);
  }, 60_000);
});
