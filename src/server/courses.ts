import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { buildCourseIndex, summarizeCourseIndex } from "../agent/courses/indexer.ts";
import { runGlossaryMaker } from "../agent/subagents/course-glossary.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import type { CourseRuntime } from "../agent/tools/course.ts";
import { coursePromptContext, type CoursePromptContext } from "../agent/courses/prompt.ts";
import { emit } from "../core/events.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, ROLE_SLOT } from "../core/settings.ts";
import type { Course, CourseIndex, CourseListItem } from "../core/contracts.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/**
 * THE COURSE SERVICE (course mode, fork 2026-10-25) — the only writer of
 * the course store, and the composition seam that turns a chat's courseId
 * into the CourseRuntime the agents close over.
 *
 *   create → validate the folder → index (background) → glossary
 *     (background, optional: it spends model tokens)
 *   reindex → incremental rebuild (unchanged files carried over)
 *   glossary → one cheap-tier pass over the whole index; an EDITED
 *     glossary is never overwritten without force
 *
 * Background runs are single-flight per course (one index OR glossary run
 * at a time), live state is in memory (the course row persists only
 * outcomes), and every change announces "courses-changed".
 */

type RunKind = "index" | "glossary";

interface LiveRun {
	kind: RunKind;
	progress?: string;
	controller: AbortController;
	done: Promise<void>;
}

interface CoursesGlobal {
	__lhCourseRuns?: Map<string, LiveRun>;
	__lhCourseIndexCache?: Map<string, { builtAt: string; index: CourseIndex }>;
}

/** Module-instance-safe registries (the run-registry idiom: Next may load
 *  this module more than once; globalThis holds the one truth). */
function runs(): Map<string, LiveRun> {
	const g = globalThis as CoursesGlobal;
	return (g.__lhCourseRuns ??= new Map());
}

function indexCache(): Map<string, { builtAt: string; index: CourseIndex }> {
	const g = globalThis as CoursesGlobal;
	return (g.__lhCourseIndexCache ??= new Map());
}

export class CourseInputError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 503 = 400,
	) {
		super(message);
	}
}

const changed = () => emit("courses-changed", {});

// ─── reads ───────────────────────────────────────────────────────────────────

export function listCourseItems(): CourseListItem[] {
	return stores.courseStore.listCourses().map(toListItem);
}

export function getCourseItem(id: string): CourseListItem | null {
	const course = stores.courseStore.getCourse(id);
	return course ? toListItem(course) : null;
}

function toListItem(course: Course): CourseListItem {
	const live = runs().get(course.id);
	return { ...course, running: live?.kind ?? null, ...(live?.progress ? { progress: live.progress } : {}) };
}

/** The course's index, parsed once per build (the tools read it per call;
 *  a multi-MB JSON parse per tool call would be waste). */
export function readCourseIndex(id: string): CourseIndex | null {
	const course = stores.courseStore.getCourse(id);
	const builtAt = course?.index?.builtAt;
	if (!builtAt) return null;
	const cached = indexCache().get(id);
	if (cached && cached.builtAt === builtAt) return cached.index;
	const index = stores.courseStore.readIndex(id);
	if (index) indexCache().set(id, { builtAt: index.builtAt, index });
	return index;
}

export function readCourseGlossary(id: string): string | null {
	return stores.courseStore.readGlossary(id);
}

/** The agents' view of a course (null = no such course — the session then
 *  runs as an ordinary one, and the handler logs it). */
export function courseRuntimeFor(courseId: string | undefined): CourseRuntime | null {
	if (!courseId) return null;
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return null;
	return {
		course: { id: course.id, name: course.name, folder: course.folder },
		index: () => readCourseIndex(course.id),
		glossary: () => readCourseGlossary(course.id),
	};
}

