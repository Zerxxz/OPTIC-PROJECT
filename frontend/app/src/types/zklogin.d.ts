/**
 * zkLogin session shape (returned by zklogin.mjs)
 */
export interface ZkLoginSession {
  suiAddress: string;
  jwt?: string;
  userSalt?: string;
  ephemeralKeyPair?: unknown;
  zkProof?: unknown;
  maxEpoch?: number;
}

export interface ZkLoginConfig {
  network: 'testnet' | 'mainnet' | 'devnet';
  googleClientId: string;
  saltUrl: string;
}

export interface ConnectOpts {
  onStage?: (stage: string) => void;
}

export interface ZkLoginModule {
  configureZkLogin(cfg: ZkLoginConfig): void;
  loadSession(): ZkLoginSession | null;
  clearSession(): void;
  connectZkLogin(opts?: ConnectOpts): Promise<ZkLoginSession>;
}
