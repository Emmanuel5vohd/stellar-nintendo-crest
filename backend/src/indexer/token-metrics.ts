import {
  ipredictTotalSupply,
  ipredictSupplyCap,
  ipredictCirculatingSupply,
  ipredictRewardsDistributedTotal,
  setGauge,
  incCounter,
} from "./metrics";

export const IPREDICT_MAX_CAP = 100_000_000;

export function updateTokenSupplyMetrics(circulating: number, totalMinted: number): void {
  setGauge(ipredictSupplyCap, IPREDICT_MAX_CAP);
  setGauge(ipredictTotalSupply, totalMinted);
  setGauge(ipredictCirculatingSupply, circulating);
}

export function recordTokenRewardDistribution(amount: number, category: "winner" | "loser" | "referrer"): void {
  incCounter(ipredictRewardsDistributedTotal, amount, { category });
}
