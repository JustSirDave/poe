/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fillTemplate, parseRule, serializeRule } from './rule-parser';

const VALID_RULE = `---
id: lazy-prompting
name: Lazy Prompting
group: prompt-quality
severity: medium
scope: requests
requiresIdeContext: false
version: 2
tags: [prompt, quality, short]
thresholds:
  minChars: 30
  maxRatio: 0.3
  minSample: 10
patterns:
  frustration: ["angry", "frustrated"]
fileTypes:
  documentation: [md, txt]
---

# Description
Detects requests with very short prompts that lack sufficient context.

# When Triggered
{{count}} requests ({{pct}}) are under {{extra.minChars}} characters.

# How to Improve
Provide more context in your prompts.

# Examples
"{{message}}" ({{extra.charCount}} chars)

# Detection Logic
\`\`\`detect
filter: messageLength < thresholds.minChars AND messageLength > 0
check: ratio > thresholds.maxRatio AND count > thresholds.minSample
\`\`\`

# Tests
\`\`\`test
{messageLength: 5} -> triggered
{messageLength: 500} -> clean
\`\`\`
`;

describe('parseRule', () => {
  it('parses frontmatter, sections, thresholds, patterns, fileTypes, and detection logic', () => {
    const rule = parseRule(VALID_RULE);
    expect(rule).not.toBeNull();
    expect(rule).toMatchObject({
      id: 'lazy-prompting',
      name: 'Lazy Prompting',
      group: 'prompt-quality',
      severity: 'medium',
      scope: 'requests',
      requiresIdeContext: false,
      version: 2,
      tags: ['prompt', 'quality', 'short'],
      thresholds: { minChars: 30, maxRatio: 0.3, minSample: 10 },
      fileTypes: { documentation: ['md', 'txt'] },
    });
    expect(rule!.patterns.frustration).toEqual(['angry', 'frustrated']);
    expect(rule!.description).toContain('very short prompts');
    expect(rule!.descriptionTemplate).toContain('{{count}}');
    expect(rule!.suggestionTemplate).toContain('Provide more context');
    expect(rule!.exampleTemplate).toContain('{{message}}');
  });

  it('parses filter/check conditions from the detect block', () => {
    const rule = parseRule(VALID_RULE)!;
    expect(rule.conditions).toHaveLength(2);
    expect(rule.conditions[0]).toMatchObject({ type: 'filter-requests', logic: 'and' });
    expect(rule.conditions[1]).toMatchObject({ type: 'filter-requests', logic: 'and' });
  });

  it('parses inline test fixtures', () => {
    const rule = parseRule(VALID_RULE)!;
    expect(rule.tests).toEqual([
      { input: { messageLength: 5 }, expect: 'triggered' },
      { input: { messageLength: 500 }, expect: 'clean' },
    ]);
  });

  it('returns null when the frontmatter block is missing', () => {
    expect(parseRule('# Just a heading\nNo frontmatter here.')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const missingSeverity = VALID_RULE.replace('severity: medium\n', '');
    expect(parseRule(missingSeverity)).toBeNull();
  });

  it('returns null for an unknown practice group', () => {
    expect(parseRule(VALID_RULE.replace('group: prompt-quality', 'group: not-a-real-group'))).toBeNull();
  });

  it('returns null for an unknown severity', () => {
    expect(parseRule(VALID_RULE.replace('severity: medium', 'severity: extreme'))).toBeNull();
  });

  it('defaults scope to "requests" when omitted', () => {
    const noScope = VALID_RULE.replace('scope: requests\n', '');
    expect(parseRule(noScope)!.scope).toBe('requests');
  });

  it('falls back to default templates when sections are absent', () => {
    const minimal = `---
id: minimal-rule
name: Minimal Rule
group: prompt-quality
severity: low
---
`;
    const rule = parseRule(minimal)!;
    expect(rule.description).toBe('Detects minimal rule patterns.');
    expect(rule.descriptionTemplate).toBe('{{count}} occurrences detected.');
    expect(rule.suggestionTemplate).toBe('Review your practices.');
    expect(rule.exampleTemplate).toBe('');
    expect(rule.conditions).toEqual([]);
    expect(rule.tests).toEqual([]);
  });
});

describe('serializeRule', () => {
  it('round-trips a parsed rule through serialize -> parse', () => {
    const original = parseRule(VALID_RULE)!;
    const reparsed = parseRule(serializeRule(original))!;
    expect(reparsed).toMatchObject({
      id: original.id,
      name: original.name,
      group: original.group,
      severity: original.severity,
      scope: original.scope,
      thresholds: original.thresholds,
      version: original.version,
      tags: original.tags,
    });
    expect(reparsed.conditions.length).toBe(original.conditions.length);
  });
});

describe('fillTemplate', () => {
  it('substitutes top-level and nested extra.* variables', () => {
    expect(fillTemplate('{{count}} of {{total}} ({{pct}})', { count: 3, total: 10, pct: '30%' }))
      .toBe('3 of 10 (30%)');
    expect(fillTemplate('{{extra.minChars}} chars', { extra: { minChars: 30 } })).toBe('30 chars');
  });

  it('formats non-integer numbers to one decimal place', () => {
    expect(fillTemplate('{{ratio}}', { ratio: 0.3333 })).toBe('0.3');
  });

  it('renders missing or null values as an empty string', () => {
    expect(fillTemplate('[{{missing}}]', {})).toBe('[]');
    expect(fillTemplate('[{{extra.missing}}]', { extra: {} })).toBe('[]');
    expect(fillTemplate('[{{value}}]', { value: null })).toBe('[]');
  });

  it('joins array values with a comma', () => {
    expect(fillTemplate('{{tags}}', { tags: ['a', 'b'] })).toBe('a, b');
  });

  it('renders booleans as their string form', () => {
    expect(fillTemplate('{{flag}}', { flag: true })).toBe('true');
  });
});
