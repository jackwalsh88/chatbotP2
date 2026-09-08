import { LlmError } from './types.js';
import type { LlmVisionClient, LlmVisionRequest } from './vision-types.js';

export interface OpenAiCompatibleVisionConfig {
  /** Base URL of the inference endpoint, e.g. https://<host>/v1 */
  baseUrl: string;
  /** Model identifier as known by the endpoint. Must be vision-capable. */
  model: string;
  /** Optional bearer token — self-hosted endpoints may be keyless. */
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Vision-capable adapter for the OpenAI-compatible chat-completions wire
 * protocol (Phase 2 avatar-derived persona).
 *
 * A DELIBERATE NEAR-DUPLICATE of llm/openai-compatible.ts's request/response
 * handling, not a modification of it. That module is shared production
 * surface (live chat + Autofill); widening its request body to accept
 * multi-part message content for the sake of persona generation would change
 * behaviour neither of those callers asked for. The two adapters will drift
 * apart the day either wire protocol needs to (e.g. a provider-specific
 * image field), which is the point of keeping them separate now.
 *
 * Still a PROTOCOL choice, not a vendor choice, exactly like its sibling:
 * nothing here names a vendor or model. Whether the configured chat endpoint
 * itself happens to be vision-capable is an environment/config question
 * (see character-persona-generator.ts's selectPersonaGenerator), not
 * something this adapter decides.
 */
export function createOpenAiCompatibleVisionClient(
  config: OpenAiCompatibleVisionConfig,
): LlmVisionClient {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async generate(request: LlmVisionRequest): Promise<string> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new LlmError('timeout', `Inference request timed out after ${config.timeoutMs}ms.`);
        }
        throw new LlmError('network', 'Could not reach the inference endpoint.');
      }

      if (!response.ok) {
        // Never include the response body in the error — it could echo the prompt.
        throw new LlmError('http', `Inference endpoint returned HTTP ${response.status}.`, response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LlmError('invalid_response', 'Inference endpoint returned non-JSON output.');
      }

      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })
        ?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new LlmError('invalid_response', 'Inference endpoint returned an empty completion.');
      }
      return content.trim();
    },
  };
}
