import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { EventRow } from './EventRow.js';
export function EventTable({ events, showContract, onTopicClick, loading, emptyMessage, }) {
    if (events.length === 0) {
        return (_jsx("div", { className: "empty", children: loading ? 'Loading…' : emptyMessage }));
    }
    return (_jsxs("table", { className: "event-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: "col-toggle", children: _jsx("span", { className: "sr-only", children: "Expand" }) }), _jsx("th", { className: "col-ledger", children: "Ledger" }), showContract && _jsx("th", { className: "col-contract", children: "Contract" }), _jsx("th", { className: "col-topic", children: "Topic" }), _jsx("th", { className: "col-value", children: "Value" }), _jsx("th", { className: "col-tx", children: "Tx" })] }) }), _jsx("tbody", { children: events.map((event) => (_jsx(EventRow, { event: event, showContract: showContract, onTopicClick: onTopicClick }, event.id))) })] }));
}
