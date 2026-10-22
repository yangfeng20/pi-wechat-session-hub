/**
 * iLink 回复所需的临时上下文, 仅随待处理消息持久化。
 */
export interface IlinkReplyContext {
  recipientId: string;
  contextToken: string;
}

/**
 * 由 channel adapter 统一后的 Gateway 入站消息。
 */
export interface GatewayInboundMessage {
  messageId: string;
  senderId: string;
  text: string;
  replyContext?: IlinkReplyContext;
}

/**
 * iLink getupdates 返回的单条消息及 text item 数据结构。
 */
export interface IlinkTextMessage {
  message_id?: number | string;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: Array<{
    type?: number;
    text_item?: {
      text?: string;
    };
  }>;
}

/**
 * iLink getupdates 的批次响应。
 */
export interface IlinkGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkTextMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}
