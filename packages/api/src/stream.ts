// return() cannot interrupt an async generator's pending next(). Abort its work
// first so an idle subscription also releases upstream requests on disconnect.
export function cancellableStream<T>(
    create: (signal: AbortSignal) => AsyncGenerator<T>,
    signal?: AbortSignal,
) {
    const controller = new AbortController();

    const iterator = create(
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );

    const finish = iterator.return.bind(iterator);
    iterator.return = (value) => {
        controller.abort();

        return finish(value);
    };

    return iterator;
}
