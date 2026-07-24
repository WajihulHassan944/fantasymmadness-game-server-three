# Fantasy MMAdness Backend — Pro Wrestling Time Range V3

- Added predefined non-overlapping match-time ranges.
- Added finish-type and match-time-range prediction persistence and validation.
- Added administrator match-start endpoint that locks submitted predictions and starts the official elapsed timer.
- Added dynamic live/provisional time-range scoring and ranking.
- Added official match duration/result handling that removes provisional points and recalculates final scores.
- Added finalization guards so finalized scores cannot change.
- Added live clock, active range, and standings-label metadata to public APIs.
- Extended Pro Wrestling core and route regression tests.
