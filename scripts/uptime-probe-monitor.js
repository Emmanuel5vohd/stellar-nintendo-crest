#!/usr/bin/env node
'use strict';

/**
 * Synthetic uptime ping monitor for Soroban RPC endpoint and Horizon API.
 * Pings getLatestLedger on primary RPC with automatic failover to backup RPC.
 */

const PRIMARY_RPC = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const BACKUP_RPC = process.env.BACKUP_SOROBAN_RPC_URL || 'https://rpc-testnet.stellar.org';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const LATENCY_ALERT_THRESHOLD_MS = Number(process.env.RPC_LATENCY_THRESHOLD_MS) || 3000;

async function pingRpc(url) {
  const startedAt = Date.now();
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getLatestLedger',
    params: {},
  };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), LATENCY_ALERT_THRESHOLD_MS) : null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    const latency = Date.now() - startedAt;

    if (!res.ok) {
      return { ok: false, status: res.status, latency, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.error) {
      return { ok: false, status: 200, latency, error: data.error.message || 'RPC Error' };
    }
    return { ok: true, status: 200, latency, ledger: data.result?.sequence };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, latency: Date.now() - startedAt, error: err.message };
  }
}

async function pingHorizon(url) {
  const startedAt = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), LATENCY_ALERT_THRESHOLD_MS) : null;
  try {
    const res = await fetch(url, { signal: controller ? controller.signal : undefined });
    if (timer) clearTimeout(timer);
    return { ok: res.ok, status: res.status, latency: Date.now() - startedAt };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, latency: Date.now() - startedAt, error: err.message };
  }
}

async function runCheck() {
  console.log(`[${new Date().toISOString()}] Checking Primary RPC: ${PRIMARY_RPC}`);
  let rpcResult = await pingRpc(PRIMARY_RPC);
  let activeRpc = PRIMARY_RPC;

  if (!rpcResult.ok || rpcResult.latency > LATENCY_ALERT_THRESHOLD_MS) {
    console.warn(`[WARN] Primary RPC failed (${rpcResult.error || rpcResult.latency + 'ms'}). Failing over to backup RPC: ${BACKUP_RPC}`);
    const backupResult = await pingRpc(BACKUP_RPC);
    if (backupResult.ok) {
      console.log(`[FAILOVER] Backup RPC is operational (${backupResult.latency}ms).`);
      activeRpc = BACKUP_RPC;
      rpcResult = backupResult;
    } else {
      console.error(`[ALERT] Both primary and backup RPCs failed!`);
    }
  } else {
    console.log(`[OK] Primary RPC operational (${rpcResult.latency}ms, ledger: ${rpcResult.ledger})`);
  }

  const horizonResult = await pingHorizon(HORIZON_URL);
  console.log(`[HORIZON] Status: ${horizonResult.status} (${horizonResult.latency}ms)`);

  return { activeRpc, rpcResult, horizonResult };
}

if (require.main === module) {
  runCheck().then((res) => {
    if (!res.rpcResult.ok) process.exit(1);
    process.exit(0);
  });
}

module.exports = { runCheck, pingRpc, pingHorizon };
