# Comparing candidates

The five eligibility gates, the Pareto frontier, business outcomes, and why there are no prices.

[< back to the README](../README.md)

## The portfolio: five gates, then a frontier

A candidate is compared only if it opens all five, in order:

1. `schema-valid` — the design and its workflow validate
2. `correctness-exhausted` — the search **finished** rather than running out of budget
3. `no-violation` — and found nothing
4. `slo-satisfied` — the **conservative end** of the interval meets every SLO
5. `business-goals-satisfied` — likewise for the business goals

Gate 2 precedes gate 3 because "we did not find a problem" and "we finished looking
and there was no problem" are different claims, and collapsing them produces the
tool's most dangerous output at the moment its search was weakest.

Among eligible candidates there is **no score**. A weighted ranking needs an
exchange rate between milliseconds and CPU units that nobody has, so the answer is a
Pareto frontier with resource axes kept separate. Differences smaller than the
measured intervals are reported as ties, not wins.

Resources are physical units only — no prices, not behind a setting. A price is a
claim about a vendor's rate card that this tool cannot check, and multiplying a
guessed rate by a simulated hour would produce its most confident-looking and least
defensible number. Every axis is independently nullable, and **unknown is never
treated as zero**: doing so would make the design nobody measured look free, so it
would win on cost while contributing no information.


## Business outcomes, not just latency

A design can serve every request in 40ms with a 0% error rate and sell three hundred
pizzas it does not have. Every oversell in history was a successful response.

So the simulator counts valid allocations, duplicate successes, oversells, remaining
stock, expired and **stranded** reservations, idempotency hits, transaction
conflicts, redeliveries, abandoned messages, stale-owner rejections and time to
exhaust — each as a 95% interval over independent seeds, because a count from one
seed is one sample of a random variable.

Stranded reservations are reported separately from oversells on purpose: a worker
that died between decrementing and recording has wasted stock, not oversold, and the
two call for different fixes.
