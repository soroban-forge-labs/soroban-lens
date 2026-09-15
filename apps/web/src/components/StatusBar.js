import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function StatusBar({ networks, selected, onSelect, health, error, lastUpdated, }) {
    // The label the user picked and the network the API actually indexed can
    // disagree if the compose file is misconfigured. Saying so is far kinder than
    // letting someone read testnet data believing it is mainnet.
    //
    // An older API that predates the /health `network` field reports nothing at
    // all, which is "I don't know", not "mismatch" — warning there would cry wolf
    // on every upgrade.
    const reported = health?.network ?? '';
    const mismatch = reported !== '' && reported !== 'unknown' && reported !== selected.label;
    return (_jsxs("div", { className: "status-bar", children: [_jsxs("div", { className: "status-left", children: [_jsx("label", { htmlFor: "network", className: "sr-only", children: "Network" }), _jsx("select", { id: "network", value: selected.label, onChange: (e) => {
                            const next = networks.find((n) => n.label === e.target.value);
                            if (next)
                                onSelect(next);
                        }, children: networks.map((n) => (_jsx("option", { value: n.label, children: n.label }, n.label))) }), _jsx("span", { className: "muted small mono", children: selected.baseUrl })] }), _jsx("div", { className: "status-right", children: error ? (_jsx("span", { className: "status-pill status-error", role: "status", children: error })) : health ? (_jsxs(_Fragment, { children: [_jsx("span", { className: `status-pill status-${health.status}`, role: "status", children: health.status === 'ok' ? 'connected' : 'degraded' }), _jsxs("span", { className: "muted small", children: [health.events.toLocaleString(), " events \u00B7 ", health.contracts, " contracts"] }), lastUpdated && (_jsxs("span", { className: "muted small", children: ["updated ", new Date(lastUpdated).toLocaleTimeString()] }))] })) : (_jsx("span", { className: "status-pill", role: "status", children: "connecting\u2026" })) }), mismatch && (_jsxs("p", { className: "warning banner", children: ["This API reports network ", _jsx("strong", { children: reported }), ", but it is configured here as", ' ', _jsx("strong", { children: selected.label }), ". Check ", _jsx("code", { children: "VITE_LENS_NETWORKS" }), " and the indexer's ", _jsx("code", { children: "LENS_NETWORK" }), "."] }))] }));
}
