/*
 * Provider coordinator: one shared refresh clock, per-provider de-duplication,
 * bounded refreshes and destroy-safe callbacks.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
            if (snap && snap.providerId)
                this._onUpdate(id, snap);
        };

        try {
            source.refresh(onSnapshot, cancellable);
        } catch (e) {
            console.error(`Codex Usage: provider ${id} failed to start:`, e.message);
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
