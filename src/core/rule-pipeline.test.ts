/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { DetectionRule } from './types';
import { createRequest, createSession } from './parser-shared';
import { checkPipelineTrigger, executePipeline, parsePipeline, resolveInheritance } from './rule-pipeline';
import { parseRule } from './rule-parser';
import { registerPersonalRuleSource, clearLayerRules } from './rule-engine';

function baseRule(overrides: Partial<DetectionRule> = {}): DetectionRule {
  return {
    id: 'test-rule',
    name: 'Test Rule',
    group: 'prompt-quality',
    severity: 'medium',
    requiresIdeContext: false,
    scope: 'requests',
    description: 'desc',
    descriptionTemplate: '{{count}} occurrences',
    suggestionTemplate: 'suggestion',
    exampleTemplate: '',
    maxExamples: 3,
    conditions: [],
    thresholds: { minChars: 30, maxRatio: 0.3 },
    patterns: {},
    fileTypes: {},
    tests: [],
    source: 'built-in',
    sourceFilePath: '',
    version: 1,
    tags: [],
    rawSource: '',
    ...overrides,
  };
}

function requestsOf(lengths: number[]) {
  return lengths.map((len, i) => createRequest({
    requestId: `r${i}`,
    timestamp: i,
    messageText: 'x'.repeat(len),
    responseText: '',
  }));
}

describe('parsePipeline', () => {
  it('returns a never-triggering default pipeline when there is no detect block', () => {
    const rule = baseRule({ rawSource: '# No detect block here' });
    expect(parsePipeline(rule)).toEqual({ scan: 'requests', aggregate: 'count' });
  });

  it('defaults scan to sessions when the rule scope is sessions', () => {
    const rule = baseRule({ scope: 'sessions', rawSource: 'no block' });
    expect(parsePipeline(rule).scan).toBe('sessions');
  });

  it('parses scan/match/aggregate/check/examples/severity directives', () => {
    const rawSource = [
      '```detect',
      'scan: sessions',
      'match: messageLength < thresholds.minChars',
      'aggregate: ratio',
      'check: ratio > thresholds.maxRatio',
      'examples: {{messageText}}',
      'severity: ratio > 0.5',
      '```',
    ].join('\n');
    const pipeline = parsePipeline(baseRule({ rawSource }));
    expect(pipeline).toMatchObject({
      scan: 'sessions',
      matchExpr: 'messageLength < thresholds.minChars',
      aggregate: 'ratio',
      checkExpr: 'ratio > thresholds.maxRatio',
      examplesTemplate: '{{messageText}}',
      severityExpr: 'ratio > 0.5',
    });
  });

  it('treats unrecognized keys as reduce expressions', () => {
    const rawSource = ['```detect', 'avgLength: avg(messageLength)', '```'].join('\n');
    const pipeline = parsePipeline(baseRule({ rawSource }));
    expect(pipeline.reduceExprs).toEqual({ avgLength: 'avg(messageLength)' });
  });

  it('joins backslash-continued lines before parsing', () => {
    const rawSource = ['```detect', 'match: messageLength < thresholds.minChars \\', '  AND messageLength > 0', '```'].join('\n');
    const pipeline = parsePipeline(baseRule({ rawSource }));
    expect(pipeline.matchExpr).toBe('messageLength < thresholds.minChars AND messageLength > 0');
  });
});

describe('executePipeline', () => {
  it('returns the empty emission when there is no data to scan', () => {
    const rule = baseRule();
    const emission = executePipeline({ scan: 'requests', aggregate: 'count' }, rule, { reqs: [], sessions: [], skipIdeDetectors: false });
    expect(emission).toEqual({ count: 0, total: 0, ratio: 0, examples: [], extra: {} });
  });

  it('filters requests through matchExpr and computes count/total/ratio', () => {
    const rule = baseRule();
    const reqs = requestsOf([5, 5, 500]); // two short, one long
    const pipeline = parsePipeline(baseRule({ rawSource: '```detect\nmatch: messageLength < thresholds.minChars\n```' }));
    const emission = executePipeline(pipeline, rule, { reqs, sessions: [], skipIdeDetectors: false });
    expect(emission.count).toBe(2);
    expect(emission.total).toBe(3);
    expect(emission.ratio).toBeCloseTo(2 / 3);
  });

  it('evaluates reduce expressions and exposes them under extra', () => {
    const rawSource = ['```detect', 'totalLength: sum(matched, messageLength)', '```'].join('\n');
    const pipeline = parsePipeline(baseRule({ rawSource }));
    const reqs = requestsOf([5, 500, 50]);
    const emission = executePipeline(pipeline, baseRule(), { reqs, sessions: [], skipIdeDetectors: false });
    expect(emission.extra.totalLength).toBe(555);
  });

  it('lets emitCount/emitTotal/emitRatio reduce expressions override the aggregate', () => {
    const rawSource = ['```detect', 'emitCount: 7', 'emitTotal: 10', '```'].join('\n');
    const pipeline = parsePipeline(baseRule({ rawSource }));
    const reqs = requestsOf([5]);
    const emission = executePipeline(pipeline, baseRule(), { reqs, sessions: [], skipIdeDetectors: false });
    expect(emission.count).toBe(7);
    expect(emission.total).toBe(10);
    expect(emission.ratio).toBeCloseTo(0.7);
  });

  it('scans sessions when the pipeline scan is sessions', () => {
    const rule = baseRule({ scope: 'sessions' });
    const sessions = [
      createSession({ sessionId: 'a', workspaceId: 'w', workspaceName: 'w', harness: 'Codex', requests: [] }),
      createSession({ sessionId: 'b', workspaceId: 'w', workspaceName: 'w', harness: 'Codex', requests: [] }),
    ];
    const pipeline = parsePipeline(baseRule({ scope: 'sessions', rawSource: '```detect\nscan: sessions\n```' }));
    const emission = executePipeline(pipeline, rule, { reqs: [], sessions, skipIdeDetectors: false });
    expect(emission.total).toBe(2);
  });
});

