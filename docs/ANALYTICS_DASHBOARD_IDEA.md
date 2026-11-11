# Analytics dashboard for GoodDollar builders (IDEA, not started)

Status: idea only. Nothing is built. For now Valor reports its numbers from Dune (see `dune/goodbuilders_s5_queries.sql`). Revisit after the GoodBuilders Season 5 application is in.

## Why

Valor could not fill the GoodBuilders form with current numbers because the data sat behind a read-only Dune account and a production database. Every GoodDollar builder has the same problem: the program asks for transactions, active users, retention, verified users and G$ used in-product, and each team assembles those by hand. A shared tool that tracks all of it from contract addresses would help Valor first and the wider ecosystem after.

## Shape

One indexer plus one dashboard. A project is a list of contract addresses and ABIs, so Valor is project #1 and any other builder is another row.

1. **Indexer.** Node/viem service reads Celo logs and transactions for each project's contracts into its own Postgres. No Dune dependency, and it never touches Valor's production database.
2. **Chain-only metrics (work for any project):**
   - Transactions and unique wallets per day, week and month; WAU and MAU.
   - New versus returning wallets, weekly retention.
   - G$ flowing into and out of the project's contracts (spend-to-payout ratio).
   - GoodDollar-verified wallets, read from the GoodDollar identity contract whitelist. This is the number GoodBuilders asks for and few teams track.
3. **Dashboard.** Project overview, targets versus actuals for a season, and an export matching the GoodBuilders form fields.
4. **Private layer (Valor only, behind login).** Off-chain metrics from Valor's own database: registered users, campaign funnels, referral and school/community cohorts.

## Phases

1. Indexer plus a CLI report that prints every number the application form needs.
2. Dashboard with season targets and progress.
3. Self-serve onboarding for other builders (paste contracts, get a dashboard) and a public ecosystem leaderboard.

## Decisions

- Lives in the Valor monorepo as a new app first, extracted once it works.
- Own Railway Postgres, so it cannot affect the game.
- Multi-tenant is designed in from the start (project = addresses + ABIs) but only built in phase 3.

## Risks

- Reading historical logs from public Celo RPC is slow and rate-limited. If backfill is too slow, use a paid RPC key or the Celoscan API.
- Verified-user counts depend on GoodDollar's whitelist, which changes over time (wallets get un-whitelisted), so the dashboard must show the live value and a date.
- A cohort view (school and community groups) needs a referral or group tag recorded at signup in Valor's own DB. The chain cannot know which school a wallet came from.
