import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// Each visual change adds a round of independent design reviews to this log, see AGENTS.md. Quality may not slip
const log = JSON.parse(readFileSync("scripts/checks/design-scores.json", "utf8")) as { rounds: { date: string; note: string; scores: Record<string, number> }[] }
const slip = 0.2

test("every round has at least two reviewers with scores out of 10", () => {
    for (const round of log.rounds) {
        const scores = Object.values(round.scores)
        assert.ok(scores.length >= 2, round.date)
        for (const score of scores) assert.ok(score >= 0 && score <= 10, round.date)
    }
})

test("no reviewer's score falls by more than 0.2 from one round to the next", () => {
    for (const [index, round] of log.rounds.entries()) {
        if (index === 0) continue
        for (const [reviewer, score] of Object.entries(round.scores)) {
            const before = log.rounds[index - 1]!.scores[reviewer]
            if (before !== undefined) assert.ok(score >= before - slip, `${reviewer} fell from ${before} to ${score} on ${round.date}`)
        }
    }
})
