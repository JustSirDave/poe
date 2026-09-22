/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Regression test: el(tag, cls, content) used to treat a plain string `content` as raw,
 * unescaped HTML (via rawHtml(content)) instead of escaped text like every other helper in
 * this module. A caller passing session/workspace-derived text (e.g. el('span', 'x', name))
 * would have been an XSS vector the moment that text contained HTML. el() must now escape a
 * plain string the same way the `html` tagged template does; rawHtml() remains the explicit
 * opt-in for genuine raw markup.
 */

import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => { /* noop */ },
  });
});

describe('el', () => {
  it('escapes a plain string content argument instead of treating it as raw HTML', async () => {
    const { el } = await import('./shared');
    const node = el('div', undefined, '<img src=x onerror=alert(1)>');
    expect(node.innerHTML).not.toContain('<img');
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('still renders literal text content unchanged when it has no special characters', async () => {
    const { el } = await import('./shared');
    const node = el('span', 'label', 'Monday');
    expect(node.textContent).toBe('Monday');
  });

  it('still allows genuine raw markup via an explicit rawHtml() wrapper', async () => {
    const { el, rawHtml } = await import('./shared');
    const node = el('div', undefined, rawHtml('<strong>bold</strong>'));
    expect(node.querySelector('strong')?.textContent).toBe('bold');
  });
});
