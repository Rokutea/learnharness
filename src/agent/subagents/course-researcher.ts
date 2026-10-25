import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { courseTools, type CourseRuntime } from "../tools/course.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The COURSE RESEARCHER (course mode, 2026-10-25): what the `research` job
 * runs in a course session instead of the web researcher. Same job, same
 * brief format, same async protocol — but its ONLY tools are the course
 * tools, so every finding is the course's own wording with a file and
 * page/section citation, and a question the material does not answer
 * comes back as a stated gap, never as outside knowledge.
 *
 * Engine injectable (tests run it scripted); the role is the researcher's
 * (cheap slot), so no new model setting exists for it.
 */

const INSTRUCTIONS = `You are a research specialist working for a teacher agent inside a learning
application. The learner is studying for a university course, and the course's own material is the
ONLY source you may use: the lecture slides, script, exercise sheets, and exams in the course folder,
reachable through course_files, course_search, and course_read. You have no web access and you must
not answer from your own background knowledge.

You operate in an isolated context with no knowledge of the lesson. All necessary context is in the
task description.

Process:
1. Break the question into the concrete terms the course would use. Search for each with
   course_search — the course's own wording first, then synonyms, abbreviations, or the term in the
   course's language if it differs from the question's.
2. Read the most relevant hits in full with course_read (the page before and after a definition often
   carries its conditions, notation, or an example).
3. Note exactly how the COURSE states things: its definitions verbatim, its symbols and notation,
   its names for theorems and methods, its sign and unit conventions, worked examples, and how its
   exercises phrase questions on this topic.
4. Synthesize a brief that answers the question from the course material alone.

Rules:
- Quote definitions and key statements verbatim, in the course's language, with the citation.
- Every finding carries a citation in the form (file, p. N) or (file, § N).
- If the course does not cover something, say so explicitly in Gaps. Do not fill it from elsewhere.
- If the course's terminology differs from the wording of the question, point that out.
- Tool outputs may be error strings (e.g. the course is not indexed). If the material is unavailable,
  say so in the brief instead of inventing content.

Your FINAL assistant message is your entire deliverable — it must stand alone, using this format:

## Summary
2-3 sentence direct answer, in the course's terms.

## Findings
Numbered findings, each with its citation:
1. **Finding** — explanation, quoting the course where it matters. (file, p. N)

## Course terminology
The exact terms, symbols, and notation the course uses for this topic (and any common alternative
names the course does NOT use).

## Gaps
What the course material does not answer.`;

export interface CourseResearcherRunOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onToolStart?: (toolName: string, args: unknown) => void;
	chatId?: string;
}

/** Run the course researcher to completion; the final text is the brief. */
export async function runCourseResearcherAgent(
	prompt: string,
	runtime: CourseRuntime,
	opts: CourseResearcherRunOptions = {},
): Promise<string> {
	const { text } = await runSubagent(Object.values(courseTools(runtime)), {
		role: "researcher",
		prompt: `Course: ${runtime.course.name}\n\n${prompt}`,
		engine: opts.engine,
		systemPrompt: INSTRUCTIONS,
		maxTurns: 14,
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		onToolStart: opts.onToolStart,
		chatId: opts.chatId,
	});
	return text;
}
