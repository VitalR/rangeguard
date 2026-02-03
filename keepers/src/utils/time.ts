export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const deadlineFromNow = (seconds: number): bigint => {
  return BigInt(nowSeconds() + seconds);
};
