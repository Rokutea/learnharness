import { CourseInputError, generateGlossary } from "@/src/server";

/** POST { force? } → 202: (re)generate the course glossary in the
 *  background (course mode, fork 2026-10-25) on the cheap model slot.
 *  409 when the course is busy, not indexed, or the glossary carries the
 *  learner's edits (force: true replaces them); 503 when no cheap-slot
 *  model or key is configured. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { force?: unknown };
	try {
		generateGlossary(id, { force: body?.force === true });
		return Response.json({ ok: true }, { status: 202 });
	} catch (err) {
		if (err instanceof CourseInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
