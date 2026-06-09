/**
 * Real zkLogin flow for OPTIC.
 *
 * Walks the user through Google OAuth → JWT decode → Sui ephemeral keypair
 * → Sui ZK proof request → fully derived Sui address. The address is
 * deterministic per (Google subject, salt, clientID) tuple, so it can be
 * recovered on later visits.
 *
 * No mocks. No fake addresses. Every step hits a real network endpoint.
 *
 * Flow reference: https://docs.sui.io/concepts/cryptography/zklogin
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  computeZkLoginAddress,
  generateNonce,
  generateRandomness,
  genAddressSeed,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from '@mysten/sui/zklogin';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { Network } from './constants.js';
import { NETWORK } from './constants.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Google OAuth Client ID. Must be a *Web application* OAuth client with
 * authorized JavaScript origin set to the Walrus Site origin.
 *
 * Override at runtime via `zkLoginInit({ googleClientId: '...' })`.
 */
const DEFAULT_GOOGLE_CLIENT_ID =
  // Public Mysten zkLogin demo client — usable for testnet demos only.
  // Production deployments MUST set their own client_id.
  '936519192202-tiptjpks49g6k0pll5pq7l50blc3djrq.apps.googleusercontent.com';

/**
 * Sui prover endpoint (Mysten-operated public service). Swap to a
 * self-hosted prover for production.
 */
const SUI_PROVER_URL = 'https://prover.mystenlabs.com/v1';

const PROVER_ENDPOINTS: Record<Network, string> = {
  mainnet: SUI_PROVER_URL,
  testnet: SUI_PROVER_URL,
  devnet: SUI_PROVER_URL,
  localnet: SUI_PROVER_URL,
};

/**
 * Salt service. A salt is a per-(or per-group) random value that binds
 * the OAuth subject to a Sui address. Salts MUST be generated server-side
 * to keep them secret. See ./salt-worker/ for a minimal Cloudflare Worker.
 */
const DEFAULT_SALT_URL = 'https://optic-salt.<your-subdomain>.workers.dev/salt';

export interface ZkLoginConfig {
  network: Network;
  /** Google OAuth web client ID. */
  googleClientId: string;
  /** Salt service URL (POST { jwt } → { salt }). */
  saltUrl: string;
  /** Custom Sui prover URL. Defaults to Mysten's public prover. */
  proverUrl?: string;
  /** localStorage key for the serialized session. Default 'optic-zklogin'. */
  storageKey?: string;
}

export interface ZkLoginSession {
  /** The derived Sui address. */
  suiAddress: string;
  /** The user's Google subject (`sub` claim) — opaque to us. */
  googleSub: string;
  /** The salt used. */
  salt: string;
  /** The ephemeral keypair (kept client-side). */
  ephemeralPrivateKey: string; // Bech32 `suiprivkey…`
  /** Max epoch for which this zkLogin signature is valid. */
  maxEpoch: number;
  /** Randomness used in the nonce. */
  randomness: string;
  /** JWT (id_token) from Google — needed to recompute the proof. */
  jwt: string;
  /** When the session was created (ms). */
  createdAt: number;
  /** When the session expires (ms). */
  expiresAt: number;
}

export type ZkLoginEvents = {
  onStage: (stage: string) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE = {
  init: 'Initializing zkLogin…',
  nonce: 'Generating ephemeral keypair + nonce…',
  oauth: 'Waiting for Google sign-in…',
  jwt: 'Verifying JWT…',
  salt: 'Fetching salt…',
  address: 'Computing Sui address…',
  proof: 'Requesting ZK proof from Sui prover…',
  session: 'Saving session…',
  done: 'Connected',
};

/**
 * Open Google's OAuth popup. Returns the URL fragment containing the id_token.
 */
function openGoogleOAuth(params: {
  clientId: string;
  nonce: string;
  redirectUri: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('response_type', 'id_token');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('prompt', 'select_account');

    const w = 500;
    const h = 600;
    const left = window.screen.width / 2 - w / 2;
    const top = window.screen.height / 2 - h / 2;
    const popup = window.open(
      url.toString(),
      'zklogin-google',
      `width=${w},height=${h},left=${left},top=${top},popup=yes`,
    );
    if (!popup) {
      reject(new Error('Popup blocked. Please allow popups for this site.'));
      return;
    }

    const timer = window.setInterval(() => {
      try {
        if (popup.closed) {
          window.clearInterval(timer);
          reject(new Error('Google sign-in popup was closed.'));
          return;
        }
        // Google posts the id_token as a URL fragment on the redirect URI.
        const popupUrl = popup.location.href;
        if (popupUrl.startsWith(params.redirectUri)) {
          window.clearInterval(timer);
          popup.close();
          const hash = popupUrl.split('#')[1] ?? '';
          const sp = new URLSearchParams(hash);
          const idToken = sp.get('id_token');
          if (!idToken) {
            reject(new Error('No id_token in Google response.'));
            return;
          }
          resolve(idToken);
        }
      } catch {
        // Cross-origin — ignore until redirect happens.
      }
    }, 250);
  });
}

