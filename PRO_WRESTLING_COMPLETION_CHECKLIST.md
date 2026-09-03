# Pro Wrestling Backend Completion Checklist

## Compatibility and foundation

- [x] Existing Fantasy MMADNESS backend structure retained
- [x] All 169 pre-existing route declarations preserved
- [x] Optional game-mode metadata added without rewriting legacy matches
- [x] `PRO_WRESTLING_ENABLED` feature flag
- [x] Existing player, affiliate, admin, token-wallet, Cloudinary, JWT, and Pusher infrastructure reused
- [x] No existing MMA/boxing score or prediction logic refactored

## Data model

- [x] Pro wrestler profiles, media, career data, moves, historical stats, and SEO metadata
- [x] Versioned scoring rules
- [x] Versioned payout rules
- [x] Pro Wrestling contest/match lifecycle
- [x] Transactional contest entries
- [x] Full-match user predictions
- [x] Score breakdown, rank, previous rank, and payout fields
- [x] Idempotent wallet ledger
- [x] Admin audit log
- [x] User wrestling notifications
- [x] Affiliate attribution and commission fields
- [x] Compound uniqueness and query indexes

## Game flow

- [x] Contest discovery and filtering
- [x] Wrestler directory and profile history
- [x] Join contest with atomic token deduction
- [x] One entry per user per contest
- [x] Draft or submitted predictions
- [x] Server-enforced prediction lock
- [x] HP, BP, K, PM, and FM predictions for both competitors
- [x] Winner prediction (`A`, `B`, or `DRAW`)
- [x] Live stats endpoint for polling
- [x] Pusher live-update events
- [x] Provisional score recalculation
- [x] Rank movement notifications
- [x] Final results and user score breakdown
- [x] Wrestling history and wallet history

## Scoring and leaderboard

- [x] Weighted category scoring
- [x] Exact / within-20% / within-50% / miss accuracy bands
- [x] Safe handling when an official statistic is zero
- [x] Correct-winner bonus
- [x] Deterministic tie-breaking
- [x] Provisional leaderboard
- [x] Final leaderboard
- [x] Rank synchronized onto contest entries
- [x] Scoring rules snapshotted per contest
- [x] Admin score recalculation

## Settlement and safety

- [x] Top-10%-with-minimum-winners payout logic
- [x] One-, two-, and three-player payout edge cases
- [x] Platform fee support
- [x] Affiliate commission support
- [x] Atomic player payout credits
- [x] Idempotent finalization
- [x] Idempotent cancellation refunds
- [x] Cancelled and no-contest handling
- [x] Minimum-participant auto-cancellation maintenance flow
- [x] Terminal-state protection
- [x] Audited manual wallet adjustments
- [x] MongoDB transaction requirement documented

## Admin operations

- [x] Wrestler create, update, list, and safe deactivation
- [x] Match create, update, list, detail, and draft deletion
- [x] Match state transitions
- [x] Live-stat submission
- [x] Official-result submission
- [x] Submitted-prediction review
- [x] Audited prediction correction before settlement
- [x] Entry roster and user details
- [x] Scoring-rule management
- [x] Payout-rule management
- [x] Analytics
- [x] Wallet-ledger inspection
- [x] Audit-log inspection
- [x] System-check endpoint
- [x] Backend endpoint documentation endpoint

## Platform integration

- [x] User token wallet integration
- [x] User notifications
- [x] Affiliate summary and commissions
- [x] Game-mode analytics dimension
- [x] Legacy match game-mode migration with dry-run mode
- [x] SEO fields for wrestlers and contests
- [x] Secure cron/maintenance endpoint

## Validation

- [x] Server syntax validation
- [x] Scoring and payout unit tests
- [x] Route manifest regression tests
- [x] Duplicate wrestling-route detection
- [x] Admin/player middleware protection assertions
- [x] Express startup smoke test
- [x] Unauthorized admin and player endpoints return HTTP 401
- [x] Clean source archive excludes dependencies and backup files

A live database settlement test was intentionally not run against production data. Before public release, run an internal contest on a staging MongoDB Atlas/replica-set database and verify join, lock, scoring, finalize, payout, and refund with test users.
