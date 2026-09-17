/**
 * Vision-capable message shapes (Phase 2 avatar-derived persona).
 *
 * A DELIBERATELY SEPARATE contract from llm/types.ts, not an extension of it.
 * LlmMessage.content is a plain string throughout the chat/Autofill path, and
 * that path is shared production surface — widening it to accept multi-part
 * content for the sake of one image-analysis feature would be a change to
 * code the chat engine depends on for every message. Persona generation is
 * the only caller of this shape, so it gets its own.
 *
 * The content-part shape mirrors the OpenAI-compatible vision wire format
 * (text + image_url parts) since that is the protocol the existing chat
 * adapter already speaks — see llm/openai-compatible.ts's own note that this
 * is a protocol choice, not a vendor choice.
 */

export interface LlmTextContentPart {
  type: 'text';
  text: string;
}

export interface LlmImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type LlmVisionContentPart = LlmTextContentPart | LlmImageContentPart;

export interface LlmVisionMessage {
  role: 'system' | 'user';
  /** A system message is always plain text; a user message may carry an image. */
  content: string | LlmVisionContentPart[];
}

export interface LlmVisionRequest {
  messages: LlmVisionMessage[];
  maxTokens: number;
  temperature: number;
}

/** The single contract a vision-capable inference adapter implements. */
export interface LlmVisionClient {
  /** Returns the assistant's reply text, or throws LlmError. */
  generate(request: LlmVisionRequest): Promise<string>;
}

// Failures reuse LlmError/LlmErrorKind from llm/types.js directly — import
// them from there, not from this module.
