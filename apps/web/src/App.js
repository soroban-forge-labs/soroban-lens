import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, configuredNetworks } from './api.js';
import { Filters } from './components/Filters.js';
import { EventTable } from './components/EventTable.js';
import { StatusBar } from './components/StatusBar.js';
import { usePersistentState, usePolling, useDebounced } from './hooks.js';
/** Testnet Stellar Asset Contract for native XLM — always emitting events. */
const EXAMPLE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
export function App() {
    const networks = useMemo(configuredNetworks, []);
    const [networkLabel, setNetworkLabel] = usePersistentState('lens.network', networks[0].label);
    const selected = networks.find((n) => n.label === networkLabel) ?? networks[0];
    const [filters, setFilters] = usePersistentState('lens.filters', {
        contractId: '',
        topic: '',
        successfulOnly: false,
        live: true,
    });
    const [events, setEvents] = useState([]);
    const [total, setTotal] = useState(0);
    const [nextCursor, setNextCursor] = useState(null);
    const [health, setHealth] = useState(null);
    const [topics, setTopics] = useState([]);
    const [error, setError] = useState(null);
    const [healthError, setHealthError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    // Typing a 56-character contract id should not fire 56 requests.
    const debouncedContractId = useDebounced(filters.contractId, 300);
    const debouncedTopic = useDebounced(filters.topic, 300);
    const contractIdValid = debouncedContractId === '' || CONTRACT_ID_PATTERN.test(debouncedContractId);
    const query = useMemo(() => ({
        ...(contractIdValid && debouncedContractId ? { contractId: debouncedContractId } : {}),
        ...(debouncedTopic ? { topics: [debouncedTopic] } : {}),
        ...(filters.successfulOnly ? { successfulOnly: true } : {}),
        limit: PAGE_SIZE,
    }), [contractIdValid, debouncedContractId, debouncedTopic, filters.successfulOnly]);
    // Guards against a slow earlier response overwriting a newer one.
    const requestId = useRef(0);
    const loadFirstPage = useCallback(async () => {
        if (!contractIdValid)
            return;
        const id = ++requestId.current;
        try {
            const page = await api.events(selected.baseUrl, query);
            if (id !== requestId.current)
                return;
            setEvents(page.events);
            setTotal(page.total);
            setNextCursor(page.nextCursor);
            setError(null);
            setLastUpdated(Date.now());
        }
        catch (err) {
            if (id !== requestId.current)
                return;
            setError(err instanceof ApiRequestError ? err.message : String(err));
        }
        finally {
            if (id === requestId.current)
                setLoading(false);
        }
    }, [selected.baseUrl, query, contractIdValid]);
    const loadMore = useCallback(async () => {
        if (!nextCursor || loadingMore)
            return;
        setLoadingMore(true);
        try {
            const page = await api.events(selected.baseUrl, { ...query, cursor: nextCursor });
            // Append by id, because a live refresh may have already added some of
            // these rows while the user was reading.
            setEvents((current) => {
                const seen = new Set(current.map((e) => e.id));
                return [...current, ...page.events.filter((e) => !seen.has(e.id))];
            });
            setNextCursor(page.nextCursor);
            setTotal(page.total);
        }
        catch (err) {
            setError(err instanceof ApiRequestError ? err.message : String(err));
        }
        finally {
            setLoadingMore(false);
        }
    }, [selected.baseUrl, query, nextCursor, loadingMore]);
    // Reset the page whenever the query or the network changes.
    useEffect(() => {
        setLoading(true);
        setEvents([]);
        setNextCursor(null);
        void loadFirstPage();
    }, [loadFirstPage]);
    usePolling(() => {
        void loadFirstPage();
    }, LIVE_INTERVAL_MS, filters.live);
    useEffect(() => {
        const controller = new AbortController();
        api
            .health(selected.baseUrl, controller.signal)
            .then((h) => {
            setHealth(h);
            setHealthError(null);
        })
            .catch((err) => {
            if (err instanceof DOMException && err.name === 'AbortError')
                return;
            setHealth(null);
            setHealthError(err instanceof ApiRequestError ? err.message : String(err));
        });
        return () => controller.abort();
    }, [selected.baseUrl, lastUpdated]);
    // Topic suggestions only exist per contract.
    useEffect(() => {
        if (!contractIdValid || !debouncedContractId) {
            setTopics([]);
            return;
        }
        const controller = new AbortController();
        api
            .topics(selected.baseUrl, debouncedContractId, controller.signal)
            .then((r) => setTopics(r.topics))
            .catch(() => setTopics([]));
        return () => controller.abort();
    }, [selected.baseUrl, debouncedContractId, contractIdValid]);
    const showContract = !query.contractId;
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "app-header", children: [_jsxs("h1", { children: ["soroban", _jsx("span", { className: "accent", children: "-lens" })] }), _jsx("p", { className: "tagline", children: "See what your Soroban contracts are actually emitting." })] }), _jsx(StatusBar, { networks: networks, selected: selected, onSelect: (n) => setNetworkLabel(n.label), health: health, error: healthError, lastUpdated: lastUpdated }), _jsx(Filters, { value: filters, onChange: setFilters, knownTopics: topics, onUseExample: () => setFilters({ ...filters, contractId: EXAMPLE_CONTRACT }) }), !contractIdValid && (_jsxs("p", { className: "warning banner", children: ["That does not look like a contract id. Expected a StrKey: ", _jsx("code", { children: "C" }), " followed by 55 upper-case letters and digits 2\u20137."] })), error && contractIdValid && (_jsx("p", { className: "warning banner", role: "alert", children: error })), _jsxs("div", { className: "result-meta", children: [_jsxs("span", { children: [total.toLocaleString(), " event", total === 1 ? '' : 's', query.contractId ? ' for this contract' : ' indexed', debouncedTopic ? ` with topic "${debouncedTopic}"` : ''] }), filters.live && _jsx("span", { className: "live-dot", title: "Polling every 5 seconds", children: "live" })] }), _jsx(EventTable, { events: events, showContract: showContract, loading: loading, onTopicClick: (topic) => setFilters({ ...filters, topic }), emptyMessage: health && health.events === 0
                    ? 'Nothing indexed yet. Start the indexer, or load the fixture with `npm run seed`.'
                    : 'No events match these filters.' }), nextCursor && (_jsx("button", { type: "button", className: "load-more", onClick: () => void loadMore(), disabled: loadingMore, children: loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more` })), _jsxs("footer", { className: "app-footer", children: [_jsx("span", { children: "Read-only explorer \u00B7 v0.1" }), _jsx("a", { href: `${selected.baseUrl}/openapi.json`, target: "_blank", rel: "noreferrer", children: "API spec" })] })] }));
}
