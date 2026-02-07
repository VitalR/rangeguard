import { KeeperError } from "../utils/errors";

const MIN_TICK = -887272;
const MAX_TICK = 887272;

export type BootstrapMode = "IN_RANGE" | "ABOVE_MAX" | "BELOW_MIN";

export const minAlignedTick = (spacing: number): number => Math.ceil(MIN_TICK / spacing) * spacing;
export const maxAlignedTick = (spacing: number): number => Math.floor(MAX_TICK / spacing) * spacing;

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
  const minTick = minAlignedTick(spacing);
  const maxTick = maxAlignedTick(spacing);
  if (tick < minTick || tick > maxTick) {
    throw new KeeperError("tick outside supported range for spacing");
  }
  if (widthTicks > maxTick - minTick) {
    throw new KeeperError("widthTicks exceeds allowed tick range");
  }
  const half = Math.floor(widthTicks / 2);
  const lower = alignDown(tick - half, spacing);
  let upper = lower + widthTicks;
  let adjustedLower = lower;
  if (adjustedLower < minTick) {
    adjustedLower = minTick;
    upper = adjustedLower + widthTicks;
  } else if (upper > maxTick) {
    upper = maxTick;
    adjustedLower = upper - widthTicks;
  }
  if (adjustedLower >= upper) {
    throw new KeeperError("Invalid tick range");
  }
  if (!isAligned(adjustedLower, spacing) || !isAligned(upper, spacing)) {
    throw new KeeperError("Tick range not aligned to spacing");
  }
  return { lower: adjustedLower, upper };
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
  const minTick = minAlignedTick(spacing);
  const maxTick = maxAlignedTick(spacing);
  if (widthTicks > maxTick - minTick) {
    throw new KeeperError("widthTicks exceeds allowed tick range");
  }
  const half = widthTicks / 2;
  const rawLower = tick - half;
  const rawUpper = tick + half;
  let lower = alignDown(rawLower, spacing);
  let upper = alignUp(rawUpper, spacing);
  let mode: BootstrapMode = "IN_RANGE";
  if (tick > maxTick) {
    mode = "ABOVE_MAX";
  } else if (tick < minTick) {
    mode = "BELOW_MIN";
  }
  if (upper > maxTick) {
    upper = maxTick;
    lower = upper - widthTicks;
    if (mode === "IN_RANGE" && tick > maxTick) {
      mode = "ABOVE_MAX";
    }
  } else if (lower < minTick) {
    lower = minTick;
    upper = lower + widthTicks;
    if (mode === "IN_RANGE" && tick < minTick) {
      mode = "BELOW_MIN";
    }
  }
  if (upper <= lower) {
    throw new KeeperError("Invalid tick range after alignment");
  }
  return { lower, upper, spacing, mode, maxAligned: maxTick, minAligned: minTick };
};
