/**
 * COURSE MODE (fork feature, 2026-10-25): a course is a named folder of the
 * learner's own course material — lecture slides, the script, exercise
 * sheets, old exams. A session linked to a course (ChatRecord.courseId)
 * sources its knowledge from that folder alone: the agents search and read
 * the course index instead of the web and the whole home directory, and
 * the course's glossary rides every turn's system prompt so the lesson
 * speaks the course's terminology and notation.
 *
 * Three records per course, all under data/courses (src/store/courses.ts):
 *   - the Course row (courses.json — the list the UI and the picker read)
 *   - the CourseIndex (<id>/index.json — extracted text, per PDF page or
 *     per markdown section; rebuilt by the indexer, never hand-edited)
 *   - the glossary (<id>/glossary.md — generated, then the learner's to edit)
 */

/** The file kinds v1 indexes (owner decision 2026-10-25: PDF + Markdown;
 *  plain .txt rides along with markdown — same reader, zero cost). */
export type CourseFileKind = "pdf" | "markdown";

/** One searchable unit: a PDF page, or a markdown section. */
export interface CoursePassage {
	/** Display + citation label: "p. 12" for PDFs, "§ 3 (lines 40–88)" for markdown. */
	label: string;
	/** PDF: the 1-indexed page. Markdown: the 1-indexed section ordinal. */
	ordinal: number;
	/** Markdown only: the section's first line (1-indexed) in the file. */
	startLine?: number;
	text: string;
}

export interface CourseIndexedFile {
	/** POSIX path relative to the course folder — the id the tools take. */
	path: string;
	kind: CourseFileKind;
	/** Change detection for incremental re-indexing (size + mtime). */
	size: number;
	mtimeMs: number;
	passages: CoursePassage[];
	/** A file that failed to read stays listed with its reason (honest gaps). */
	error?: string;
}

export interface CourseIndex {
	courseId: string;
	builtAt: string;
	files: CourseIndexedFile[];
}

/** The last index run's outcome, persisted on the course row. */
export interface CourseIndexSummary {
	builtAt: string;
	fileCount: number;
	/** PDF pages + markdown sections. */
	passageCount: number;
	/** Files that could not be read (scanned PDFs without text, broken files). */
	failedFiles: string[];
	/** PDF pages with (almost) no extractable text — likely scans. */
	emptyPages: number;
}

/** The last glossary run's outcome, persisted on the course row. */
export interface CourseGlossarySummary {
	generatedAt: string;
	termCount: number;
	/** True once the learner saved their own edit — a regeneration asks first. */
	edited?: boolean;
}

export interface Course {
	id: string;
	name: string;
	/** Absolute path to the course folder on the learner's machine. */
	folder: string;
	createdAt: string;
	updatedAt: string;
	index?: CourseIndexSummary;
	glossary?: CourseGlossarySummary;
	/** The last background failure (index or glossary), cleared on success. */
	lastError?: string;
}

/** What the course list route serves: the row + live work state. */
export interface CourseListItem extends Course {
	/** Live (in-memory) — an index or glossary run is in flight. */
	running: "index" | "glossary" | null;
	/** Live progress line while running ("Skript.pdf 12/40"). */
	progress?: string;
}

/** One course_search hit. */
export interface CourseSearchHit {
	path: string;
	label: string;
	ordinal: number;
	score: number;
	/** A window of the passage around the best-matching terms. */
	snippet: string;
}
