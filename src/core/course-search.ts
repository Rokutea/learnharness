import type { CourseIndex, CourseIndexedFile, CoursePassage, CourseSearchHit } from "./contracts/courses.ts";

/**
 * COURSE SEARCH (course mode, 2026-10-25): pure retrieval over a course
 * index — no IO, no embeddings, no model. BM25 over passages (a PDF page
 * or a markdown section), with two additions that matter for real course
 * material:
 *
 *   - ACCENT/CASE FOLDING: "Übertragungsfunktion", "ubertragungsfunktion"
 *     and "UBERTRAGUNGSFUNKTION" are one term (NFKD + combining marks
 *     dropped, ß → ss). Course languages vary; the fold is language-free.
 *   - COMPOUND PARTIALS: a query term of 4+ letters also matches longer
 *     tokens that CONTAIN it, at reduced weight — "funktion" finds
 *     "übertragungsfunktion", "matrix" finds "systemmatrix". German and
 *     Dutch course material is unsearchable without it.
 *
 * Deterministic by construction: ties break by file order then ordinal,
 * so the same index and query always rank the same way (tests pin it).
 */

const K1 = 1.2;
const B = 0.75;
/** Weight of a compound-partial match relative to an exact token match. */
const PARTIAL_WEIGHT = 0.5;
const MIN_PARTIAL_LENGTH = 4;
/** A multi-word query found verbatim in a passage multiplies its score. */
const PHRASE_BOOST = 1.5;

/** Fold one string: lowercase, accents stripped, ß → ss. */
export function foldText(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/ß/g, "ss");
}

/** The tokens of a text, folded. Single characters drop (variable names
 *  and list markers are noise to a keyword ranker). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of foldText(text).matchAll(/[\p{L}\p{N}]+/gu)) {
		if (m[0].length >= 2) out.push(m[0]);
	}
	return out;
}

interface PostingDoc {
	fileIndex: number;
	passageIndex: number;
	length: number;
	tf: Map<string, number>;
	folded: string;
}

interface SearchModel {
	docs: PostingDoc[];
	df: Map<string, number>;
	avgLength: number;
}

/** Per-index model cache: an index object is immutable once read, so its
 *  derived postings are computed once per object (the tool reads the
 *  index fresh per call; the store returns the same object until a
 *  rebuild replaces it). */
const models = new WeakMap<CourseIndex, SearchModel>();

function modelFor(index: CourseIndex): SearchModel {
	const cached = models.get(index);
	if (cached) return cached;
	const docs: PostingDoc[] = [];
	const df = new Map<string, number>();
	let total = 0;
	index.files.forEach((file, fileIndex) => {
		file.passages.forEach((passage, passageIndex) => {
			const tokens = tokenize(passage.text);
			const tf = new Map<string, number>();
			for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
			for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
			total += tokens.length;
			docs.push({ fileIndex, passageIndex, length: tokens.length, tf, folded: foldText(passage.text) });
		});
	});
	const model = { docs, df, avgLength: docs.length > 0 ? total / docs.length : 0 };
	models.set(index, model);
	return model;
}

/** The vocabulary entries a query term matches: itself (weight 1) and,
 *  for 4+ letter terms, every longer token containing it (partial weight). */
function expandTerm(term: string, df: Map<string, number>): Array<{ token: string; weight: number }> {
	const out: Array<{ token: string; weight: number }> = [];
	if (df.has(term)) out.push({ token: term, weight: 1 });
	if (term.length >= MIN_PARTIAL_LENGTH) {
		for (const token of df.keys()) {
			if (token !== term && token.length > term.length && token.includes(term)) {
				out.push({ token, weight: PARTIAL_WEIGHT });
			}
		}
	}
	return out;
}

export interface CourseSearchOptions {
	/** Max hits (default 8). */
	limit?: number;
	/** Restrict to files whose path contains this text (case-insensitive). */
	pathFilter?: string;
	/** Snippet window in characters (default 600). */
	snippetChars?: number;
}

