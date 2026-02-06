import { KeeperError } from "../utils/errors";

export const alignDown = (tick: number, spacing: number): number => {
  if (spacing <= 0) {
    throw new KeeperError("Invalid tick spacing");
  }
  return Math.floor(tick / spacing) * spacing;
};

export const alignUp = (tick: number, spacing: number): number => {
  if (spacing <= 0) {
    throw new KeeperError("Invalid tick spacing");
  }
  return Math.ceil(tick / spacing) * spacing;
};

export const isAligned = (tick: number, spacing: number): boolean => tick % spacing === 0;

export const computeRangeTicks = (tick: number, spacing: number, widthTicks: number) => {
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

export const centerRange = (tick: number, widthTicks: number, spacing: number) =>
  computeRangeTicks(tick, spacing, widthTicks);

export const computeBootstrapTicks = (tick: number, spacing: number, widthTicks: number) => {
  if (widthTicks <= 0) {
    throw new KeeperError("widthTicks must be positive");
  }
  if (widthTicks % spacing !== 0) {
    throw new KeeperError("widthTicks must be a multiple of tick spacing");
  }
  const half = widthTicks / 2;
  const rawLower = tick - half;
  const rawUpper = tick + half;
  const lower = alignDown(rawLower, spacing);
  const upper = alignUp(rawUpper, spacing);
  if (upper <= lower) {
    throw new KeeperError("Invalid tick range after alignment");
  }
  return { lower, upper };
};
