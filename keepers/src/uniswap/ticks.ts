import { KeeperError } from "../utils/errors";

export const alignDown = (tick: number, spacing: number): number => {
  if (spacing <= 0) {
    throw new KeeperError("Invalid tick spacing");
  }
  return Math.floor(tick / spacing) * spacing;
};

export const isAligned = (tick: number, spacing: number): boolean => tick % spacing === 0;

export const centerRange = (tick: number, widthTicks: number, spacing: number) => {
  if (widthTicks <= 0) {
    throw new KeeperError("widthTicks must be positive");
  }
  if (widthTicks % spacing !== 0) {
    throw new KeeperError("widthTicks must be a multiple of tick spacing");
  }
  const half = Math.floor(widthTicks / 2);
  const lower = alignDown(tick - half, spacing);
  const upper = lower + widthTicks;
  if (lower >= upper) {
    throw new KeeperError("Invalid tick range");
  }
  if (!isAligned(lower, spacing) || !isAligned(upper, spacing)) {
    throw new KeeperError("Tick range not aligned to spacing");
  }
  return { lower, upper };
};
