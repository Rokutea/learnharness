import { CourseInputError, deleteCourse, getCourseItem, readCourseGlossary, readCourseIndex, saveGlossary, updateCourse } from "@/src/server";

/**
 * One course (course mode, fork 2026-10-25).
 *
 * GET    → { course, glossary, files } — the row + live state, the glossary
 *          markdown (null before the first run), and the indexed files'
 *          summary (path, kind, passages, error) — never the index text.
 * PATCH  { name?, folder?, glossary? } → { course } — rename, move (a new
 *          folder re-indexes), or save the learner's glossary edit.
 * DELETE → 204 — the course, its index, and its glossary. Sessions linked
 *          to it continue as ordinary sessions.
 */
function failure(err: unknown): Response {
	if (err instanceof CourseInputError) return Response.json({ error: err.message }, { status: err.status });
	throw err;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = getCourseItem(id);
	if (!course) return Response.json({ error: "Not found" }, { status: 404 });
	const index = readCourseIndex(id);
	return Response.json({
		course,
		glossary: readCourseGlossary(id),
		files: (index?.files ?? []).map((f) => ({
			path: f.path,
			kind: f.kind,
			passages: f.passages.length,
			...(f.error ? { error: f.error } : {}),
		})),
	});
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { name?: unknown; folder?: unknown; glossary?: unknown } | null;
	if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	try {
		let course = body.name !== undefined || body.folder !== undefined ? updateCourse(id, body) : null;
		if (body.glossary !== undefined) course = saveGlossary(id, body.glossary);
		if (!course) return Response.json({ error: "Nothing to change" }, { status: 400 });
		return Response.json({ course });
	} catch (err) {
		return failure(err);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const removed = await deleteCourse(id);
	if (!removed) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(null, { status: 204 });
}
