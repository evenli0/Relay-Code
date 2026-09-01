/**
 * service-package.ts —— 集群 App 包（rpk，framework-design §10.2，Phase5-B）
 *
 * rpk = 单个 JSON 文件：manifest + 文件树 + SHA-256 checksum。
 *   导出：services/<id>/ → packages/<id>-<version>.rpk
 *   导入：校验 manifest + checksum + 依赖 → 落盘 services/<id>/ → sync 生效
 *   冲突：已存在 → 自动备份旧版（.relay/backups/）→ 覆盖安装；rollback 恢复
 *   签名：标记 TODO（无密钥体系不假装有；checksum 防篡改/损坏）
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { type ServiceContract, validateContract } from "./service-contract";

export interface RpkManifest {
	format: "relay-package";
	id: string;
	version: string;
	name: string;
	description: string;
	archetype: string;
	execution: string;
	dependsOn: string[];
	createdAt: number;
	author?: string;
}

export interface RpkFile {
	/** 相对服务目录，如 entry.ts / service.json */
	path: string;
	content: string;
	/** 内容 SHA-256（完整性校验，防篡改/损坏） */
	sha256: string;
}

export interface RpkPackage {
	manifest: RpkManifest;
	files: RpkFile[];
}

const PACKAGES_DIR = "packages";
const BACKUPS_DIR = ".relay/backups";
/** 导出时跳过的运行时目录（服务自管状态） */
const SKIP_DIRS = new Set(["data"]);

export function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** 导出服务为 rpk 包 */
export function exportServicePackage(
	serviceId: string,
	dir = "services",
): { ok: true; path: string; pkg: RpkPackage } | { ok: false; error: string } {
	const contractPath = `${dir}/${serviceId}/service.json`;
	if (!existsSync(contractPath)) {
		return { ok: false, error: `服务不存在: ${serviceId}` };
	}
	let contract: ServiceContract;
	try {
		contract = JSON.parse(
			readFileSync(contractPath, "utf-8"),
		) as ServiceContract;
	} catch (e) {
		return { ok: false, error: `service.json 解析失败: ${e}` };
	}
	const v = validateContract(contract);
	if (!v.ok) return { ok: false, error: `契约无效: ${v.errors.join("; ")}` };

	const files: RpkFile[] = [];
	const collectErr = collectFiles(`${dir}/${serviceId}`, "", files);
	if (collectErr) return { ok: false, error: collectErr };

	const pkg: RpkPackage = {
		manifest: {
			format: "relay-package",
			id: contract.id,
			version: contract.version,
			name: contract.name,
			description: contract.description,
			archetype: contract.archetype,
			execution: contract.execution,
			dependsOn: [],
			createdAt: Date.now(),
		},
		files,
	};
	if (!existsSync(PACKAGES_DIR)) mkdirSync(PACKAGES_DIR, { recursive: true });
	const path = `${PACKAGES_DIR}/${contract.id}-${contract.version}.rpk`;
	writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
	return { ok: true, path, pkg };
}

/** 校验包：结构 + manifest + 每个文件 checksum */
export function validatePackage(
	raw: unknown,
): { ok: true; pkg: RpkPackage } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, errors: ["包必须是对象"] };
	}
	const pkg = raw as RpkPackage;
	const m = pkg.manifest;
	if (m?.format !== "relay-package") {
		errors.push("manifest.format 必须是 relay-package");
	}
	if (typeof m?.id !== "string" || !m.id) errors.push("manifest.id 必填");
	if (typeof m?.version !== "string" || !m.version) {
		errors.push("manifest.version 必填");
	}
	if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
		errors.push("files 必填且非空");
	}
	if (!pkg.files?.some((f) => f.path === "service.json")) {
		errors.push("包内必须包含 service.json");
	}
	for (const f of pkg.files ?? []) {
		if (
			typeof f.path !== "string" ||
			typeof f.content !== "string" ||
			typeof f.sha256 !== "string"
		) {
			errors.push(`文件 ${f.path} 结构无效`);
			continue;
		}
		if (sha256Hex(f.content) !== f.sha256) {
			errors.push(`文件 ${f.path} checksum 不匹配（包可能被篡改或损坏）`);
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, pkg };
}

/**
 * 安装包到 services/<id>/：依赖检查 → 冲突备份 → 落盘。
 * 安装后由调用方执行 supervisor.sync() 热加载。
 */
export function installPackage(
	pkg: RpkPackage,
	dir = "services",
):
	| { ok: true; installed: string; backedUp?: string }
	| { ok: false; error: string } {
	const v = validatePackage(pkg);
	if (!v.ok) return { ok: false, error: v.errors.join("; ") };

	const id = pkg.manifest.id;
	// 依赖检查
	for (const dep of pkg.manifest.dependsOn ?? []) {
		if (!existsSync(`${dir}/${dep}/service.json`)) {
			return { ok: false, error: `依赖缺失: ${dep}（先安装依赖服务）` };
		}
	}

	// 冲突：已存在 → 备份旧版
	let backedUp: string | undefined;
	const target = `${dir}/${id}`;
	if (existsSync(target)) {
		if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
		backedUp = `${BACKUPS_DIR}/${id}-${Date.now().toString(36)}`;
		try {
			copyDir(target, backedUp);
		} catch (e) {
			return { ok: false, error: `备份旧版失败: ${e}` };
		}
	}

	// 落盘
	try {
		if (!existsSync(target)) mkdirSync(target, { recursive: true });
		for (const f of pkg.files) {
			const full = `${target}/${f.path}`;
			const dirPart = full.slice(0, full.lastIndexOf("/"));
			if (!existsSync(dirPart)) mkdirSync(dirPart, { recursive: true });
			writeFileSync(full, f.content, "utf-8");
		}
	} catch (e) {
		return { ok: false, error: `写入失败: ${e}` };
	}
	return { ok: true, installed: id, backedUp };
}

/** 回滚到最近一次备份（当前版本先备份，防误回滚） */
export function rollbackService(
	serviceId: string,
	dir = "services",
): { ok: true; from: string } | { ok: false; error: string } {
	if (!existsSync(BACKUPS_DIR)) return { ok: false, error: "无备份目录" };
	const backups = readdirSync(BACKUPS_DIR)
		.filter((n) => n.startsWith(`${serviceId}-`))
		.sort();
	if (backups.length === 0)
		return { ok: false, error: `无 ${serviceId} 的备份` };
	const latest = backups[backups.length - 1] ?? "";

	const target = `${dir}/${serviceId}`;
	if (existsSync(target)) {
		copyDir(target, `${BACKUPS_DIR}/${serviceId}-${Date.now().toString(36)}`);
	}
	rmSync(target, { recursive: true, force: true });
	copyDir(`${BACKUPS_DIR}/${latest}`, target);
	return { ok: true, from: latest };
}

function collectFiles(
	dir: string,
	prefix: string,
	out: RpkFile[],
): string | null {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const err = collectFiles(full, rel, out);
			if (err) return err;
		} else {
			const content = readFileSync(full, "utf-8");
			out.push({ path: rel, content, sha256: sha256Hex(content) });
		}
	}
	return null;
}

function copyDir(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const src = `${from}/${entry.name}`;
		const dst = `${to}/${entry.name}`;
		if (entry.isDirectory()) copyDir(src, dst);
		else copyFileSync(src, dst);
	}
}
