import { stellarTxConfirmationSeconds, setGauge } from "./metrics";

export class TxLatencyTracker {
  private pendingSubmissions = new Map<string, number>();

  public recordSubmission(txHash: string, timestampMs = Date.now()): void {
    this.pendingSubmissions.set(txHash, timestampMs);
  }

  public recordConfirmation(txHash: string, confirmedAtMs = Date.now()): number | null {
    const submittedAt = this.pendingSubmissions.get(txHash);
    if (!submittedAt) return null;

    this.pendingSubmissions.delete(txHash);
    const durationSeconds = Math.max(0, (confirmedAtMs - submittedAt) / 1000);
    setGauge(stellarTxConfirmationSeconds, durationSeconds, { tx: txHash });
    return durationSeconds;
  }
}

export const txLatencyTracker = new TxLatencyTracker();
