import { gvar } from "@/globalVar"

declare global {
	interface GlobalVar {
		sess: Session
	}
}

type SessionCallback = () => void | Promise<void>

class Session {
	installCbs: Set<() => void> = new Set()
	safeCbs: Set<SessionCallback> = new Set()
	safeStartupCbs: Set<SessionCallback> = new Set()
	ready?: Promise<void>
	#loadedForSession = false
	#installPending = false
	#completedCbs = new Set<SessionCallback>()
	constructor() {
		chrome.runtime.onInstalled.addListener(this.handleInstall)
		chrome.runtime.onStartup.addListener(this.handleStartup)
	}
	handleInstall = async () => {
		if (this.#loadedForSession) return
		this.#loadedForSession = true
		this.#installPending = true
		await this.ensureReady()
	}
	handleStartup = async () => {
		if (this.#loadedForSession) return
		this.#loadedForSession = true
		await this.ensureReady()
	}
	ensureReady = () => {
		// Ordinary worker wakes have no session initialization to retry.
		if (!this.#loadedForSession) return Promise.resolve()
		return (this.ready ??= this.handleCommon().catch((err) => {
			this.ready = undefined
			throw err
		}))
	}
	handleCommon = async () => {
		if (this.#installPending) {
			this.installCbs.forEach((cb) => cb())
			await gvar.installPromise
			this.#installPending = false
		}
		// Resume failed initialization without repeating completed cleanup.
		for (const cb of [...this.safeCbs, ...this.safeStartupCbs]) {
			if (this.#completedCbs.has(cb)) continue
			await cb()
			this.#completedCbs.add(cb)
		}
	}
}

gvar.sess = new Session()

export {}
