/** Provider-neutral JSON transport boundary. No credentials, endpoint or SDK defaults. */
import { z } from 'zod';
import { browserActionSchema } from './browser-actions.js';
export const modelReplySchema = z.strictObject({
  action: browserActionSchema,
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().max(100000),
    outputTokens: z.number().int().nonnegative().max(10000),
  }),
});
export interface BrowserModelRequest {
  instruction: string;
  goal: string;
  actions: z.infer<typeof browserActionSchema>[];
  observation: { untrusted: true; snapshot: string; pngBase64: string };
  maxInputTokens: number;
  maxOutputTokens: number;
}
export interface BrowserModel {
  propose(
    request: BrowserModelRequest,
    signal: AbortSignal,
  ): Promise<z.infer<typeof modelReplySchema>>;
}
/** Transport must enforce token ceilings and honor abort; reply is never executable code. */
export function createJsonBrowserModel(
  transport: (
    request: BrowserModelRequest,
    signal: AbortSignal,
  ) => Promise<string>,
): BrowserModel {
  return {
    async propose(request, signal) {
      signal.throwIfAborted();
      const raw = await transport(structuredClone(request), signal);
      signal.throwIfAborted();
      if (Buffer.byteLength(raw, 'utf8') > 8192)
        throw Error('model_response_size');
      return modelReplySchema.parse(JSON.parse(raw));
    },
  };
}
