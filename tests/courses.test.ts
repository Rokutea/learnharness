/**
 * COURSE MODE PINS (fork, 2026-10-25): a session linked to a course learns
 * only from that course's material. Deterministic, zero network:
 *
 *   1. course search (pure): folding, BM25 ranking, compound partials,
 *      markdown sections, page specs, file lookup, glossary clipping
 *   2. the indexer over a real folder (markdown + the 3-page PDF fixture),
 *      incremental rebuilds
 *   3. the course tools (files / search / read) over a runtime
 *   4. the registries: course sessions swap the learner-fs tools for the
 *      course tools; the prompt composes the grounding fragment + context
 *   5. glossary merge/render; pdf jobs stay inside the course folder
 *   6. the course service end to end (create → index → runtime) and the
 *      job runner routing research to the course researcher
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline: the
 * seam is set before any config-loading import, so app imports are dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-data-"));
process.env.LH_DATA_DIR = TMP_DATA;
const COURSE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-folder-"));
const PDF_FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

const search = await import("../src/core/course-search.ts");
const { buildCourseIndex, summarizeCourseIndex } = await import("../src/agent/courses/indexer.ts");
const { courseTools, GLOSSARY_PATH } = await import("../src/agent/tools/course.ts");
const { sourceTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { mergeGlossaryEntries, renderGlossary } = await import("../src/agent/subagents/course-glossary.ts");
const { coursePdfPath, createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const courses = await import("../src/server/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
type CourseIndex = import("../src/core/contracts.ts").CourseIndex;
type CourseRuntime = import("../src/agent/tools/course.ts").CourseRuntime;
type ResearchResult = import("../src/core/contracts.ts").ResearchResult;
type PiEngine = import("../src/agent/models.ts").PiEngine;

const LECTURE = `# Lecture 1: Systems

A linear system maps inputs to outputs. This introduction is long enough to stand as its own section of the
course material, so the chunker keeps it apart from the section that follows. Students meet the state space
here for the first time, written as a pair of equations in the matrices A, B, C and D.

## Die Übertragungsfunktion

Die Übertragungsfunktion G(s) beschreibt das Verhalten eines linearen zeitinvarianten Systems im Bildbereich.
Sie ist der Quotient aus Ausgangs- und Eingangssignal bei verschwindenden Anfangsbedingungen. Dieser Abschnitt
ist ebenfalls lang genug, um ein eigener Abschnitt zu bleiben, damit die Suche ihn einzeln zitieren kann.
`;

before(() => {
	fs.writeFileSync(path.join(COURSE_DIR, "lecture-01.md"), LECTURE);
	fs.mkdirSync(path.join(COURSE_DIR, "slides"));
	fs.copyFileSync(PDF_FIXTURE, path.join(COURSE_DIR, "slides", "week-02.pdf"));
	fs.writeFileSync(path.join(COURSE_DIR, ".hidden.md"), "# hidden\nnever indexed");
	fs.writeFileSync(path.join(COURSE_DIR, "photo.png"), "not a course file");
});

after(() => {
	researchModelOverride.current = undefined;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	fs.rmSync(COURSE_DIR, { recursive: true, force: true });
});

/** A hand-built index: two files, distinct vocabulary per passage. */
function sampleIndex(): CourseIndex {
	const passage = (ordinal: number, text: string) => ({ label: `p. ${ordinal}`, ordinal, text });
	return {
		courseId: "c1",
		builtAt: "2026-10-25T00:00:00.000Z",
		files: [
			{
				path: "lectures/control.pdf",
				kind: "pdf",
				size: 1,
				mtimeMs: 1,
				passages: [
					passage(1, "Die Übertragungsfunktion eines Systems im Bildbereich."),
					passage(2, "Stability: all poles in the left half plane. Poles poles poles."),
					passage(3, "The state space model uses the system matrix A."),
				],
			},
			{
				path: "notes/summary.md",
				kind: "markdown",
				size: 1,
				mtimeMs: 1,
				passages: [{ label: "§ 1 (lines 1–4)", ordinal: 1, startLine: 1, text: "Summary of the systemmatrix and the transfer function." }],
			},
		],
	};
}

async function runText(tool: AgentTool<any>, params: unknown): Promise<string> {
	const result = await tool.execute!("c", params as never, undefined);
	const first = result.content[0];
	assert.ok(first !== undefined && first.type === "text", "first content part is text");
	return (first as { type: "text"; text: string }).text;
}

function runtimeOver(index: CourseIndex | null, glossary: string | null = null): CourseRuntime {
	return { course: { id: "c1", name: "Regelungstechnik", folder: COURSE_DIR }, index: () => index, glossary: () => glossary };
}

// ─── 1. search (pure) ────────────────────────────────────────────────────────

