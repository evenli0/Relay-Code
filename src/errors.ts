/**
 * 统一错误处理工具
 *
 * 提供类型安全的错误解构函数，替代 catch (e: any)。
 */

export interface UnwrappedError {
	message: string;
	name: string;
	status?: number;
	code?: string;
}

/** 将 unknown 类型的错误解构为可安全访问的结构 */
export function unwrapError(err: unknown): UnwrappedError {
	if (err instanceof Error) {
		return {
			message: err.message,
			name: err.name,
			code: (err as NodeJS.ErrnoException).code,
		};
	}
	if (typeof err === "object" && err !== null) {
		const obj = err as Record<string, unknown>;
		return {
			message: typeof obj.message === "string" ? obj.message : String(err),
			name: typeof obj.name === "string" ? obj.name : "UnknownError",
			status: typeof obj.status === "number" ? obj.status : undefined,
			code: typeof obj.code === "string" ? obj.code : undefined,
		};
	}
	return {
		message: String(err),
		name: "UnknownError",
	};
}
