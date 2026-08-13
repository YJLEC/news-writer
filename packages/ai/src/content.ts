import type { ChatCompletionResult } from './contracts.js';

export interface ContentAcceptancePort {
  accept(result: ChatCompletionResult): Promise<ChatCompletionResult>;
}