/** The per-turn prompt snapshot of a runtime (re-exported for the handler). */
export function coursePromptFor(runtime: CourseRuntime): CoursePromptContext {
	return coursePromptContext(runtime);
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** Expand "~" and require an existing, absolute directory. */
export function normalizeCourseFolder(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) throw new CourseInputError("A course folder is required");
	let folder = raw.trim();
	if (folder === "~" || folder.startsWith("~/") || folder.startsWith("~\\")) folder = path.join(os.homedir(), folder.slice(1));
	if (!path.isAbsolute(folder)) throw new CourseInputError("The course folder must be an absolute path (or start with ~)");
	folder = path.resolve(folder);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(folder);
	} catch {
		throw new CourseInputError(`Folder not found: ${folder}`);
	}
	if (!stat.isDirectory()) throw new CourseInputError(`Not a folder: ${folder}`);
	return folder;
}

export function createCourse(body: { name?: unknown; folder?: unknown; glossary?: unknown }): Course {
	const folder = normalizeCourseFolder(body.folder);
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : path.basename(folder);
	const course = stores.courseStore.createCourse({ name, folder });
	changed();
	startIndex(course.id, { thenGlossary: body.glossary === true });
	return course;
}

export function updateCourse(id: string, body: { name?: unknown; folder?: unknown }): Course {
	const course = stores.courseStore.getCourse(id);
	if (!course) throw new CourseInputError("No such course", 404);
	const patch: { name?: string; folder?: string } = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim()) throw new CourseInputError("The course name cannot be empty");
		patch.name = body.name.trim();
	}
	if (body.folder !== undefined) patch.folder = normalizeCourseFolder(body.folder);
	const next = stores.courseStore.updateCourse(id, patch)!;
	changed();
	if (patch.folder && patch.folder !== course.folder) startIndex(id, { thenGlossary: false });
	return next;
}

/** Delete a course (its index and glossary go with it; sessions linked to
 *  it fall back to ordinary sessions). A running job is aborted first. */
export async function deleteCourse(id: string): Promise<boolean> {
	const live = runs().get(id);
	if (live) {
		live.controller.abort();
		await live.done.catch(() => undefined);
	}
	indexCache().delete(id);
	const removed = stores.courseStore.deleteCourse(id);
	if (removed) changed();
	return removed;
}

export function saveGlossary(id: string, markdown: unknown): Course {
	if (typeof markdown !== "string") throw new CourseInputError("The glossary must be text");
	const course = stores.courseStore.getCourse(id);
	if (!course) throw new CourseInputError("No such course", 404);
	if (runs().get(id)?.kind === "glossary") throw new CourseInputError("A glossary run is in progress", 409);
	stores.courseStore.writeGlossary(id, markdown);
	const termCount = markdown.split("\n").filter((l) => /^\s*[-*]\s+\*\*/.test(l)).length;
	const next = stores.courseStore.updateCourse(id, {
		glossary: { generatedAt: course.glossary?.generatedAt ?? new Date().toISOString(), termCount, edited: true },
	})!;
	changed();
	return next;
}

// ─── background runs ─────────────────────────────────────────────────────────

/** Start (re)indexing; 409 when the course is busy. */
export function reindexCourse(id: string): void {
	if (!stores.courseStore.getCourse(id)) throw new CourseInputError("No such course", 404);
	if (runs().has(id)) throw new CourseInputError("This course is already being processed", 409);
	startIndex(id, { thenGlossary: false });
}

/** Start a glossary run. An edited glossary needs force (the learner's
 *  work is never overwritten silently); a missing engine refuses (503). */
export function generateGlossary(id: string, opts: { force?: boolean } = {}): void {
	const course = stores.courseStore.getCourse(id);
	if (!course) throw new CourseInputError("No such course", 404);
	if (runs().has(id)) throw new CourseInputError("This course is already being processed", 409);
	if (!course.index) throw new CourseInputError("Index the course before generating its glossary", 409);
	if (course.glossary?.edited && !opts.force) {
		throw new CourseInputError("The glossary has your edits — regenerating would replace them", 409);
	}
	const engine = glossaryEngine();
	if (typeof engine === "string") throw new CourseInputError(engine, 503);
	startRun(id, "glossary", (run) => runGlossary(id, engine, run));
}