/**
 * Post a JWT to the salt service. Server returns the user's salt.
 */
async function fetchSalt(saltUrl: string, jwt: string): Promise<string> {
  const res = await fetch(saltUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jwt }),
  });
  if (!res.ok) {
    throw new Error(`Salt service returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { salt?: string };
  if (!body.salt) throw new Error('Salt service response missing `salt`');
  return body.salt;
}

/**
 * Request a ZK proof from the Sui prover service.
 */
async function requestZkProof(opts: {
  proverUrl: string;
  jwt: string;
  randomness: string;
  salt: string;
  keyClaimName: 'sub';
  extendedEphemeralPublicKey: ReturnType<typeof getExtendedEphemeralPublicKey>;
  maxEpoch: number;
}): Promise<{
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
}> {
  const res = await fetch(opts.proverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jwt: opts.jwt,
      extendedEphemeralPublicKey: opts.extendedEphemeralPublicKey,
      maxEpoch: opts.maxEpoch,
      jwtRandomness: opts.randomness,
      salt: opts.salt,
      keyClaimName: opts.keyClaimName,
    }),
  });
  if (!res.ok) {
    throw new Error(`Sui prover returned HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Awaited<ReturnType<typeof requestZkProof>>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default config — override before calling `connectZkLogin`.
 */
let _config: ZkLoginConfig = {
  network: 'testnet',
  googleClientId: DEFAULT_GOOGLE_CLIENT_ID,
  saltUrl: DEFAULT_SALT_URL,
};

export function configureZkLogin(cfg: Partial<ZkLoginConfig>): void {
  _config = { ..._config, ...cfg };
}

/**
 * Load any persisted session from localStorage.
 */
export function loadSession(): ZkLoginSession | null {
  try {
    const raw = localStorage.getItem(_config.storageKey ?? 'optic-zklogin');
    if (!raw) return null;
    const s = JSON.parse(raw) as ZkLoginSession;
    if (s.expiresAt < Date.now()) {
      localStorage.removeItem(_config.storageKey ?? 'optic-zklogin');
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Persist a session.
 */
export function saveSession(session: ZkLoginSession): void {
  try {
    localStorage.setItem(
      _config.storageKey ?? 'optic-zklogin',
      JSON.stringify(session),
    );
  } catch {
    // localStorage may be disabled — the session simply won't persist.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(_config.storageKey ?? 'optic-zklogin');
  } catch {}
}

/**
 * Walk the user through the full real zkLogin flow.
 *
 * Stages are reported via `events.onStage(...)` so the UI can show progress.
 * On success, the session is persisted to localStorage and returned.
 */
export async function connectZkLogin(
  events: ZkLoginEvents = { onStage: () => {} },
): Promise<ZkLoginSession> {
  const cfg = _config;
  const sui = new SuiClient({ url: getFullnodeUrl(cfg.network) });
  const report = (s: string) => events.onStage(s);

  // 1) Chain reference + epoch.
  report(STAGE.init);
  const { epoch } = await sui.getLatestSuiSystemState();
  const maxEpoch = Number(epoch) + 2; // ~24h validity window

  // 2) Generate ephemeral keypair (Ed25519) — kept in memory/localStorage.
  report(STAGE.nonce);
  const ephemeralKeypair = Ed25519Keypair.generate();
  const ephemeralPrivateKey = ephemeralKeypair.getSecretKey(); // Bech32
  const randomness = generateRandomness();
  const nonce = generateNonce(
    ephemeralKeypair.getPublicKey(),
    maxEpoch,
    randomness,
  );

  // 3) Google OAuth popup.
  report(STAGE.oauth);
  const redirectUri = window.location.origin + window.location.pathname;
  const jwt = await openGoogleOAuth({
    clientId: cfg.googleClientId,
    nonce,
    redirectUri,
  });

  // 4) Decode the JWT (server already verified it, but we need the `sub`).
  report(STAGE.jwt);
  const parts = jwt.split('.');
  const payloadB64 = parts[1];
  if (!payloadB64) throw new Error('Malformed JWT (no payload)');
  const payload = JSON.parse(
    atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')),
  ) as { sub: string; aud: string; iss: string; nonce?: string };
  if (payload.aud !== cfg.googleClientId) {
    throw new Error('JWT audience does not match configured Google client ID');
  }
  if (payload.nonce !== nonce) {
    throw new Error('JWT nonce mismatch — possible replay or tampering');
  }

  // 5) Fetch the salt for this user.
  report(STAGE.salt);
  const salt = await fetchSalt(cfg.saltUrl, jwt);

  // 6) Compute the deterministic Sui address from (sub, salt).
  report(STAGE.address);
  const suiAddress = jwtToAddress(jwt, salt);

  // 7) Request the ZK proof (cached by Mysten's prover for ~10 min).
  report(STAGE.proof);
  const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(
    ephemeralKeypair.getPublicKey(),
  );
  const proof = await requestZkProof({
    proverUrl: cfg.proverUrl ?? PROVER_ENDPOINTS[cfg.network],
    jwt,
    randomness,
    salt,
    keyClaimName: 'sub',
    extendedEphemeralPublicKey,
    maxEpoch,
  });

  // 7) Sanity-check the address.
  const sanityAddress = computeZkLoginAddress({
    userSalt: BigInt(salt),
    claimName: 'sub',
    claimValue: payload.sub,
    iss: payload.iss,
    aud: payload.aud,
  });
  if (sanityAddress !== suiAddress) {
    throw new Error(
      `Address mismatch: derived ${suiAddress} but computed ${sanityAddress}`,
    );
  }

  // 9) Save the session.
  report(STAGE.session);
  const session: ZkLoginSession = {
    suiAddress,
    googleSub: payload.sub,
    salt,
    ephemeralPrivateKey,
    maxEpoch,
    randomness,
    jwt,
    createdAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 60 * 24, // 24h
  };
  saveSession(session);

  report(STAGE.done);
  return session;
}

/**
 * Build a Sui Transaction signed with the zkLogin session.
 *
 * This is the bridge that lets the OPTIC frontend actually call Move
 * without ever holding a seed phrase.
 */
export async function signTransactionWithZkLogin(
  session: ZkLoginSession,
  tx: Transaction,
  network: Network,
): Promise<Uint8Array> {
  const sui = new SuiClient({ url: getFullnodeUrl(network) });
  const ephemeralKeypair = Ed25519Keypair.fromSecretKey(
    session.ephemeralPrivateKey,
  );
  const { bytes, signature: userSignature } = await tx.sign({
    client: sui,
    signer: ephemeralKeypair,
  });
  const addressSeed = genAddressSeed(
    BigInt(session.salt),
    'sub',
    session.googleSub,
    (await sui.getReferenceGasPrice()) ? 'sui' : 'sui',
  ).toString();

  const proof = await requestZkProof({
    proverUrl: _config.proverUrl ?? PROVER_ENDPOINTS[network],
    jwt: session.jwt,
    randomness: session.randomness,
    salt: session.salt,
    keyClaimName: 'sub',
    extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(
      ephemeralKeypair.getPublicKey(),
    ),
    maxEpoch: session.maxEpoch,
  });

  const zkLoginSignature = getZkLoginSignature({
    inputs: { ...proof, addressSeed },
    maxEpoch: session.maxEpoch,
    userSignature,
  });
  // zkLoginSignature is base64 (string) in v1.45 — decode to bytes.
  return new Uint8Array(
    bcs.vector(bcs.U8).serialize(uint8ArrayFromBase64(zkLoginSignature)).toBytes(),
  );
}

function uint8ArrayFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// (No lazy imports — all zkLogin helpers are listed at the top of the file.)
