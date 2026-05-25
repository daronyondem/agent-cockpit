import React from 'react';

import { formatMsgElapsed } from './chatTime.js';
import { deriveBlocks } from './messageModel.js';

/* Legacy fallback: for tool activities persisted before the server started
   tagging `batchIndex`, we approximate parallel grouping by startTime proximity. */
const PARALLEL_THRESHOLD_MS = 500;

/* Cross-message subagent linkage. Because a subagent's Agent tool_use and its
   internal children can be persisted on different messages, we precompute the
   full agent/child index at the feed level and make it available to every
   ToolRun down the tree. */
const AgentIndexContext = React.createContext({ agentIds: new Set(), childrenByAgent: new Map() });

/* Renders a contiguous run of tool activities, nesting subagent children and
   splitting remaining tools into parallel/sequential groups. */
export function ToolRun({ tools }){
  const agentIndex = React.useContext(AgentIndexContext);
  const segments = partitionToolRun(tools, agentIndex);
  return <>{segments.map((s, i) => renderToolSegment(s, i))}</>;
}

function renderToolSegment(seg, key){
  if (seg.type === 'agent') {
    return <SubagentCard key={key} activity={seg.activity} childGroups={seg.children}/>;
  }
  return <ToolGroup key={key} group={seg}/>;
}

/* Pull agents out of the run and interleave them with parallel/sequential
   groups of the remaining tools. Children, including ones persisted on
   messages other than the Agent's own, come from the cross-message index. */
export function partitionToolRun(tools, agentIndex){
  const { agentIds, childrenByAgent } = agentIndex || { agentIds: new Set(), childrenByAgent: new Map() };
  const segments = [];
  let plainBuf = [];
  const flushPlain = () => {
    if (plainBuf.length) {
      for (const g of partitionParallel(plainBuf)) segments.push(g);
      plainBuf = [];
    }
  };
  for (const t of tools) {
    if (!t) continue;
    if (t.isAgent) {
      flushPlain();
      segments.push({
        type: 'agent',
        activity: t,
        children: partitionParallel(childrenByAgent.get(t.id) || []),
      });
    } else if (t.parentAgentId && agentIds.has(t.parentAgentId)) {
      // Rendered inside its parent's card wherever that card appears.
    } else {
      plainBuf.push(t);
    }
  }
  flushPlain();
  return segments;
}

/* Merge consecutive tools that share a server-assigned batchIndex into a
   parallel group. Tools across different batchIndex values are sequential.
   Legacy tools without batchIndex fall back to startTime proximity. */
export function partitionParallel(tools){
  if (!tools || tools.length === 0) return [];
  if (tools.length === 1) return [{ type: 'sequential', items: [tools[0]] }];
  const close = [];
  for (let i = 1; i < tools.length; i++) {
    const a = tools[i-1];
    const b = tools[i];
    if (a && b && a.batchIndex != null && b.batchIndex != null) {
      close.push(a.batchIndex === b.batchIndex);
    } else {
      const aStart = (a && a.startTime) || 0;
      const bStart = (b && b.startTime) || 0;
      close.push(Math.abs(bStart - aStart) <= PARALLEL_THRESHOLD_MS);
    }
  }
  const groups = [];
  let i = 0;
  while (i < tools.length) {
    if (i + 1 < tools.length && close[i]) {
      let j = i;
      while (j + 1 < tools.length && close[j]) j++;
      groups.push({ type: 'parallel', items: tools.slice(i, j + 1) });
      i = j + 1;
    } else {
      let j = i;
      while (j + 1 < tools.length && !close[j]) j++;
      groups.push({ type: 'sequential', items: tools.slice(i, j + 1) });
      i = j + 1;
    }
  }
  return groups;
}

/* Walks every message, builds the set of all Agent ids and a children map
   (agentId -> flat list of child tool activities in chronological order). */
export function buildAgentIndex(messages){
  const agentIds = new Set();
  const childrenByAgent = new Map();
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant') continue;
    const blocks = deriveBlocks(m);
    for (const b of blocks) {
      if (b && b.type === 'tool' && b.activity && b.activity.isAgent && b.activity.id) {
        agentIds.add(b.activity.id);
        if (!childrenByAgent.has(b.activity.id)) childrenByAgent.set(b.activity.id, []);
      }
    }
  }
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant') continue;
    const blocks = deriveBlocks(m);
    for (const b of blocks) {
      if (b && b.type === 'tool' && b.activity) {
        const t = b.activity;
        if (t.parentAgentId && childrenByAgent.has(t.parentAgentId)) {
          childrenByAgent.get(t.parentAgentId).push(t);
        }
      }
    }
  }
  return { agentIds, childrenByAgent };
}

export function AgentIndexProvider({ messages, children }){
  const value = React.useMemo(() => buildAgentIndex(messages), [messages]);
  return <AgentIndexContext.Provider value={value}>{children}</AgentIndexContext.Provider>;
}

function ToolGroup({ group }){
  const showHeader = group.type === 'parallel' || group.items.length >= 2;
  const cls = group.type === 'parallel' ? 'tools parallel' : 'tools';
  return (
    <div className={cls}>
      {group.type === 'parallel' ? <span className="rail"/> : null}
      {showHeader ? (
        <div className="tools-head">
          <span className={`tag ${group.type}`}>{group.type}</span>
          <span>{group.items.length} step{group.items.length !== 1 ? 's' : ''}</span>
        </div>
      ) : null}
      {group.items.map((t, i) => <ToolRow key={t.id || i} activity={t}/>)}
    </div>
  );
}

function SubagentCard({ activity, childGroups }){
  const label = activity.description || activity.tool || 'agent';
  return (
    <div className="subagent">
      <div className="subagent-head">
        <span className="chip">{activity.subagentType || 'agent'}</span>
        <span className="title">{label}</span>
        <span className="elapsed">
          {activity.outcome
            ? ''
            : activity.duration != null
              ? `${activity.duration}ms`
              : activity.startTime
                ? <LiveElapsed startTime={activity.startTime}/>
                : '…'}
        </span>
      </div>
      {childGroups && childGroups.length
        ? childGroups.map((g, i) => <ToolGroup key={i} group={g}/>)
        : null}
    </div>
  );
}

/* Live-ticking elapsed for still-running tools / subagents. */
function LiveElapsed({ startTime }){
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatMsgElapsed(Math.max(0, now - startTime))}</>;
}

function ToolRow({ activity }){
  const state = activity.status === 'error'
    ? 'err'
    : activity.outcome
      ? 'done'
      : activity.duration != null
        ? 'done'
        : 'run';
  return (
    <div className={`tool ${state}`}>
      <span className="marker"/>
      <span>
        <span className="name">{activity.tool}</span>
        {activity.description ? <> <span className="arg">{activity.description}</span></> : null}
      </span>
      <span className="ms">
        {activity.outcome
          ? activity.outcome
          : activity.duration != null
            ? `${activity.duration}ms`
            : activity.startTime
              ? <LiveElapsed startTime={activity.startTime}/>
              : '…'}
      </span>
      <span/>
    </div>
  );
}
