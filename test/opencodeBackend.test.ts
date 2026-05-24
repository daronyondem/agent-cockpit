import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CliProfile, StreamEvent } from '../src/types';
import { OpenCodeAdapter, __opencodeTestUtils, resolveOpenCodeCliRuntime } from '../src/services/backends/opencode';

const TEXT_ONLY_CAPABILITIES = { input: { text: true }, output: { text: true } };

function opencodeProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  const now = '2026-05-24T00:00:00.000Z';
  return {
    id: 'profile-opencode',
    name: 'OpenCode DeepSeek',
    vendor: 'opencode',
    authMode: 'server-configured',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('OpenCode backend helpers', () => {
  test('metadata advertises thinking and tool activity support', () => {
    expect(new OpenCodeAdapter().metadata.capabilities.thinking).toBe(true);
    expect(new OpenCodeAdapter().metadata.capabilities.toolActivity).toBe(true);
    expect(new OpenCodeAdapter().metadata.capabilities.oneShotMediaInput).toEqual({
      image: ['explicit-attachment'],
      pdf: ['explicit-attachment'],
    });
  });

  test('resolves ~/.opencode/bin/opencode when PATH lacks opencode', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'));
    const binDir = path.join(home, '.opencode', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binary = path.join(binDir, 'opencode');
    fs.writeFileSync(binary, '#!/bin/sh\n');
    fs.chmodSync(binary, 0o755);

    try {
      const runtime = resolveOpenCodeCliRuntime(opencodeProfile({ env: { HOME: home, PATH: '/usr/bin:/bin' } }));
      expect(runtime.command).toBe(binary);
      expect(runtime.displayCommand).toBe(binary);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('builds opencode run args with provider model and session', () => {
    const args = __opencodeTestUtils.buildOpenCodeRunArgs('hello', {
      cliProfile: opencodeProfile({ opencode: { provider: 'deepseek', model: 'deepseek/deepseek-chat' } }),
      workingDir: '/tmp/workspace',
      externalSessionId: 'ses_123',
      allowTools: true,
    });

    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp/workspace',
      '--model',
      'deepseek/deepseek-chat',
      '--session',
      'ses_123',
      '--dangerously-skip-permissions',
      'hello',
    ]);
  });

  test('passes OpenCode variant when selected model supports the requested effort', () => {
    const args = __opencodeTestUtils.buildOpenCodeRunArgs('hello', {
      workingDir: '/tmp/workspace',
      model: 'deepseek/deepseek-v4-pro',
      effort: 'high',
      modelCatalog: [{
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        family: 'deepseek',
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      }],
    });

    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp/workspace',
      '--model',
      'deepseek/deepseek-v4-pro',
      '--variant',
      'high',
      'hello',
    ]);
  });

  test('passes OpenCode thinking flag when visible thinking is requested', () => {
    const args = __opencodeTestUtils.buildOpenCodeRunArgs('hello', {
      workingDir: '/tmp/workspace',
      model: 'deepseek/deepseek-v4-pro',
      showThinking: true,
    });

    expect(args).toContain('--thinking');
  });

  test('passes OpenCode image and PDF attachments through --file', () => {
    const args = __opencodeTestUtils.buildOpenCodeRunArgs('hello', {
      workingDir: '/tmp/workspace',
      attachments: [
        { path: '/tmp/workspace/page.png', kind: 'image' },
        { path: '/tmp/workspace/source.pdf', kind: 'pdf' },
        { path: '/tmp/workspace/audio.wav', kind: 'audio' },
      ],
    });

    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp/workspace',
      '--file',
      '/tmp/workspace/page.png',
      '--file',
      '/tmp/workspace/source.pdf',
      'hello',
    ]);
  });


  test('omits OpenCode variant when effort is unsupported by the selected model', () => {
    const args = __opencodeTestUtils.buildOpenCodeRunArgs('hello', {
      workingDir: '/tmp/workspace',
      model: 'deepseek/deepseek-v4-pro',
      effort: 'xhigh',
      modelCatalog: [{
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        family: 'deepseek',
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      }],
    });

    expect(args).not.toContain('--variant');
  });

  test('reports a missing working directory before spawning OpenCode', async () => {
    const missing = path.join(os.tmpdir(), `opencode-missing-${Date.now()}`);
    const adapter = new OpenCodeAdapter({ workingDir: missing });
    const result = adapter.sendMessage('hello', {
      sessionId: 'session-1',
      isNewSession: true,
      workingDir: missing,
      systemPrompt: '',
    });

    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'error', error: `OpenCode working directory does not exist: ${missing}` },
      { type: 'done' },
    ]);
  });

  test('converts ACP-shaped MCP servers to OpenCode local MCP config', () => {
    const config = __opencodeTestUtils.mcpServersToOpenCodeConfig([{
      name: 'agent-cockpit-memory',
      command: 'node',
      args: ['/tmp/memory-stub.cjs'],
      env: [{ name: 'MEMORY_TOKEN', value: 'tok' }],
    }]);

    expect(config).toEqual({
      'agent-cockpit-memory': {
        type: 'local',
        command: ['node', '/tmp/memory-stub.cjs'],
        enabled: true,
        environment: { MEMORY_TOKEN: 'tok' },
      },
    });
  });

  test('parses OpenCode model output into model options', () => {
    const models = __opencodeTestUtils.parseOpenCodeModelsOutput([
      'deepseek/deepseek-chat',
      '\u001b[32mdeepseek/deepseek-v4-pro\u001b[0m',
      '',
    ].join('\n'));

    expect(models).toEqual([
      { id: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat', family: 'deepseek', capabilities: TEXT_ONLY_CAPABILITIES },
      { id: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro', family: 'deepseek', capabilities: TEXT_ONLY_CAPABILITIES },
    ]);
  });

  test('parses OpenCode verbose model variants and capabilities', () => {
    const models = __opencodeTestUtils.parseOpenCodeModelsOutput([
      'deepseek/deepseek-v4-pro',
      '{',
      '  "id": "deepseek-v4-pro",',
      '  "providerID": "deepseek",',
      '  "name": "DeepSeek V4 Pro",',
      '  "url": "https://api.deepseek.com",',
      '  "npm": "@ai-sdk/openai-compatible",',
      '  "capabilities": {',
      '    "input": { "text": true, "image": false, "audio": false, "pdf": false, "video": false },',
      '    "output": { "text": true, "image": false, "audio": false, "pdf": false, "video": false },',
      '    "attachment": false,',
      '    "toolcall": true,',
      '    "reasoning": true',
      '  },',
      '  "variants": {',
      '    "low": { "reasoningEffort": "low" },',
      '    "medium": { "reasoningEffort": "medium" },',
      '    "high": { "reasoningEffort": "high" },',
      '    "max": { "reasoningEffort": "max" }',
      '  }',
      '}',
      'deepseek/deepseek-chat',
      '{',
      '  "id": "deepseek-chat",',
      '  "providerID": "deepseek",',
      '  "name": "DeepSeek Chat",',
      '  "variants": {}',
      '}',
      'openrouter/vision-model',
      '{',
      '  "id": "vision-model",',
      '  "providerID": "openrouter",',
      '  "name": "Vision Model",',
      '  "capabilities": {',
      '    "input": { "text": true, "image": true, "pdf": true },',
      '    "output": { "text": true }',
      '  }',
      '}',
    ].join('\n'));

    expect(models).toEqual([
      {
        id: 'deepseek/deepseek-v4-pro',
        label: 'deepseek/deepseek-v4-pro',
        family: 'deepseek',
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        capabilities: {
          input: { text: true, image: false, audio: false, pdf: false, video: false },
          output: { text: true, image: false, audio: false, pdf: false, video: false },
          attachment: false,
          toolcall: true,
          reasoning: true,
        },
      },
      {
        id: 'deepseek/deepseek-chat',
        label: 'deepseek/deepseek-chat',
        family: 'deepseek',
        capabilities: TEXT_ONLY_CAPABILITIES,
      },
      {
        id: 'openrouter/vision-model',
        label: 'openrouter/vision-model',
        family: 'openrouter',
        capabilities: {
          input: { text: true, image: true, pdf: true },
          output: { text: true },
        },
      },
    ]);
  });

  test('translates OpenCode JSON text and usage events', () => {
    const line = JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_abc',
      part: {
        type: 'step-finish',
        tokens: {
          input: 10,
          output: 2,
          cache: { read: 7, write: 3 },
        },
        cost: 0.001,
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events[0]).toEqual({ type: 'external_session', sessionId: 'ses_abc' });
    expect(events[1]).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        costUsd: 0.001,
        costSource: 'reported',
      },
    });
  });

  test('translates OpenCode reasoning events into thinking', () => {
    const line = JSON.stringify({
      type: 'reasoning',
      sessionID: 'ses_abc',
      part: {
        type: 'reasoning',
        messageID: 'msg_assistant',
        text: 'Considering the answer.',
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events).toEqual([
      { type: 'external_session', sessionId: 'ses_abc' },
      { type: 'thinking', content: 'Considering the answer.', streaming: true },
    ]);
    expect(__opencodeTestUtils.openCodeLineMetadata(line).assistantMessageId).toBe('msg_assistant');
  });

  test('translates OpenCode read tool events into tool activity and outcomes', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call_read_1',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/workspace/src/index.ts' },
          output: '<content>hello</content>',
        },
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events).toEqual([
      { type: 'external_session', sessionId: 'ses_abc' },
      {
        type: 'tool_activity',
        tool: 'Read',
        id: 'call_read_1',
        description: 'Reading `.../src/index.ts`',
      },
      {
        type: 'tool_outcomes',
        outcomes: [{
          toolUseId: 'call_read_1',
          isError: false,
          outcome: 'read',
          status: 'success',
        }],
      },
    ]);
  });

  test('translates OpenCode MCP tool names without losing underscored tool names', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'agent-cockpit-kb-search_search_topics',
        callID: 'call_mcp_1',
        state: {
          status: 'completed',
          input: { query: 'release notes' },
          output: '{"topics":[]}',
        },
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events[1]).toEqual({
      type: 'tool_activity',
      tool: 'search_topics',
      id: 'call_mcp_1',
      description: 'agent-cockpit-kb-search.search_topics',
    });
    expect(events[2]).toEqual({
      type: 'tool_outcomes',
      outcomes: [{
        toolUseId: 'call_mcp_1',
        isError: false,
        outcome: 'done',
        status: 'success',
      }],
    });
  });

  test('does not emit OpenCode tool outcomes for non-terminal tool states', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call_read_1',
        state: {
          status: 'running',
          input: { filePath: '/tmp/workspace/src/index.ts' },
        },
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events).toEqual([
      { type: 'external_session', sessionId: 'ses_abc' },
      {
        type: 'tool_activity',
        tool: 'Read',
        id: 'call_read_1',
        description: 'Reading `.../src/index.ts`',
      },
    ]);
  });

  test('does not emit OpenCode tool outcomes when call id is missing', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/workspace/src/index.ts' },
          output: '<content>hello</content>',
        },
      },
    });

    const events = __opencodeTestUtils.translateOpenCodeLine(line) as StreamEvent[];
    expect(events).toEqual([
      { type: 'external_session', sessionId: 'ses_abc' },
      {
        type: 'tool_activity',
        tool: 'Read',
        id: null,
        description: 'Reading `.../src/index.ts`',
      },
    ]);
  });

  test('extracts assistant message metadata from OpenCode JSON events', () => {
    const line = JSON.stringify({
      type: 'step_start',
      sessionID: 'ses_abc',
      part: {
        type: 'step-start',
        sessionID: 'ses_abc',
        messageID: 'msg_assistant',
      },
    });

    expect(__opencodeTestUtils.openCodeLineMetadata(line)).toEqual({
      sessionId: 'ses_abc',
      assistantMessageId: 'msg_assistant',
    });
  });

  test('extracts assistant text from OpenCode session export output', () => {
    const exportOutput = [
      'Exporting session: ses_abc',
      JSON.stringify({
        messages: [
          {
            info: { id: 'msg_user', role: 'user' },
            parts: [{ type: 'text', text: 'hi' }],
          },
          {
            info: { id: 'msg_old', role: 'assistant' },
            parts: [{ type: 'text', text: 'old answer' }],
          },
          {
            info: { id: 'msg_new', role: 'assistant' },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' there' },
              { type: 'step-finish' },
            ],
          },
        ],
      }),
    ].join('\n');

    expect(__opencodeTestUtils.extractOpenCodeExportText(exportOutput, 'msg_new')).toBe('Hello there');
    expect(__opencodeTestUtils.extractOpenCodeExportText(exportOutput, null)).toBe('Hello there');
  });

  test('collects final text from OpenCode JSON lines', () => {
    const stdout = [
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'AC_' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK' } }),
    ].join('\n');

    expect(__opencodeTestUtils.collectOpenCodeJson(stdout)).toEqual({
      text: 'AC_OK',
      sessionId: 'ses_1',
      usage: null,
    });
  });

  test('requests export recovery when latest OpenCode assistant message has no stdout text', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_1',
        part: { type: 'step-start', messageID: 'msg_pre', sessionID: 'ses_1' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_1',
        part: { type: 'text', messageID: 'msg_pre', sessionID: 'ses_1', text: 'CHECKING' },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: { type: 'step-finish', messageID: 'msg_pre', sessionID: 'ses_1' },
      }),
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_1',
        part: { type: 'step-start', messageID: 'msg_final', sessionID: 'ses_1' },
      }),
    ].join('\n');

    expect(__opencodeTestUtils.collectOpenCodeJson(stdout)).toEqual({
      text: 'CHECKING',
      sessionId: 'ses_1',
      usage: null,
      assistantMessageId: 'msg_final',
      textRecoveryRecommended: true,
    });
  });

  test('does not request export recovery when latest OpenCode assistant message has stdout text', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_1',
        part: { type: 'step-start', messageID: 'msg_final', sessionID: 'ses_1' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_1',
        part: { type: 'text', messageID: 'msg_final', sessionID: 'ses_1', text: 'DONE' },
      }),
    ].join('\n');

    expect(__opencodeTestUtils.collectOpenCodeJson(stdout)).toEqual({
      text: 'DONE',
      sessionId: 'ses_1',
      usage: null,
      assistantMessageId: 'msg_final',
    });
  });

  test('attributes OpenCode text without message id to the current assistant message', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_1',
        part: { type: 'step-start', messageID: 'msg_final', sessionID: 'ses_1' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_1',
        part: { type: 'text', sessionID: 'ses_1', text: 'DONE' },
      }),
    ].join('\n');

    expect(__opencodeTestUtils.collectOpenCodeJson(stdout)).toEqual({
      text: 'DONE',
      sessionId: 'ses_1',
      usage: null,
      assistantMessageId: 'msg_final',
    });
  });
});
