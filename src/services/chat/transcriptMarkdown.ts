import type { Message, SessionEntry } from '../../types';

export function messagesToMarkdown(
  title: string,
  convId: string,
  sessionMeta: { number: number; startedAt: string },
  messages: Message[],
): string {
  const lines = [
    `# ${title}`,
    ``,
    `**Session ${sessionMeta.number}** | Started: ${sessionMeta.startedAt}`,
    `**Conversation ID:** ${convId}`,
    ``,
    `---`,
    ``,
  ];

  appendMessages(lines, messages, true);

  return lines.join('\n');
}

export function conversationToMarkdown(
  title: string,
  backend: string,
  sessions: Array<{ session: SessionEntry; messages: Message[] }>,
): string {
  const lines = [
    `# ${title}`,
    ``,
    `**Backend:** ${backend}`,
    ``,
    `---`,
    ``,
  ];

  for (const { session, messages } of sessions) {
    if (!messages.length) continue;

    const label = session.active ? `Session ${session.number} (current)` : `Session ${session.number}`;
    lines.push(`## ${label}`);
    lines.push(``);

    appendMessages(lines, messages, false);

    if (!session.active) {
      lines.push(`---`);
      lines.push(`*Session reset — ${new Date(session.endedAt!).toLocaleString()}*`);
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join('\n');
}

function appendMessages(lines: string[], messages: Message[], includeDividers: boolean): void {
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const time = new Date(msg.timestamp).toLocaleString();
    lines.push(`### ${role} — ${time}`);
    if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
    if (msg.streamError) {
      lines.push(`*Stream error${msg.streamError.source ? ` (${msg.streamError.source})` : ''}: ${msg.streamError.message}*`);
    }
    lines.push(``);
    lines.push(msg.content);
    lines.push(``);
    if (includeDividers) {
      lines.push(`---`);
      lines.push(``);
    }
  }
}
