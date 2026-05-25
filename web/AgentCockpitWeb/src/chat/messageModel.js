/* Prefer authoritative contentBlocks; fall back to legacy thinking + toolActivity + content
   for messages saved before the field existed. */
export function deriveBlocks(message){
  if (Array.isArray(message.contentBlocks) && message.contentBlocks.length) {
    return message.contentBlocks;
  }
  const legacy = [];
  if (message.thinking) legacy.push({ type: 'thinking', content: message.thinking });
  if (Array.isArray(message.toolActivity)) {
    for (const t of message.toolActivity) legacy.push({ type: 'tool', activity: t });
  }
  if (message.content) legacy.push({ type: 'text', content: message.content });
  return legacy;
}

/* Splits contentBlocks into render segments. Consecutive tool blocks merge into
   one 'tool-run' segment so the renderer can group them as
   parallel/sequential/agent activity. */
export function groupBlocksForRender(contentBlocks){
  const out = [];
  let toolBuf = [];
  const flush = () => {
    if (toolBuf.length) {
      out.push({ kind: 'tool-run', tools: toolBuf });
      toolBuf = [];
    }
  };
  for (const b of contentBlocks) {
    if (b && b.type === 'tool' && b.activity) {
      toolBuf.push(b.activity);
    } else if (b && b.type === 'text') {
      flush();
      out.push({ kind: 'text', content: b.content || '' });
    } else if (b && b.type === 'thinking') {
      flush();
      out.push({ kind: 'thinking', content: b.content || '' });
    } else if (b && b.type === 'artifact' && b.artifact) {
      flush();
      out.push({ kind: 'artifact', artifact: b.artifact });
    }
  }
  flush();
  return out;
}

/* Render a "Processing..." spinner once at least one tool has finished, no tool
   is currently running, and no text has streamed yet for this turn. */
export function shouldShowProcessing(blocks){
  let hasCompleted = false;
  let hasRunning = false;
  let hasText = false;
  for (const b of blocks) {
    if (b && b.type === 'tool' && b.activity) {
      const a = b.activity;
      const completed = a.duration != null || !!a.outcome || a.status === 'error';
      if (completed) hasCompleted = true;
      else hasRunning = true;
    } else if (b && b.type === 'text' && b.content && b.content.length) {
      hasText = true;
    } else if (b && b.type === 'artifact') {
      hasText = true;
    }
  }
  return hasCompleted && !hasRunning && !hasText;
}

/* Collapse runs of consecutive assistant messages with turn:'progress' into a
   single breadcrumb entry. Three cases:
     - plain                   -> a non-progress message rendered as-is
     - final-with-progress     -> the breadcrumb prepends to a following
                                   non-progress assistant bubble
     - progress-trailing       -> the run has no following assistant bubble
*/
export function collapseProgressRuns(messages){
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const isProgress = m && m.role === 'assistant' && m.turn === 'progress';
    if (!isProgress) {
      out.push({ kind: 'plain', message: m });
      i++;
      continue;
    }
    const run = [];
    while (i < messages.length) {
      const mi = messages[i];
      if (mi && mi.role === 'assistant' && mi.turn === 'progress') {
        run.push(mi);
        i++;
      } else {
        break;
      }
    }
    const next = messages[i];
    if (next && next.role === 'assistant' && next.turn !== 'progress') {
      out.push({ kind: 'final-with-progress', message: next, progressRun: run });
      i++;
    } else {
      out.push({ kind: 'progress-trailing', progressRun: run });
    }
  }
  return out;
}
