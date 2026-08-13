# Fantasy MMadness backend v16

This release accompanies frontend v57.

- Customer-visible checkout errors now use generic secure-payment language and do not expose the payment provider or implementation details.
- Payment integration environment variables, signed webhook validation, idempotent checkout orders, first-purchase coin doubling, account creation after confirmed payment, and FM+ 30-day entitlements remain unchanged internally.
- Existing fight-placement, date-only scheduling, per-fight AI scouting, fight-entry, scoring, scraping/discovery, and Pro Wrestling APIs from v15 remain intact.

## Validation

- `npm test` passes all client-feedback, Pro Wrestling, route-regression, swarm, SEO/performance, fight-data-quality, and UFC event-discovery suites.

