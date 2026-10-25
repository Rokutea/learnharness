import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CourseFileKind, CourseIndex, CourseIndexedFile, CourseIndexSummary } from "../../core/contracts.ts";
import { chunkMarkdown } from "../../core/course-search.ts";
import { pdfPageTexts } from "../subagents/pdf-ops.ts";

/**
 * THE COURSE INDEXER (course mode, 2026-10-25): walks a course folder and
 * extracts the text of every supported file into a CourseIndex — PDF text
 * per page (pdfjs, the same engine the pdf reader uses), markdown/plain
 * text per section (core/course-search.ts chunkMarkdown). No model, no
 * network: indexing is free and repeatable.
 *
 * INCREMENTAL: a file whose size and mtime match the previous index is
 * carried over untouched, so re-indexing after adding one lecture costs
 * one lecture.
 *
 * Read-only by construction: the folder is never written to.
 */

/** v1 file kinds (owner decision 2026-10-25: PDF + Markdown; .txt rides
 *  the markdown reader at no cost). */
const KIND_BY_EXT: Record<string, CourseFileKind> = {
	".pdf": "pdf",
	".md": "markdown",
	".markdown": "markdown",
	".txt": "markdown",
};

/** Directory names never entered (noise, VCS, OS litter). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "__MACOSX", ".Trash"]);

/** Safety ceilings: a course folder is a semester, not a disk. */
const MAX_FILES = 2000;
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
/** A PDF page with less text than this is counted as "empty" (a scan). */
const EMPTY_PAGE_CHARS = 20;

export function courseFileKind(filePath: string): CourseFileKind | null {
	return KIND_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

/** Every supported file under the folder, as sorted POSIX relative paths. */
export async function listCourseFiles(folder: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (out.length >= MAX_FILES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable subfolder: skip, keep walking
		}
		entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full);
			} else if (entry.isFile() && courseFileKind(entry.name)) {
				out.push(path.relative(folder, full).split(path.sep).join("/"));
				if (out.length >= MAX_FILES) return;
			}
		}
	};
	await walk(folder);
	return out;
}

/** Extract one file's passages (throws on unreadable input). */
export async function readCourseFile(absolute: string, kind: CourseFileKind): Promise<CourseIndexedFile["passages"]> {
	if (kind === "pdf") {
		const pages = await pdfPageTexts(absolute);
		return pages.map((text, i) => ({ label: `p. ${i + 1}`, ordinal: i + 1, text }));
	}
	const stat = await fs.stat(absolute);
	if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error("file too large (over 5 MB of text)");
	return chunkMarkdown(await fs.readFile(absolute, "utf-8"));
}

export interface BuildCourseIndexOptions {
	/** The previous index — unchanged files are carried over. */
	previous?: CourseIndex | null;
	/** Progress line per file ("Skript.pdf (3/12)"). */
	onProgress?: (line: string) => void;
	abortSignal?: AbortSignal;
}

/** Build the course's index from its folder. Throws only when the folder
 *  itself is unreadable; per-file failures are recorded on the file. */
export async function buildCourseIndex(
	courseId: string,
	folder: string,
	opts: BuildCourseIndexOptions = {},
): Promise<CourseIndex> {
	const stat = await fs.stat(folder).catch(() => null);
	if (!stat?.isDirectory()) throw new Error(`Course folder not found: ${folder}`);
	const previous = new Map((opts.previous?.files ?? []).map((f) => [f.path, f]));
	const relPaths = await listCourseFiles(folder);
	const files: CourseIndexedFile[] = [];
	for (const [i, rel] of relPaths.entries()) {
		if (opts.abortSignal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		const absolute = path.join(folder, ...rel.split("/"));
		const kind = courseFileKind(rel)!;
		const fileStat = await fs.stat(absolute).catch(() => null);
		if (!fileStat) continue;
		const prior = previous.get(rel);
		if (prior && !prior.error && prior.size === fileStat.size && prior.mtimeMs === fileStat.mtimeMs) {
			files.push(prior);
			continue;
		}
		opts.onProgress?.(`${rel} (${i + 1}/${relPaths.length})`);
		try {
			const passages = await readCourseFile(absolute, kind);
			files.push({ path: rel, kind, size: fileStat.size, mtimeMs: fileStat.mtimeMs, passages });
		} catch (err) {
			files.push({
				path: rel,
				kind,
				size: fileStat.size,
				mtimeMs: fileStat.mtimeMs,
				passages: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { courseId, builtAt: new Date().toISOString(), files };
}

/** The persisted outcome of a build (the course row's index summary). */
export function summarizeCourseIndex(index: CourseIndex): CourseIndexSummary {
	let passageCount = 0;
	let emptyPages = 0;
	const failedFiles: string[] = [];
	for (const file of index.files) {
		if (file.error) failedFiles.push(file.path);
		passageCount += file.passages.length;
		if (file.kind === "pdf") emptyPages += file.passages.filter((p) => p.text.trim().length < EMPTY_PAGE_CHARS).length;
	}
	return { builtAt: index.builtAt, fileCount: index.files.length, passageCount, failedFiles, emptyPages };
}
