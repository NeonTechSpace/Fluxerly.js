# Test value

Before adding or retaining a test, identify the behavior or binding contract it protects and a plausible regression it would catch. Do not add checks merely to increase test counts or make an implementation appear covered

- Do not freeze README, guide, API-description or other authored prose in copied assertions or snapshots. Harmless rewording must not fail tests. Check relevant structure, navigation, rendering behavior or runnable examples instead, and review the writing itself
- Do not lock incidental whitespace, attribute order or implementation source text when the observable behavior can be tested. Source checks are appropriate only for a real structural constraint that runtime checks cannot establish
- Exact values remain appropriate for protocol data, commands, identifiers, explicit literal-text requirements and fixture round trips where byte preservation is the behavior under test
- Remove a redundant test only after identifying which retained check covers its failure mode. Different API styles, ownership boundaries, failure paths and execution environments are not duplicates merely because their assertions look similar