describe("course search (pure)", () => {
	it("folds case, accents and ß, and drops one-letter tokens", () => {
		assert.equal(search.foldText("ÜBERTRAGUNGSFUNKTION Größe"), "ubertragungsfunktion grosse");
		assert.deepEqual(search.tokenize("Die Matrix A, x_1 und Größe"), ["die", "matrix", "und", "grosse"]);
	});

	it("ranks the passage that contains the term, accent-insensitively", () => {
		const hits = search.searchCourse(sampleIndex(), "ubertragungsfunktion");
		assert.equal(hits[0]?.path, "lectures/control.pdf");
		assert.equal(hits[0]?.ordinal, 1);
	});

	it("finds a term inside compounds at reduced weight (exact beats partial)", () => {
		const hits = search.searchCourse(sampleIndex(), "matrix");
		assert.ok(hits.some((h) => h.path === "notes/summary.md"), "'matrix' finds 'systemmatrix'");
		assert.equal(hits[0]?.path, "lectures/control.pdf", "the exact token ranks first");
		const funktion = search.searchCourse(sampleIndex(), "funktion");
		assert.equal(funktion[0]?.ordinal, 1, "'funktion' finds 'Übertragungsfunktion'");
	});

	it("filters by path, honours the limit, and returns nothing for an empty query", () => {
		const filtered = search.searchCourse(sampleIndex(), "system", { pathFilter: "summary" });
		assert.ok(filtered.length > 0 && filtered.every((h) => h.path === "notes/summary.md"));
		assert.equal(search.searchCourse(sampleIndex(), "system", { limit: 1 }).length, 1);
		assert.deepEqual(search.searchCourse(sampleIndex(), "  ? "), []);
	});

	it("is deterministic: the same index and query rank identically", () => {
		const a = search.searchCourse(sampleIndex(), "system poles");
		const b = search.searchCourse(sampleIndex(), "system poles");
		assert.deepEqual(a, b);
	});

	it("snippets centre on the hit and mark elisions", () => {
		const text = `${"filler ".repeat(200)}Übertragungsfunktion ${"tail ".repeat(200)}`;
		const snippet = search.snippetFor(text, ["ubertragungsfunktion"], 120);
		assert.match(snippet, /Übertragungsfunktion/);
		assert.ok(snippet.startsWith("… ") && snippet.endsWith(" …"));
	});

	it("chunks markdown at headings, merging undersized sections, with line labels", () => {
		const passages = search.chunkMarkdown(LECTURE);
		assert.equal(passages.length, 2);
		assert.match(passages[0]!.label, /^§ 1 \(lines 1–\d+\)$/);
		assert.match(passages[1]!.text, /^## Die Übertragungsfunktion/);
		assert.equal(`lines ${passages[1]!.startLine}–`, passages[1]!.label.match(/lines \d+–/)![0]);
		const tiny = search.chunkMarkdown("# A\nshort\n# B\nalso short");
		assert.equal(tiny.length, 1, "a lone short section merges forward");
	});

	it("parses page specs within bounds", () => {
		assert.deepEqual(search.parseOrdinalSpec("3", 5), [3]);
		assert.deepEqual(search.parseOrdinalSpec("2-4", 5), [2, 3, 4]);
		assert.deepEqual(search.parseOrdinalSpec("5,1, 9", 5), [1, 5]);
		assert.deepEqual(search.parseOrdinalSpec("all", 3), [1, 2, 3]);
		assert.deepEqual(search.parseOrdinalSpec("zero", 3), []);
	});

	it("finds files by exact path or a unique basename, never an ambiguous one", () => {
		const index = sampleIndex();
		assert.equal(search.findCourseFile(index, "notes/summary.md")?.path, "notes/summary.md");
		assert.equal(search.findCourseFile(index, "CONTROL.pdf")?.path, "lectures/control.pdf");
		const twice: CourseIndex = { ...index, files: [...index.files, { ...index.files[1]!, path: "old/summary.md" }] };
		assert.equal(search.findCourseFile(twice, "summary.md"), null);
	});

	it("clips a long glossary at a line boundary and says so", () => {
		const glossary = Array.from({ length: 50 }, (_, i) => `- **term ${i}**: definition`).join("\n");
		assert.equal(search.glossaryForPrompt(glossary), glossary);
		const clipped = search.glossaryForPrompt(glossary, 200);
		assert.ok(clipped.length < glossary.length);
		assert.match(clipped, /Glossary clipped here/);
		assert.match(clipped.split("\n\n")[0]!, /definition$/);
	});
});

// ─── 2. the indexer ──────────────────────────────────────────────────────────

describe("course indexer", () => {
	it("indexes markdown sections and PDF pages, skipping dot-files and other types", async () => {
		const index = await buildCourseIndex("c1", COURSE_DIR);
		assert.deepEqual(
			index.files.map((f) => f.path),
			["lecture-01.md", "slides/week-02.pdf"],
		);
		const pdf = index.files.find((f) => f.kind === "pdf")!;
		assert.equal(pdf.passages.length, 3);
		assert.deepEqual(
			pdf.passages.map((p) => p.ordinal),
			[1, 2, 3],
		);
		assert.ok(pdf.passages[1]!.text.toLowerCase().includes("force"), "page 2 carries its own text");
		const summary = summarizeCourseIndex(index);
		assert.equal(summary.fileCount, 2);
		assert.equal(summary.passageCount, 5);
		assert.deepEqual(summary.failedFiles, []);
	});

	it("rebuilds incrementally: an unchanged file keeps its passages object", async () => {
		const first = await buildCourseIndex("c1", COURSE_DIR);
		const second = await buildCourseIndex("c1", COURSE_DIR, { previous: first });
		const pdfA = first.files.find((f) => f.kind === "pdf")!;
		const pdfB = second.files.find((f) => f.kind === "pdf")!;
		assert.equal(pdfB.passages, pdfA.passages, "reused, not re-extracted");
	});
});

// ─── 3. the course tools ─────────────────────────────────────────────────────

describe("course tools", () => {
	it("an unindexed course says so instead of answering", async () => {
		const tools = courseTools(runtimeOver(null));
		assert.match(await runText(tools.course_search!, { query: "system" }), /no index yet/);
		assert.match(await runText(tools.course_files!, {}), /no index yet/);
	});

	it("course_files lists files with their page/section counts and the glossary", async () => {
		const tools = courseTools(runtimeOver(sampleIndex(), "- **Pol**: Nullstelle des Nenners"));
		const text = await runText(tools.course_files!, {});
		assert.match(text, /lectures\/control\.pdf — pdf, 3 pages/);
		assert.match(text, /notes\/summary\.md — markdown, 1 sections/);
		assert.ok(text.includes(GLOSSARY_PATH));
	});

	it("course_search ranks passages and also searches the glossary", async () => {
		const tools = courseTools(runtimeOver(sampleIndex(), "# Glossary\n\n- **Pol**: Nullstelle des Nenners der Übertragungsfunktion"));
		const hits = await runText(tools.course_search!, { query: "Nullstelle" });
		assert.ok(hits.startsWith(`1. ${GLOSSARY_PATH}`));
		const miss = await runText(tools.course_search!, { query: "quaternion" });
		assert.match(miss, /No passage in the course matches/);
	});

	it("course_read returns the requested pages and flags thin ones", async () => {
		const index = sampleIndex();
		index.files[0]!.passages.push({ label: "p. 4", ordinal: 4, text: "Fig. 3" });
		const tools = courseTools(runtimeOver(index));
		const text = await runText(tools.course_read!, { path: "control.pdf", pages: "2-4" });
		assert.match(text, /--- lectures\/control\.pdf p\. 2 ---/);
		assert.match(text, /--- lectures\/control\.pdf p\. 4 ---/);
		assert.doesNotMatch(text, /p\. 1 ---/);
		assert.match(text, /likely a scan/);
		assert.match(await runText(tools.course_read!, { path: "control.pdf", pages: "9" }), /selects nothing/);
		assert.match(await runText(tools.course_read!, { path: "missing.pdf", pages: "1" }), /No course file matches/);
	});
});

// ─── 4. registries + prompt ──────────────────────────────────────────────────

describe("course sessions swap the learner's files for the course", () => {
	it("sourceTools: course tools replace read/ls/find/grep", () => {
		assert.deepEqual(Object.keys(sourceTools()).sort(), ["find", "grep", "ls", "read"]);
		assert.deepEqual(Object.keys(sourceTools(runtimeOver(sampleIndex()))).sort(), ["course_files", "course_read", "course_search"]);
	});

	it("the prompt composes the grounding fragment and the course context only with a course", () => {
		for (const kind of ["prober", "teacher", "practice"] as const) {
			const plain = composeInstructions(kind);
			assert.doesNotMatch(plain, /# Your course:/, `${kind}: no course context without a course`);
			assert.doesNotMatch(plain, /course_search/, `${kind}: no grounding fragment without a course`);
			const grounded = composeInstructions(kind, undefined, {
				name: "Regelungstechnik",
				index: sampleIndex(),
				glossary: "- **Pol**: Nullstelle des Nenners",
			});
			assert.match(grounded, /course_search/, `${kind}: the grounding fragment composes`);
			assert.match(grounded, /# Your course: Regelungstechnik/);
			assert.match(grounded, /Nullstelle des Nenners/, `${kind}: the glossary rides the prompt`);
		}
	});
});

// ─── 5. glossary + pdf paths ─────────────────────────────────────────────────

describe("glossary merge and render", () => {
	it("dedupes by folded term, first definition wins, sources union, first notation kept", () => {
		const merged = mergeGlossaryEntries([
			[{ term: "Übertragungsfunktion", definition: "Quotient Ausgang/Eingang", source: "lecture-01.md, § 2" }],
			[
				{ term: "ubertragungsfunktion", definition: "a later wording", notation: "G(s)", source: "week-02.pdf, p. 3" },
				{ term: "Pol", definition: "Nullstelle des Nenners", source: "" },
				{ term: " ", definition: "blank term drops", source: "x" },
			],
		]);
		assert.equal(merged.length, 2);
		assert.deepEqual(merged[0], {
			term: "Übertragungsfunktion",
			definition: "Quotient Ausgang/Eingang",
			notation: "G(s)",
			sources: ["lecture-01.md, § 2", "week-02.pdf, p. 3"],
		});
		const md = renderGlossary("Regelungstechnik", merged);
		assert.match(md, /^# Glossary — Regelungstechnik/);
		assert.ok(md.includes("- **Übertragungsfunktion** (G(s)): Quotient Ausgang/Eingang — lecture-01.md, § 2; week-02.pdf, p. 3"));
		assert.ok(md.includes("- **Pol**: Nullstelle des Nenners\n"));
	});
});

describe("pdf jobs stay inside the course folder", () => {
	it("resolves relative and absolute paths inside, refuses everything outside", () => {
		assert.equal(coursePdfPath(COURSE_DIR, "slides/week-02.pdf"), path.join(COURSE_DIR, "slides", "week-02.pdf"));
		assert.equal(coursePdfPath(COURSE_DIR, path.join(COURSE_DIR, "a.pdf")), path.join(COURSE_DIR, "a.pdf"));
		assert.equal(coursePdfPath(COURSE_DIR, "../elsewhere.pdf"), null);
		assert.equal(coursePdfPath(COURSE_DIR, "/etc/passwd"), null);
		assert.equal(coursePdfPath(COURSE_DIR, "."), null);
	});
});

// ─── 6. the service end to end + runner routing ──────────────────────────────

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function researchCallMessages(toolCallId: string, input: unknown) {
	return [
		{ id: "u1", role: "user", content: "teach me", timestamp: 1 },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "research", arguments: input }],
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			id: "r1",
			role: "toolResult",
			toolCallId,
			toolName: "research",
			content: [{ type: "text", text: "Dispatched." }],
			details: "Dispatched.",
			isError: false,
			timestamp: 1,
		},
	] as never;
}

describe("course service + research routing", () => {
	it("refuses a missing folder", () => {
		assert.throws(() => courses.createCourse({ folder: path.join(COURSE_DIR, "nope") }), courses.CourseInputError);
	});

	it("creates, indexes, and exposes a runtime; a course session's research reads the course, not the web", async () => {
		const course = courses.createCourse({ name: "Regelungstechnik", folder: COURSE_DIR, glossary: false });
		await courses.courseRunSettled(course.id);
		const item = courses.getCourseItem(course.id)!;
		assert.equal(item.running, null);
		assert.equal(item.index?.fileCount, 2);

		const runtime = courses.courseRuntimeFor(course.id)!;
		assert.ok(runtime.index(), "the runtime reads the built index");
		assert.equal(courses.courseRuntimeFor("missing"), null);

		const chat = chatStore.createChat("course session", undefined, course.id);
		assert.equal(chat.courseId, course.id);
		chatStore.saveMessages(chat.id, researchCallMessages("call-c1", { question: "Was ist die Übertragungsfunktion?" }));
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-c1" });

		const steers: unknown[] = [];
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url) => {
			fetched.push(String(url));
			throw new Error("no network in course mode");
		}) as typeof fetch;
		const brief = "## Summary\nG(s) ist der Quotient (lecture-01.md, § 2).";
		researchModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("course_search", { query: "Übertragungsfunktion" }, { id: "s1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("course_read", { path: "lecture-01.md", pages: "2" }, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(brief)]),
		]);
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				steers.push(steer);
			},
			searchProvider: () => {
				throw new Error("the web search provider must not be consulted in course mode");
			},
			courseForChat: (chatId) => courses.courseRuntimeFor(chatStore.getChat(chatId)?.courseId),
		});
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
			globalThis.fetch = realFetch;
		}
		assert.deepEqual(fetched, [], "no network");
		const result = jobStore.getJob(job.id)!.result as ResearchResult;
		assert.equal(result.brief, brief);
		assert.equal(result.sources.length, 1);
		assert.equal(result.sources[0]!.title, "lecture-01.md, § 2");
		assert.ok(result.sources[0]!.url.startsWith("file://"));
		assert.equal(steers.length, 1);

		assert.equal(await courses.deleteCourse(course.id), true);
		assert.equal(courses.courseRuntimeFor(course.id), null);
	});
});
