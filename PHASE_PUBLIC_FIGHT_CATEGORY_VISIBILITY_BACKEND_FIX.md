# Public Fight Category Visibility Backend Fix

## Problem
Public/user fight cards were being grouped primarily by `matchCategory`, so fights with a secondary category such as:

- `matchCategory: "boxing"`, `matchCategoryTwo: "Bare-knuckle"`
- `matchCategory: "mma"`, `matchCategoryTwo: "kickboxing"`

could disappear from category views or be counted under the wrong parent category.

## Backend Fix
- Added secondary-category-first normalization.
- Added response fields:
  - `effectiveCategory`
  - `effectiveCategorySlug`
  - `displayCategory`
  - `categoryLabel`
  - `categorySlug`
  - `hasSecondaryCategory`
- Category filtering now prefers `matchCategoryTwo` when present.
- `boxing` filters no longer incorrectly swallow `Bare-knuckle` fights.
- `mma` filters no longer incorrectly swallow `kickboxing` fights.
- `/match` keeps all non-draft fights visible by default.
- `/api/public/prediction-fights` now returns all non-draft user-visible fights instead of hiding finished/legacy fights by default.
- If `playerId` or `userId` is passed, public fight records include:
  - `predictionSubmitted`
  - `userPredictionSubmitted`
  - `userPredictionStatus`
  - `userFightBucket`
  - `canSubmitPrediction`
- Submitted fights can be moved to completed cards by the frontend, while unsubmitted fights remain playable.

## Compatibility
- No database fields were removed.
- `matchCategory` is preserved for scoring/rules logic.
- `matchCategoryTwo` is preserved as the secondary UI/category grouping field.
- Existing fight/fighter references remain unchanged.
