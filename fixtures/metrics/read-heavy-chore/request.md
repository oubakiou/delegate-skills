# Objective

Classify the following design notes into themes and identify duplicated concerns.

# Scope

Read all notes in this request and produce a compact classification. No file edits.

# Context

Note A: The delegation flow should avoid placing large reports in the main context. The main agent should read status first, then inspect only needed sections. Small reports may be read inline when the repeated shell round trips cost more than the content.

Note B: A cheap worker can absorb large read-only context when the main model would otherwise need to read many files. This is useful for exploration and review, but weak for one-line shell chores where the content never enters any model context.

Note C: The measurement story must not multiply raw token counts by model prices when cache-read and output components are unknown. Raw count is useful for direction, but not enough for cost magnitude.

Note D: A future benchmark should separate main output, main first-input, worker-read content, and orchestration events. Stable proxy metrics are better than pretending to know exact bills.

Note E: Read-heavy tasks need fixture data so the same scenario can be measured repeatedly. The goal is to discover boundaries where delegation starts to help, not to prove a universal cost ratio.

# Acceptance criteria

Return themes, duplicated concerns, and a short recommendation.

# Verification

No commands required.

# Constraints

Do not edit files. Do not invent cost multipliers.
