import type { CourseIndex } from "../../core/contracts.ts";
import { glossaryForPrompt } from "../../core/course-search.ts";
import type { CourseRuntime } from "../tools/course.ts";

/**
 * The per-session COURSE CONTEXT appended to a course session's system
 * prompt (course mode, 2026-10-25): the course's name, its file list, and
 * its glossary. The grounding doctrine itself is a normal prompt fragment
 * (prompts/shared/35-course-grounding.md, overridable like any other);
 * this is the session's DATA, rebuilt per turn from the live index and
 * glossary so a re-index or a glossary edit lands on the next turn.
 */

/** Files listed by name in the prompt; the rest are one course_files call away. */
const MAX_LISTED_FILES = 80;

/** The snapshot the composition needs (kept plain so tests build it directly). */
export interface CoursePromptContext {
	name: string;
	index: CourseIndex | null;
	glossary: string | null;
}

export function coursePromptContext(runtime: CourseRuntime): CoursePromptContext {
	return { name: runtime.course.name, index: runtime.index(), glossary: runtime.glossary() };
}

export function renderCourseContext(ctx: CoursePromptContext): string {
	const lines = [`# Your course: ${ctx.name}`, ""];
	if (!ctx.index) {
		lines.push("The course has not been indexed yet, so its material cannot be searched. Tell the learner before teaching anything.");
	} else if (ctx.index.files.length === 0) {
		lines.push("The course folder contains no indexed PDF or Markdown files. Tell the learner before teaching anything.");
	} else {
		lines.push(`Course files (${ctx.index.files.length}):`);
		for (const file of ctx.index.files.slice(0, MAX_LISTED_FILES)) {
			const unit = file.kind === "pdf" ? "pages" : "sections";
			lines.push(file.error ? `- ${file.path} (unreadable)` : `- ${file.path} (${file.passages.length} ${unit})`);
		}
		if (ctx.index.files.length > MAX_LISTED_FILES) {
			lines.push(`- … and ${ctx.index.files.length - MAX_LISTED_FILES} more (course_files lists them all)`);
		}
	}
	lines.push("", "## Course glossary", "");
	lines.push(
		ctx.glossary && ctx.glossary.trim()
			? glossaryForPrompt(ctx.glossary)
			: "No glossary exists for this course yet. Establish its terms by searching the material.",
	);
	return lines.join("\n");
}
