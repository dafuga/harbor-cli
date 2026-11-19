async function stopCurrent(state) {
    const running = state.current;
    if (!running)
        return;
    running.controller.abort();
    await running.stopped;
    state.current = undefined;
}
function coolDown(state, name, cooldownMs) {
    state.failures.set(name, Date.now() + cooldownMs);
}
async function startSelected(supervisor, state, candidate, options) {
    const { name, estimatedHourlyReward, reason } = candidate;
    const fail = (error) => {
        coolDown(state, name, options.cooldownMs);
        supervisor.report({ event: 'service-unavailable', service: name, reason: error.message });
    };
    try {
        const plan = await supervisor.prepare(name);
        if (options.signal.aborted)
            return;
        const controller = new AbortController();
        const stopped = supervisor.start(plan, {
            signal: controller.signal,
            onReady: () => supervisor.report({ event: 'service-ready', service: name }),
        }).then(() => {
            if (!controller.signal.aborted)
                fail(new Error('service exited'));
        }).catch((error) => {
            if (!controller.signal.aborted)
                fail(error);
        }).finally(() => {
            if (state.current?.controller === controller)
                state.current = undefined;
        });
        state.current = { name, controller, stopped };
        supervisor.report({ event: 'service-selected', service: name, estimate: estimatedHourlyReward, reason });
    }
    catch (error) {
        fail(error);
    }
}
async function pollMarket(supervisor, state, options) {
    try {
        const candidates = await supervisor.inspect();
        const best = candidates.find(({ name, status }) => status === 'open' && (state.failures.get(name) ?? 0) <= Date.now());
        if (best?.name !== state.current?.name)
            await stopCurrent(state);
        if (!best)
            supervisor.report({ event: 'no-eligible-service' });
        if (!state.current && best && !options.signal.aborted)
            await startSelected(supervisor, state, best, options);
    }
    catch (error) {
        await stopCurrent(state);
        supervisor.report({ event: 'market-unavailable', reason: error.message });
    }
}
/** Example: when storage overtakes relay, drain relay before starting storage. */
export async function marketSupervision(supervisor, options) {
    const state = { failures: new Map() };
    try {
        while (!options.signal.aborted) {
            await pollMarket(supervisor, state, options);
            await supervisor.wait(options.signal).catch((error) => {
                if (!options.signal.aborted)
                    throw error;
            });
        }
    }
    finally {
        await stopCurrent(state);
    }
}
