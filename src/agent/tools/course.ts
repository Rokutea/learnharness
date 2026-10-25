import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { Course, CourseIndex } from "../../core/contracts.ts";
import { chunkMarkdown, findCourseFile, parseOrdinalSpec, searchCourse } from "../../core/course-search.ts";
import { MAX_OUTPUT_BYTES } from "./fs-shared.ts";

/**
 * THE COURSE TOOLS (course mode, 2026-10-25): in a session linked to a
 * course, these REPLACE the learner-filesystem set (read/ls/find/grep) for
 * the prober, the teacher, the practitioner, and the course researcher —
 * the agents' window onto material is the course folder's index and
 * nothing else.
 *
 *   course_files   what the course contains (files, pages/sections)
 *   course_search  ranked passages for a query, with citations
 *   course_read    the full text of chosen pages/sections of one file
 *
 * The index arrives through a closure (read fresh per call — a re-index
 * mid-session lands on the next call); the agent layer never touches the
 * store. Mechanical descriptions only (the 2026-10-03 ruling): how to use
 * the course lives in the grounding prompt (prompts/shared/35-…).
 *
 * Tool contract: never throw for a bad request — return a clear string
 * the model adapts to.
 */

/** What a course session's tools close over (built by the composition root). */
export interface CourseRuntime {
	course: Pick<Course, "id" | "name" | "folder">;
	/** The current index, or null when the course was never indexed. */
	index: () => CourseIndex | null;
	/** The current glossary markdown, or null when none exists yet. */
	glossary: () => string | null;
}

/** The glossary's pseudo-file in search results. */
export const GLOSSARY_PATH = "(course glossary)";

/** Under this many characters a PDF page is flagged as probably a scan or a figure. */
const THIN_PAGE_CHARS = 40;

const NOT_INDEXED =
	"This course has no index yet — the learner must index it (Settings → Courses) before its material can be searched. " +
	"Tell the learner plainly; do not substitute outside knowledge for the missing material.";

/** The search corpus: the index plus the glossary as one more source,
 *  cached per (index object, glossary text) so the search model's
 *  per-index cache survives across calls. */
function corpusCache(runtime: CourseRuntime) {
	let lastIndex: CourseIndex | null = null;
	let lastGlossary: string | null = null;
	let lastCorpus: CourseIndex | null = null;
	return (): CourseIndex | null => {
		const index = runtime.index();
		if (!index) return null;
		const glossary = runtime.glossary();
		if (index === lastIndex && glossary === lastGlossary && lastCorpus) return lastCorpus;
		lastIndex = index;
		lastGlossary = glossary;
		lastCorpus =
			glossary && glossary.trim()
				? {
						...index,
						files: [
							...index.files,
							{ path: GLOSSARY_PATH, kind: "markdown", size: glossary.length, mtimeMs: 0, passages: chunkMarkdown(glossary) },
						],
					}
				: index;
		return lastCorpus;
	};
}

function capText(text: string, notice: string): string {
	if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES) return text;
	let cut = text.slice(0, MAX_OUTPUT_BYTES);
	while (Buffer.byteLength(cut, "utf-8") > MAX_OUTPUT_BYTES) cut = cut.slice(0, -1024);
	return `${cut}\n\n[${notice}]`;
}

export function courseTools(runtime: CourseRuntime): Record<string, AgentTool<any>> {
	const corpus = corpusCache(runtime);

	const filesInput = Type.Object({});
	const searchInput = Type.Object({
		query: Type.String({
			minLength: 1,
			description: "Words to find — a term, a name, a formula's wording. Several words rank passages that contain more of them.",
		}),
		path: Type.Optional(
			Type.String({ description: "Only search files whose path contains this text (e.g. a lecture's file name)." }),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum hits (default 8)." })),
	});
	const readInput = Type.Object({
		path: Type.String({ minLength: 1, description: "The file's path exactly as course_files or course_search shows it." }),
		pages: Type.String({
			description:
				"Which pages (PDF) or sections (markdown) to read: '12', '12-14', '3,7,9'. Read what you need — never 'all' on a long file.",
		}),
	});

	return {
		course_files: {
			name: "course_files",
			label: "course_files",
			description:
				"List the files of the learner's course: each file's path, kind, and how many pages (PDF) or sections (markdown) it has.",
			parameters: filesInput,
			execute: serverExecute("course_files", filesInput, async () => {
				const index = runtime.index();
				if (!index) return NOT_INDEXED;
				if (index.files.length === 0) return `The course "${runtime.course.name}" has no indexed files (PDF or Markdown).`;
				const lines = index.files.map((f) => {
					const unit = f.kind === "pdf" ? "pages" : "sections";
					return f.error
						? `${f.path} — unreadable (${f.error})`
						: `${f.path} — ${f.kind}, ${f.passages.length} ${unit}`;
				});
				const glossary = runtime.glossary();
				if (glossary && glossary.trim()) lines.push(`${GLOSSARY_PATH} — the course glossary (searchable)`);
				return capText(`Course "${runtime.course.name}" — ${index.files.length} files:\n${lines.join("\n")}`, "list truncated");
			}),
		},

		course_search: {
			name: "course_search",
			label: "course_search",
			description:
				"Search the learner's course material (and its glossary). Returns ranked passages — file, page or section, and a snippet. " +
				"Matching ignores case and accents and finds words inside compounds. Follow up with course_read for the full page.",
			parameters: searchInput,
			execute: serverExecute("course_search", searchInput, async ({ query, path, limit }) => {
				const index = corpus();
				if (!index) return NOT_INDEXED;
				const hits = searchCourse(index, query, { limit: limit ?? 8, pathFilter: path });
				if (hits.length === 0) {
					return `No passage in the course matches "${query}"${path ? ` (files matching "${path}")` : ""}. ` +
						"Try the course's own wording, a synonym, or a shorter term.";
				}
				const body = hits
					.map((h, i) => `${i + 1}. ${h.path} ${h.label} (score ${h.score})\n   ${h.snippet}`)
					.join("\n\n");
				return capText(body, "results truncated");
			}),
		},

		course_read: {
			name: "course_read",
			label: "course_read",
			description:
				"Read pages (PDF) or sections (markdown) of one course file as text. Formulas and figures in PDFs can come out " +
				"garbled or missing — a page flagged as thin text is likely a scan or a figure.",
			parameters: readInput,
			execute: serverExecute("course_read", readInput, async ({ path, pages }) => {
				const index = corpus();
				if (!index) return NOT_INDEXED;
				const file = findCourseFile(index, path);
				if (!file) {
					return `No course file matches "${path}". Call course_files for the exact paths.`;
				}
				if (file.error) return `${file.path} could not be read when the course was indexed: ${file.error}`;
				const ordinals = parseOrdinalSpec(pages, file.passages.length);
				if (ordinals.length === 0) {
					const unit = file.kind === "pdf" ? "pages" : "sections";
					return `"${pages}" selects nothing in ${file.path} (it has ${file.passages.length} ${unit}, numbered from 1).`;
				}
				const parts = ordinals.map((n) => {
					const passage = file.passages[n - 1]!;
					const thin =
						file.kind === "pdf" && passage.text.trim().length < THIN_PAGE_CHARS
							? "\n(Little or no extractable text on this page — likely a scan, a figure, or typeset math.)"
							: "";
					return `--- ${file.path} ${passage.label} ---\n${passage.text}${thin}`;
				});
				return capText(parts.join("\n\n"), "output truncated at 50KB — read fewer pages per call");
			}),
		},
	};
}