/** Rank the index's passages for a free-text query. Empty query or empty
 *  index → no hits (never throws). */
export function searchCourse(index: CourseIndex, query: string, opts: CourseSearchOptions = {}): CourseSearchHit[] {
	const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return [];
	const model = modelFor(index);
	const n = model.docs.length;
	if (n === 0) return [];
	const filter = opts.pathFilter ? foldText(opts.pathFilter) : null;
	const expanded = terms.map((t) => expandTerm(t, model.df));
	const foldedQuery = terms.join(" ");
	const scored: Array<{ doc: PostingDoc; score: number }> = [];
	for (const doc of model.docs) {
		const file = index.files[doc.fileIndex]!;
		if (filter && !foldText(file.path).includes(filter)) continue;
		let score = 0;
		for (const variants of expanded) {
			for (const { token, weight } of variants) {
				const tf = doc.tf.get(token);
				if (!tf) continue;
				const dfToken = model.df.get(token) ?? 0;
				const idf = Math.log(1 + (n - dfToken + 0.5) / (dfToken + 0.5));
				const norm = tf + K1 * (1 - B + (B * doc.length) / Math.max(model.avgLength, 1));
				score += weight * idf * ((tf * (K1 + 1)) / norm);
			}
		}
		if (score <= 0) continue;
		if (terms.length > 1 && collapseWhitespace(doc.folded).includes(foldedQuery)) score *= PHRASE_BOOST;
		scored.push({ doc, score });
	}
	scored.sort(
		(a, b) => b.score - a.score || a.doc.fileIndex - b.doc.fileIndex || a.doc.passageIndex - b.doc.passageIndex,
	);
	return scored.slice(0, limit).map(({ doc, score }) => {
		const file = index.files[doc.fileIndex]!;
		const passage = file.passages[doc.passageIndex]!;
		return {
			path: file.path,
			label: passage.label,
			ordinal: passage.ordinal,
			score: Math.round(score * 100) / 100,
			snippet: snippetFor(passage.text, expanded.flat().map((v) => v.token), opts.snippetChars ?? 600),
		};
	});
}

function collapseWhitespace(text: string): string {
	return text.replace(/[^\p{L}\p{N}]+/gu, " ");
}

/** A window of the passage around the first matched token — located in
 *  the FOLDED text, mapped back to original offsets char by char (folding
 *  can change lengths: "ß" → "ss", decomposed accents drop). */
export function snippetFor(text: string, tokens: readonly string[], width: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= width) return clean;
	let folded = "";
	const origin: number[] = [];
	for (let i = 0; i < clean.length; i++) {
		const f = foldText(clean[i]!);
		for (let k = 0; k < f.length; k++) origin.push(i);
		folded += f;
	}
	let hit = -1;
	for (const token of tokens) {
		const at = folded.indexOf(token);
		if (at !== -1 && (hit === -1 || at < hit)) hit = at;
	}
	const center = hit === -1 ? 0 : origin[hit]!;
	let start = Math.max(0, center - Math.floor(width / 3));
	let end = Math.min(clean.length, start + width);
	start = Math.max(0, end - width);
	// Snap to word boundaries so a snippet never opens mid-word.
	if (start > 0) {
		const space = clean.indexOf(" ", start);
		if (space !== -1 && space - start < 40) start = space + 1;
	}
	if (end < clean.length) {
		const space = clean.lastIndexOf(" ", end);
		if (space > start && end - space < 40) end = space;
	}
	return `${start > 0 ? "… " : ""}${clean.slice(start, end)}${end < clean.length ? " …" : ""}`;
}

// ─── markdown sections ───────────────────────────────────────────────────────

/** Target section size: a heading opens a section; a section that grows
 *  past MAX splits at the next blank line; one under MIN merges forward. */
const SECTION_MAX_CHARS = 4000;
const SECTION_MIN_CHARS = 300;

