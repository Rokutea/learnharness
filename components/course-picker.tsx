"use client";
/**
 * THE SESSION COURSE PICKER (course mode, fork 2026-10-25): the pill in the
 * new-session action row (home + the /chat/new draft) that links the
 * session about to be created to one of the learner's courses. The choice
 * rides POST /api/chats as courseId and is fixed for the session's life.
 *
 * Remembered per device (a student usually studies one subject for days):
 * the last choice is the next session's default. Hidden entirely while no
 * course exists — ordinary sessions look exactly as before.
 */

import { useCallback, useEffect, useState } from "react";
import { GraduationCapIcon } from "lucide-react";
import type { CourseListItem } from "@/src/core";

const STORAGE_KEY = "lh:session-course";

function readStored(): string | null {
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStored(id: string | null): void {
	try {
		if (id) window.localStorage.setItem(STORAGE_KEY, id);
		else window.localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable: the choice lasts for this view only */
	}
}

/** The picker state: the course list, the chosen id (null = no course),
 *  and the setter. A remembered id whose course is gone resolves to null. */
export function useSessionCourse(): {
	courses: CourseListItem[];
	courseId: string | null;
	setCourseId: (id: string | null) => void;
	refresh: () => void;
} {
	const [courses, setCourses] = useState<CourseListItem[]>([]);
	const [chosen, setChosen] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void fetch("/api/courses", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ courses: CourseListItem[] }>) : { courses: [] }))
			.then((body) => setCourses(body.courses ?? []))
			.catch(() => setCourses([]));
	}, []);

	useEffect(() => {
		setChosen(readStored());
		refresh();
	}, [refresh]);

	const setCourseId = useCallback((id: string | null) => {
		setChosen(id);
		writeStored(id);
	}, []);

	const courseId = chosen && courses.some((c) => c.id === chosen) ? chosen : null;
	return { courses, courseId, setCourseId, refresh };
}

export function CoursePickerControl({
	courses,
	courseId,
	onChange,
	onOpen,
}: {
	courses: readonly CourseListItem[];
	courseId: string | null;
	onChange: (id: string | null) => void;
	/** Refetch on focus, so a course added in Settings shows up without a reload. */
	onOpen?: () => void;
}) {
	if (courses.length === 0) return null;
	const active = courseId !== null;
	return (
		<label
			data-testid="course-picker"
			className={
				"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
				(active
					? "border-border bg-card text-foreground hover:bg-accent"
					: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
			}
			title={active ? "This session learns only from the chosen course's material" : "Ground the session in one of your courses"}
		>
			<GraduationCapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
			<select
				aria-label="Course for this session"
				value={courseId ?? ""}
				onFocus={onOpen}
				onChange={(e) => onChange(e.target.value || null)}
				className="cursor-pointer appearance-none bg-transparent font-ui text-xs outline-none"
			>
				<option value="">No course</option>
				{courses.map((c) => (
					<option key={c.id} value={c.id}>
						{c.name}
					</option>
				))}
			</select>
		</label>
	);
}
