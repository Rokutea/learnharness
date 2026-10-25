import { CourseInputError, createCourse, listCourseItems } from "@/src/server";

/**
 * Course mode (fork, 2026-10-25): the course list + creation.
 *
 * GET  → { courses: CourseListItem[] } — rows + live run state (the
 *        settings section and the session course pickers read this).
 * POST { name?, folder, glossary? } → 201 { course } — validates the
 *        folder (absolute or ~-prefixed, must exist), then indexes in the
 *        background; glossary: true chains a glossary run after the index
 *        (it spends cheap-slot model tokens, so the caller opts in).
 */
export async function GET() {
	return Response.json({ courses: listCourseItems() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { name?: unknown; folder?: unknown; glossary?: unknown } | null;
	try {
		const course = createCourse(body ?? {});
		return Response.json({ course }, { status: 201 });
	} catch (err) {
		if (err instanceof CourseInputError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
