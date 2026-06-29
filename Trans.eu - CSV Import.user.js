// ==UserScript==
// @name         Trans.eu - CSV Import
// @namespace    trans-direct-import-menu
// @version      2.8
// @description  Otwiera asystenta importu CSV po kliknięciu w menu Trans.eu „Importuj frachty z CSV”
// @match        https://platform.trans.eu/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const API_V1 = 'https://api-platform.trans.eu/app/ida-storage/api/rest/v1';
    const API_V2 = 'https://api-platform.trans.eu/app/ida-storage/api/rest/v2';
    const DEFAULT_FRONTEND_COMPONENT = 'freightImport.module@2.41.8';
    const DEFAULT_CONFIG_VERSION = '2.3082.0';
    const DEFAULT_APP_VERSION = '29.69.1';
    const DEFAULT_PAYMENT_DAYS = 55;
    const ASSISTANT_VERSION = 'v2.8';
    const DEFAULT_DUPLICATE_COUNT = 0;
    const MAX_DUPLICATE_COUNT = 15;
    const CSV_CHUNK_SIZE = 10;
    const IMPORT_SAFETY_LIMIT = 400;
    const ETA_REFRESH_MS = 5000;
    const IMPORT_QUEUE_MIN_DELAY_MS = 3000;
    const IMPORT_QUEUE_MAX_DELAY_MS = 10000;
    const IMPORT_QUEUE_MAX_ACTIVE = 3;
    const IMPORT_QUEUE_UI_REFRESH_MS = 2500;
    const POLL_DELAY_MS = 2000;
    const POLL_NETWORK_RETRY_DELAY_MS = 5000;
    const REQUIRED_TRANS_HEADERS = [
        'Loading-country',
        'Loading-postal',
        'Loading-city',
        'Unloading-country',
        'Unloading-postal',
        'Unloading-city',
        'Loading-date',
        'Unloading-date',
        'external_shipment_id',
        'capacity',
        'publication_price_currency',
        'publication_price_value',
        'Vehicle-size',
        'Vehicle-type',
        'Freight_type',
        'Description',
        'Loading-type',
        'Load-name',
        'Load-type',
        'Load-length',
        'Load-width',
        'Load-height',
        'Load-volume',
        'Additional-requirements',
        'ADR'
    ];

    const auth = {
        authorization: '',
        sessionId: '',
        appVersion: '',
        configVersion: '',
        frontendComponent: ''
    };

    let selectedFile = null;
    let selectedFileValid = false;
    let busy = false;
    let currentStep = 'file';
    let plannedPublicationTotal = 0;
    let lastEtaUpdateAt = 0;
    let lastEtaText = '';
    let lastQueueUiUpdateAt = 0;
    let stopImportRequested = false;
    let currentImportTracker = null;
    let currentImportAbortController = null;
    let lastMenuInterceptAt = 0;

    function openCsvImportAssistantFromMenu() {
        createAssistant();
    }

    function showAssistant() {
        const overlay = document.getElementById('tcia-overlay');
        const mini = document.getElementById('tcia-mini');

        if (overlay) overlay.style.display = 'flex';
        if (mini) mini.style.display = 'none';
    }

    function normalizeMenuText(text) {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function textLooksLikeCsvImport(text) {
        const normalized = normalizeMenuText(text);

        return normalized.includes('importuj frachty z csv') ||
            normalized.includes('import frachtow z csv') ||
            normalized.includes('importuj frachty') && normalized.includes('csv');
    }

    function isStandardCsvImportElement(element) {
        if (!element || !element.getAttribute) return false;
        const dataCtx = normalizeMenuText(element.getAttribute('data-ctx'));
        const text = normalizeMenuText(element.innerText || element.textContent);
        const ariaLabel = normalizeMenuText(element.getAttribute('aria-label'));
        const title = normalizeMenuText(element.getAttribute('title'));

        return dataCtx === 'import-freight' ||
            textLooksLikeCsvImport(text) ||
            textLooksLikeCsvImport(ariaLabel) ||
            textLooksLikeCsvImport(title);
    }

    function getEventPath(event) {
        if (event.composedPath) return event.composedPath();

        const path = [];
        let node = event.target;

        while (node) {
            path.push(node);
            node = node.parentNode;
        }

        return path;
    }

    function isStandardCsvImportEvent(event) {
        const target = event && event.target;
        const directByDataCtx = target && target.closest ? target.closest('[data-ctx="import-freight"]') : null;

        if (directByDataCtx) return true;

        return getEventPath(event).some(isStandardCsvImportElement);
    }

    function interceptStandardCsvImport(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const now = Date.now();
        if (now - lastMenuInterceptAt < 800) return;

        lastMenuInterceptAt = now;
        openCsvImportAssistantFromMenu();
    }

    function handleStandardCsvImportEvent(event) {
        const overlay = document.getElementById('tcia-overlay');
        if (overlay && overlay.contains(event.target)) return;
        if (!isStandardCsvImportEvent(event)) return;

        interceptStandardCsvImport(event);
    }

    function hookStandardCsvImportMenu() {
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(eventName => {
            window.addEventListener(eventName, handleStandardCsvImportEvent, true);
            document.addEventListener(eventName, handleStandardCsvImportEvent, true);
        });
    }

    if (window.top === window.self) {
        hookStandardCsvImportMenu();
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function captureHeader(key, value) {
        const name = String(key || '').toLowerCase();
        const val = String(value || '');

        if (!val) return;

        if (name === 'authorization') auth.authorization = val;
        if (name === 'x-session-id') auth.sessionId = val;
        if (name === 'x-app-version') auth.appVersion = val;
        if (name === 'x-config-version') auth.configVersion = val;
        if (name === 'x-frontend-component') auth.frontendComponent = val;
    }

    function captureHeaders(headers) {
        if (!headers) return;

        try {
            if (headers instanceof Headers) {
                headers.forEach((value, key) => captureHeader(key, value));
                return;
            }
        } catch (error) {
            // Brak akcji.
        }

        if (Array.isArray(headers)) {
            headers.forEach(pair => {
                if (Array.isArray(pair) && pair.length >= 2) {
                    captureHeader(pair[0], pair[1]);
                }
            });
            return;
        }

        if (typeof headers === 'object') {
            Object.keys(headers).forEach(key => captureHeader(key, headers[key]));
        }
    }

    function hookAuthCapture() {
        const originalFetch = window.fetch;
        window.fetch = function directImportFetch(input, init) {
            try {
                if (input instanceof Request) captureHeaders(input.headers);
                if (init && init.headers) captureHeaders(init.headers);
            } catch (error) {
                // Brak akcji.
            }

            return originalFetch.apply(this, arguments);
        };

        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function directImportHeader(key, value) {
            captureHeader(key, value);
            return originalSetRequestHeader.apply(this, arguments);
        };
    }

    function requestHeaders(isJson) {
        const headers = {
            Accept: 'application/json, text/plain, */*',
            'x-frontend-component': auth.frontendComponent || DEFAULT_FRONTEND_COMPONENT,
            'x-config-version': auth.configVersion || DEFAULT_CONFIG_VERSION,
            'x-app-version': auth.appVersion || DEFAULT_APP_VERSION
        };

        if (auth.authorization) headers.Authorization = auth.authorization;
        if (auth.sessionId) headers['X-Session-Id'] = auth.sessionId;
        if (isJson) headers['Content-Type'] = 'application/json';

        return headers;
    }

    async function waitForAuthorization() {
        for (let i = 0; i < 100; i++) {
            if (auth.authorization) return true;
            await sleep(100);
        }

        return false;
    }

    async function requestJson(url, options) {
        const requestOptions = {
            credentials: 'include',
            ...options
        };

        if (currentImportAbortController && !requestOptions.signal) {
            requestOptions.signal = currentImportAbortController.signal;
        }

        const response = await fetch(url, requestOptions);

        const text = await response.text();
        let data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                data = { raw: text };
            }
        }

        if (!response.ok) {
            if (data && data.detail === 'NOTHING_TO_IMPORT') {
                throw new Error('Trans.eu nie ma nic do opublikowania. Najczęściej oznacza to, że wszystkie frachty są duplikatami.');
            }

            throw new Error(formatApiError(response.status, data, text || response.statusText));
        }

        return data;
    }

    function formatApiError(status, data, rawText) {
        const title = data && data.title ? String(data.title) : '';
        const detail = data && data.detail ? String(data.detail) : '';
        const raw = rawText ? String(rawText).slice(0, 500) : '';

        if (detail.includes('AWAITING_SCHEMA')) {
            return 'Trans.eu nie rozpoznał schematu CSV. Wybierz plik CSV wygenerowany do importu frachtów Trans.eu.';
        }

        if (title || detail) {
            return `Trans.eu zwrócił błąd ${status}: ${title}${title && detail ? ' - ' : ''}${detail}`;
        }

        return `Trans.eu zwrócił błąd ${status}: ${raw}`;
    }

    function splitCsvLine(line) {
        const semicolons = (line.match(/;/g) || []).length;
        const commas = (line.match(/,/g) || []).length;
        const delimiter = semicolons >= commas ? ';' : ',';
        const values = [];
        let current = '';
        let quoted = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            const next = line[i + 1];

            if (ch === '"' && quoted && next === '"') {
                current += '"';
                i++;
                continue;
            }

            if (ch === '"') {
                quoted = !quoted;
                continue;
            }

            if (ch === delimiter && !quoted) {
                values.push(current.trim());
                current = '';
                continue;
            }

            current += ch;
        }

        values.push(current.trim());
        return values;
    }

    function splitCsvRecords(text) {
        const records = [];
        let current = '';
        let quoted = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];

            if (ch === '"' && quoted && next === '"') {
                current += ch + next;
                i++;
                continue;
            }

            if (ch === '"') {
                quoted = !quoted;
                current += ch;
                continue;
            }

            if ((ch === '\n' || ch === '\r') && !quoted) {
                if (ch === '\r' && next === '\n') i++;
                if (current.trim().length > 0) records.push(current);
                current = '';
                continue;
            }

            current += ch;
        }

        if (current.trim().length > 0) records.push(current);
        return records;
    }

    async function buildCsvChunks(file) {
        const text = (await file.text()).replace(/^\uFEFF/, '');
        const records = splitCsvRecords(text);
        const header = records[0] || '';
        const rows = records.slice(1).filter(row => row.trim().length > 0);

        if (!header || rows.length === 0) {
            return {
                chunks: [],
                rowCount: 0
            };
        }

        const chunks = [];
        const baseName = String(file.name || 'freight_import.csv').replace(/\.csv$/i, '');

        for (let i = 0; i < rows.length; i += CSV_CHUNK_SIZE) {
            const chunkRows = rows.slice(i, i + CSV_CHUNK_SIZE);
            const chunkText = `\uFEFF${[header, ...chunkRows].join('\r\n')}\r\n`;
            const chunkIndex = chunks.length + 1;
            const chunkName = `${baseName}_part-${String(chunkIndex).padStart(3, '0')}.csv`;
            const chunkFile = new File([chunkText], chunkName, {
                type: file.type || 'text/csv;charset=utf-8'
            });

            chunks.push({
                file: chunkFile,
                index: chunkIndex,
                rows: chunkRows.length
            });
        }

        return {
            chunks,
            rowCount: rows.length
        };
    }

    async function validateTransCsvFile(file) {
        if (!file) {
            return {
                ok: false,
                message: 'Wybierz plik CSV z generatora ofert.'
            };
        }

        if (!/\.csv$/i.test(file.name)) {
            return {
                ok: false,
                message: 'Wybrany plik nie ma rozszerzenia .csv.'
            };
        }

        const preview = await file.slice(0, 12000).text();
        const firstLine = preview
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .find(line => line.trim().length > 0) || '';
        const headers = splitCsvLine(firstLine);
        const missing = REQUIRED_TRANS_HEADERS.filter(header => !headers.includes(header));

        if (missing.length > 0) {
            return {
                ok: false,
                message: `To nie jest plik importu frachtów Trans.eu. Wybierz CSV wygenerowany do importu frachtów. Brakuje m.in.: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '...' : ''}.`
            };
        }

        return {
            ok: true,
            message: `Wybrano poprawny plik: ${file.name}`
        };
    }

    async function uploadCsv(file) {
        const form = new FormData();
        form.append('file', file, file.name || 'freight_import.csv');
        form.append('time_zone', String(new Date().getTimezoneOffset()));

        return requestJson(`${API_V2}/import`, {
            method: 'POST',
            headers: requestHeaders(false),
            body: form
        });
    }

    async function getImport(importUuid, limit) {
        return requestJson(`${API_V1}/import/${encodeURIComponent(importUuid)}/?limit=${limit || 10}`, {
            method: 'GET',
            headers: requestHeaders(false)
        });
    }

    async function publishImport(importUuid, employeeId) {
        const payload = {
            time_zone: new Date().getTimezoneOffset(),
            with_duplicates: true,
            general: {
                contact_persons: [Number(employeeId)],
                is_first_buy: false,
                payment: {
                    days: DEFAULT_PAYMENT_DAYS,
                    type: '1_deferred'
                },
                receivers: {
                    public_exchange: true
                },
                type: 'EXCHANGE'
            }
        };

        return requestJson(`${API_V2}/import/${encodeURIComponent(importUuid)}/publish`, {
            method: 'POST',
            headers: requestHeaders(true),
            body: JSON.stringify(payload)
        });
    }

    function getState(data) {
        return data && data.import && data.import.import_state ? data.import.import_state : {};
    }

    function stateTotal(data) {
        return Number(getState(data).total || 0);
    }

    function stateSuccess(data) {
        return Number(getState(data).success || 0);
    }

    function stateProcessing(data) {
        return Number(getState(data).processing || 0);
    }

    function stateFailures(data) {
        const state = getState(data);
        return Number(state.failure || 0) + Number(state.publication_failure || 0);
    }

    function stateSummary(data) {
        return {
            total: stateTotal(data),
            ok: stateSuccess(data),
            processing: stateProcessing(data),
            errors: stateFailures(data)
        };
    }

    function emptyImportTotals() {
        return {
            total: 0,
            ok: 0,
            errors: 0
        };
    }

    function addImportTotals(totals, data) {
        const summary = stateSummary(data);

        totals.total += summary.total;
        totals.ok += summary.ok;
        totals.errors += summary.errors;

        return totals;
    }

    function readDuplicateCount() {
        const input = document.getElementById('tcia-repeat-count');
        const raw = input ? Number(input.value) : DEFAULT_DUPLICATE_COUNT;
        const parsed = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_DUPLICATE_COUNT;

        return Math.max(0, Math.min(MAX_DUPLICATE_COUNT, parsed || DEFAULT_DUPLICATE_COUNT));
    }

    function duplicateText(count) {
        return Number(count || 0) === 1 ? '1 duplikat' : `${Number(count || 0)} duplikatów`;
    }

    function requestStopImport() {
        if (!busy || stopImportRequested) return;

        stopImportRequested = true;

        if (currentImportTracker) {
            currentImportTracker.stopRequested = true;
            currentImportTracker.stopPlannedTotal = Math.max(
                Number(currentImportTracker.launchedRows || 0),
                Number(currentImportTracker.ok || 0) + Number(currentImportTracker.errors || 0)
            );
            plannedPublicationTotal = currentImportTracker.stopPlannedTotal;
            updateStatsValues(
                plannedPublicationTotal,
                currentImportTracker.ok,
                Math.max(0, plannedPublicationTotal - currentImportTracker.ok - currentImportTracker.errors),
                currentImportTracker.errors
            );
            setProgressControl(currentImportTracker.ok + currentImportTracker.errors, plannedPublicationTotal, true);
            if (typeof currentImportTracker.resolveQueue === 'function') {
                currentImportTracker.resolveQueue();
            }
        }

        if (currentImportAbortController) {
            currentImportAbortController.abort();
        }

        setStep('done');
        setMessage('STOP. Import zatrzymany.', 'warning');
        setProgressNote(currentImportTracker
            ? `STOP: przerwano po wysłaniu ${currentImportTracker.sent}/${currentImportTracker.totalTasks} paczek.`
            : 'STOP: import przerwany.');
        updateBusy();
    }

    function randomQueueDelay() {
        return IMPORT_QUEUE_MIN_DELAY_MS + Math.floor(Math.random() * (IMPORT_QUEUE_MAX_DELAY_MS - IMPORT_QUEUE_MIN_DELAY_MS + 1));
    }

    function createImportQueueTracker(totalTasks, plannedTotal, publicationStartedAt, runCount, baseRowCount) {
        return {
            totalTasks,
            plannedTotal,
            publicationStartedAt,
            runCount,
            baseRowCount,
            sent: 0,
            done: 0,
            ok: 0,
            errors: 0,
            launchedRows: 0,
            stopRequested: false,
            stopPlannedTotal: 0,
            remaining: plannedTotal,
            states: new Map()
        };
    }

    function updateImportQueueTracker(tracker, task, data, forceUi) {
        const summary = stateSummary(data);

        tracker.states.set(task.importIndex, {
            task,
            summary
        });

        let ok = 0;
        let errors = 0;

        tracker.states.forEach(item => {
            ok += Number(item.summary.ok || 0);
            errors += Number(item.summary.errors || 0);
        });

        const totalRows = tracker.stopRequested
            ? Math.max(Number(tracker.stopPlannedTotal || 0), Number(tracker.launchedRows || 0), ok + errors)
            : tracker.plannedTotal;
        const remaining = Math.max(0, totalRows - ok - errors);
        const eta = estimateRemainingTime(ok + errors, totalRows, tracker.publicationStartedAt);
        const now = Date.now();

        tracker.ok = ok;
        tracker.errors = errors;
        tracker.remaining = remaining;
        if (tracker.stopRequested) {
            tracker.stopPlannedTotal = totalRows;
            plannedPublicationTotal = totalRows;
            return;
        }
        updateStatsValues(totalRows, ok, remaining, errors);

        if (forceUi || !lastQueueUiUpdateAt || now - lastQueueUiUpdateAt >= IMPORT_QUEUE_UI_REFRESH_MS) {
            if (tracker.stopRequested) {
                setMessage(`STOP aktywny. Kończę tylko wysłane paczki. Opublikowano ${ok} z ${totalRows}. Pozostało w aktywnych paczkach: ${remaining}.`, 'warning');
                setProgressNote(`STOP: wysłano ${tracker.sent}/${tracker.totalTasks} paczek. Zakończono ${tracker.done}/${tracker.sent}.`);
            } else {
                setMessage(`Łącznie opublikowano ${ok} z ${totalRows}. Pozostało: ${remaining}. Szacunkowy czas do końca: ${eta}.`, 'info');
                setProgressNote(`Wysłano ${tracker.sent}/${tracker.totalTasks} paczek. Zakończono ${tracker.done}/${tracker.totalTasks}.`);
            }
            lastQueueUiUpdateAt = now;
        }
    }

    function importFinished(data) {
        const state = getState(data);
        const total = Number(state.total || 0);
        const done = Number(state.success || 0) +
            Number(state.failure || 0) +
            Number(state.publication_failure || 0) +
            Number(state.duplicate || 0);

        return total > 0 && Number(state.processing || 0) === 0 && done >= total;
    }

    function formatFirstImportProblem(data) {
        const rows = data && Array.isArray(data.import_data) ? data.import_data : [];

        for (const row of rows) {
            const status = String(row.status || '').toUpperCase();
            if (status !== 'FAILURE' && status !== 'PUBLICATION_FAILURE' && !row.error) continue;

            let message = '';
            if (typeof row.error === 'string') {
                message = row.error;
            } else if (row.error && typeof row.error === 'object') {
                message = row.error.message || row.error.detail || JSON.stringify(row.error).slice(0, 350);
            } else {
                message = `status ${status}`;
            }

            return `Pierwszy problem: wiersz ${row.id || '?'}, ${message}`;
        }

        return '';
    }

    function conciseStatus(data) {
        const state = getState(data);
        const total = Number(state.total || 0);
        const ok = Number(state.success || 0);
        const processing = Number(state.processing || 0);
        const failures = Number(state.failure || 0);
        const publicationFailures = Number(state.publication_failure || 0);
        const duplicates = Number(state.duplicate || 0);
        const problem = formatFirstImportProblem(data);

        let text = `Frachty: ${ok}/${total} opublikowane, ${processing} w toku.`;
        if (failures || publicationFailures || duplicates) {
            text += ` Błędy pliku: ${failures}, błędy publikacji: ${publicationFailures}, duplikaty: ${duplicates}.`;
        }
        if (problem) text += `\n${problem}`;

        return text;
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes > 0) return `${minutes} min ${seconds} sek`;
        return `${seconds} sek`;
    }

    function estimateRemainingTime(completed, total, startedAt, force) {
        const now = Date.now();
        const safeCompleted = Math.max(0, Number(completed || 0));
        const safeTotal = Math.max(0, Number(total || 0));
        const remaining = Math.max(0, safeTotal - safeCompleted);

        if (safeTotal <= 0 || safeCompleted <= 0) {
            lastEtaText = 'liczę po pierwszych publikacjach';
            lastEtaUpdateAt = now;
            return lastEtaText;
        }

        if (remaining <= 0) {
            lastEtaText = '0 sek';
            lastEtaUpdateAt = now;
            return lastEtaText;
        }

        if (!force && lastEtaText && now - lastEtaUpdateAt < ETA_REFRESH_MS) {
            return lastEtaText;
        }

        const elapsed = Math.max(1000, now - Number(startedAt || now));
        const rate = safeCompleted / elapsed;

        if (rate <= 0) {
            lastEtaText = 'liczę tempo';
        } else {
            lastEtaText = formatDuration(remaining / rate);
        }

        lastEtaUpdateAt = now;
        return lastEtaText;
    }

    function isTransientNetworkError(error) {
        const message = String(error && error.message ? error.message : error || '').toLowerCase();

        return message.includes('failed to fetch') ||
            message.includes('networkerror') ||
            message.includes('network error') ||
            message.includes('load failed') ||
            message.includes('api-platform.trans.eu');
    }

    async function pollImport(importUuid, context) {
        let attempt = 0;
        let networkErrors = 0;
        let lastGoodState = null;
        const importIndex = context && context.importIndex ? context.importIndex : 1;
        const importCount = context && context.importCount ? context.importCount : 1;
        const runIndex = context && context.runIndex ? context.runIndex : importIndex;
        const runCount = context && context.runCount ? context.runCount : importCount;
        const chunkIndex = context && context.chunkIndex ? context.chunkIndex : importIndex;
        const chunkCount = context && context.chunkCount ? context.chunkCount : importCount;
        const baseRowCount = context && context.baseRowCount ? context.baseRowCount : 0;
        const runOffset = context && context.runOffset ? context.runOffset : 0;
        const publicationStartedAt = context && context.publicationStartedAt ? context.publicationStartedAt : Date.now();
        const completedTotals = context && context.completedTotals ? context.completedTotals : emptyImportTotals();

        while (true) {
            attempt++;
            let last = null;

            try {
                last = await getImport(importUuid, 10);
                networkErrors = 0;
                lastGoodState = last;
            } catch (error) {
                if (!isTransientNetworkError(error)) throw error;

                networkErrors++;
                const lastStatus = lastGoodState ? conciseStatus(lastGoodState) : 'Czekam na pierwszy poprawny status.';
                const runPublished = baseRowCount > 0 ? Math.min(baseRowCount, Math.max(0, Number(completedTotals.ok || 0) - runOffset)) : 0;

                setMessage(`Import ${runIndex}/${runCount} (${runPublished}/${baseRowCount || '?'}). Trans.eu chwilowo nie odpowiedział. Nie przerywam importu, sprawdzam dalej.\n${lastStatus}`, 'warning');
                setProgressNote(`Paczka ${chunkIndex}/${chunkCount}. Sprawdzanie statusu: próba ${attempt}, przerwy API: ${networkErrors}`);
                await sleep(POLL_NETWORK_RETRY_DELAY_MS);
                continue;
            }

            updateStatsWithRunningBatch(completedTotals, last);

            const total = stateTotal(last);
            const ok = stateSuccess(last);
            const processing = stateProcessing(last);
            const totalOk = completedTotals.ok + ok;
            const totalErrors = completedTotals.errors + stateFailures(last);
            const totalRows = plannedPublicationTotal > 0 ? plannedPublicationTotal : completedTotals.total + total;
            const runOk = baseRowCount > 0 ? Math.min(baseRowCount, Math.max(0, totalOk - runOffset)) : totalOk;
            const remaining = Math.max(0, totalRows - totalOk - totalErrors);
            const eta = estimateRemainingTime(totalOk + totalErrors, totalRows, publicationStartedAt);

            setMessage(`Import ${runIndex}/${runCount} (${runOk}/${baseRowCount || total}). Łącznie opublikowano ${totalOk} z ${totalRows}. Pozostało: ${remaining}. Szacunkowy czas do końca: ${eta}.`, 'info');
            setProgressNote(`Paczka ${chunkIndex}/${chunkCount}. Sprawdzanie statusu: próba ${attempt}${processing ? `, w tej paczce w toku: ${processing}` : ''}.`);

            if (importFinished(last)) {
                return {
                    completed: true,
                    data: last
                };
            }

            await sleep(POLL_DELAY_MS);
        }
    }

    async function pollQueuedImport(importUuid, task, tracker) {
        let attempt = 0;
        let networkErrors = 0;
        let lastGoodState = null;

        while (true) {
            if (stopImportRequested || tracker.stopRequested) {
                return {
                    stopped: true,
                    data: lastGoodState || {},
                    task
                };
            }

            attempt++;
            let last = null;

            try {
                last = await getImport(importUuid, 10);
                networkErrors = 0;
                lastGoodState = last;
            } catch (error) {
                if (!isTransientNetworkError(error)) throw error;

                networkErrors++;
                const lastStatus = lastGoodState ? conciseStatus(lastGoodState) : 'Czekam na pierwszy poprawny status.';
                const eta = estimateRemainingTime(tracker.ok + tracker.errors, tracker.plannedTotal, tracker.publicationStartedAt);

                console.warn('[Trans CSV Import Assistant] Status retry', {
                    importUuid,
                    task,
                    attempt,
                    networkErrors,
                    lastStatus
                });
                setMessage(`Trans.eu chwilowo nie odpowiedział, ale import działa dalej. Szacunkowy czas do końca: ${eta}.`, 'warning');
                setProgressNote(`Wysłano ${tracker.sent}/${tracker.totalTasks} paczek. Zakończono ${tracker.done}/${tracker.totalTasks}.`);
                await sleep(POLL_NETWORK_RETRY_DELAY_MS);
                continue;
            }

            updateImportQueueTracker(tracker, task, last, false);

            if (importFinished(last)) {
                tracker.done++;
                updateImportQueueTracker(tracker, task, last, true);

                return {
                    completed: true,
                    data: last,
                    task
                };
            }

            await sleep(POLL_DELAY_MS);
        }
    }

    async function startQueuedImportTask(task, tracker) {
        if (stopImportRequested || tracker.stopRequested) {
            return {
                stopped: true,
                data: {},
                task
            };
        }

        setProgressNote(`Wysłano ${tracker.sent}/${tracker.totalTasks} paczek. Kolejne startują po zwolnieniu miejsca.`);

        const upload = await uploadCsv(task.chunk.file);
        const importUuid = upload && upload.import && upload.import.uuid;
        const employeeId = upload && upload.import && upload.import.employee_id;

        if (stopImportRequested || tracker.stopRequested) {
            return {
                stopped: true,
                data: upload || {},
                task
            };
        }

        if (!importUuid) {
            throw new Error('Trans.eu przyjął plik, ale nie zwrócił identyfikatora importu.');
        }

        console.info('[Trans CSV Import Assistant] Import UUID:', importUuid);
        updateImportQueueTracker(tracker, task, upload, false);

        if (hasBlockingErrors(upload)) {
            throw new Error(`Trans.eu znalazł błędy w paczce ${task.chunkIndex}/${task.chunkCount}.\n${conciseStatus(upload)}`);
        }

        const published = await publishImport(importUuid, employeeId);

        if (stopImportRequested || tracker.stopRequested) {
            return {
                stopped: true,
                data: published || {},
                task
            };
        }

        updateImportQueueTracker(tracker, task, published, false);

        if (hasBlockingErrors(published)) {
            throw new Error(`Publikacja paczki ${task.chunkIndex}/${task.chunkCount} zakończona błędem.\n${conciseStatus(published)}`);
        }

        return pollQueuedImport(importUuid, task, tracker);
    }

    async function runLimitedImportTasks(tasks, tracker) {
        const results = [];
        let nextIndex = 0;
        let active = 0;
        let resolved = false;
        let scheduling = false;

        return new Promise(resolve => {
            tracker.resolveQueue = () => {
                if (resolved) return true;
                resolved = true;
                resolve(results);
                return true;
            };

            const finishIfDone = () => {
                if (resolved) return true;

                if (results.length >= tasks.length || stopImportRequested) {
                    return tracker.resolveQueue();
                }

                return false;
            };

            const scheduleNext = async () => {
                if (scheduling || resolved) return;

                scheduling = true;
                try {
                    while (!stopImportRequested && active < IMPORT_QUEUE_MAX_ACTIVE && nextIndex < tasks.length) {
                        const task = tasks[nextIndex++];
                        active++;
                        tracker.sent++;
                        tracker.launchedRows += Number(task.chunk && task.chunk.rows ? task.chunk.rows : CSV_CHUNK_SIZE);

                        setProgressNote(`Wysłano ${tracker.sent}/${tracker.totalTasks} paczek. Aktywne: ${active}/${IMPORT_QUEUE_MAX_ACTIVE}. Zakończono ${tracker.done}/${tracker.totalTasks}.`);

                        startQueuedImportTask(task, tracker)
                            .then(result => {
                                results.push({
                                    ok: true,
                                    result,
                                    task
                                });
                            })
                            .catch(error => {
                                results.push({
                                    ok: false,
                                    error,
                                    task
                                });
                            })
                            .finally(() => {
                                active--;

                                if (finishIfDone()) return;

                                if (!stopImportRequested && nextIndex < tasks.length) {
                                    setTimeout(scheduleNext, randomQueueDelay());
                                } else {
                                    scheduleNext();
                                }
                            });

                        if (!stopImportRequested && active < IMPORT_QUEUE_MAX_ACTIVE && nextIndex < tasks.length) {
                            await sleep(randomQueueDelay());
                        }
                    }
                } finally {
                    scheduling = false;
                    if (finishIfDone()) return;
                    if (!stopImportRequested && active < IMPORT_QUEUE_MAX_ACTIVE && nextIndex < tasks.length) {
                        setTimeout(scheduleNext, randomQueueDelay());
                    }
                }
            };

            scheduleNext();
        });
    }

    function hasBlockingErrors(data) {
        return stateFailures(data) > 0;
    }

    async function runImport() {
        if (busy) return;

        if (!selectedFile) {
            setStep('file');
            setMessage('Wybierz plik CSV do importu.', 'warning');
            return;
        }

        busy = true;
        stopImportRequested = false;
        lastQueueUiUpdateAt = 0;
        currentImportAbortController = new AbortController();
        updateBusy();

        const duplicateCount = readDuplicateCount();
        const totals = emptyImportTotals();
        const publicationStartedAt = Date.now();
        plannedPublicationTotal = 0;
        lastEtaUpdateAt = 0;
        lastEtaText = '';
        setProgressControl(0, 0, false);

        try {
            setStep('file');
            setProgressNote('Sprawdzam plik...');
            const validation = await validateTransCsvFile(selectedFile);
            selectedFileValid = validation.ok;

            if (!validation.ok) {
                setMessage(validation.message, 'error');
                updateBusy();
                return;
            }

            setStep('validation');
            setMessage('Plik wygląda poprawnie. Łączę z aktywną sesją Trans.eu...', 'info');
            setProgressNote('Pobieram sesję użytkownika.');

            const ready = await waitForAuthorization();
            if (!ready) {
                throw new Error('Nie udało się pobrać aktywnej sesji Trans.eu. Odśwież stronę i spróbuj ponownie.');
            }

            setMessage(`Dzielę CSV na paczki po ${CSV_CHUNK_SIZE} ofert...`, 'info');
            setProgressNote(`Plik: ${selectedFile.name}`);
            const chunkPlan = await buildCsvChunks(selectedFile);

            if (chunkPlan.chunks.length === 0) {
                throw new Error('CSV nie zawiera ofert do importu.');
            }

            const runCount = duplicateCount + 1;
            plannedPublicationTotal = chunkPlan.rowCount * runCount;

            if (plannedPublicationTotal > IMPORT_SAFETY_LIMIT) {
                throw new Error(`Limit bezpieczeństwa: maksymalnie ${IMPORT_SAFETY_LIMIT} publikacji na jedno uruchomienie. Ten import ma ${plannedPublicationTotal} (${chunkPlan.rowCount} ofert x ${runCount} importów). Zmniejsz liczbę duplikatów albo podziel plik.`);
            }

            const importCount = runCount * chunkPlan.chunks.length;
            const tasks = [];
            let importIndex = 0;
            updateStatsValues(plannedPublicationTotal, 0, plannedPublicationTotal, 0);
            setProgressControl(0, plannedPublicationTotal, true);

            for (let runIndex = 1; runIndex <= runCount; runIndex++) {
                const runOffset = (runIndex - 1) * chunkPlan.rowCount;
                for (const chunk of chunkPlan.chunks) {
                    importIndex++;
                    tasks.push({
                        importIndex,
                        importCount,
                        runIndex,
                        runCount,
                        chunk,
                        chunkIndex: chunk.index,
                        chunkCount: chunkPlan.chunks.length,
                        baseRowCount: chunkPlan.rowCount,
                        runOffset,
                        publicationStartedAt
                    });
                }
            }

            const tracker = createImportQueueTracker(tasks.length, plannedPublicationTotal, publicationStartedAt, runCount, chunkPlan.rowCount);
            currentImportTracker = tracker;

            setStep('publish');
            setMessage(`Startuję import. Paczki po maks. ${CSV_CHUNK_SIZE} ofert, równolegle do ${IMPORT_QUEUE_MAX_ACTIVE} paczek.`, 'info');
            setProgressNote(`Docelowo: ${plannedPublicationTotal} publikacji. ${duplicateText(duplicateCount)}.`);

            const results = await runLimitedImportTasks(tasks, tracker);

            if (stopImportRequested) {
                const attemptedTotal = Math.max(Number(tracker.launchedRows || 0), tracker.ok + tracker.errors);
                plannedPublicationTotal = attemptedTotal;
                updateStatsValues(plannedPublicationTotal, tracker.ok, 0, tracker.errors);
                setStep('done');
                setMessage(`STOP. Skrypt zatrzymany. Przerwano po wysłaniu ${tracker.sent}/${tasks.length} paczek.`, 'warning');
                setProgressNote('Nie wysyłam, nie publikuję i nie sprawdzam kolejnych paczek.');
                return;
            }

            for (const item of results) {
                if (!item.ok) continue;
                addImportTotals(totals, item.result.data);
            }

            updateStatsValues(plannedPublicationTotal, totals.ok, 0, totals.errors);

            const failed = results.find(item => !item.ok);
            if (failed) {
                setStep('publish-error');
                setMessage(failed.error && failed.error.message ? failed.error.message : String(failed.error), 'error');
                return;
            }

            const finalError = results.find(item => item.ok && hasBlockingErrors(item.result.data));
            if (finalError) {
                setStep('publish-error');
                setMessage(`Import ${finalError.task.runIndex}/${finalError.task.runCount}. Import zakończony z błędami.\n${conciseStatus(finalError.result.data)}`, 'error');
                return;
            }

            if (stopImportRequested && results.length < tasks.length) {
                const attemptedTotal = Math.max(Number(tracker.launchedRows || 0), totals.total, totals.ok + totals.errors);
                plannedPublicationTotal = attemptedTotal;
                updateStatsValues(plannedPublicationTotal, totals.ok, 0, totals.errors);
                setStep('done');
                setMessage(`STOP. Opublikowano ${totals.ok} frachtów z ${attemptedTotal} wysłanych. Zatrzymano przed wysłaniem kolejnych paczek. Czas pracy ${formatDuration(Date.now() - publicationStartedAt)}.`, 'warning');
                setProgressNote(`Możesz zamknąć okno importu. Wysłano ${results.length}/${tasks.length} paczek.`);
                return;
            }

            setStep('done');
            setMessage(`Gotowe. Opublikowano ${totals.ok} frachtów. Importy: ${runCount} (${duplicateText(duplicateCount)}). Czas trwania publikacji ${formatDuration(Date.now() - publicationStartedAt)}.`, 'success');
            setProgressNote(`Możesz zamknąć okno importu. Plik miał ${chunkPlan.rowCount} ofert, łącznie przetworzono ${totals.total} wierszy.`);
        } catch (error) {
            setStep(currentStep === 'publish' ? 'publish-error' : 'validation-error');
            setMessage(error.message || String(error), 'error');
        } finally {
            busy = false;
            currentImportTracker = null;
            currentImportAbortController = null;
            updateBusy();
            setProgressControl(0, 0, false);
        }
    }

    function createAssistant() {
        if (document.getElementById('tcia-overlay')) {
            showAssistant();
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'tcia-overlay';
        overlay.innerHTML = `
            <div id="tcia-dialog" role="dialog" aria-modal="true" aria-labelledby="tcia-title">
                <button id="tcia-minimize" type="button" title="Minimalizuj">−</button>
                <button id="tcia-close" type="button" title="Zamknij">×</button>
                <div class="tcia-header">
                    <div>
                        <div class="tcia-kicker">TRANS ASSISTANT</div>
                        <h2 id="tcia-title">Import frachtów z CSV</h2>
                    </div>
                    <div class="tcia-badge">${ASSISTANT_VERSION}</div>
                </div>

                <div class="tcia-steps">
                    <div class="tcia-step is-active" data-step="file"><span>1</span>Plik CSV</div>
                    <div class="tcia-step" data-step="validation"><span>2</span>Walidacja</div>
                    <div class="tcia-step" data-step="publish"><span>3</span>Publikacja</div>
                    <div class="tcia-step" data-step="done"><span>4</span>Gotowe</div>
                </div>

                <div class="tcia-body">
                    <input id="tcia-file" type="file" accept=".csv,text/csv" />
                    <label id="tcia-dropzone" for="tcia-file">
                        <span class="tcia-upload-icon">↑</span>
                        <span class="tcia-upload-title">Wybierz plik CSV</span>
                        <span id="tcia-file-name">Nie wybrano pliku</span>
                    </label>

                    <div class="tcia-stats">
                        <div><strong id="tcia-stat-total">0</strong><span>Razem</span></div>
                        <div><strong id="tcia-stat-ok">0</strong><span>Opublikowane</span></div>
                        <div><strong id="tcia-stat-processing">0</strong><span>W toku</span></div>
                    </div>

                    <div id="tcia-message" class="tcia-message is-info">Wybierz plik CSV do importu.</div>
                    <div id="tcia-progress-note" class="tcia-progress-note"></div>
                </div>

                <div class="tcia-footer">
                    <div class="tcia-duplicate-control" id="tcia-duplicate-control">
                        <div class="tcia-duplicate-head">
                            <label id="tcia-repeat-label" for="tcia-repeat-count">Ilość duplikatów</label>
                            <strong id="tcia-repeat-value">${DEFAULT_DUPLICATE_COUNT}</strong>
                        </div>
                        <input id="tcia-repeat-count" type="range" min="0" max="${MAX_DUPLICATE_COUNT}" step="1" value="${DEFAULT_DUPLICATE_COUNT}" />
                        <div class="tcia-live-progress" aria-hidden="true">
                            <span id="tcia-live-progress-bar"></span>
                            <strong id="tcia-live-progress-text">0%</strong>
                        </div>
                    </div>
                    <div class="tcia-actions">
                        <button id="tcia-stop" type="button" class="tcia-stop" disabled>STOP</button>
                        <button id="tcia-run" type="button" class="tcia-primary">Importuj i opublikuj</button>
                    </div>
                </div>
            </div>
        `;

        const mini = document.createElement('div');
        mini.id = 'tcia-mini';
        mini.innerHTML = `
            <div class="tcia-mini-head">
                <div class="tcia-mini-kicker">TRANS ASSISTANT</div>
                <div class="tcia-mini-actions">
                    <button id="tcia-mini-expand" type="button" title="Pokaż okno">−</button>
                    <button id="tcia-mini-close" type="button" title="Zamknij">×</button>
                </div>
            </div>
            <div class="tcia-mini-progress">
                <div id="tcia-mini-progress-bar"></div>
            </div>
            <div id="tcia-mini-status">Czeka na import CSV.</div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #tcia-overlay {
                position: fixed;
                inset: 0;
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(12, 24, 39, 0.48);
                backdrop-filter: blur(2px);
                font-family: Inter, Arial, sans-serif;
                color: #172033;
            }
            #tcia-dialog {
                position: relative;
                width: min(860px, calc(100vw - 72px));
                min-height: 560px;
                background: #fff;
                border-radius: 18px;
                box-shadow: 0 24px 70px rgba(11, 31, 54, 0.32);
                overflow: hidden;
            }
            #tcia-close,
            #tcia-minimize {
                position: absolute;
                top: 18px;
                width: 34px;
                height: 34px;
                border: 0;
                border-radius: 50%;
                background: #edf3fb;
                color: #59708c;
                cursor: pointer;
                font-size: 22px;
                line-height: 30px;
                z-index: 2;
            }
            #tcia-close {
                right: 18px;
            }
            #tcia-minimize {
                right: 58px;
                font-size: 24px;
            }
            #tcia-close:hover,
            #tcia-minimize:hover {
                background: #dce9f8;
                color: #254f7d;
            }
            .tcia-header {
                display: flex;
                justify-content: space-between;
                gap: 28px;
                padding: 34px 42px 26px;
                background: linear-gradient(135deg, #f7fbff 0%, #eef5fd 100%);
                border-bottom: 1px solid #dfeaf6;
            }
            .tcia-kicker {
                color: #1b75bb;
                font-weight: 800;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                font-size: 12px;
                margin-bottom: 8px;
            }
            #tcia-title {
                margin: 0;
                color: #10243d;
                font-size: 28px;
                line-height: 1.18;
            }
            .tcia-header p {
                margin: 10px 0 0;
                color: #65758b;
                font-size: 14px;
                line-height: 1.45;
                max-width: 610px;
            }
            .tcia-badge {
                align-self: flex-start;
                margin-right: 88px;
                padding: 10px 16px;
                border-radius: 999px;
                background: #e8f6ef;
                color: #188052;
                font-weight: 800;
                font-size: 13px;
            }
            .tcia-steps {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                padding: 20px 42px 0;
                gap: 10px;
            }
            .tcia-step {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #8b9bb0;
                font-weight: 700;
                font-size: 13px;
            }
            .tcia-step span {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 26px;
                height: 26px;
                border-radius: 50%;
                background: #edf3fb;
                color: #6f8198;
            }
            .tcia-step.is-active,
            .tcia-step.is-done {
                color: #1b75bb;
            }
            .tcia-step.is-active span {
                background: #1b75bb;
                color: #fff;
            }
            .tcia-step.is-done span {
                background: #27a162;
                color: #fff;
            }
            .tcia-step.is-error {
                color: #c0392b;
            }
            .tcia-step.is-error span {
                background: #c0392b;
                color: #fff;
            }
            .tcia-body {
                padding: 24px 42px 8px;
            }
            #tcia-file {
                position: absolute;
                opacity: 0;
                pointer-events: none;
                width: 1px;
                height: 1px;
            }
            #tcia-dropzone {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 145px;
                border: 2px dashed #9fbee2;
                border-radius: 16px;
                background: #f7fbff;
                cursor: pointer;
                transition: all 0.15s ease;
                text-align: center;
            }
            #tcia-dropzone:hover,
            #tcia-dropzone.is-dragover {
                border-color: #1b75bb;
                background: #eef7ff;
                transform: translateY(-1px);
            }
            .tcia-upload-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 42px;
                height: 42px;
                border-radius: 50%;
                background: #1b75bb;
                color: #fff;
                font-size: 28px;
                font-weight: 800;
                margin-bottom: 12px;
            }
            .tcia-upload-title {
                color: #10243d;
                font-size: 18px;
                font-weight: 800;
                margin-bottom: 4px;
            }
            #tcia-file-name {
                color: #65758b;
                font-size: 13px;
            }
            .tcia-stats {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 12px;
                margin: 20px 0 16px;
            }
            .tcia-stats div {
                padding: 15px;
                border-radius: 14px;
                background: #f4f7fb;
                border: 1px solid #e5edf7;
            }
            .tcia-stats strong {
                display: block;
                font-size: 24px;
                color: #10243d;
                line-height: 1;
                margin-bottom: 6px;
            }
            .tcia-stats span {
                color: #73849b;
                font-size: 12px;
                font-weight: 700;
            }
            .tcia-message {
                min-height: 48px;
                border-radius: 14px;
                padding: 14px 16px;
                font-size: 14px;
                line-height: 1.45;
                white-space: pre-wrap;
            }
            .tcia-message.is-info {
                background: #eef6ff;
                color: #244b73;
                border: 1px solid #cfe3f8;
            }
            .tcia-message.is-success {
                background: #e9f8f0;
                color: #12683e;
                border: 1px solid #bde8cf;
            }
            .tcia-message.is-warning {
                background: #fff7dd;
                color: #7a5a00;
                border: 1px solid #f1d98a;
            }
            .tcia-message.is-error {
                background: #fff0ef;
                color: #a83228;
                border: 1px solid #f2b8b5;
            }
            .tcia-progress-note {
                color: #73849b;
                font-size: 12px;
                margin: 10px 2px 0;
                min-height: 16px;
            }
            .tcia-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 22px;
                padding: 24px 42px 34px;
            }
            .tcia-actions {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .tcia-duplicate-control {
                flex: 1;
                max-width: 390px;
                padding: 12px 16px;
                border-radius: 16px;
                background: linear-gradient(135deg, #f5f9ff 0%, #edf6ff 100%);
                border: 1px solid #d8e8fa;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
            }
            .tcia-duplicate-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 10px;
            }
            .tcia-duplicate-head label {
                color: #10243d;
                font-size: 13px;
                font-weight: 800;
            }
            .tcia-duplicate-head strong {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 38px;
                height: 28px;
                border-radius: 999px;
                background: #1b75bb;
                color: #fff;
                font-size: 15px;
                font-weight: 900;
                box-shadow: 0 6px 14px rgba(27, 117, 187, 0.22);
            }
            #tcia-repeat-count {
                --tcia-range-value: 0%;
                width: 100%;
                height: 10px;
                appearance: none;
                -webkit-appearance: none;
                border-radius: 999px;
                outline: none;
                background: linear-gradient(90deg, #1b75bb 0%, #27a162 var(--tcia-range-value), #dbe8f6 var(--tcia-range-value), #dbe8f6 100%);
                cursor: pointer;
            }
            .tcia-live-progress {
                display: none;
                position: relative;
                width: 100%;
                height: 28px;
                border-radius: 999px;
                overflow: hidden;
                background: #dbe8f6;
                box-shadow: inset 0 1px 2px rgba(16, 36, 61, 0.08);
            }
            .tcia-live-progress span {
                display: block;
                width: 0%;
                height: 100%;
                border-radius: inherit;
                background: linear-gradient(90deg, #1b75bb 0%, #27a162 100%);
                transition: width 0.25s ease;
            }
            .tcia-live-progress strong {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #10243d;
                font-size: 13px;
                font-weight: 900;
                text-shadow: 0 1px 0 rgba(255,255,255,0.55);
            }
            .tcia-duplicate-control.is-progress #tcia-repeat-count {
                display: none;
            }
            .tcia-duplicate-control.is-progress {
                max-width: 460px;
                padding: 16px 18px;
            }
            .tcia-duplicate-control.is-progress .tcia-duplicate-head {
                display: none;
            }
            .tcia-duplicate-control.is-progress .tcia-live-progress {
                display: block;
            }
            #tcia-repeat-count::-webkit-slider-thumb {
                appearance: none;
                -webkit-appearance: none;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #fff;
                border: 5px solid #1b75bb;
                box-shadow: 0 5px 14px rgba(27, 117, 187, 0.35);
            }
            #tcia-repeat-count::-moz-range-thumb {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #fff;
                border: 5px solid #1b75bb;
                box-shadow: 0 5px 14px rgba(27, 117, 187, 0.35);
            }
            .tcia-primary,
            .tcia-secondary,
            .tcia-stop {
                border: 0;
                border-radius: 12px;
                padding: 13px 22px;
                cursor: pointer;
                font-weight: 800;
                font-size: 14px;
            }
            .tcia-stop {
                min-width: 74px;
                padding-left: 14px;
                padding-right: 14px;
                background: linear-gradient(135deg, #d84a3a, #a92d24);
                color: #fff;
                box-shadow: 0 10px 22px rgba(194, 47, 36, 0.22);
            }
            .tcia-stop:hover:not(:disabled) {
                background: linear-gradient(135deg, #ef5b49, #b9342b);
            }
            .tcia-primary {
                background: linear-gradient(135deg, #1b75bb, #14599b);
                color: #fff;
                min-width: 210px;
                box-shadow: 0 10px 24px rgba(27, 117, 187, 0.28);
            }
            .tcia-primary:hover {
                background: linear-gradient(135deg, #2183cf, #1765ad);
            }
            .tcia-secondary {
                background: #edf3fb;
                color: #31506f;
            }
            .tcia-secondary:hover {
                background: #ddeaf8;
            }
            .tcia-primary:disabled,
            .tcia-secondary:disabled {
                opacity: 0.62;
                cursor: wait;
                box-shadow: none;
            }
            .tcia-stop:disabled {
                opacity: 0.42;
                cursor: not-allowed;
                box-shadow: none;
                filter: grayscale(0.25);
            }
            #tcia-mini {
                position: fixed;
                right: 22px;
                bottom: 22px;
                z-index: 999999;
                display: none;
                width: 310px;
                padding: 14px 14px 13px;
                border-radius: 16px;
                background: #f7fbff;
                border: 1px solid #d6e6f7;
                box-shadow: 0 14px 36px rgba(11, 31, 54, 0.28);
                font-family: Inter, Arial, sans-serif;
                color: #10243d;
            }
            .tcia-mini-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 10px;
            }
            .tcia-mini-kicker {
                color: #1b75bb;
                font-weight: 800;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                font-size: 11px;
            }
            .tcia-mini-actions {
                display: flex;
                gap: 6px;
            }
            .tcia-mini-actions button {
                width: 25px;
                height: 25px;
                border: 0;
                border-radius: 50%;
                background: #edf3fb;
                color: #59708c;
                cursor: pointer;
                font-size: 15px;
                font-weight: 800;
                line-height: 23px;
            }
            .tcia-mini-actions button:hover {
                background: #dce9f8;
                color: #254f7d;
            }
            .tcia-mini-progress {
                height: 9px;
                border-radius: 999px;
                overflow: hidden;
                background: #e4eef9;
                border: 1px solid #d4e4f5;
            }
            #tcia-mini-progress-bar {
                width: 0%;
                height: 100%;
                border-radius: inherit;
                background: linear-gradient(135deg, #1b75bb, #27a162);
                transition: width 0.2s ease;
            }
            #tcia-mini-status {
                margin-top: 9px;
                color: #415a77;
                font-size: 12px;
                line-height: 1.35;
                font-weight: 700;
            }
        `;

        document.documentElement.appendChild(style);
        document.body.appendChild(overlay);
        document.body.appendChild(mini);

        const fileInput = document.getElementById('tcia-file');
        const dropzone = document.getElementById('tcia-dropzone');

        fileInput.addEventListener('change', async event => {
            await handleSelectedFile(event.target.files && event.target.files[0] ? event.target.files[0] : null);
        });

        const repeatInput = document.getElementById('tcia-repeat-count');
        if (repeatInput) {
            repeatInput.addEventListener('input', updateRepeatValue);
            updateRepeatValue();
        }

        dropzone.addEventListener('dragover', event => {
            event.preventDefault();
            dropzone.classList.add('is-dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('is-dragover');
        });

        dropzone.addEventListener('drop', async event => {
            event.preventDefault();
            dropzone.classList.remove('is-dragover');
            await handleSelectedFile(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null);
        });

        document.getElementById('tcia-run').addEventListener('click', runImport);
        document.getElementById('tcia-stop').addEventListener('click', requestStopImport);
        document.getElementById('tcia-minimize').addEventListener('click', () => {
            overlay.style.display = 'none';
            mini.style.display = 'block';
        });
        document.getElementById('tcia-close').addEventListener('click', () => {
            overlay.remove();
            mini.remove();
        });
        document.getElementById('tcia-mini-expand').addEventListener('click', () => {
            overlay.style.display = 'flex';
            mini.style.display = 'none';
        });
        document.getElementById('tcia-mini-close').addEventListener('click', () => {
            overlay.remove();
            mini.remove();
        });

        setStep('file');
        setMessage('Wybierz plik CSV do importu.', 'info');
        setProgressNote('');
        updateMiniProgress(0, 0, 0, 0);
        updateBusy();
    }

    async function handleSelectedFile(file) {
        selectedFile = file || null;
        selectedFileValid = false;
        plannedPublicationTotal = 0;
        updateStatsValues(0, 0, 0, 0);
        setProgressControl(0, 0, false);

        if (!selectedFile) {
            setFileName('Nie wybrano pliku.');
            setMessage('Wybierz plik CSV do importu.', 'warning');
            return;
        }

        setFileName(`${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)`);
        const validation = await validateTransCsvFile(selectedFile);
        selectedFileValid = validation.ok;
        setMessage(validation.message, validation.ok ? 'success' : 'error');
        setProgressNote(validation.ok ? 'Plik jest gotowy do importu.' : 'Import zatrzymany przed wysyłką do Trans.eu.');
    }

    function setFileName(text) {
        const node = document.getElementById('tcia-file-name');
        if (node) node.textContent = text;
    }

    function setMessage(message, type) {
        const node = document.getElementById('tcia-message');
        if (!node) return;

        node.className = `tcia-message is-${type || 'info'}`;
        node.textContent = message;
        console.log('[Trans CSV Import Assistant]', message);
    }

    function setProgressNote(text) {
        const node = document.getElementById('tcia-progress-note');
        if (node) node.textContent = text || '';
    }

    function updateRepeatValue() {
        const input = document.getElementById('tcia-repeat-count');
        const valueNode = document.getElementById('tcia-repeat-value');
        const control = document.getElementById('tcia-duplicate-control');
        const label = document.getElementById('tcia-repeat-label');
        if (!input) return;
        if (control && control.classList.contains('is-progress')) return;

        const value = readDuplicateCount();
        const percent = MAX_DUPLICATE_COUNT > 0 ? (value / MAX_DUPLICATE_COUNT) * 100 : 0;

        input.value = String(value);
        input.style.setProperty('--tcia-range-value', `${percent}%`);
        if (label) label.textContent = 'Ilość duplikatów';
        if (valueNode) valueNode.textContent = String(value);
    }

    function setProgressControl(completed, total, active) {
        const control = document.getElementById('tcia-duplicate-control');
        const label = document.getElementById('tcia-repeat-label');
        const valueNode = document.getElementById('tcia-repeat-value');
        const bar = document.getElementById('tcia-live-progress-bar');
        const progressText = document.getElementById('tcia-live-progress-text');
        const safeTotal = Number(total || 0);
        const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed || 0)));
        const percent = safeTotal > 0 ? Math.min(100, Math.round((safeCompleted / safeTotal) * 100)) : 0;

        if (!control) return;

        if (!active || safeTotal <= 0) {
            control.classList.remove('is-progress');
            if (bar) bar.style.width = '0%';
            if (progressText) progressText.textContent = '0%';
            updateRepeatValue();
            return;
        }

        control.classList.add('is-progress');
        if (label) label.textContent = 'Postęp publikacji';
        if (valueNode) valueNode.textContent = `${percent}%`;
        if (bar) bar.style.width = `${percent}%`;
        if (progressText) progressText.textContent = `${percent}%`;
    }

    function updateMiniProgress(total, ok, processing, errors) {
        const bar = document.getElementById('tcia-mini-progress-bar');
        const status = document.getElementById('tcia-mini-status');
        const safeTotal = Number(total || 0);
        const safeOk = Number(ok || 0);
        const safeProcessing = Number(processing || 0);
        const safeErrors = Number(errors || 0);
        const completed = safeTotal > 0 ? Math.max(0, safeTotal - safeProcessing) : 0;
        const percent = safeTotal > 0 ? Math.min(100, Math.round((completed / safeTotal) * 100)) : 0;

        if (bar) bar.style.width = `${percent}%`;
        if (!status) return;

        if (safeTotal <= 0) {
            status.textContent = 'Czeka na import CSV.';
        } else if (safeProcessing > 0) {
            status.textContent = `${safeOk}/${safeTotal} opublikowane, ${safeProcessing} w toku${safeErrors ? `, błędy: ${safeErrors}` : ''}.`;
        } else if (safeErrors > 0) {
            status.textContent = `Zakończono z błędami: ${safeOk}/${safeTotal} opublikowane, błędy: ${safeErrors}.`;
        } else {
            status.textContent = `Gotowe: opublikowano ${safeOk}/${safeTotal} frachtów.`;
        }
    }

    function setStep(step) {
        const order = ['file', 'validation', 'publish', 'done'];
        const activeIndex = order.indexOf(step);
        const errorStep = step && step.endsWith('-error') ? step.replace('-error', '') : '';
        const errorIndex = order.indexOf(errorStep);

        if (activeIndex > -1) currentStep = step;

        document.querySelectorAll('.tcia-step').forEach(node => {
            const nodeStep = node.getAttribute('data-step');
            const nodeIndex = order.indexOf(nodeStep);

            node.classList.remove('is-active', 'is-done', 'is-error');

            if (errorStep) {
                if (nodeStep === errorStep) {
                    node.classList.add('is-error');
                } else if (errorIndex > -1 && nodeIndex > -1 && nodeIndex < errorIndex) {
                    node.classList.add('is-done');
                }
                return;
            }

            if (step === 'done') {
                node.classList.add('is-done');
                return;
            }

            if (nodeStep === step) {
                node.classList.add('is-active');
            } else if (activeIndex > -1 && nodeIndex > -1 && nodeIndex < activeIndex) {
                node.classList.add('is-done');
            }
        });
    }

    function updateStats(data) {
        const state = getState(data);
        const total = Number(state.total || 0);
        const ok = Number(state.success || 0);
        const processing = Number(state.processing || 0);
        const errors = Number(state.failure || 0) + Number(state.publication_failure || 0);

        updateStatsValues(total, ok, processing, errors);
    }

    function updateStatsWithRunningBatch(totals, batchData) {
        const summary = stateSummary(batchData);

        updateStatsValues(
            Number(totals.total || 0) + summary.total,
            Number(totals.ok || 0) + summary.ok,
            summary.processing,
            Number(totals.errors || 0) + summary.errors
        );
    }

    function updateStatsValues(total, ok, processing, errors) {
        const safeOk = Number(ok || 0);
        const safeErrors = Number(errors || 0);
        const visibleTotal = plannedPublicationTotal > 0 ? plannedPublicationTotal : Number(total || 0);
        const visibleProcessing = plannedPublicationTotal > 0
            ? Math.max(0, visibleTotal - safeOk - safeErrors)
            : Number(processing || 0);

        setStat('tcia-stat-total', visibleTotal);
        setStat('tcia-stat-ok', safeOk);
        setStat('tcia-stat-processing', visibleProcessing);
        setStat('tcia-stat-errors', safeErrors);
        updateMiniProgress(visibleTotal, safeOk, visibleProcessing, safeErrors);
        if (busy && visibleTotal > 0) setProgressControl(safeOk + safeErrors, visibleTotal, true);
    }

    function setStat(id, value) {
        const node = document.getElementById(id);
        if (node) node.textContent = String(value || 0);
    }

    function updateBusy() {
        const run = document.getElementById('tcia-run');
        const stop = document.getElementById('tcia-stop');
        const file = document.getElementById('tcia-file');
        const repeat = document.getElementById('tcia-repeat-count');

        if (run) run.disabled = busy;
        if (stop) stop.disabled = !busy || stopImportRequested;
        if (file) file.disabled = busy;
        if (repeat) repeat.disabled = busy;
    }

    hookAuthCapture();
})();
