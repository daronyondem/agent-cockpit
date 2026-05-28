export function isAgentCockpitSystemMessage(message){
  return !!(message && message.role === 'system' && !message.goalEvent);
}

export function messageAuthorLabel(message, assistantName){
  if (!message) return assistantName || 'assistant';
  if (message.role === 'user') return 'You';
  if (message.goalEvent) return 'Goal';
  if (isAgentCockpitSystemMessage(message)) return 'Agent Cockpit';
  return assistantName || 'assistant';
}

export function messageAvatarBackend(message){
  if (isAgentCockpitSystemMessage(message)) return null;
  return (message && message.backend) || null;
}

export function pinMessageSourceLabel(message){
  if (!message) return 'Message';
  if (message.role === 'user') return 'You';
  if (message.goalEvent) return 'Goal';
  if (isAgentCockpitSystemMessage(message)) return 'Agent Cockpit';
  return message.backend || 'Assistant';
}