/** Split markdown (or plain text) into citeable sections. Labels read
 *  "§ 3 (lines 40–88)"; startLine is 1-indexed. */
export function chunkMarkdown(text: string): CoursePassage[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const raw: Array<{ start: number; end: number }> = [];
	let start = 0;
	let size = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const heading = /^#{1,6}\s/.test(line);
		const tooBig = size >= SECTION_MAX_CHARS && line.trim() === "";
		if (i > start && (heading || tooBig)) {
			raw.push({ start, end: i });
			start = tooBig ? i + 1 : i;
			size = 0;
			if (tooBig) continue;
		}
		size += line.length + 1;
	}
	if (start < lines.length) raw.push({ start, end: lines.length });

	// Merge undersized sections forward (a lone heading is no passage).
	const merged: Array<{ start: number; end: number }> = [];
	for (const section of raw) {
		const prev = merged[merged.length - 1];
		const prevSize = prev ? lines.slice(prev.start, prev.end).join("\n").trim().length : Infinity;
		if (prev && prevSize < SECTION_MIN_CHARS) prev.end = section.end;
		else merged.push({ ...section });
	}
	const out: CoursePassage[] = [];
	for (const section of merged) {
		const body = lines.slice(section.start, section.end).join("\n").trim();
		if (!body) continue;
		const ordinal = out.length + 1;
		const first = section.start + 1;
		const last = section.end;
		out.push({ label: `§ ${ordinal} (lines ${first}–${last})`, ordinal, startLine: first, text: body });
	}
	return out;
}

// ─── reading ─────────────────────────────────────────────────────────────────

/** Parse "3" | "3-5" | "1,4,7" | "all" into sorted 1-indexed ordinals
 *  within [1, total]. Unparseable parts drop; nothing matched → []. */
export function parseOrdinalSpec(spec: string, total: number): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (trimmed === "all") return Array.from({ length: total }, (_, i) => i + 1);
	const picked = new Set<number>();
	for (const part of trimmed.split(",")) {
		const p = part.trim();
		if (!p) continue;
		const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(p);
		if (range) {
			const from = Math.max(1, Number(range[1]));
			const to = Math.min(total, Number(range[2]));
			for (let i = from; i <= to; i++) picked.add(i);
		} else if (/^\d+$/.test(p)) {
			const v = Number(p);
			if (v >= 1 && v <= total) picked.add(v);
		}
	}
	return [...picked].sort((a, b) => a - b);
}

/** Find an indexed file by the path the model passed: exact relative path
 *  first, then a unique case-insensitive suffix/basename match (models
 *  drop folders or casing). Null when absent or ambiguous. */
export function findCourseFile(index: CourseIndex, requested: string): CourseIndexedFile | null {
	const want = requested.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const exact = index.files.find((f) => f.path === want);
	if (exact) return exact;
	const folded = foldText(want);
	const matches = index.files.filter((f) => {
		const p = foldText(f.path);
		return p === folded || p.endsWith(`/${folded}`) || p.split("/").pop() === folded;
	});
	return matches.length === 1 ? matches[0]! : null;
}

// ─── the glossary in the prompt ──────────────────────────────────────────────

/** Characters of glossary the system prompt carries (~4k tokens): enough
 *  for a full course's core vocabulary; past it, the rest stays reachable
 *  through course_search (the glossary is indexed as a passage source). */
export const GLOSSARY_PROMPT_CHARS = 16_000;

/** Clip a glossary at a line boundary under the budget; says so when it clipped. */
export function glossaryForPrompt(glossary: string, budget = GLOSSARY_PROMPT_CHARS): string {
	const text = glossary.trim();
	if (text.length <= budget) return text;
	const cut = text.lastIndexOf("\n", budget);
	return `${text.slice(0, cut > 0 ? cut : budget).trimEnd()}\n\n(Glossary clipped here for length — search the course for further terms.)`;
}
