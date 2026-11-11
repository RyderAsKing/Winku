// Engine → shell Requests and their Responses, correlated by id.
import type { Request, Response } from "./protocol.ts";

type RequestMethod = Request["method"];
type ParamsOf<M extends RequestMethod> = Extract<Request, { method: M }>["params"];

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

export class RequestTimeout extends Error {}
export class RequestAborted extends Error {}

export class ShellRequests {
	private readonly pending = new Map<string, Pending>();
	private next = 0;

	constructor(private readonly send: (request: Request) => void) {}

	/** Send a Request and wait for its Response's data. Rejects on an error Response, timeout or abort. */
	request<M extends RequestMethod>(
		method: M,
		params: ParamsOf<M>,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const { timeoutMs, signal } = options;
		if (signal?.aborted) return Promise.reject(new RequestAborted("Aborted"));
		const id = `r${++this.next}`;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				this.pending.get(id)?.cleanup();
				reject(new RequestAborted("Aborted"));
			};
			const cleanup = () => {
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			this.pending.set(id, { resolve, reject, cleanup });
			if (timeoutMs !== undefined)
				timer = setTimeout(() => {
					cleanup();
					reject(new RequestTimeout(`The shell did not answer "${method}" in time`));
				}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.send({ type: "request", id, method, params } as Request);
		});
	}

	/** Route a Response to its waiting Request. Unknown ids (late answers) are ignored. */
	handle(response: Response): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		pending.cleanup();
		if (response.ok) pending.resolve(response.data);
		else pending.reject(new Error(response.error || "The shell could not do that"));
	}
}
