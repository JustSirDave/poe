// cspell:ignore analy
import type { SessionRequest } from '../core/types';

export type ResponseIntent = 'requested-detail' | 'brevity-conflict' | 'unclassified';
export interface RequestContext { intent: ResponseIntent; requestId: string }

function requestText(value: string): string {
  const marker = '## My request:';
  const offset = value.lastIndexOf(marker);
  return (offset >= 0 ? value.slice(offset + marker.length) : value).trim().replace(/[*_`#]/g, '').replace(/\s+/g, ' ');
}

/** Narrow textual signals, not a semantic quality judgment. */
export function responseContexts(requests: SessionRequest[]): Map<string, RequestContext> {
  const contexts = new Map<string, RequestContext>();
  let previous: RequestContext | undefined;
  for (const request of requests) {
    const text = requestText(request.messageText);
    const continuation = /^(?:(?:please\s+)?(?:resume|continue|carry on|pick up)(?:\s+(?:what you were doing|from where you left off|the task|the work|working|please))?[.!]?|I hit my usage limit while you were working, but it has reset now\. Please continue from where you left off\.)$/i.test(text);
    let context: RequestContext;
    if (continuation) context = previous || { intent: 'unclassified', requestId: request.requestId };
    else {
      const brief = /\b(?:keep (?:it|the (?:answer|response|report)) (?:brief|short|concise)|one[- ](?:line|sentence)|(?:under|at most|no more than) \d+ words|brief (?:answer|summary)|answer briefly)\b/i.test(text);
      const detailed = /(?:^|[.!?]\s+)(?:please\s+)?(?:audit\b|(?:I (?:want|need) you to |can you |could you )?(?:write|produce|give|provide|create|perform|conduct|prepare|review|analy[sz]e|audit)\b.{0,180}\b(?:report|audit|comprehensive|detailed|extensive|complete code|full implementation|architecture|codebase)\b)/i.test(text)
        || /\b(?:write|give|provide|produce|prepare|create) (?:me |us )?(?:a |an |the )?(?:[a-z-]+ ){0,3}(?:report|audit|full implementation)\b/i.test(text)
        || /\b(?:comprehensive|detailed|extensive|clinical|full) (?:report|audit|analysis|review)\b/i.test(text);
      const auditDeliverable = /\b(?:auditing|conducting)\b.{0,100}\b(?:backend|audit)\b/i.test(text) && /\bdeliverables\b/i.test(text);
      const negated = /\b(?:do not|don't|no need to) (?:write|produce|give|provide|create|perform|conduct|prepare) (?:me |us )?(?:a |an |the )?(?:(?:detailed|extensive|full|comprehensive) )?(?:audit|report|review)\b|\bwithout (?:a |an )?(?:detailed |full )?(?:audit|report|review)\b/i.test(text);
      const intent: ResponseIntent = request.messageLength > 16000 || text.startsWith('<') ? 'unclassified'
        : brief ? 'brevity-conflict' : (detailed || auditDeliverable) && !negated ? 'requested-detail' : 'unclassified';
      context = { intent, requestId: request.requestId };
      previous = context;
    }
    contexts.set(request.requestId, context);
  }
  return contexts;
}
