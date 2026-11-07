# Marketing discovery audit — November 6, 2026 (Eastern)

The read-only public Registry snapshot contains 137 distinct records: Boxing 70, MMA 24, Bare-Knuckle 36, Kickboxing 6, Pro Wrestling 1. The production predicate admits two contests within its configured 21-day horizon. Both have contradictory public entry-state signals, so the repaired predicate holds them for reconciliation: **zero unambiguous eligible contests**. This does not establish that either event has finished.

| Registry record | Stored matchup | Stored date | Derived entry cutoff (Eastern) | Evidence |
| --- | --- | --- | --- | --- |
| 6ad629a60df141df46931a8b | ELIF NUR TURHAN vs ALYCIA BAUMGARDNER | 2026-11-08 | November 8, 11:00 PM EST (2026-11-09T04:00:00Z) | Ongoing, LIVE, entryOpen true; anonymous global fightStatusBucket completed, canSubmitPrediction false |
| 6adfcba7ee2996e566885594 | CIRYL GANE vs JOSH HOKIT | 2026-11-14 | November 14, 11:00 PM EST (2026-11-15T04:00:00Z) | Same contradictory entry signals; description instead names Tai Tuivasa and discusses their 2022 bout |

Neither has an explicit lockAt or entryClosedAt. The cutoffs above are derived by the existing, unchanged game entry-time helper from matchDateKey, matchTime 23:00 and America/New_York. They are not independently verified event start times. No event timing, opponent name, description, entry setting or Registry record was changed.

The wider public snapshot contains three Boxing records outside the 21-day window: Jai Opetaia / Deontay Wilder and Tyson Fury / Anthony Joshua on December 11, and David Benavidez / Michal Cieslak on December 5. Bare-Knuckle records do not have open entry; the six Kickboxing records are shadows and have no open entry. The sole OPEN public Pro Wrestling record (Roman Reigns / LA Knight) is dated October 10, already past. All row-level source URLs, IDs and rejection reasons are in the accompanying JSON audit.

## Actual discovery path and limitations

Growth reads GET /api/public/prediction-fights from the existing game backend and GET /api/public/pro-wrestling/matches?status=OPEN. The source is the live public Registry feeds, not a fixed list of two fights or a fixture. The six-hour cache is for canonical website URL resolution, not contest eligibility. The durable runtime enqueues refresh_marketing in six-hour UTC buckets, and continuous preparation also invokes refreshMarketing on its 15-minute preparation cycles. The worker remains enabled and unchanged; its latest inspected receipt completed at 9:21:37 PM Eastern with zero reported errors, approvals, sends or payment mutations. This receipt does not prove that every individual six-hour discovery job succeeded. Private job/coverage/audit endpoints require an owner session; Growth runtime-log access remains HTTP 403 through the connected Vercel account.

Production currently still reports two pending Marketing drafts, zero approved Marketing drafts, and four prepared poster receipts. This is the existing production queue, not evidence that the stricter holds are deployed.

## Isolated repairs

- Query the Registry's supported categories independently to prevent mixed-feed top-100 starvation. Saturated category responses are explicitly incomplete because this endpoint does not offer pagination.
- Follow documented Pro Wrestling pagination, with bounded page requests; never call a truncated scan complete.
- Hold contradictory anonymous global Registry entry state independently of a player's prediction flag. Do not rename or rewrite source records.
- Revalidate approved and owner-edited campaigns. Store separate hold evidence while preserving exact approved copy, approval version and review history; never enable delivery.
- Allow a quoted fighter nickname such as JOE "THE SHOW " CRONIN through media-name classification without changing the original name.
- Record per-source scan coverage and expose the configured horizon and per-sport campaign cap in the existing coverage description.

Validation: 38 production-composition, browser, security, preparation and refresh checks passed without skips. A subsequent 21-check filter/display run passed, including the nickname regression. The approved-expiry regression preserves the approved content hash and history while holding expired source evidence. These repairs are not deployed; production queue holds are not claimed.
