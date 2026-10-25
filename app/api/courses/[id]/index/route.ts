import { CourseInputError, reindexCourse } from "@/src/server";

/** POST → 202: re-index the course folder in the background (course mode,
 *  fork 2026-10-25). Incremental — unchanged files are carried over.
 *  409 while the course is already being processed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		reindexCourse(id);
		return Response.json({ ok: true }, { status: 202 });
	} catch (err) {
		if (err instanceof CourseInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