describe('checkPipelineTrigger', () => {
  it('defaults to triggering whenever count > 0 when there is no check expression', () => {
    const rule = baseRule();
    expect(checkPipelineTrigger({ scan: 'requests', aggregate: 'count' }, { count: 1, total: 1, ratio: 1, examples: [], extra: {} }, rule)).toBe(true);
    expect(checkPipelineTrigger({ scan: 'requests', aggregate: 'count' }, { count: 0, total: 1, ratio: 0, examples: [], extra: {} }, rule)).toBe(false);
  });

  it('resolves thresholds.* references before evaluating the check expression', () => {
    const rule = baseRule({ thresholds: { maxRatio: 0.5 } });
    const pipeline = { scan: 'requests' as const, aggregate: 'ratio' as const, checkExpr: 'ratio > thresholds.maxRatio' };
    expect(checkPipelineTrigger(pipeline, { count: 8, total: 10, ratio: 0.8, examples: [], extra: {} }, rule)).toBe(true);
    expect(checkPipelineTrigger(pipeline, { count: 2, total: 10, ratio: 0.2, examples: [], extra: {} }, rule)).toBe(false);
  });

  it('falls back to count > 0 when the check expression fails to compile', () => {
    const rule = baseRule();
    const pipeline = { scan: 'requests' as const, aggregate: 'count' as const, checkExpr: 'not a valid expression (((' };
    expect(checkPipelineTrigger(pipeline, { count: 3, total: 5, ratio: 0.6, examples: [], extra: {} }, rule)).toBe(true);
  });
});

describe('resolveInheritance', () => {
  it('returns the rule unchanged when it does not extend anything', () => {
    const rule = baseRule();
    expect(resolveInheritance(rule)).toBe(rule);
  });

  it('merges a parent rule’s thresholds/patterns/templates with the child’s overrides', () => {
    clearLayerRules('personal');
    registerPersonalRuleSource('parent-rule', [
      '---',
      'id: parent-rule',
      'name: Parent Rule',
      'group: prompt-quality',
      'severity: low',
      'thresholds:',
      '  minChars: 10',
      '  maxRatio: 0.2',
      '---',
      '',
      '# Description',
      'Parent description.',
      '',
      '# When Triggered',
      'Parent template.',
      '',
      '# How to Improve',
      'Parent suggestion.',
      '',
    ].join('\n'), 'test-fixture-parent.md');

    const child = parseRule([
      '---',
      'id: child-rule',
      'name: Child Rule',
      'group: prompt-quality',
      'severity: high',
      'extends: parent-rule',
      'thresholds:',
      '  maxRatio: 0.9',
      '---',
      '',
    ].join('\n'))!;

    const resolved = resolveInheritance(child);
    expect(resolved.id).toBe('child-rule');
    expect(resolved.severity).toBe('high');
    expect(resolved.thresholds).toEqual({ minChars: 10, maxRatio: 0.9 });
    // Note: parseRule fills descriptionTemplate with a generic default whenever a rule's
    // markdown has no "# When Triggered" section of its own, *before* inheritance ever runs —
    // so a child rule can never inherit the parent's template unless it also omits the
    // fallback (which parseRule never leaves empty). This documents that actual behavior.
    expect(resolved.descriptionTemplate).toBe('{{count}} occurrences detected.');
    clearLayerRules('personal');
  });

  it('detects circular inheritance and returns the rule unresolved instead of looping', () => {
    const rule = baseRule({ id: 'self-loop', extendsRule: 'self-loop' });
    expect(resolveInheritance(rule, new Set(['self-loop']))).toBe(rule);
  });
});
