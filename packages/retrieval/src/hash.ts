import { createHash } from 'node:crypto';

import { sha256Schema, type Sha256 } from '@news-writer/shared';

export const sha256Bytes = (bytes: Uint8Array): Sha256 =>
  sha256Schema.parse(createHash('sha256').update(bytes).digest('hex'));

export const sha256Text = (text: string): Sha256 => sha256Bytes(new TextEncoder().encode(text));
