import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './server';
import type { IncomingMessage } from 'node:http';

function fakeRequest(method: string, headers: Record<string, string | undefined>): IncomingMessage {
  return { method, headers } as IncomingMessage;
}

const origin = 'http://127.0.0.1:4317';

describe('isSameOriginRequest', () => {
  it('allows a GET with no Origin or Sec-Fetch-Site header when Host matches', () => {
    expect(isSameOriginRequest(fakeRequest('GET', { host: '127.0.0.1:4317' }), origin)).toBe(true);
  });

  it('allows a POST that carries a matching Origin header', () => {
    expect(isSameOriginRequest(fakeRequest('POST', { host: '127.0.0.1:4317', origin }), origin)).toBe(true);
  });

  it('allows a POST that carries only Sec-Fetch-Site: same-origin', () => {
    expect(isSameOriginRequest(fakeRequest('POST', { host: '127.0.0.1:4317', 'sec-fetch-site': 'same-origin' }), origin)).toBe(true);
  });

  it('rejects a POST with neither Origin nor Sec-Fetch-Site, even when Host matches', () => {
    expect(isSameOriginRequest(fakeRequest('POST', { host: '127.0.0.1:4317' }), origin)).toBe(false);
  });

  it('rejects a mismatched Host', () => {
    expect(isSameOriginRequest(fakeRequest('GET', { host: 'evil.example:4317' }), origin)).toBe(false);
  });

  it('rejects a mismatched Origin', () => {
    expect(isSameOriginRequest(fakeRequest('GET', { host: '127.0.0.1:4317', origin: 'http://evil.example' }), origin)).toBe(false);
  });

  it('rejects Sec-Fetch-Site: cross-site regardless of Origin', () => {
    expect(isSameOriginRequest(fakeRequest('GET', { host: '127.0.0.1:4317', origin, 'sec-fetch-site': 'cross-site' }), origin)).toBe(false);
  });
});
