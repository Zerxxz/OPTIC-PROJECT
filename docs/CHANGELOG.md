# Changelog

All notable changes to OPTIC are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-06-08

### Added
- 5 Move modules (`core`, `treasury`, `deepbook_adapter`, `walrus_adapter`,
  `predict_adapter`) with **38/38 unit tests passing**.
- TypeScript SDK (`sdk/`) with `OpticClient`, `AgentBuilder`, `Treasury`,
  `WalrusAudit`, `DeepBookClient`, `PredictClient`.
- Multi-agent orchestrator (`orchestrator/`) with `QuantAgent`, `RiskAgent`,
  `ExecutorAgent`, and 3 pluggable strategies (mean-reversion, momentum,
  market-making). **12/12 integration tests passing**.
- Walrus Site frontend (`frontend/site/`) — static, no build step,
  zkLogin stub, live decision log with filters.
- Deployment scripts (`scripts/publish.sh`, `scripts/init-agent.sh`).
- Demo cycle runner (`scripts/demo-cycle.mts`).
- Identity: `optic.sui` (main), `quant.sui`, `risk.sui`, `executor.sui`.
- Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/DEMO.md`,
  `docs/TRACKS.md`, `docs/CHANGELOG.md`.

### Notes
- SDK is shimmed with `sdk-stub/` for orchestrator test isolation.
  The real SDK depends on `@mysten/sui@^1.69.0` which has been
  superseded by `2.x` on npm; the stub preserves the type surface
  used by the orchestrator. For production deploys, the stub is
  replaced by the real SDK via tsconfig path mapping.
