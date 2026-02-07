import { KeeperError } from "../utils/errors";

export const NEAR_BOUNDARY_TICK = 885000;

export const isTickNearBounds = (tick: number): boolean => Math.abs(tick) >= NEAR_BOUNDARY_TICK;

export const tickSanityMessage = (tick: number): string =>
  `Pool tick is near global bounds (tick=${tick}). Switch POOL_FEE/POOL_TICK_SPACING/POOL_HOOKS or set POOL_ID to a different pool. Use \`npm run probePools\` to find a working pool.`;

export const assertTickNotNearBounds = (tick: number): void => {
  if (isTickNearBounds(tick)) {
    throw new KeeperError(tickSanityMessage(tick));
  }
};
