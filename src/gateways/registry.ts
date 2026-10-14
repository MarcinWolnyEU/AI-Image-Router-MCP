import type { GatewayId } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { EdenAiGateway } from './edenai.js';
import { FalGateway } from './fal.js';
import { MistralGateway } from './mistral.js';
import { OpenRouterGateway } from './openrouter.js';
import type { Gateway } from './types.js';

/** Per-gateway options taken from `config.json`; each gateway reads only the part that concerns it. */
export interface GatewayOptions {
  /** fal only: send relaxed safety settings (`fal.relaxSafety`). */
  falRelaxSafety?: boolean;
}

export function createGateway(id: GatewayId, token: string, logger: Logger, options: GatewayOptions = {}): Gateway {
  switch (id) {
    case 'openrouter':
      return new OpenRouterGateway(token, logger);
    case 'mistral':
      return new MistralGateway(token, logger);
    case 'edenai':
      return new EdenAiGateway(token, logger);
    case 'fal':
      return new FalGateway(token, logger, { relaxSafety: options.falRelaxSafety ?? false });
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown gateway: ${String(_exhaustive)}`);
    }
  }
}
