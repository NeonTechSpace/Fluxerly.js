// What Enter opens in the docs search dialog. The shown results may still answer an earlier query, such as a prefix typed a
// moment before, while the newest one is being searched. Enter opens a result only when the results answer the query as
// typed, and otherwise waits for that query's results and opens the first one
import type { Hit } from "./docs-search"

export class EnterIntent {
    // The query whose results Enter waits for
    #waiting: string | undefined

    // Enter was pressed. Returns the result to open now, or nothing while Enter waits for the query's own results
    press(query: string, answered: string, hits: Hit[], active: number): Hit | undefined {
        if (answered === query) {
            this.#waiting = undefined
            return hits[active]
        }
        this.#waiting = query
        return undefined
    }

    // A query's results arrived. Returns the first one when Enter waits for that query
    arrive(query: string, hits: Hit[]): Hit | undefined {
        if (this.#waiting !== query) return undefined
        this.#waiting = undefined
        return hits[0]
    }

    // The query changed, the search failed or the dialog closed, so an earlier Enter opens nothing
    clear() {
        this.#waiting = undefined
    }
}

// A key pressed while an input method composes text, such as Enter confirming a Japanese word or the arrows choosing a
// candidate, belongs to that input method. Some browsers report such a key only through key code 229
export const composing = (event: { isComposing?: boolean; keyCode?: number }) => Boolean(event.isComposing) || event.keyCode === 229
