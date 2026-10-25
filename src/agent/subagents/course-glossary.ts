import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { CourseIndex } from "../../core/contracts.ts";
import { foldText } from "../../core/course-search.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * THE COURSE GLOSSARY MAKER (course mode, 2026-10-25): one pass over the
 * whole course index that collects the course's own vocabulary — terms,
 * their definitions IN THE COURSE'S WORDING, its symbols and notation —
 * into a markdown glossary. The glossary then rides every course
 * session's system prompt, which is the lever that keeps the lesson in
 * the course's terminology on every turn (search alone only helps when
 * the agent remembers to search).
 *
 * Shape: the index is cut into batches of consecutive passages; each
 * batch is one submit-agent call (the extraction pipeline's seam:
 * schema-validated submit, retry on a bad call). The merge is
 * DETERMINISTIC: terms dedupe by folded name, the FIRST definition in
 * course order wins (courses define before they use), sources union.
 *
 * The result is a starting point the learner edits (Settings → Courses);
 * a regeneration over an edited glossary asks first (the service owns it).
 */

/** Characters of course text per model call (~6k tokens). */
const BATCH_CHARS = 24_000;
/** Max sources listed per term in the rendered glossary. */
const MAX_SOURCES = 3;

const termsSchema = Type.Object({
	terms: Type.Array(
		Type.Object({
			term: Type.String({ description: "The term exactly as the course writes it (its language, its spelling)." }),
			definition: Type.String({
				description:
					"The course's own definition or explanation, as close to verbatim as possible, one to three sentences, in the course's language.",
			}),
			notation: Type.Optional(
				Type.String({ description: "The symbol or notation the course uses for it, if any (LaTeX allowed, e.g. $G(s)$)." }),
			),
			source: Type.String({ description: "Where it is defined: the file and page/section label from the excerpt header." }),
		}),
	),
});

type SubmittedTerms = Static<typeof termsSchema>;

const SYSTEM_PROMPT = `You build a glossary of a university course from its own material, so a tutor
can teach with exactly the course's terminology. You receive consecutive excerpts of the course
(lecture slides, script, exercises), each headed with its file and page or section.

Collect every term the course DEFINES or introduces as technical vocabulary in these excerpts:
concepts, named theorems and methods, quantities and their symbols, abbreviations, and notation
conventions. For each, give the course's own definition in its own words and language — quote or
closely paraphrase; never substitute a textbook definition from your own knowledge. Skip everyday
words and terms that are only mentioned in passing without explanation.

Submit everything with one submit_terms call. An excerpt with no definitions → submit an empty list.`;

export interface GlossaryEntry {
	term: string;
	definition: string;
	notation?: string;
	sources: string[];
}

/** Cut the index into prompt batches of consecutive passages, headed. */
export function glossaryBatches(index: CourseIndex, batchChars = BATCH_CHARS): string[] {
	const batches: string[] = [];
	let current = "";
	for (const file of index.files) {
		for (const passage of file.passages) {
			const text = passage.text.trim();
			if (!text) continue;
			const block = `=== ${file.path} ${passage.label} ===\n${text.length > batchChars ? text.slice(0, batchChars) : text}\n\n`;
			if (current && current.length + block.length > batchChars) {
				batches.push(current);
				current = "";
			}
			current += block;
		}
	}
	if (current.trim()) batches.push(current);
	return batches;
}

/** Deterministic merge: dedupe by folded term, first definition wins,
 *  sources union (capped), the first notation that appears is kept. */
export function mergeGlossaryEntries(batches: ReadonlyArray<SubmittedTerms["terms"]>): GlossaryEntry[] {
	const byKey = new Map<string, GlossaryEntry>();
	for (const terms of batches) {
		for (const t of terms) {
			const term = t.term.trim();
			const definition = t.definition.trim();
			if (!term || !definition) continue;
			const key = foldText(term).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, {
					term,
					definition,
					...(t.notation?.trim() ? { notation: t.notation.trim() } : {}),
					sources: t.source.trim() ? [t.source.trim()] : [],
				});
				continue;
			}
			if (!existing.notation && t.notation?.trim()) existing.notation = t.notation.trim();
			const source = t.source.trim();
			if (source && !existing.sources.includes(source) && existing.sources.length < MAX_SOURCES) existing.sources.push(source);
		}
	}
	return [...byKey.values()];
}

/** Render the glossary markdown (course order kept — the order a student meets the terms). */
export function renderGlossary(courseName: string, entries: readonly GlossaryEntry[]): string {
	const lines = [
		`# Glossary — ${courseName}`,
		"",
		"Generated from the course material. Edit freely: this text is what the tutor treats as the course's terminology.",
		"",
	];
	for (const e of entries) {
		const notation = e.notation ? ` (${e.notation})` : "";
		const sources = e.sources.length ? ` — ${e.sources.join("; ")}` : "";
		lines.push(`- **${e.term}**${notation}: ${e.definition}${sources}`);
	}
	return `${lines.join("\n")}\n`;
}

export interface GlossaryRunOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	/** Progress per batch ("batch 3/12"). */
	onProgress?: (line: string) => void;
}

/** Build the glossary for an index. A failed batch is skipped (the rest
 *  still lands) unless EVERY batch failed — then the first error throws. */
export async function runGlossaryMaker(
	courseName: string,
	index: CourseIndex,
	opts: GlossaryRunOptions = {},
): Promise<{ markdown: string; termCount: number; failedBatches: number }> {
	const batches = glossaryBatches(index);
	if (batches.length === 0) throw new Error("The course index has no text to build a glossary from.");
	const collected: Array<SubmittedTerms["terms"]> = [];
	let failed = 0;
	let firstError: unknown;
	for (const [i, batch] of batches.entries()) {
		if (opts.abortSignal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		opts.onProgress?.(`glossary batch ${i + 1}/${batches.length}`);
		try {
			const submitted = await runSubmitAgent<SubmittedTerms>({
				role: "glossaryMaker",
				toolName: "submit_terms",
				toolDescription: "Submit the glossary terms found in these excerpts (an empty list when there are none).",
				parameters: termsSchema,
				fill: (input: SubmittedTerms) => ({ terms: Array.isArray(input.terms) ? input.terms : [] }),
				systemPrompt: SYSTEM_PROMPT,
				prompt: `Course: ${courseName}\n\nExcerpts:\n\n${batch}`,
				engine: opts.engine,
				signal: opts.abortSignal,
				onStep: (usage) => opts.onUsage?.(usage),
				neverSubmitted: "the glossary maker never submitted its terms",
			});
			collected.push(submitted.terms);
		} catch (err) {
			if (opts.abortSignal?.aborted) throw err;
			failed++;
			firstError ??= err;
		}
	}
	if (failed === batches.length) throw firstError instanceof Error ? firstError : new Error(String(firstError));
	const entries = mergeGlossaryEntries(collected);
	return { markdown: renderGlossary(courseName, entries), termCount: entries.length, failedBatches: failed };
}
