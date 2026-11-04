import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Message, ToolActivity } from './types';

export function buildMobileAgentIndex(messages: Message[], liveTools: ToolActivity[]) {
  const tools = [...messages.flatMap(message => message.contentBlocks?.length
    ? message.contentBlocks.flatMap(block => block.type === 'tool' ? [block.activity] : []) : message.toolActivity || []), ...liveTools];
  const ids = new Set(tools.filter(tool => tool.isAgent && tool.id).map(tool => tool.id!));
  const children = new Map<string, ToolActivity[]>();
  for (const tool of tools) {
    if (!tool.parentAgentId || !ids.has(tool.parentAgentId)) continue;
    const group = children.get(tool.parentAgentId) || [];
    if (!tool.id || !group.some(item => item.id === tool.id)) group.push(tool);
    children.set(tool.parentAgentId, group);
  }
  return { ids, children };
}
const AgentIndexContext = createContext<ReturnType<typeof buildMobileAgentIndex>>({ ids: new Set(), children: new Map() });

export function AgentToolsProvider(props: { messages: Message[]; liveTools: ToolActivity[]; children: ReactNode }) {
  const index = useMemo(() => buildMobileAgentIndex(props.messages, props.liveTools), [props.messages, props.liveTools]);
  return <AgentIndexContext.Provider value={index}>{props.children}</AgentIndexContext.Provider>;
}

function Summary({ content }: { content?: string }) {
  return content ? <details className="agent-summary"><summary>Summary</summary><p>{content}</p></details> : null;
}
function ToolRow({ activity }: { activity: ToolActivity }) {
  return <div className={`tool-block ${activity.status || ''}`}>
    <strong>{activity.tool}</strong><span>{activity.description || 'Tool activity'}</span>
    <span>{activity.outcome || (activity.duration != null ? 'done' : 'running')}</span>
    <Summary content={activity.summary}/>
  </div>;
}
export function ToolActivityView({ activity }: { activity: ToolActivity }) {
  const index = useContext(AgentIndexContext);
  if (activity.parentAgentId && index.ids.has(activity.parentAgentId)) return null;
  if (!activity.isAgent) return <ToolRow activity={activity}/>;
  return <section className={`agent-card ${activity.status || ''}`} aria-label="Subagent">
    <header><strong>{activity.subagentType || 'Agent'}</strong><span>{activity.outcome || (activity.duration != null ? 'done' : 'running')}</span></header>
    <p>{activity.description}</p>
    {(index.children.get(activity.id || '') || []).map((tool, index) => <ToolRow key={tool.id || index} activity={tool}/>)}
    <Summary content={activity.summary}/>
  </section>;
}
