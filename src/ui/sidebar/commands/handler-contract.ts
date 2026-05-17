import type { SidebarCommand } from '../messages';
import type { AckPoster, RouterDeps } from './router-types';

export interface HandlerContext {
  readonly deps: RouterDeps;
  readonly postAck: AckPoster;
  readonly correlationId: string;
}

export type CommandHandler<C extends SidebarCommand = SidebarCommand> = (
  ctx: HandlerContext,
  command: C
) => Promise<void>;
