// ── WebSocket Frame Types ────────────────────────────────────────────

import type { Message } from './chat';
import type { StreamEvent } from './streams';

export interface WsInputFrame {
  type: 'input';
  text: string;
}

export interface WsAbortFrame {
  type: 'abort';
}

export interface WsReconnectFrame {
  type: 'reconnect';
}

export type WsClientFrame = WsInputFrame | WsAbortFrame | WsReconnectFrame;

export interface WsTitleUpdatedFrame {
  type: 'title_updated';
  title: string;
}

export interface WsAssistantMessageFrame {
  type: 'assistant_message';
  message: Message;
}

export interface WsTurnCompleteFrame {
  type: 'turn_complete';
}

export interface WsReplayStartFrame {
  type: 'replay_start';
  bufferedEvents: number;
}

export interface WsReplayEndFrame {
  type: 'replay_end';
}

export type WsServerFrame =
  | StreamEvent
  | WsTitleUpdatedFrame
  | WsAssistantMessageFrame
  | WsTurnCompleteFrame
  | WsReplayStartFrame
  | WsReplayEndFrame;
