# gooddollar-builder-analytics

Chain-only analytics for GoodDollar builders. A project is a list of Celo contract addresses in `projects.json`; the indexer needs no ABIs and never touches a project's own database. Valor is project #1.

## Run (Node >= 22.5)

    npm install
    npm run refresh   # index + live GoodDollar check + write public/<project>.json
    npm run report    # human-readable; add `-- --json` for JSON; pass a project key as an argument

Individual steps: `npm run index` (incremental; first backfill ~1h, Forno caps getLogs at 5,000 blocks), `npm run verify`, `npm run publish`.

`public/valor.json` is the feed the Valor admin page (`/admin/analytics`) reads. A scheduled workflow (`.github/workflows/refresh.yml`) refreshes it every 6 hours.

## What is counted

- **Player** = a wallet that created a character (`CharacterClaimed`) AND is currently GoodDollar-whitelisted. Dated from the later of the claim and `VerificationRecorded`.
- **Active** = a player who played, bought, earned, or sent/received G$ in the window, counted from contract events.
- **Excluded**: team and relay wallets (`excludeWallets` in `projects.json`) plus any `FundsDeposited` sender, so pool funding never looks like player spend.
- **Season**: `season` in `projects.json` holds the start date, epoch ends and targets; the report shows actual vs target and a per-epoch table.

## Caveats

- Characters claimed on-chain (1,505) is far above verified players (112) because Aug 2026 referral-farm wallets claimed characters but were never GoodDollar-verified. Players are the verified ones.
- Verified is a live snapshot (GoodDollar un-whitelists over time).
- Not in contract data: groups, Face-Off duel stakes, the withdrawal fee and duel house cut.
- Contract addresses in `projects.json` must be valid; lowercase is safest.

## Roadmap

1. Indexer + CLI report (done)
2. Funder exclusion, season targets vs actuals, admin dashboard (done)
3. Index duel escrow so Face-Off stakes count; self-serve onboarding for other builders
