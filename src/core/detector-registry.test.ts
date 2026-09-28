/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { createRequest } from './parser-shared';
import {
  DETECTOR_REGISTRY,
  getActiveDetectors,
  getDetectorGroupCounts,
  invalidateDetectorRegistry,
  runDetectors,
  runEmitters,
} from './detector-registry';

// "lazy-prompting" is a real built-in rule: requests under 30 chars, ratio > 0.3, count > 10.
function shortRequests(count: number) {
  return Array.from({ length: count }, (_, i) => createRequest({
    requestId: `short-${i}`,
    timestamp: i,
    messageText: 'fix bug',
    responseText: 'done',
  }));
}

describe('DETECTOR_REGISTRY', () => {
  it('lazily builds the registry from all built-in rules and exposes each as a DetectorDefinition', () => {
    expect(DETECTOR_REGISTRY.length).toBeGreaterThan(10);
    for (const detector of DETECTOR_REGISTRY) {
      expect(typeof detector.name).toBe('string');
      expect(typeof detector.run).toBe('function');
    }
    expect(DETECTOR_REGISTRY.some(d => d.rule?.id === 'lazy-prompting')).toBe(true);
  });

  it('invalidateDetectorRegistry forces the next access to rebuild rather than erroring', () => {
    const before = DETECTOR_REGISTRY.length;
    invalidateDetectorRegistry();
    expect(DETECTOR_REGISTRY.length).toBe(before);
  });
});

describe('runDetectors', () => {
  it('returns an AntiPattern for a rule whose trigger condition is met', () => {
    const reqs = shortRequests(12); // ratio=1 > 0.3, count=12 > 10
    const patterns = runDetectors(reqs, [], false);
    const lazy = patterns.find(p => p.id === 'lazy-prompting');
    expect(lazy).toBeDefined();
    expect(lazy!.occurrences).toBe(12);
    expect(lazy!.severity).toMatch(/^(high|medium|low)$/);
    expect(lazy!.description).toContain('12');
    expect(lazy!.examples.length).toBeGreaterThan(0);
  });

  it('does not emit an AntiPattern for a rule whose trigger condition is not met', () => {
    const reqs = shortRequests(3); // count=3, below minSample=10
    const patterns = runDetectors(reqs, [], false);
    expect(patterns.some(p => p.id === 'lazy-prompting')).toBe(false);
  });

  it('returns no anti-patterns at all for empty input', () => {
    expect(runDetectors([], [], false)).toEqual([]);
  });
});

describe('getActiveDetectors', () => {
  it('excludes IDE-context-requiring detectors when skipIdeDetectors is true', () => {
    const all = getActiveDetectors(false);
    const filtered = getActiveDetectors(true);
    expect(all.some(d => d.requiresIdeContext)).toBe(true);
    expect(filtered.every(d => !d.requiresIdeContext)).toBe(true);
    expect(filtered.length).toBeLessThan(all.length);
  });
});

describe('getDetectorGroupCounts', () => {
  it('sums to the total number of active detectors across all five practice groups', () => {
    const counts = getDetectorGroupCounts(false);
    const groups = ['prompt-quality', 'session-hygiene', 'code-review', 'tool-mastery', 'context-management'] as const;
    expect(Object.keys(counts).sort()).toEqual([...groups].sort());
    const sum = groups.reduce((s, g) => s + counts[g], 0);
    expect(sum).toBe(getActiveDetectors(false).length);
  });
});

describe('runEmitters', () => {
  it('returns an emission for every rule, keyed by rule id, regardless of whether it triggers', () => {
    const reqs = shortRequests(12);
    const emissions = runEmitters(reqs, [], false);
    expect(emissions.size).toBe(DETECTOR_REGISTRY.length);
    const lazy = emissions.get('lazy-prompting');
    expect(lazy).toBeDefined();
    expect(lazy!.count).toBe(12);
    expect(lazy!.total).toBe(12);
  });

  it('skips IDE-context-requiring rules when skipIdeDetectors is true', () => {
    const emissions = runEmitters([], [], true);
    const ideRuleIds = DETECTOR_REGISTRY.filter(d => d.requiresIdeContext).map(d => d.rule!.id);
    for (const id of ideRuleIds) expect(emissions.has(id)).toBe(false);
  });
});
