/**
 * Deterministic synthetic event generator.
 *
 * Produces `RawEventInput`-shaped events (what `insertEvents` accepts) with
 * hand-built XDR, so the full decode + insert path is what gets measured, and
 * the same seed always yields the same database.
 *
 * Shape, on purpose realistic rather than uniform:
 *  - 1000 contracts with a long-tail popularity (a few are very hot)
 *  - 5000 accounts, also skewed, so address filters have hot and cold cases
 *  - ~65% SAC-style `transfer` events (symbol, from, to + i128 amount), the
 *    rest mint / burn / approve / swap, plus a very rare topic for search
 */
import { StrKey } from '@stellar/stellar-sdk';

const CONTRACTS = 1000;
const ACCOUNTS = 5000;
const EVENTS_PER_LEDGER = 20;
const LEDGER_SECONDS = 5;
const BASE_LEDGER = 4_000_000;
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const RARE_RATE = 0.0002;

export const RARE_SEARCH_TERM = 'unobtainium';
const RARE_TOPIC = 'unobtainium_event';

/** mulberry32: tiny seeded PRNG, so a run is reproducible from `--seed`. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function u32(n) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(n);
  return buffer;
}

function randomBytes32(rng) {
  const buffer = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) buffer.writeUInt32BE(Math.floor(rng() * 4294967296), i * 4);
  return buffer;
}

/** ScVal::Symbol (discriminant 15): length-prefixed, padded to 4 bytes. */
function symbolXdr(text) {
  const bytes = Buffer.from(text, 'utf8');
  const padding = (4 - (bytes.length % 4)) % 4;
  return Buffer.concat([u32(15), u32(bytes.length), bytes, Buffer.alloc(padding)]).toString('base64');
}

/**
 * ScVal::Address (discriminant 18). kind 0 = account, 1 = contract.
 * An account is a PublicKey union, so it carries its own key-type tag
 * (0 = ed25519) before the 32 key bytes; a contract id is bare bytes.
 */
function addressXdr(kind, key) {
  const parts = kind === 0 ? [u32(18), u32(0), u32(0), key] : [u32(18), u32(1), key];
  return Buffer.concat(parts).toString('base64');
}

/** ScVal::I128 (discriminant 10) for a non-negative value below 2^53. */
function i128Xdr(value) {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt32BE(10, 0);
  buffer.writeBigInt64BE(0n, 4);
  buffer.writeBigUInt64BE(BigInt(value), 12);
  return buffer.toString('base64');
}

/** ScVal::U32 (discriminant 3). */
function u32Xdr(value) {
  return Buffer.concat([u32(3), u32(value)]).toString('base64');
}

function hex64(rng) {
  let out = '';
  for (let i = 0; i < 8; i++) out += Math.floor(rng() * 4294967296).toString(16).padStart(8, '0');
  return out;
}

/**
 * @param {{ events: number, seed: number }} options
 * `info` is filled in as batches are generated; it is complete once the
 * `batches()` generator has been fully consumed.
 */
export function createDataset({ events, seed }) {
  const rng = mulberry32(seed);
  const contracts = Array.from({ length: CONTRACTS }, () => StrKey.encodeContract(randomBytes32(rng)));
  const accounts = Array.from({ length: ACCOUNTS }, () => addressXdr(0, randomBytes32(rng)));
  const accountCounts = new Uint32Array(ACCOUNTS);

  const symbols = {
    transfer: symbolXdr('transfer'),
    mint: symbolXdr('mint'),
    burn: symbolXdr('burn'),
    approve: symbolXdr('approve'),
    swap: symbolXdr('swap'),
    rare: symbolXdr(RARE_TOPIC),
  };

  const info = {
    events,
    seed,
    baseLedger: BASE_LEDGER,
    lastLedger: BASE_LEDGER,
    baseTime: BASE_TIME,
    ledgerSeconds: LEDGER_SECONDS,
    midId: '',
    midLedger: BASE_LEDGER,
    midTxHash: '',
    rareCount: 0,
    hotAccountXdr: '',
    coldAccountXdr: '',
  };

  const middle = Math.floor(events / 2);
  const pickAccount = () => {
    const index = Math.floor(ACCOUNTS * rng() ** 2);
    accountCounts[index]++;
    return accounts[index];
  };

  function* batches(size) {
    let batch = [];
    let ledger = BASE_LEDGER;
    let closedAt = '';

    for (let i = 0; i < events; i++) {
      const k = i % EVENTS_PER_LEDGER;
      if (k === 0) {
        ledger = BASE_LEDGER + i / EVENTS_PER_LEDGER;
        const seconds = BASE_TIME + (ledger - BASE_LEDGER) * LEDGER_SECONDS;
        closedAt = new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
      }

      // Ids sort chronologically and are fixed width, like real Soroban ids.
      const toid = BigInt(ledger) * 4294967296n + BigInt(k) * 4096n;
      const id = `${toid.toString().padStart(19, '0')}-0000000000`;
      const contractId = contracts[Math.floor(CONTRACTS * rng() ** 3)];

      let topic;
      let value;
      if (rng() < RARE_RATE) {
        topic = [symbols.rare];
        value = u32Xdr(Math.floor(rng() * 1000));
        info.rareCount++;
      } else {
        const kind = rng();
        if (kind < 0.65) {
          topic = [symbols.transfer, pickAccount(), pickAccount()];
          value = i128Xdr(1 + Math.floor(rng() * 1e9));
        } else if (kind < 0.75) {
          topic = [symbols.mint, pickAccount()];
          value = i128Xdr(1 + Math.floor(rng() * 1e9));
        } else if (kind < 0.85) {
          topic = [symbols.burn, pickAccount()];
          value = i128Xdr(1 + Math.floor(rng() * 1e9));
        } else if (kind < 0.95) {
          topic = [symbols.approve, pickAccount(), pickAccount()];
          value = i128Xdr(1 + Math.floor(rng() * 1e9));
        } else {
          topic = [symbols.swap, pickAccount()];
          value = u32Xdr(Math.floor(rng() * 1000));
        }
      }

      const txHash = hex64(rng);
      if (i === middle) {
        info.midId = id;
        info.midLedger = ledger;
        info.midTxHash = txHash;
      }
      info.lastLedger = ledger;

      batch.push({
        id,
        type: 'contract',
        ledger,
        ledgerClosedAt: closedAt,
        contractId,
        topic,
        value,
        txHash,
        transactionIndex: k,
        operationIndex: 0,
        inSuccessfulContractCall: rng() > 0.02,
      });

      if (batch.length >= size) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;

    // Hottest and coldest account that actually appears, for address filters.
    let hot = 0;
    let cold = -1;
    for (let a = 0; a < ACCOUNTS; a++) {
      const count = accountCounts[a];
      if (count > accountCounts[hot]) hot = a;
      if (count > 0 && (cold === -1 || count < accountCounts[cold])) cold = a;
    }
    info.hotAccountXdr = accounts[hot];
    info.coldAccountXdr = accounts[cold === -1 ? hot : cold];
  }

  return { info, batches };
}
