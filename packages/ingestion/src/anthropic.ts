// Anthropic Claude client — Phase 4 LLM-driven artist enrichment.
//
// Thin wrapper around @anthropic-ai/sdk. Exposes:
//   - runToolLoop: bounded tool-use iteration (6 turns max) with
//     per-call error containment. A Firecrawl timeout or a 404 on a
//     profile URL surfaces back to the model as an is_error
//     tool_result so the model can swap platforms (SC → BC) or give
//     up on that escalation step — the whole enrichment run
//     shouldn't abort because one tool hiccuped.
//
//     Two Phase 4f features bolted on for the full backfill:
//
//       (a) Ephemeral prompt caching — the system prompt embeds the
//           full taxonomy vocabulary (~1600 subgenres, ~100 vibes),
//           which is stable across all 1,600 artists in a run.
//           Marking system + tools with cache_control: ephemeral
//           drops per-call input tokens from ~8k to ~800 (90% cache
//           hit). Pricing: cache writes cost 1.25× base, cache
//           reads cost 0.1× base — breakeven after two hits.
//
//       (b) Stall fallback — when the model burns all 6 tool-use
//           iterations without calling submit_enrichment, instead of
//           throwing we inject a user nudge ("submit your best
//           guess with confidence=low NOW") and make one final
//           forced call with tool_choice pinned to submit_enrichment.
//           The orchestrator flags stalled results for review.
//
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
  /** True when the iter cap was hit and we fell back to forced-submit. */
  stalled: boolean;
}

/**
 * Drive a tool-use loop. The executor is invoked once per tool_use
 * block the model emits; its return string becomes the tool_result
 * content for the next user turn. Exceptions are caught and reported
 * as is_error=true tool_results so the model can attempt recovery
 * within its remaining budget.
 *
 * Terminates when stop_reason !== 'tool_use' OR when MAX_TOOL_ITERATIONS
 * is exhausted. On iter-cap exhaustion:
 *   - If stallFallbackTool is set, we inject a user nudge and make
 *     one final call with tool_choice pinned to that tool; whatever
 *     the model submits there (low-confidence best guess) is returned
 *     with stalled=true.
 *   - Otherwise we throw — callers that don't want fallback behavior
 *     get the original crash-on-stall semantics.
 */
export async function runToolLoop(opts: {
  system: string;
  userMessage: string;
  tools: ToolDefinition[];
  executeToolCall: (call: ToolInvocation) => Promise<string>;
  maxTokens?: number;
  /** Enable ephemeral prompt caching on system + tools. Saves ~90% of
   *  input tokens across a long batch where system+tools are stable. */
  enablePromptCache?: boolean;
  /** On iter-cap exhaustion, force the model to call this tool with
   *  tool_choice rather than throwing. Caller must still parse the
   *  submitted input — the executor will be invoked as normal. */
  stallFallbackTool?: string;
}): Promise<ToolLoopResult> {
  const anthropic = getClient();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: opts.userMessage },
  ];
  const invocations: ToolInvocation[] = [];
  let lastStopReason: string | null = null;

  // Anthropic caches up to and including the block marked with
  // cache_control. Marking the last tool definition caches the system
  // prompt (via position) AND every tool above it. Two separate
  // cache_control markers (one on system, one on tools) give us two
  // independent cache breakpoints, which is what we want since the
  // taxonomy vocabulary dominates system-prompt size.
  type SysParam = string | Anthropic.TextBlockParam[];
  const systemParam: SysParam = opts.enablePromptCache
    ? [
        {
          type: 'text',
          text: opts.system,
          cache_control: { type: 'ephemeral' },
        } as Anthropic.TextBlockParam,
      ]
    : opts.system;
  const toolsParam: Anthropic.Tool[] = opts.enablePromptCache
    ? opts.tools.map((tool, i) =>
        i === opts.tools.length - 1
          ? ({
              ...tool,
              cache_control: { type: 'ephemeral' },
            } as unknown as Anthropic.Tool)
          : (tool as unknown as Anthropic.Tool),
      )
    : (opts.tools as unknown as Anthropic.Tool[]);

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemParam as unknown as string,
      tools: toolsParam,
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
      return { text, invocations, stopReason: lastStopReason, stalled: false };
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

  // Iter cap hit. Stall fallback or throw.
  if (opts.stallFallbackTool) {
    // Append a text nudge to the last user message (which currently ends
    // with tool_result blocks — Anthropic accepts mixed content arrays).
    const lastMessage = messages[messages.length - 1];
    const nudge: Anthropic.TextBlockParam = {
      type: 'text',
      text:
        `Iteration cap reached. Submit your current best guess with ` +
        `confidence="low" NOW via ${opts.stallFallbackTool}. Do not ` +
        `call any more discovery tools. Use whatever partial evidence ` +
        `you've already gathered; a low-confidence structured submission ` +
        `is required — silent stop is not acceptable.`,
    };
    if (
      lastMessage &&
      lastMessage.role === 'user' &&
      Array.isArray(lastMessage.content)
    ) {
      (lastMessage.content as Anthropic.ContentBlockParam[]).push(nudge);
    } else {
      messages.push({ role: 'user', content: [nudge] });
    }

    const forced = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemParam as unknown as string,
      tools: toolsParam,
      messages,
      tool_choice: {
        type: 'tool',
        name: opts.stallFallbackTool,
      } as unknown as Anthropic.MessageCreateParams['tool_choice'],
    });
    lastStopReason = forced.stop_reason ?? null;

    const forcedToolUseBlocks = forced.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    for (const block of forcedToolUseBlocks) {
      const invocation: ToolInvocation = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
      invocations.push(invocation);
      if (invocation.name === opts.stallFallbackTool) {
        try {
          await opts.executeToolCall(invocation);
        } catch {
          // Swallow — this is best-effort. Downstream will notice the
          // missing submit and surface an error for review.
        }
      }
    }
    const text = forced.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return { text, invocations, stopReason: lastStopReason, stalled: true };
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
