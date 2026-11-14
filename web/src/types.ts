// Mirrors kingfisher-events' AgentEvent. Bump alongside SCHEMA_VERSION.

export type ToolKind = 'read' | 'write' | 'edit' | 'search' | 'shell' | 'web' | 'agent' | 'mcp' | 'other';

export type EventBody =
  | {
      type: 'session_started';
      model: string;
      cwd: string;
      tools: string[];
      mcp: { name: string; status: string }[];
      capabilities: string[];
      permission_mode: string | null;
      api_key_source: string | null;
      version: string | null;
    }
  | { type: 'turn_started'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string; estimated_tokens: number | null }
  | { type: 'message_complete'; text: string }
  | { type: 'tool_call'; call_id: string; tool: string; kind: ToolKind; input: any; paths: string[] }
  | { type: 'tool_result'; call_id: string; tool: string | null; ok: boolean; summary: string }
  | { type: 'usage'; context_tokens: number; output_tokens: number }
  | { type: 'rate_limit'; status: string; window: string | null; utilization: number | null; resets_at: number | null }
  | { type: 'status'; status: string }
  | { type: 'hook'; event: string; phase: string }
  | { type: 'retry'; attempt: number | null; delay_ms: number | null; error: string | null }
  | { type: 'compaction'; trigger: string | null }
  | {
      type: 'turn_ended';
      ok: boolean;
      reason: string | null;
      cost_usd: number | null;
      duration_ms: number | null;
      context_window: number | null;
    }
  | { type: 'permission_requested'; req_id: string; tool: string; input: any }
  | { type: 'permission_resolved'; req_id: string; allow: boolean; auto?: boolean }
  | { type: 'mode'; autonomous: boolean; banter: boolean }
  | { type: 'permission_withdrawn'; req_id: string }
  | { type: 'session_ended'; reason: string | null }
  | { type: 'agent_exited'; code: number | null }
  | { type: 'notice'; text: string }
  | { type: 'unknown'; raw_type: string };

export interface AgentEvent {
  v: number;
  seq: number;
  ts: number;
  session: string | null;
  parent: string | null;
  body: EventBody;
}

export type ClientMsg =
  | { type: 'prompt'; text: string }
  | { type: 'interrupt' }
  | { type: 'permission'; req_id: string; allow: boolean }
  | { type: 'take_over'; session: string }
  | { type: 'set_mode'; autonomous?: boolean; banter?: boolean };
