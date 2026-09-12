import { builders, MessageBuilder, type MessageInput } from "@neontechspace/fluxerly"

/** Packed builder type state keeps constructor selection internal while fluent construction remains available */
export function builderTypeState() {
    const factory: MessageInput = builders.message().content("factory body").build()
    const direct: MessageInput = new MessageBuilder().content("direct body").build()
    const empty = new MessageBuilder()

    // @ts-expect-error MessageBuilder's body state is not caller-selectable
    if (false) new MessageBuilder<true>().build()
    // @ts-expect-error A boolean type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<boolean>().build()
    // @ts-expect-error A union type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<true | false>().build()
    // @ts-expect-error A never type argument cannot make an empty builder buildable
    if (false) new MessageBuilder<never>().build()

    void empty
    return { factory, direct }
}
