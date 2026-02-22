export interface ChannelCapabilities {
  streaming: boolean;
  inlineActions: boolean;
  codeBlocks: boolean;
  multiModal: boolean;
  threadedReplies: boolean;
}

export const DEFAULT_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  inlineActions: false,
  codeBlocks: true,
  multiModal: false,
  threadedReplies: false,
};

export function resolveChannelCapabilities(
  partial: Partial<ChannelCapabilities>,
): ChannelCapabilities {
  return {
    streaming: partial.streaming ?? DEFAULT_CHANNEL_CAPABILITIES.streaming,
    inlineActions: partial.inlineActions ?? DEFAULT_CHANNEL_CAPABILITIES.inlineActions,
    codeBlocks: partial.codeBlocks ?? DEFAULT_CHANNEL_CAPABILITIES.codeBlocks,
    multiModal: partial.multiModal ?? DEFAULT_CHANNEL_CAPABILITIES.multiModal,
    threadedReplies: partial.threadedReplies ?? DEFAULT_CHANNEL_CAPABILITIES.threadedReplies,
  };
}