/** Resolve the glossary engine — the cheap slot (or a refusal reason). */
function glossaryEngine(): PiEngine | string {
	const spec = resolveRoleSpec("glossaryMaker", stores.settingsStore.readSettings());
	if (!spec) return `${modelsNotConfigured([ROLE_SLOT.glossaryMaker]).error} (missing: ${ROLE_SLOT.glossaryMaker})`;
	if (!providerKeyPresent(spec.provider)) return `No API key for ${spec.provider} — add it in Settings → Providers`;
	try {
		return piEngineForSpec(spec);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function startIndex(id: string, opts: { thenGlossary: boolean }): void {
	startRun(id, "index", async (run) => {
		const ok = await runIndex(id, run);
		if (!ok || !opts.thenGlossary || run.controller.signal.aborted) return;
		const engine = glossaryEngine();
		if (typeof engine === "string") {
			stores.courseStore.updateCourse(id, { lastError: `Glossary not generated: ${engine}` });
			return;
		}
		run.kind = "glossary";
		run.progress = undefined;
		changed();
		await runGlossary(id, engine, run);
	});
}

function startRun(id: string, kind: RunKind, body: (run: LiveRun) => Promise<void>): void {
	const run: LiveRun = { kind, controller: new AbortController(), done: Promise.resolve() };
	runs().set(id, run);
	changed();
	run.done = (async () => {
		try {
			await body(run);
		} catch (err) {
			if (!run.controller.signal.aborted) {
				console.error(`[course ${id}] ${run.kind} run failed:`, err);
				stores.courseStore.updateCourse(id, { lastError: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			runs().delete(id);
			changed();
		}
	})();
}

function progress(run: LiveRun, line: string): void {
	run.progress = line;
	changed();
}

async function runIndex(id: string, run: LiveRun): Promise<boolean> {
	const course = stores.courseStore.getCourse(id);
	if (!course) return false;
	try {
		const index = await buildCourseIndex(id, course.folder, {
			previous: stores.courseStore.readIndex(id),
			onProgress: (line) => progress(run, line),
			abortSignal: run.controller.signal,
		});
		if (!stores.courseStore.getCourse(id)) return false; // deleted mid-run
		stores.courseStore.writeIndex(id, index);
		indexCache().set(id, { builtAt: index.builtAt, index });
		stores.courseStore.updateCourse(id, { index: summarizeCourseIndex(index), lastError: undefined });
		return true;
	} catch (err) {
		if (run.controller.signal.aborted) return false;
		stores.courseStore.updateCourse(id, { lastError: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

async function runGlossary(id: string, engine: PiEngine, run: LiveRun): Promise<void> {
	const course = stores.courseStore.getCourse(id);
	const index = readCourseIndex(id);
	if (!course || !index) return;
	try {
		const result = await runGlossaryMaker(course.name, index, {
			engine,
			abortSignal: run.controller.signal,
			onProgress: (line) => progress(run, line),
		});
		if (!stores.courseStore.getCourse(id)) return;
		stores.courseStore.writeGlossary(id, result.markdown);
		stores.courseStore.updateCourse(id, {
			glossary: { generatedAt: new Date().toISOString(), termCount: result.termCount },
			lastError: result.failedBatches > 0 ? `Glossary: ${result.failedBatches} batch(es) failed and were skipped` : undefined,
		});
	} catch (err) {
		if (run.controller.signal.aborted) return;
		stores.courseStore.updateCourse(id, { lastError: `Glossary failed: ${err instanceof Error ? err.message : String(err)}` });
	}
}

/** Test seam: await a course's live run (resolves at once when idle). */
export async function courseRunSettled(id: string): Promise<void> {
	await runs().get(id)?.done;
}
