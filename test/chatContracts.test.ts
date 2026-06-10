import {
  parseServiceTierInput,
  validateQueueUpdateRequest,
  validateSettingsRequest,
} from '../src/contracts/chat';
import {
  validateWorkspaceContextEnabledRequest,
} from '../src/contracts/workspaceContext';
import { validateCreateConversationRequest, validateSetMessagePinnedRequest, validateSetUnreadRequest } from '../src/contracts/conversations';
import { validateExplorerSaveFileRequest } from '../src/contracts/explorer';
import {
  validateKbAutoDigestRequest,
  validateKbEmbeddingConfigRequest,
  validateKbEnabledRequest,
  validateKbFolderRenameRequest,
  validateKbGlossaryTermRequest,
} from '../src/contracts/knowledgeBase';
import { validateMemoryEnabledRequest } from '../src/contracts/memory';
import { validateRoutineEnabledRequest } from '../src/contracts/routines';
import { validateConversationInputRequest, validateSendMessageRequest } from '../src/contracts/streams';
import { validateAttachmentOcrRequest } from '../src/contracts/uploads';
import {
  asRecord,
  isContractValidationError,
  optionalArray,
  optionalClampedInteger,
  optionalRecord,
} from '../src/contracts/validation';

describe('chat API contracts', () => {
  test('parses service tier payload values', () => {
    expect(parseServiceTierInput(undefined)).toBeUndefined();
    expect(parseServiceTierInput(null)).toBeNull();
    expect(parseServiceTierInput('')).toBeNull();
    expect(parseServiceTierInput('default')).toBeNull();
    expect(parseServiceTierInput('fast')).toBe('fast');
    expect(() => parseServiceTierInput('slow')).toThrow('serviceTier must be "fast" or "default"');
  });

  test('validates queued message update payloads', () => {
    expect(validateQueueUpdateRequest({
      queue: [
        { content: 'hello' },
        { content: 'with file', attachments: [{ name: 'a.txt', path: '/tmp/a.txt' }] },
      ],
    }).queue).toHaveLength(2);

    expect(() => validateQueueUpdateRequest({ queue: ['legacy'] }))
      .toThrow('queue entries must be objects with a content string');
    expect(() => validateQueueUpdateRequest({ queue: [{ content: 'x', attachments: [{}] }] }))
      .toThrow('each attachment must have string name and non-empty path');
  });

  test('settings payload must be an object', () => {
    expect(validateSettingsRequest({ theme: 'system' })).toEqual({ theme: 'system' });
    expect(() => validateSettingsRequest(null)).toThrow('settings must be an object');
    expect(() => validateSettingsRequest({ theme: 'sepia' })).toThrow('theme must be light, dark, or system');
    expect(() => validateSettingsRequest({ cliProfiles: {} })).toThrow('cliProfiles must be an array');
    expect(() => validateSettingsRequest({ workspaceContext: [] })).toThrow('workspaceContext must be an object');
  });

  test('shared validation helpers cover object, array, and clamped integer payload fields', () => {
    const record = asRecord({
      limit: 12.6,
      options: { enabled: true },
      tags: ['a', 'b'],
    });

    expect(optionalClampedInteger(record, 'limit', 1, 10)).toBe(10);
    expect(optionalRecord(record, 'options')).toEqual({ enabled: true });
    expect(optionalArray(record, 'tags', (item) => {
      if (typeof item !== 'string') throw new Error('tag must be a string');
      return item.toUpperCase();
    })).toEqual(['A', 'B']);

    expect(() => optionalClampedInteger(asRecord({ limit: Number.NaN }), 'limit', 1, 10)).toThrow('limit must be a finite number');
    expect(() => optionalRecord(asRecord({ options: [] }), 'options')).toThrow('options must be an object');
    expect(() => optionalArray(asRecord({ tags: 'a' }), 'tags', (item) => item)).toThrow('tags must be an array');
  });

  test('normalizes conversation and stream mutation payloads', () => {
    expect(validateCreateConversationRequest({
      title: 'T',
      workingDir: '/tmp/ac',
      backend: 'codex',
      claudeCodeMode: 'ultracode',
      serviceTier: 'default',
    })).toMatchObject({
      title: 'T',
      workingDir: '/tmp/ac',
      backend: 'codex',
      claudeCodeMode: 'ultracode',
      serviceTier: null,
    });
    expect(validateSetUnreadRequest({ unread: true })).toEqual({ unread: true });
    expect(validateSetUnreadRequest({})).toEqual({ unread: false });
    expect(validateSetMessagePinnedRequest({ pinned: true })).toEqual({ pinned: true });
    expect(() => validateSetMessagePinnedRequest({})).toThrow('pinned must be a boolean');
    expect(validateSendMessageRequest({ content: 'hello', serviceTier: 'fast' })).toMatchObject({
      content: 'hello',
      serviceTier: 'fast',
    });
    expect(validateSendMessageRequest({ content: 'hello', claudeCodeMode: null })).toMatchObject({
      content: 'hello',
      claudeCodeMode: null,
    });
    expect(validateConversationInputRequest({ text: 'answer', streamActive: false })).toEqual({
      text: 'answer',
      streamActive: false,
    });
  });

  test('validates domain-specific mutation payloads with contract errors', () => {
    expect(validateExplorerSaveFileRequest({ path: 'a.txt', content: '' })).toEqual({ path: 'a.txt', content: '' });
    expect(validateAttachmentOcrRequest({ path: '/tmp/image.png', cliProfileId: 'profile-1', backend: 'codex' })).toEqual({
      path: '/tmp/image.png',
      cliProfileId: 'profile-1',
      backend: 'codex',
    });
    expect(validateKbFolderRenameRequest({ fromPath: 'old', toPath: 'new' })).toEqual({ fromPath: 'old', toPath: 'new' });
    expect(validateKbEnabledRequest({ enabled: true })).toEqual({ enabled: true });
    expect(validateKbAutoDigestRequest({ autoDigest: false })).toEqual({ autoDigest: false });
    expect(validateKbGlossaryTermRequest({ term: 'API', expansion: 'Application programming interface' })).toEqual({
      term: 'API',
      expansion: 'Application programming interface',
    });
    expect(validateKbEmbeddingConfigRequest({ model: 'nomic-embed-text', ollamaHost: 'http://localhost:11434', dimensions: 768 })).toEqual({
      model: 'nomic-embed-text',
      ollamaHost: 'http://localhost:11434',
      dimensions: 768,
    });
    expect(validateMemoryEnabledRequest({ enabled: false })).toEqual({ enabled: false });
    expect(validateWorkspaceContextEnabledRequest({ enabled: true })).toEqual({ enabled: true });
    expect(validateRoutineEnabledRequest({ enabled: true })).toEqual({ enabled: true });

    for (const fn of [
      () => validateSendMessageRequest({ content: '' }),
      () => validateSendMessageRequest({ content: 'hello', effort: 'extreme' }),
      () => validateSendMessageRequest({ content: 'hello', claudeCodeMode: 'ultra' }),
      () => validateConversationInputRequest({ text: 1 }),
      () => validateExplorerSaveFileRequest({ path: 'a.txt' }),
      () => validateAttachmentOcrRequest({ path: '' }),
      () => validateKbFolderRenameRequest({ fromPath: 'old' }),
      () => validateKbEnabledRequest({ enabled: 'yes' }),
      () => validateKbAutoDigestRequest({ autoDigest: 'yes' }),
      () => validateKbGlossaryTermRequest({ term: '', expansion: 'x' }),
      () => validateKbEmbeddingConfigRequest({ dimensions: 0 }),
      () => validateMemoryEnabledRequest({ enabled: 'yes' }),
      () => validateWorkspaceContextEnabledRequest({ enabled: 'yes' }),
      () => validateRoutineEnabledRequest({ enabled: 'yes' }),
    ]) {
      try {
        fn();
        throw new Error('expected contract validation to fail');
      } catch (err: unknown) {
        expect(isContractValidationError(err)).toBe(true);
      }
    }
  });
});
