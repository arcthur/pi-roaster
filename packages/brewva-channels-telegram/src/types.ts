export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number | string;
  type: TelegramChatType;
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type TelegramSendMethod =
  | "sendMessage"
  | "sendPhoto"
  | "sendDocument"
  | "answerCallbackQuery";

export interface TelegramOutboundRequest {
  method: TelegramSendMethod;
  params: Record<string, unknown>;
}
