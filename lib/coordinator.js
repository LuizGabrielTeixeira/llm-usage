/*
 * Provider coordinator: one shared refresh clock, per-provider de-duplication,
 * bounded refreshes and destroy-safe callbacks.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {nextDelaySeconds} from './backoff.js';

const REFRESH_TIMEOUT_SECONDS = 90;

export class ProviderCoordinator {
    /**
     * @param {Array<{id: string, source: object}>} sources
     * @param {(id: string, snapshot: object) => void} onUpdate
     */
    constructor({sources, onUpdate}) {
        this._sources = new Map(sources.map(({id, source}) => [id, source]));
        this._onUpdate = onUpdate;
        this._enabled = new Set(this._sources.keys());
        this._inFlight = new Map(); // id -> GCancellable
        this._timerId = null;
        this._intervalSeconds = 0;
        this._delays = new Map(); // id -> current back-off delay (seconds)
        this._notBefore = new Map(); // id -> earliest timer refresh (ms)
        this._destroyed = false;
    }

    isEnabled(id) {
        return this._enabled.has(id);
    }

    /** Enables the given ids; newly enabled providers are refreshed once. */
    setEnabled(ids) {
        const next = new Set(ids);
        const newlyEnabled = [...next].filter(id => !this._enabled.has(id));
        this._enabled = next; // must be updated first: refreshProvider guards on it
        for (const id of newlyEnabled)
            this.refreshProvider(id);
    }

    refreshProvider(id) {
        if (this._destroyed)
            return;
        if (!this._sources.has(id) || !this._enabled.has(id))
            return;
        if (this._inFlight.has(id))
            return; // de-dup: timer + menu open + manual refresh can overlap

        const source = this._sources.get(id);
        const cancellable = new Gio.Cancellable();
        this._inFlight.set(id, cancellable);

        let timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_TIMEOUT_SECONDS,
            () => {
                timeoutId = null;
                cancellable.cancel();
                this._inFlight.delete(id);
                return GLib.SOURCE_REMOVE;
            });

        const onSnapshot = snap => {
            if (this._destroyed)
                return;
            if (timeoutId !== null) {
                GLib.source_remove(timeoutId);
                timeoutId = null;
            }
            this._inFlight.delete(id);
            if (snap && snap.providerId) {
                this._updateBackoff(id, snap);
                this._onUpdate(id, snap);
            }
        };

        try {
            source.refresh(onSnapshot, cancellable);
        } catch (e) {
            console.error(`LLM Usage: provider ${id} failed to start:`, e.message);
            if (timeoutId !== null) {
                GLib.source_remove(timeoutId);
                timeoutId = null;
            }
            this._inFlight.delete(id);
        }
    }

    refreshAll() {
        for (const id of this._enabled)
            this.refreshProvider(id);
    }

    /** Base polling interval; also clears any back-off. */
    setRefreshInterval(seconds) {
        this._intervalSeconds = seconds;
        this._delays.clear();
        this._notBefore.clear();
    }

    /** Timer tick: like refreshAll, but skips providers backing off after a 429. */
    refreshDue() {
        const now = Date.now();
        for (const id of this._enabled) {
            if (now >= (this._notBefore.get(id) ?? 0))
                this.refreshProvider(id);
        }
    }

    _updateBackoff(id, snap) {
        if (this._intervalSeconds <= 0)
            return;
        const delay = nextDelaySeconds(
            this._intervalSeconds, this._delays.get(id) ?? this._intervalSeconds, snap);
        this._delays.set(id, delay);
        if (delay > this._intervalSeconds)
            this._notBefore.set(id, Date.now() + delay * 1000);
        else
            this._notBefore.delete(id);
    }

    startTimer(intervalSeconds) {
        this.stopTimer();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            intervalSeconds,
            () => {
                this.refreshAll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this.stopTimer();
        for (const cancellable of this._inFlight.values())
            cancellable.cancel();
        this._inFlight.clear();
    }
}
