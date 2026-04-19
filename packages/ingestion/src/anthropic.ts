// Anthropic Claude client — Phase 4 LLM-driven artist enrichment.
//
// Thin wrapper around @anthropic-ai/sdk. Exposes:
//   - runToolLoop: bounded tool-use iteration (6 turns max) with
//     per-call error containment. A Firecrawl timeout or a 404 on a
//     profile URL surfaces back to the model as an is_error
//     tool_result so the model can swap platforms (SC → BC) or give
//     up on that escalation step — the whole enrichment run
//     shouldn't abort because one tool hiccuped.
//   - extractJson: balanced-brace extractor used as a fallback when
//     we ask the model to return JSON as free text rather than via
//     a structured submit_enrichment tool. In the happy path the
//     enrichment module uses the structured-tool pattern and never
//     touches this.
//
// Model: claude-sonnet-4-6 (April 2026 tool-use workhorse).

import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = env.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — Phase 4 enrichment is disabled.',
    );
  }
  client = new Anthropic({ apiKey });
  return client;
}

export const SONNET_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2000;
const MAX_TOOL_ITERATIONS = 6;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolInvocation {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolLoopResult {
  /** Concatenated final assistant text blocks, if any. */
  text: string;
  /** Every tool_use block the model emitted, in order, across turns. */
  invocations: ToolInvocation[];
  stopReason: string | null;
}

/**
 * Drive a tool-use loop. The executor is invoked once per tool_use
 * block the model emits; its return string becomes the tool_result
 * content for the next user turn. Exceptions are caught and reported
 * as is_error=true tool_results so the model can attempt recovery
 * within its remaining budget.
 *
 * Terminates when stop_reason !== 'tool_use' OR when MAX_TOOL_ITERATIONS
 * is exhausted (which throws — that's a pipeline-level bug, not a
 * per-artist failure we want to swallow).
 */
export async function runToolLoop(opts: {
  system: string;
  userMessage: string;
  tools: ToolDefinition[];
  executeToolCall: (call: ToolInvocation) => Promise<string>;
  maxTokens?: number;
}): Promise<ToolLoopResult> {
  const anthropic = getClient();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: opts.userMessage },
  ];
  const invocations: ToolInvocation[] = [];
  let lastStopReason: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system,
      tools: opts.tools as unknown as Anthropic.Tool[],
      messages,
    });
    lastStopReason = response.stop_reason ?? null;

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      return { text, invocations, stopReason: lastStopReason };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const invocation: ToolInvocation = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
      invocations.push(invocation);
      try {
        const result = await opts.executeToolCall(invocation);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(
    `anthropic runToolLoop: exceeded ${MAX_TOOL_ITERATIONS} iterations without end_turn`,
  );
}

/**
 * Extract the first balanced-brace JSON object from a string. Strips
 * ```json fences if present. Used as a fallback when the model
 * returns JSON as free text rather than via a structured submit tool.
 */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  if (start < 0) {
    throw new Error(`extractJson: no object in: ${raw.slice(0, 200)}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error(`extractJson: unbalanced braces in: ${raw.slice(0, 200)}`);
}
